/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P4 (ADR-119 A2): the bounded auto-apply engine. A Mode-A RCA proposal whose declared action is in the sanctioned class (restart-container ONLY) may execute unattended — behind the SELF_HEAL_AUTO_APPLY kill switch (default FALSE; off = byte-identical A1 semantics), never on core infra (isCoreInfraTarget over the SAME dependency-map names — absolute regardless of every other setting, re-checked immediately before execution so no ladder reorder can bypass it), at most ONCE per incident key per consolidation TTL (in-process ledger + the durable recurrenceOf-predecessor audit — a recurrence escalates to a human instead of re-applying), under a global sliding-hour apply cap mirroring the RcaBudgetGate reservation shape (over cap parks at the approve gate, visibly). Verification-after-apply is required, not decoration: the ticket may complete ONLY when the target is observed healthy inside the verify window; a failed verify (or failed apply) escalates with needs-attention — never silent, never complete. Every attempted apply leaves a full audit record on the ticket (incident.autoApply + the flags[] seam + labels + activity history). The engine reads numbers and calls the executor seam; it never calls an LLM (controller/LLM boundary holds)
 */

import type { InternalTicket, TicketStatusMetadata } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import {
  ALERT_INCIDENT_KEY_FIELD,
  autoApplyEnabled,
  autoApplyHourlyCap,
  autoApplyVerifyTimeoutSeconds,
  consolidationTtlSeconds,
} from './alert-triage-constants';
import { isCoreInfraTarget } from './dependency-map';
import { incidentOf, type IncidentAutoApplyAudit, type IncidentRecord } from './incident-record';

const logger = createChildLogger({ module: 'alert-auto-apply' });

/**
 * @description The sanctioned A2 remediation classes (ADR-119 A2). Deliberately a code
 * constant, not an env knob: widening what the swarm may do to itself unattended is a
 * reviewed code change with guards, never a deployment flip (§9.9 — a knob nobody's guard
 * exercises is the trap).
 */
export const AUTO_APPLY_CLASSES: ReadonlySet<string> = new Set(['restart-container']);

/** @description flags[]/label on a successfully applied-and-verified incident. */
export const AUTO_APPLIED_FLAG = 'auto-applied';

/** @description flags[]/label when the apply command itself failed (escalated, audited). */
export const AUTO_APPLY_APPLY_FAILED_FLAG = 'auto-apply:apply-failed';

/** @description flags[]/label when post-apply verification failed (escalated, audited). */
export const AUTO_APPLY_VERIFY_FAILED_FLAG = 'auto-apply:verify-failed';

/** @description flags[]/label when the global hourly apply cap parked the proposal. */
export const AUTO_APPLY_CAP_PARKED_FLAG = 'auto-apply-parked:hourly-cap';

/** @description flags[]/label when a same-key recurrence inside the TTL blocked re-apply. */
export const AUTO_APPLY_RECURRENCE_FLAG = 'auto-apply-blocked:recurrence';

/** @description flags[]/label when the core-infra guard refused the target. */
export const AUTO_APPLY_CORE_INFRA_FLAG = 'auto-apply-blocked:core-infra';

/** @description The P2 operator-attention flag (same literal alert-consolidation.ts uses). */
const NEEDS_ATTENTION_FLAG = 'needs-attention';

/**
 * @description The remediation seam A2 executes through. The app layer wires an
 * implementation that reaches the self-healing bot node's deterministic apply endpoint
 * (the ONE container holding the docker socket) — the controller never shells out and
 * never calls an LLM here. Absent executor = the engine declines every apply.
 */
export interface RemediationExecutor {
  /**
   * @description Restarts the named swarm container (the node re-checks its own whitelist).
   * @param target - Container name (e.g. oshal-local-research-bot).
   * @returns ok + human-readable detail for the audit record.
   */
  restartContainer(target: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * @description Observes the target until healthy or the window elapses (ADR-119 A2
   * bound 3: exit-0 is not "done" — only observed health completes the ticket).
   * @param target - Container name.
   * @param timeoutMs - Verification window.
   * @returns healthy + detail for the audit record.
   */
  verifyHealthy(target: string, timeoutMs: number): Promise<{ healthy: boolean; detail: string }>;
}

/**
 * @description The minimal ticket surface the engine needs, expressed structurally so this
 * slice never imports the ticketing slice (FSD). TicketService satisfies it as-is.
 */
export interface AutoApplyTicketGateway {
  getTicket(ticketId: string): Promise<InternalTicket | null>;
  updateTicket(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt' | 'status'>>): Promise<void>;
  recordActivity(ticketId: string, metadata: TicketStatusMetadata): Promise<void>;
}

/**
 * @description What the Mode-A finalizer should do with the ticket after the engine ran.
 * `status` is the terminal state the incident pipeline writes; `disposition`/`reason` ride
 * the status metadata so the decision is visible in ticket history.
 */
export interface AutoApplyResolution {
  status: 'complete' | 'customer_action' | 'escalated';
  disposition: string;
  reason: string;
  /** True only when a restart was actually executed (verified or not). */
  applied: boolean;
}

/** @description The A1 fall-through: proposal waits at the approve-or-close gate. */
const A1_RESOLUTION_BASE = { status: 'customer_action', disposition: 'proposed_solution', applied: false } as const;

/**
 * @description ADR-119 A2 — the bounded auto-apply engine, consulted by the incident
 * pipeline's Mode-A finalizer (the queue manager threads it in exactly like the
 * cost-governance pre-dispatch budget hook). One instance per queue manager; the hourly
 * cap and per-key ledger are in-process state, and the durable once-per-key truth is the
 * audit record on the recurrence predecessor ticket (restart-safe via recurrenceOf).
 */
export class SelfHealAutoApplyEngine {
  /** Sliding-hour apply slots (reservation shape mirroring RcaBudgetGate). */
  private applySlots: Array<{ atMs: number; released: boolean }> = [];

  /** In-process once-per-key ledger: incident key → last apply epoch ms. */
  private readonly appliedKeys = new Map<string, number>();

  /**
   * @param tickets - Ticket read/annotate surface (TicketService, structurally).
   * @param executor - The remediation seam; null declines every apply (logged).
   */
  constructor(
    private readonly tickets: AutoApplyTicketGateway,
    private readonly executor: RemediationExecutor | null = null,
  ) {}

  /**
   * @description Resolves a Mode-A RCA proposal: apply-and-verify when every A2 bound
   * passes, otherwise the A1 disposition (customer_action) or an escalation — never a
   * silent outcome. With SELF_HEAL_AUTO_APPLY unset/false this returns the plain A1
   * resolution WITHOUT touching the ticket (kill switch off = A1 exactly).
   * @param ticket - The incident ticket (snapshot from dispatch; re-read before writes).
   * @param remediationClass - The proposal's declared class (RCA-REPORT.md marker), or null.
   * @param nowMs - Evaluation time (injected for deterministic guards).
   * @returns The terminal resolution for the finalizer to write.
   */
  async resolveModeA(ticket: InternalTicket, remediationClass: string | null, nowMs = Date.now()): Promise<AutoApplyResolution> {
    if (!autoApplyEnabled()) {
      return { ...A1_RESOLUTION_BASE, reason: 'auto-apply-disabled' };
    }
    const declined = await this.evaluateBounds(ticket, remediationClass, nowMs);
    if (declined) return declined;
    const incident = incidentOf(ticket)!;
    const target = resolveApplyTarget(ticket, incident)!;
    return this.applyAndVerify(ticket, incident, target, remediationClass!, nowMs);
  }

  /**
   * @description Runs the pre-apply bound ladder (executor present → sanctioned class →
   * resolvable target → core-infra guard → once-per-key-per-TTL → hourly cap). Returns the
   * declining resolution, or null when every bound passes and the apply may proceed.
   * @param ticket - The incident ticket.
   * @param remediationClass - Declared remediation class or null.
   * @param nowMs - Evaluation time.
   * @returns A resolution when declined, else null.
   */
  private async evaluateBounds(
    ticket: InternalTicket,
    remediationClass: string | null,
    nowMs: number,
  ): Promise<AutoApplyResolution | null> {
    if (!this.executor) {
      logger.warn({ ticketId: ticket.ticketId }, 'SELF_HEAL_AUTO_APPLY is on but no remediation executor is wired — proposal stays at the gate');
      return { ...A1_RESOLUTION_BASE, reason: 'no-remediation-executor' };
    }
    if (!remediationClass || !AUTO_APPLY_CLASSES.has(remediationClass)) {
      return { ...A1_RESOLUTION_BASE, reason: `remediation-class-not-sanctioned:${remediationClass ?? 'none'}` };
    }
    const incident = incidentOf(ticket);
    if (!incident) {
      return { ...A1_RESOLUTION_BASE, reason: 'no-incident-record' };
    }
    const target = resolveApplyTarget(ticket, incident);
    if (!target) {
      return { ...A1_RESOLUTION_BASE, reason: 'no-resolvable-target' };
    }
    if (isCoreInfraTarget(target)) {
      // ADR-119: api/db/redis (and the rest of the infra tier) are watchdog territory —
      // absolute, regardless of the kill switch or any other knob.
      await this.annotate(ticket, [AUTO_APPLY_CORE_INFRA_FLAG], `auto-apply refused: ${target} is core infra (watchdog territory, ADR-119 A2)`);
      return { ...A1_RESOLUTION_BASE, reason: `core-infra-target:${target}` };
    }
    if (await this.appliedWithinTtl(incident, nowMs)) {
      await this.annotate(ticket, [AUTO_APPLY_RECURRENCE_FLAG, NEEDS_ATTENTION_FLAG], `auto-apply refused: incident key ${incident.key} was already auto-applied inside the consolidation TTL — escalating to a human instead of re-applying (ADR-119 A2 bound 1)`);
      return { status: 'escalated', disposition: 'auto_apply_recurrence', reason: 'already-applied-within-ttl', applied: false };
    }
    if (this.hourlyCapExhausted(nowMs)) {
      await this.annotate(ticket, [AUTO_APPLY_CAP_PARKED_FLAG], `auto-apply parked: global hourly apply cap (${autoApplyHourlyCap()}) reached — proposal waits at the approve gate (ADR-119 A2 bound 2)`);
      return { ...A1_RESOLUTION_BASE, reason: 'hourly-cap-reached' };
    }
    return null;
  }

  /**
   * @description Executes the sanctioned restart, verifies observed health inside the
   * window, and writes the full audit trail (incident.autoApply + flags + labels +
   * activity). Verified → complete; failed apply or failed verify → escalated with
   * needs-attention. The apply slot is consumed the moment execution starts.
   * @param ticket - The incident ticket.
   * @param incident - Parsed incident record (from the dispatch snapshot; re-read on write).
   * @param target - The container to restart (already core-infra-cleared).
   * @param remediationClass - The sanctioned class being executed.
   * @param nowMs - Evaluation time.
   * @returns The terminal resolution.
   */
  private async applyAndVerify(
    ticket: InternalTicket,
    incident: IncidentRecord,
    target: string,
    remediationClass: string,
    nowMs: number,
  ): Promise<AutoApplyResolution> {
    // Defense in depth: the absolute guard re-checked at the execution boundary so no
    // future reorder of the bound ladder can route core infra here.
    if (isCoreInfraTarget(target)) {
      return { ...A1_RESOLUTION_BASE, reason: `core-infra-target:${target}` };
    }
    this.applySlots.push({ atMs: nowMs, released: false });
    this.appliedKeys.set(incident.key, nowMs);
    const audit: IncidentAutoApplyAudit = {
      level: 'A2',
      remediationClass,
      target,
      decidedAt: new Date(nowMs).toISOString(),
      outcome: 'apply-failed',
    };
    let applyOk = false;
    let applyDetail = '';
    try {
      const result = await this.executor!.restartContainer(target);
      applyOk = result.ok;
      applyDetail = result.detail;
    } catch (err) {
      applyDetail = err instanceof Error ? err.message : String(err);
      logger.error({ err, ticketId: ticket.ticketId, target }, 'Auto-apply restart threw — escalating with needs-attention');
    }
    audit.appliedAt = new Date().toISOString();
    audit.applyOk = applyOk;
    audit.applyDetail = applyDetail;
    if (!applyOk) {
      await this.persistAudit(ticket, audit, [AUTO_APPLY_APPLY_FAILED_FLAG, NEEDS_ATTENTION_FLAG], `auto-apply FAILED to restart ${target}: ${applyDetail} — escalated (never silent)`);
      return { status: 'escalated', disposition: 'auto_apply_failed', reason: 'apply-failed', applied: true };
    }
    return this.verifyAndFinalize(ticket, target, audit);
  }

  /**
   * @description The verification half (ADR-119 A2 bound 3): the ticket completes ONLY
   * when the restarted target is observed healthy inside the verify window; anything else
   * escalates with needs-attention and the audit records the failure.
   * @param ticket - The incident ticket.
   * @param target - The restarted container.
   * @param audit - The in-progress audit record (apply fields already filled).
   * @returns The terminal resolution.
   */
  private async verifyAndFinalize(ticket: InternalTicket, target: string, audit: IncidentAutoApplyAudit): Promise<AutoApplyResolution> {
    let healthy = false;
    let verifyDetail = '';
    try {
      const verdict = await this.executor!.verifyHealthy(target, autoApplyVerifyTimeoutSeconds() * 1000);
      healthy = verdict.healthy;
      verifyDetail = verdict.detail;
    } catch (err) {
      verifyDetail = err instanceof Error ? err.message : String(err);
      logger.error({ err, ticketId: ticket.ticketId, target }, 'Auto-apply verification threw — treated as failed verification');
    }
    audit.verifiedAt = new Date().toISOString();
    audit.verified = healthy;
    audit.verifyDetail = verifyDetail;
    audit.outcome = healthy ? 'applied-verified' : 'verify-failed';
    if (!healthy) {
      await this.persistAudit(ticket, audit, [AUTO_APPLY_VERIFY_FAILED_FLAG, NEEDS_ATTENTION_FLAG], `auto-apply restarted ${target} but verification FAILED (${verifyDetail}) — escalated with needs-attention, ticket may not complete`);
      return { status: 'escalated', disposition: 'auto_apply_verify_failed', reason: 'verification-failed', applied: true };
    }
    await this.persistAudit(ticket, audit, [AUTO_APPLIED_FLAG], `auto-applied ${audit.remediationClass} on ${target} and verified healthy (${verifyDetail}) — completing (ADR-119 A2)`);
    logger.info({ ticketId: ticket.ticketId, target }, 'Auto-apply verified healthy — incident completes unattended (ADR-119 A2)');
    return { status: 'complete', disposition: 'auto_applied_verified', reason: 'applied-and-verified', applied: true };
  }

  /**
   * @description Once-per-key-per-TTL check (ADR-119 A2 bound 1): the in-process ledger
   * catches same-process repeats; the durable check reads the audit record off this
   * incident's own record (a re-finalize must never re-apply) and off its recurrenceOf
   * predecessor (consolidation stamps that link exactly when the prior incident on this
   * key went terminal inside the TTL — restart-safe).
   * @param incident - The current incident record.
   * @param nowMs - Evaluation time.
   * @returns True when an apply already happened for this key inside the TTL.
   */
  private async appliedWithinTtl(incident: IncidentRecord, nowMs: number): Promise<boolean> {
    const ttlMs = consolidationTtlSeconds() * 1000;
    const within = (appliedAtIso: string | undefined): boolean => {
      const ms = Date.parse(appliedAtIso ?? '');
      return Number.isFinite(ms) && nowMs - ms <= ttlMs;
    };
    const ledgerMs = this.appliedKeys.get(incident.key);
    if (ledgerMs !== undefined && nowMs - ledgerMs <= ttlMs) return true;
    if (incident.autoApply && within(incident.autoApply.decidedAt)) return true;
    if (!incident.recurrenceOf) return false;
    try {
      const prior = await this.tickets.getTicket(incident.recurrenceOf);
      const priorAudit = prior ? incidentOf(prior)?.autoApply : undefined;
      return !!priorAudit && within(priorAudit.decidedAt);
    } catch (err) {
      // Unreadable predecessor: fail SAFE for an outward-acting decision — do not apply.
      logger.error({ err, recurrenceOf: incident.recurrenceOf }, 'Could not read recurrence predecessor — refusing auto-apply (fail-safe)');
      return true;
    }
  }

  /**
   * @description Sliding-hour cap check (ADR-119 A2 bound 2), reservation shape mirroring
   * RcaBudgetGate: slots prune after one hour; the cap counts live slots.
   * @param nowMs - Evaluation time.
   * @returns True when the cap is exhausted.
   */
  private hourlyCapExhausted(nowMs: number): boolean {
    const cutoff = nowMs - 3_600_000;
    this.applySlots = this.applySlots.filter((s) => !s.released && s.atMs >= cutoff);
    return this.applySlots.length >= autoApplyHourlyCap();
  }

  /**
   * @description Writes the completed audit record + surfacing flags/labels and the
   * activity line onto the ticket (fresh read first — the dispatch snapshot may be stale
   * after refires). Best-effort on the activity line; the record write is the audit.
   * @param ticket - The incident ticket (id source).
   * @param audit - The completed audit record.
   * @param flags - flags[]/labels to surface.
   * @param activity - Human-readable history line.
   */
  private async persistAudit(ticket: InternalTicket, audit: IncidentAutoApplyAudit, flags: string[], activity: string): Promise<void> {
    await this.writeIncident(ticket, (incident) => {
      incident.autoApply = audit;
    }, flags, activity);
  }

  /**
   * @description Flags-only annotation for declined/parked decisions (visible, promotable,
   * never silent) — same write path as the audit, without an apply record.
   * @param ticket - The incident ticket.
   * @param flags - flags[]/labels to surface.
   * @param activity - Human-readable history line.
   */
  private async annotate(ticket: InternalTicket, flags: string[], activity: string): Promise<void> {
    await this.writeIncident(ticket, () => undefined, flags, activity);
  }

  /**
   * @description Shared incident-record writer: fresh-read the ticket, apply the mutation,
   * union the flags into incident.flags[] AND ticket labels, persist, then leave the
   * activity line. Failures log at ERROR and never throw — an audit-write failure must not
   * lose the pipeline's terminal status write.
   * @param ticket - The incident ticket (id source).
   * @param mutate - Mutation applied to the parsed incident record.
   * @param flags - flags[]/labels to union in.
   * @param activity - Human-readable history line.
   */
  private async writeIncident(
    ticket: InternalTicket,
    mutate: (incident: IncidentRecord) => void,
    flags: string[],
    activity: string,
  ): Promise<void> {
    try {
      const fresh = (await this.tickets.getTicket(ticket.ticketId)) ?? ticket;
      const incident = incidentOf(fresh);
      if (!incident) return;
      mutate(incident);
      for (const flag of flags) {
        if (!incident.flags.includes(flag)) incident.flags.push(flag);
      }
      const metadata: Record<string, unknown> = {
        ...((fresh.metadata as Record<string, unknown> | undefined) ?? {}),
        [ALERT_INCIDENT_KEY_FIELD]: incident.key,
        incident,
      };
      await this.tickets.updateTicket(fresh.ticketId, {
        metadata,
        labels: [...new Set([...(fresh.labels ?? []), ...flags])],
      });
      await this.tickets.recordActivity(fresh.ticketId, { source: 'self-heal-auto-apply', reason: activity });
    } catch (err) {
      logger.error({ err, ticketId: ticket.ticketId }, 'Failed to persist auto-apply audit/annotation on the ticket');
    }
  }
}

/**
 * @description Resolves the ONE container an A2 apply may act on — always from the
 * incident's own alert evidence (root candidate, then the ticket's target metadata, then
 * the genesis member), never from LLM output: the proposal chooses the CLASS, the observed
 * incident chooses the TARGET.
 * @param ticket - The incident ticket.
 * @param incident - Parsed incident record.
 * @returns The target container name, or null when unresolvable.
 */
export function resolveApplyTarget(ticket: InternalTicket, incident: IncidentRecord): string | null {
  const metaTarget = (ticket.metadata as Record<string, unknown> | undefined)?.target;
  const fromRoot = incident.rootCandidate?.target?.trim() ?? '';
  const fromMeta = typeof metaTarget === 'string' ? metaTarget.trim() : '';
  const fromMember = incident.members[0]?.target?.trim() ?? '';
  const target = fromRoot || fromMeta || fromMember;
  return target && target !== 'unknown-target' ? target : null;
}
