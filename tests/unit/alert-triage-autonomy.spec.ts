/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P4 named guards (ADR-119 autonomy ladder / BACKLOG "Alert triage & consolidation" P4): kill-switch-default-off (SELF_HEAL_AUTO_APPLY unset OR false => A2 behaves exactly as A1 — no executor call, no ticket annotation, proposal parks at the human gate), A1-analysis-never-remediates (Modes B/C and marker-less Mode A never touch the executor even with everything enabled + the four container-health rules carry intake:auto while SwarmApiUnreachable does not), core-infra-never-applies (api/db/redis targets NEVER restart, with every knob enabled, from any target source — asserted on executor CALLS), once-per-key-per-ttl (an in-process repeat AND a recurrenceOf predecessor audit inside the TTL escalate instead of re-applying; outside the TTL applies again), hourly-cap-parks (over the sliding-hour cap parks visibly at the gate; slots expire after an hour; cap 0 parks everything), verify-fail-blocks-complete (failed verification or failed apply => escalated + needs-attention, never complete, audited), audit-trail-present (a successful apply leaves the full incident.autoApply record + auto-applied flag/label), remediation-class-marker (header-window-only, exact-token-only parsing; unknown classes decline). Behavior/call assertions throughout — no substring guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import {
  AUTO_APPLIED_FLAG,
  AUTO_APPLY_APPLY_FAILED_FLAG,
  AUTO_APPLY_CAP_PARKED_FLAG,
  AUTO_APPLY_CORE_INFRA_FLAG,
  AUTO_APPLY_RECURRENCE_FLAG,
  AUTO_APPLY_VERIFY_FAILED_FLAG,
  SelfHealAutoApplyEngine,
  incidentOf,
  isCoreInfraTarget,
  type IncidentRecord,
  type RemediationExecutor,
} from '@/features/alert-triage';
import { finalizeIncidentByMode } from '@/features/swarm-orchestration/services/dispatch-incident-worker';
import { readRcaRemediationClass } from '@/features/swarm-orchestration/services/rca-mode';
import type { InternalTicket } from '@/entities/ticket';

const ENV_KEYS = ['SELF_HEAL_AUTO_APPLY', 'SELF_HEAL_APPLY_HOURLY_CAP', 'SELF_HEAL_VERIFY_TIMEOUT', 'ALERT_CONSOLIDATION_TTL'];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

/** A spy executor whose outcomes the test controls (call counts are the guards). */
function makeExecutor(overrides: Partial<RemediationExecutor> = {}): RemediationExecutor & {
  restartContainer: ReturnType<typeof vi.fn>;
  verifyHealthy: ReturnType<typeof vi.fn>;
} {
  return {
    restartContainer: vi.fn(async () => ({ ok: true, detail: 'restarted' })),
    verifyHealthy: vi.fn(async () => ({ healthy: true, detail: 'observed running/healthy' })),
    ...overrides,
  } as RemediationExecutor & { restartContainer: ReturnType<typeof vi.fn>; verifyHealthy: ReturnType<typeof vi.fn> };
}

interface TicketOpts {
  key?: string;
  target?: string;
  status?: InternalTicket['status'];
  incidentExtra?: Partial<IncidentRecord>;
}

let ticketSeq = 0;

/** Creates an in-flight incident ticket shaped like the live intake creates them. */
async function makeIncidentTicket(service: TicketService, opts: TicketOpts = {}): Promise<InternalTicket> {
  ticketSeq += 1;
  const key = opts.key ?? `SwarmContainerDown::target-${ticketSeq}`;
  const target = opts.target ?? 'oshal-local-research-bot';
  const now = new Date().toISOString();
  const incident: IncidentRecord = {
    key,
    firstSeen: now,
    lastSeen: now,
    updateCount: 0,
    instanceSeq: 0,
    severity: 'critical',
    members: [{ fingerprint: `fp-${ticketSeq}`, alertname: 'SwarmContainerDown', target, severity: 'critical', firstSeen: now, lastSeen: now, count: 1, attachReason: 'genesis' }],
    membersOverflow: 0,
    escalations: [],
    flags: [],
    claimNonce: `nonce-${ticketSeq}`,
    ...(opts.incidentExtra ?? {}),
  };
  const created = await service.createTicket({
    title: `[critical] SwarmContainerDown on ${target}`,
    ticketType: 'intelligent-processing',
    description: 'guard-spec incident',
    externalProvider: 'prometheus',
    externalId: `${key}#${ticketSeq}`,
    externalUrl: null,
    status: 'approved',
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    priority: 'high',
    labels: ['prometheus', 'incident'],
    metadata: { source: 'prometheus', target, incidentKey: key, incident },
  });
  const wanted = opts.status ?? 'in_process_discovery';
  if (wanted !== 'approved') await service.updateStatus(created.ticketId, wanted);
  return (await service.getTicket(created.ticketId))!;
}

/** Writes a Mode-A RCA report (with or without the class marker) into a temp deliv dir. */
function delivDirWithReport(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'p4-autonomy-'));
  writeFileSync(join(dir, 'RCA-REPORT.md'), lines.join('\n'), 'utf8');
  return dir;
}

const MODE_A_WITH_MARKER = ['MODE: A (remediation)', 'REMEDIATION-CLASS: restart-container', '', 'Root cause: wedged worker.'];

function harness() {
  const service = new TicketService(new InMemoryTicketStore());
  const executor = makeExecutor();
  const engine = new SelfHealAutoApplyEngine(service, executor);
  return { service, executor, engine };
}

describe('guard: kill-switch-default-off — SELF_HEAL_AUTO_APPLY unset/false is A1 exactly', () => {
  it('does nothing with the env unset: no restart, no annotation, proposal parks at the human gate', async () => {
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service);
    const dir = delivDirWithReport(MODE_A_WITH_MARKER);
    await finalizeIncidentByMode(ticket, dir, service, engine);
    const after = (await service.getTicket(ticket.ticketId))!;
    expect(after.status).toBe('customer_action');
    expect(executor.restartContainer).not.toHaveBeenCalled();
    expect(executor.verifyHealthy).not.toHaveBeenCalled();
    const incident = incidentOf(after)!;
    expect(incident.autoApply).toBeUndefined();
    expect(incident.flags).toEqual([]);
  });

  it('explicit false behaves identically (kill switch reverts A2 to A1 semantics)', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'false';
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service);
    const resolution = await engine.resolveModeA(ticket, 'restart-container');
    expect(resolution.status).toBe('customer_action');
    expect(resolution.applied).toBe(false);
    expect(executor.restartContainer).not.toHaveBeenCalled();
  });
});

describe('guard: A1-analysis-never-remediates', () => {
  it('Mode B and Mode C never consult the executor even with the kill switch ON', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, executor, engine } = harness();
    for (const [modeLine, expected] of [
      ['MODE: B (info-request)', 'customer_action'],
      ['MODE: C (escalate)', 'escalated'],
    ] as const) {
      const ticket = await makeIncidentTicket(service);
      const dir = delivDirWithReport([modeLine, 'REMEDIATION-CLASS: restart-container']);
      await finalizeIncidentByMode(ticket, dir, service, engine);
      expect((await service.getTicket(ticket.ticketId))!.status).toBe(expected);
    }
    expect(executor.restartContainer).not.toHaveBeenCalled();
    expect(executor.verifyHealthy).not.toHaveBeenCalled();
  });

  it('a Mode-A proposal WITHOUT the class marker is analysis-only: parks at the gate, zero executor calls', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service);
    const dir = delivDirWithReport(['MODE: A (remediation)', '', 'Restart everything!']);
    await finalizeIncidentByMode(ticket, dir, service, engine);
    expect((await service.getTicket(ticket.ticketId))!.status).toBe('customer_action');
    expect(executor.restartContainer).not.toHaveBeenCalled();
  });

  it('the four container-health rules opt into A1 (intake: auto) while SwarmApiUnreachable stays A0', () => {
    const doc = yamlLoad(readFileSync('ops/monitoring/alert-rules.yml', 'utf8')) as {
      groups: Array<{ rules: Array<{ alert: string; labels?: Record<string, string> }> }>;
    };
    const rules = new Map(doc.groups.flatMap((g) => g.rules).map((r) => [r.alert, r.labels ?? {}]));
    for (const name of ['SwarmContainerDown', 'SwarmContainerRestartLoop', 'SwarmContainerHighMemory', 'SwarmContainerHighCPU']) {
      expect(rules.get(name)?.intake, `${name} must carry the A1 intake: auto label`).toBe('auto');
    }
    expect(rules.get('SwarmApiUnreachable')?.intake, 'SwarmApiUnreachable must NOT auto-flow (watchdog territory)').toBeUndefined();
  });
});

describe('guard: core-infra-never-applies — absolute, even with everything enabled', () => {
  it('api/db/redis targets are never restarted regardless of every knob', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    process.env.SELF_HEAL_APPLY_HOURLY_CAP = '100';
    const { service, executor, engine } = harness();
    for (const target of ['oshal-local-api', 'oshal-local-db', 'oshal-local-redis', 'oshal-local-chromadb']) {
      const ticket = await makeIncidentTicket(service, { key: `SwarmContainerDown::${target}`, target });
      const resolution = await engine.resolveModeA(ticket, 'restart-container');
      expect(resolution.status).toBe('customer_action');
      expect(resolution.applied).toBe(false);
      const incident = incidentOf((await service.getTicket(ticket.ticketId))!)!;
      expect(incident.flags).toContain(AUTO_APPLY_CORE_INFRA_FLAG);
      expect(incident.autoApply).toBeUndefined();
    }
    expect(executor.restartContainer).not.toHaveBeenCalled();
    expect(executor.verifyHealthy).not.toHaveBeenCalled();
  });

  it('a bundle whose rootCandidate is core infra never applies either (target source does not matter)', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service, {
      target: 'oshal-local-research-bot',
      incidentExtra: { rootCandidate: { target: 'oshal-local-api', reason: 'deepest-dependency' } },
    });
    const resolution = await engine.resolveModeA(ticket, 'restart-container');
    expect(resolution.status).toBe('customer_action');
    expect(executor.restartContainer).not.toHaveBeenCalled();
  });

  it('isCoreInfraTarget reuses the dependency-map names (normalized), and workers are not core infra', () => {
    expect(isCoreInfraTarget('oshal-local-api')).toBe(true);
    expect(isCoreInfraTarget('OSHAL-LOCAL-DB:5432')).toBe(true);
    expect(isCoreInfraTarget('oshal-local-redis')).toBe(true);
    expect(isCoreInfraTarget('oshal-local-vault')).toBe(true);
    expect(isCoreInfraTarget('oshal-local-research-bot')).toBe(false);
    expect(isCoreInfraTarget('oshal-local-self-healing')).toBe(false);
  });
});

describe('guard: once-per-key-per-ttl', () => {
  it('a same-key repeat in the same process escalates instead of re-applying', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, executor, engine } = harness();
    const first = await makeIncidentTicket(service, { key: 'SwarmContainerDown::worker-x', target: 'oshal-local-worker-x' });
    expect((await engine.resolveModeA(first, 'restart-container')).status).toBe('complete');
    const second = await makeIncidentTicket(service, { key: 'SwarmContainerDown::worker-x', target: 'oshal-local-worker-x' });
    const resolution = await engine.resolveModeA(second, 'restart-container');
    expect(resolution.status).toBe('escalated');
    expect(resolution.applied).toBe(false);
    expect(executor.restartContainer).toHaveBeenCalledTimes(1);
    const incident = incidentOf((await service.getTicket(second.ticketId))!)!;
    expect(incident.flags).toContain(AUTO_APPLY_RECURRENCE_FLAG);
  });

  it('the recurrenceOf predecessor audit blocks a FRESH engine (restart-safe durable check)', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, engine } = harness();
    const first = await makeIncidentTicket(service, { key: 'SwarmContainerDown::worker-y', target: 'oshal-local-worker-y' });
    expect((await engine.resolveModeA(first, 'restart-container')).status).toBe('complete');
    // New engine = new process: the in-memory ledger is gone, only the ticket audit remains.
    const freshExecutor = makeExecutor();
    const freshEngine = new SelfHealAutoApplyEngine(service, freshExecutor);
    const successor = await makeIncidentTicket(service, {
      key: 'SwarmContainerDown::worker-y',
      target: 'oshal-local-worker-y',
      incidentExtra: { recurrenceOf: first.ticketId, recurrenceCount: 1 },
    });
    const resolution = await freshEngine.resolveModeA(successor, 'restart-container');
    expect(resolution.status).toBe('escalated');
    expect(freshExecutor.restartContainer).not.toHaveBeenCalled();
  });

  it('outside the consolidation TTL the same key may apply again', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    process.env.ALERT_CONSOLIDATION_TTL = '60';
    const { service, engine, executor } = harness();
    const first = await makeIncidentTicket(service, { key: 'SwarmContainerDown::worker-z', target: 'oshal-local-worker-z' });
    const t0 = Date.now();
    expect((await engine.resolveModeA(first, 'restart-container', t0)).status).toBe('complete');
    const successor = await makeIncidentTicket(service, {
      key: 'SwarmContainerDown::worker-z',
      target: 'oshal-local-worker-z',
      incidentExtra: { recurrenceOf: first.ticketId },
    });
    const resolution = await engine.resolveModeA(successor, 'restart-container', t0 + 61_000);
    expect(resolution.status).toBe('complete');
    expect(executor.restartContainer).toHaveBeenCalledTimes(2);
  });
});

describe('guard: hourly-cap-parks', () => {
  it('over the sliding-hour cap the proposal parks visibly at the gate; slots expire after an hour', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    process.env.SELF_HEAL_APPLY_HOURLY_CAP = '1';
    const { service, executor, engine } = harness();
    const t0 = Date.now();
    const first = await makeIncidentTicket(service, { key: 'k-a', target: 'oshal-local-worker-a' });
    expect((await engine.resolveModeA(first, 'restart-container', t0)).status).toBe('complete');
    const second = await makeIncidentTicket(service, { key: 'k-b', target: 'oshal-local-worker-b' });
    const parked = await engine.resolveModeA(second, 'restart-container', t0 + 1000);
    expect(parked.status).toBe('customer_action');
    expect(parked.applied).toBe(false);
    expect(executor.restartContainer).toHaveBeenCalledTimes(1);
    const incident = incidentOf((await service.getTicket(second.ticketId))!)!;
    expect(incident.flags).toContain(AUTO_APPLY_CAP_PARKED_FLAG);
    // An hour later the slot has expired and a new incident applies again.
    const third = await makeIncidentTicket(service, { key: 'k-c', target: 'oshal-local-worker-c' });
    expect((await engine.resolveModeA(third, 'restart-container', t0 + 3_601_000)).status).toBe('complete');
    expect(executor.restartContainer).toHaveBeenCalledTimes(2);
  });

  it('cap 0 parks every apply (a real value, not treated as unset)', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    process.env.SELF_HEAL_APPLY_HOURLY_CAP = '0';
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service);
    expect((await engine.resolveModeA(ticket, 'restart-container')).status).toBe('customer_action');
    expect(executor.restartContainer).not.toHaveBeenCalled();
  });
});

describe('guard: verify-fail-blocks-complete', () => {
  it('a failed verification escalates with needs-attention — the ticket never completes', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const service = new TicketService(new InMemoryTicketStore());
    const executor = makeExecutor({ verifyHealthy: vi.fn(async () => ({ healthy: false, detail: 'still unhealthy' })) });
    const engine = new SelfHealAutoApplyEngine(service, executor);
    const ticket = await makeIncidentTicket(service);
    const dir = delivDirWithReport(MODE_A_WITH_MARKER);
    await finalizeIncidentByMode(ticket, dir, service, engine);
    const after = (await service.getTicket(ticket.ticketId))!;
    expect(after.status).toBe('escalated');
    expect(after.status).not.toBe('complete');
    const incident = incidentOf(after)!;
    expect(incident.flags).toContain('needs-attention');
    expect(incident.flags).toContain(AUTO_APPLY_VERIFY_FAILED_FLAG);
    expect(incident.autoApply?.verified).toBe(false);
    expect(incident.autoApply?.outcome).toBe('verify-failed');
    expect(executor.restartContainer).toHaveBeenCalledTimes(1);
  });

  it('a failed apply escalates with needs-attention and never runs verification', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const service = new TicketService(new InMemoryTicketStore());
    const executor = makeExecutor({ restartContainer: vi.fn(async () => ({ ok: false, detail: 'node unreachable' })) });
    const engine = new SelfHealAutoApplyEngine(service, executor);
    const ticket = await makeIncidentTicket(service);
    const resolution = await engine.resolveModeA(ticket, 'restart-container');
    expect(resolution.status).toBe('escalated');
    expect(executor.verifyHealthy).not.toHaveBeenCalled();
    const incident = incidentOf((await service.getTicket(ticket.ticketId))!)!;
    expect(incident.flags).toContain('needs-attention');
    expect(incident.flags).toContain(AUTO_APPLY_APPLY_FAILED_FLAG);
    expect(incident.autoApply?.applyOk).toBe(false);
    expect(incident.autoApply?.outcome).toBe('apply-failed');
  });
});

describe('guard: audit-trail-present', () => {
  it('a successful apply leaves the full audit record, the flag AND the label on the ticket', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service, { target: 'oshal-local-worker-audit' });
    const dir = delivDirWithReport(MODE_A_WITH_MARKER);
    await finalizeIncidentByMode(ticket, dir, service, engine);
    const after = (await service.getTicket(ticket.ticketId))!;
    expect(after.status).toBe('complete');
    expect(executor.restartContainer).toHaveBeenCalledWith('oshal-local-worker-audit');
    expect(executor.verifyHealthy).toHaveBeenCalledTimes(1);
    const audit = incidentOf(after)!.autoApply!;
    expect(audit.level).toBe('A2');
    expect(audit.remediationClass).toBe('restart-container');
    expect(audit.target).toBe('oshal-local-worker-audit');
    expect(Number.isFinite(Date.parse(audit.decidedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(audit.appliedAt ?? ''))).toBe(true);
    expect(Number.isFinite(Date.parse(audit.verifiedAt ?? ''))).toBe(true);
    expect(audit.applyOk).toBe(true);
    expect(audit.verified).toBe(true);
    expect(audit.outcome).toBe('applied-verified');
    expect(incidentOf(after)!.flags).toContain(AUTO_APPLIED_FLAG);
    expect(after.labels).toContain(AUTO_APPLIED_FLAG);
  });
});

describe('guard: remediation-class-marker — exact header contract, unknown classes decline', () => {
  it('parses the line-2 marker and only the header window', () => {
    expect(readRcaRemediationClass(delivDirWithReport(MODE_A_WITH_MARKER))).toBe('restart-container');
    expect(readRcaRemediationClass(delivDirWithReport(['MODE: A (remediation)', 'remediation-class: RESTART-CONTAINER']))).toBe('restart-container');
    expect(readRcaRemediationClass(delivDirWithReport(['MODE: A (remediation)', 'no marker here']))).toBeNull();
    expect(readRcaRemediationClass(delivDirWithReport(['1', '2', '3', '4', '5', '6', 'REMEDIATION-CLASS: restart-container']))).toBeNull();
    expect(readRcaRemediationClass(delivDirWithReport(['MODE: A', 'REMEDIATION-CLASS: rm -rf /']))).toBeNull();
    expect(readRcaRemediationClass(mkdtempSync(join(tmpdir(), 'p4-empty-')))).toBeNull();
  });

  it('an unknown class never applies even with everything enabled', async () => {
    process.env.SELF_HEAL_AUTO_APPLY = 'true';
    const { service, executor, engine } = harness();
    const ticket = await makeIncidentTicket(service);
    const resolution = await engine.resolveModeA(ticket, 'scale-up');
    expect(resolution.status).toBe('customer_action');
    expect(executor.restartContainer).not.toHaveBeenCalled();
  });
});
