/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 named guards (ADR-119 Stage D / BACKLOG "Alert triage & consolidation" P2): api-down-drill-one-bundle (SwarmApiUnreachable + SwarmContainerDown{api} + a dependent-bot alert ⇒ ONE ticket, 3 members with attach reasons, api as rootCandidate — spec guard 4), rca-dispatched-once (exactly one createTicket, zero updateStatus, one dispatchable unit — spec guard 5 / FR-E1), bundling-window-boundary (stale incidents never attract a bundle; ALERT_CORRELATION_WINDOW is a real knob incl. 0=disabled), dependency-depth-limit (BFS hop bound honored, ALERT_CORRELATION_DEPTH is a real knob), attach-never-promotes (FR-D7 — backlog stays backlog, needs-attention flag instead of auto-promote), root-candidate-policy (FR-D4 ordered: root-filter > deepest-dependency > earliest-first-seen), member-cap knob (FR-D5 ALERT_MAX_MEMBERS + overflow counter), dependency-map-override (ALERT_DEPENDENCY_MAP file honored, malformed file fails OPEN to defaults). Behavior/call assertions throughout — no substring guards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAlertmanagerRoutes } from '@/app/routes/alertmanager-routes';
import { InMemoryTicketStore, TicketService } from '@/features/ticketing';
import {
  ALERT_CORRELATION_DEPTH_DEFAULT,
  ALERT_MAX_INCIDENT_MEMBERS,
  AlertBundlingService,
  StaticDependencyMap,
  correlationDepth,
  correlationWindowSeconds,
  incidentOf,
  maxIncidentMembers,
  type IncidentMember,
} from '@/features/alert-triage';
import type { InternalTicket } from '@/entities/ticket';

const TOKEN = 'p2-triage-test-token';
const ALERT_ENV_KEYS = [
  'ALERT_WEBHOOK_TOKEN',
  'ALERT_WEBHOOK_HMAC_SECRET',
  'ALERT_APPROVED_NAMES',
  'ALERT_BACKLOG_NAMES',
  'ALERT_DEFAULT_INTAKE',
  'ALERT_TICKET_TYPE',
  'ALERT_CONSOLIDATION_TTL',
  'ALERT_CORRELATION_WINDOW',
  'ALERT_CORRELATION_DEPTH',
  'ALERT_DEPENDENCY_MAP',
  'ALERT_MAX_MEMBERS',
];
const savedEnv = new Map<string, string | undefined>();

interface Harness {
  service: TicketService;
  server: Server;
  post(payload: unknown, token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  getStats(token?: string | null): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Boot the real router over the real service + in-memory store on an ephemeral port. */
async function makeHarness(): Promise<Harness> {
  const service = new TicketService(new InMemoryTicketStore());
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', createAlertmanagerRoutes(service));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  const request = async (method: string, path: string, body: unknown, token: string | null | undefined) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token ?? TOKEN}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}; } catch { parsed = {}; }
    return { status: res.status, body: parsed };
  };

  return {
    service,
    server,
    post: (payload, token) => request('POST', '/api/alerts/alertmanager', payload, token),
    getStats: (token) => request('GET', '/api/alerts/intake-stats', undefined, token),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A recent ISO timestamp (bundling correlates against REAL arrival time). */
function recentIso(secondsAgo = 30): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

/** One firing alert payload (Alertmanager v4 shape) with a resolvable container target. */
function firing(
  alertname: string,
  opts: { target?: string; severity?: string; fingerprint?: string; startsAt?: string; intake?: string } = {},
): { alerts: Array<Record<string, unknown>> } {
  const target = opts.target ?? 'oshal-local-api';
  const labels: Record<string, string> = { alertname, container: target, severity: opts.severity ?? 'warning' };
  if (opts.intake) labels.intake = opts.intake;
  return {
    alerts: [{
      status: 'firing',
      labels,
      annotations: { summary: `${alertname} test alert` },
      startsAt: opts.startsAt ?? recentIso(),
      fingerprint: opts.fingerprint ?? `fp-${alertname}-${target}`,
    }],
  };
}

async function onlyTicket(service: TicketService): Promise<InternalTicket> {
  const tickets = await service.listTickets();
  expect(tickets).toHaveLength(1);
  return tickets[0];
}

/** The api-down drill (spec guard 4): api probe + api container + one dependent bot. */
async function postApiDownDrill(h: Harness): Promise<{
  a: { status: number; body: Record<string, unknown> };
  b: { status: number; body: Record<string, unknown> };
  c: { status: number; body: Record<string, unknown> };
}> {
  const a = await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api', severity: 'critical' }));
  const b = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api', severity: 'critical' }));
  const c = await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot', severity: 'warning' }));
  return { a, b, c };
}

beforeEach(() => {
  for (const key of ALERT_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ALERT_WEBHOOK_TOKEN = TOKEN;
});

afterEach(() => {
  for (const key of ALERT_ENV_KEYS) {
    const prior = savedEnv.get(key);
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  vi.restoreAllMocks();
});

describe('alert triage P2 bundling guards (ADR-119 Stage D / BACKLOG P2)', () => {
  it('P2 guard api-down-drill-one-bundle: SwarmApiUnreachable + SwarmContainerDown{api} + a dependent-bot alert inside the window open ONE ticket with 3 attach-reasoned members and the api as rootCandidate', async () => {
    const h = await makeHarness();
    try {
      const { a, b, c } = await postApiDownDrill(h);
      expect(a.status).toBe(200);
      expect(a.body.created).toBe(1);
      expect(b.body.created).toBe(0);
      expect(b.body.bundled).toBe(1);
      expect(c.body.created).toBe(0);
      expect(c.body.bundled).toBe(1);

      const ticket = await onlyTicket(h.service);
      expect((b.body.bundledTicketIds as string[])[0]).toBe(ticket.ticketId);
      expect((c.body.bundledTicketIds as string[])[0]).toBe(ticket.ticketId);

      const incident = incidentOf(ticket);
      expect(incident).not.toBeNull();
      // FR-D5: composition recorded AT ATTACH TIME — three members, each with its reason.
      expect(incident!.members).toHaveLength(3);
      expect(incident!.members[0]).toMatchObject({ alertname: 'SwarmApiUnreachable', target: 'oshal-local-api', attachReason: 'genesis' });
      expect(incident!.members[1]).toMatchObject({ alertname: 'SwarmContainerDown', target: 'oshal-local-api', attachReason: 'same-target' });
      expect(incident!.members[2].alertname).toBe('SwarmContainerRestartLoop');
      expect(incident!.members[2].attachReason).toMatch(/^dependency:oshal-local-api@1$/);
      // FR-D4: the api wins the ordered policy via deepest-dependency (the bot depends on it).
      expect(incident!.rootCandidate).toEqual({ target: 'oshal-local-api', reason: 'deepest-dependency' });

      // FR-A3: `bundled` is a counted, queryable decision class.
      const stats = await h.getStats();
      const counts = (stats.body.stats as { counts: Record<string, number> }).counts;
      expect(counts.created).toBe(1);
      expect(counts.bundled).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('P2 guard rca-dispatched-once: the bundled drill is ONE dispatchable unit — one createTicket, zero status transitions, and a post-dispatch attach never re-dispatches (FR-E1/FR-D7)', async () => {
    const h = await makeHarness();
    try {
      const createSpy = vi.spyOn(h.service, 'createTicket');
      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      await postApiDownDrill(h);

      // Exactly one ticket entered the queue in the auto-flow status — the single RCA
      // dispatch unit. Attaches asserted as CALLS: no second create, no status touch.
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(statusSpy).not.toHaveBeenCalled();
      const ticket = await onlyTicket(h.service);
      expect(ticket.status).toBe('approved');

      // Dispatcher takes the bundle; a fourth related alert attaches without
      // re-dispatching or re-creating.
      await h.service.updateStatus(ticket.ticketId, 'in_process_discovery');
      statusSpy.mockClear();
      const d = await h.post(firing('SwarmContainerHighMemory', { target: 'oshal-local-api', severity: 'warning' }));
      expect(d.body.bundled).toBe(1);
      expect(d.body.created).toBe(0);
      expect(statusSpy).not.toHaveBeenCalled();
      const after = (await h.service.getTicket(ticket.ticketId))!;
      expect(after.status).toBe('in_process_discovery');
      expect(incidentOf(after)!.members).toHaveLength(4);
      expect(await h.service.listTickets()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('P2 guard bundling-window-boundary: an incident with last activity OUTSIDE ALERT_CORRELATION_WINDOW never attracts a bundle; a wider window does; 0 disables bundling', async () => {
    // Default 15m window: activity 20 minutes ago is stale — a related alert opens its own ticket.
    let h = await makeHarness();
    try {
      await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api', startsAt: recentIso(1200) }));
      const related = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api' }));
      expect(related.body.created).toBe(1);
      expect(related.body.bundled).toBe(0);
      expect(await h.service.listTickets()).toHaveLength(2);
    } finally {
      await h.close();
    }

    // The knob is real: widened to 1h, the same 20-minute-old incident bundles.
    process.env.ALERT_CORRELATION_WINDOW = '3600';
    h = await makeHarness();
    try {
      await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api', startsAt: recentIso(1200) }));
      const related = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api' }));
      expect(related.body.bundled).toBe(1);
      expect(await h.service.listTickets()).toHaveLength(1);
    } finally {
      await h.close();
    }

    // 0 disables Stage D entirely — even immediately-adjacent related alerts stay separate.
    process.env.ALERT_CORRELATION_WINDOW = '0';
    h = await makeHarness();
    try {
      await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api' }));
      const related = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api' }));
      expect(related.body.created).toBe(1);
      expect(related.body.bundled).toBe(0);
      expect(await h.service.listTickets()).toHaveLength(2);
    } finally {
      await h.close();
    }

    // Junk values fall back to the 15m default (one constants module, spec §9.8).
    process.env.ALERT_CORRELATION_WINDOW = 'not-a-number';
    expect(correlationWindowSeconds()).toBe(900);
    delete process.env.ALERT_CORRELATION_WINDOW;
    expect(correlationWindowSeconds()).toBe(900);
  });

  it('P2 guard dependency-depth-limit: BFS distance honors the hop bound, and ALERT_CORRELATION_DEPTH gates dependency bundling end-to-end', async () => {
    // Pure map semantics: bot → api = 1 hop; bot → db = 2 hops (via the api); direction matters.
    const map = new StaticDependencyMap();
    expect(await map.dependencyDistance('oshal-local-email-bot', 'oshal-local-api', 3)).toBe(1);
    expect(await map.dependencyDistance('oshal-local-email-bot', 'oshal-local-db', 3)).toBe(2);
    expect(await map.dependencyDistance('oshal-local-email-bot', 'oshal-local-db', 1)).toBeNull();
    expect(await map.dependencyDistance('oshal-local-db', 'oshal-local-email-bot', 3)).toBeNull();
    expect(await map.dependencyDistance('oshal-local-api', 'oshal-local-db', 3)).toBe(1);
    // Instance labels normalize (`host:port`), so probe targets match container targets.
    expect(await map.dependencyDistance('oshal-local-api:5000', 'oshal-local-db', 3)).toBe(1);

    // Depth 1: a 2-hop relation (bot ↔ db) must NOT bundle.
    process.env.ALERT_CORRELATION_DEPTH = '1';
    let h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-db', severity: 'critical' }));
      const botAlert = await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot' }));
      expect(botAlert.body.created).toBe(1);
      expect(botAlert.body.bundled).toBe(0);
      expect(await h.service.listTickets()).toHaveLength(2);
    } finally {
      await h.close();
    }

    // Default depth 3: the same 2-hop relation bundles, reason names the connecting member.
    delete process.env.ALERT_CORRELATION_DEPTH;
    h = await makeHarness();
    try {
      await h.post(firing('SwarmContainerDown', { target: 'oshal-local-db', severity: 'critical' }));
      const botAlert = await h.post(firing('SwarmContainerRestartLoop', { target: 'oshal-local-email-bot' }));
      expect(botAlert.body.bundled).toBe(1);
      const incident = incidentOf(await onlyTicket(h.service))!;
      expect(incident.members[1].attachReason).toBe('dependency:oshal-local-db@2');
    } finally {
      await h.close();
    }

    // Junk depth falls back to the deployed default of 3.
    process.env.ALERT_CORRELATION_DEPTH = 'garbage';
    expect(correlationDepth()).toBe(ALERT_CORRELATION_DEPTH_DEFAULT);
  });

  it('P2 guard attach-never-promotes (FR-D7): an auto-flow member attaching to a BACKLOG bundle leaves it backlog with a needs-attention flag — no promote, no dispatch', async () => {
    const h = await makeHarness();
    try {
      await h.post(firing('SwarmApiUnreachable', { target: 'oshal-local-api', severity: 'critical', intake: 'backlog' }));
      const parked = await onlyTicket(h.service);
      expect(parked.status).toBe('backlog');

      const statusSpy = vi.spyOn(h.service, 'updateStatus');
      const attach = await h.post(firing('SwarmContainerDown', { target: 'oshal-local-api', severity: 'critical', intake: 'auto' }));
      expect(attach.body.bundled).toBe(1);

      const after = (await h.service.getTicket(parked.ticketId))!;
      expect(after.status).toBe('backlog'); // attach to backlog KEEPS backlog
      expect(statusSpy).not.toHaveBeenCalled(); // asserted as CALLS, not just end-state
      const incident = incidentOf(after)!;
      expect(incident.flags).toContain('needs-attention'); // the operator signal instead of auto-promote
      expect(incident.members).toHaveLength(2);
      expect(await h.service.listTickets()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('P2 guard root-candidate-policy (FR-D4): ordered — an explicit root filter beats deepest-dependency beats earliest-firstSeen, and the reason records which step won', async () => {
    const bundling = new AlertBundlingService();
    const member = (alertname: string, target: string, firstSeen: string): IncidentMember => ({
      fingerprint: `fp-${alertname}-${target}`,
      alertname,
      target,
      severity: 'warning',
      firstSeen,
      lastSeen: firstSeen,
      count: 1,
      attachReason: 'genesis',
    });
    // Bot listed FIRST so dict-iteration-first (the source platform's documented flaw)
    // would pick the bot — the policy must pick the api instead.
    const members = [
      member('SwarmContainerRestartLoop', 'oshal-local-email-bot', '2026-07-31T10:00:00.000Z'),
      member('SwarmApiUnreachable', 'oshal-local-api', '2026-07-31T10:05:00.000Z'),
    ];

    // Step 2 — deepest dependency: the bot depends on the api, so the api is the candidate.
    expect(await bundling.chooseRootCandidate(members)).toEqual({ target: 'oshal-local-api', reason: 'deepest-dependency' });

    // Step 1 — an explicit ordered filter overrides, first matching entry wins.
    expect(await bundling.chooseRootCandidate(members, ['oshal-local-email-bot', 'oshal-local-api'])).toEqual({
      target: 'oshal-local-email-bot',
      reason: 'root-filter:oshal-local-email-bot',
    });
    expect(await bundling.chooseRootCandidate(members, ['no-such-target', 'oshal-local-email-bot'])).toEqual({
      target: 'oshal-local-email-bot',
      reason: 'root-filter:oshal-local-email-bot',
    });

    // Step 3 — no dependency relation between two workers: earliest firstSeen wins.
    const unrelated = [
      member('BotAlert2', 'oshal-local-weather-bot', '2026-07-31T10:10:00.000Z'),
      member('BotAlert1', 'oshal-local-email-bot', '2026-07-31T10:00:00.000Z'),
    ];
    expect(await bundling.chooseRootCandidate(unrelated)).toEqual({ target: 'oshal-local-email-bot', reason: 'earliest-first-seen' });
  });

  it('P2 guard member-cap knob (FR-D5): ALERT_MAX_MEMBERS caps recorded members with a visible overflow counter, and junk values fall back to 50', async () => {
    process.env.ALERT_MAX_MEMBERS = '2';
    const h = await makeHarness();
    try {
      await postApiDownDrill(h);
      const incident = incidentOf(await onlyTicket(h.service))!;
      expect(incident.members).toHaveLength(2); // genesis + first attach recorded
      expect(incident.membersOverflow).toBe(1); // the third is COUNTED, never silent
    } finally {
      await h.close();
    }

    process.env.ALERT_MAX_MEMBERS = 'junk';
    expect(maxIncidentMembers()).toBe(ALERT_MAX_INCIDENT_MEMBERS);
    process.env.ALERT_MAX_MEMBERS = '0'; // an incident always records its genesis member
    expect(maxIncidentMembers()).toBe(ALERT_MAX_INCIDENT_MEMBERS);
  });

  it('P2 guard dependency-map-override: ALERT_DEPENDENCY_MAP edges extend the compose map, and a malformed file fails OPEN to the built-in topology', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oshal-depmap-'));
    const goodFile = join(dir, 'edges.json');
    writeFileSync(goodFile, JSON.stringify({ edges: [['custom-web', 'custom-db']] }), 'utf8');
    process.env.ALERT_DEPENDENCY_MAP = goodFile;
    const withOverride = StaticDependencyMap.fromEnvironment();
    expect(await withOverride.dependencyDistance('custom-web', 'custom-db', 3)).toBe(1);
    expect(await withOverride.dependencyDistance('oshal-local-api', 'oshal-local-db', 3)).toBe(1); // defaults still present

    const badFile = join(dir, 'broken.json');
    writeFileSync(badFile, 'not json at all', 'utf8');
    process.env.ALERT_DEPENDENCY_MAP = badFile;
    const failOpen = StaticDependencyMap.fromEnvironment();
    expect(await failOpen.dependencyDistance('custom-web', 'custom-db', 3)).toBeNull();
    expect(await failOpen.dependencyDistance('oshal-local-api', 'oshal-local-redis', 3)).toBe(1); // bundling never disabled by a bad override
  });
});
