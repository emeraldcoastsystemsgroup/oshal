/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119) Stage C: identity-based consolidation. Exactly one open ticket per incident key (FR-C2 — per-key serialization in-process + the tickets table's (external_provider, external_id) unique claim in the DB, release-on-failure by folding the loser into the winner); a refire is a visible consolidation update — updateCount/lastSeen/member counts — never a silent skip (FR-C3); severity only escalates priority, never lowers it (FR-C4); a refire after the prior incident went terminal within the TTL opens a NEW ticket linked recurrenceOf (FR-C5); genesis fields are write-once (FR-C6). Consolidation updates never touch ticket status, so RCA structurally runs once per incident (FR-E1)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): an arrival that did not consolidate now checks OPEN related incidents (AlertBundlingService — same-target FR-D2, dependency FR-D3) before creating, and ATTACHES instead: member recorded at attach time with its attachReason (FR-D5), rootCandidate recomputed by the ordered policy (FR-D4), severity escalation shared with the refire path (FR-C4 max-over-members). Attach NEVER touches ticket status — no promote, no re-dispatch (FR-D7); an auto-flow member attaching to a backlog bundle sets the needs-attention flag instead. The incident record types + incidentOf moved verbatim to incident-record.ts (import-cycle break); the intake serialization domain widened from per-key to the intake stage because Stage D correlates ACROSS keys — the DB's (external_provider, external_id) unique claim remains the durable restart-safe guarantee (spec §9.7). Member cap now reads the ALERT_MAX_MEMBERS knob (FR-D5)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 Stage E): the dispatch gates. FR-E2 — an auto-flow CREATE consults the RcaBudgetGate first: over budget it parks the ticket in backlog carrying the visible analysis-skipped:budget flag+label (an operator promote overrides; backlog-parked tickets never spend); allowed dispatches reserve the p95 estimate before the create and release it on create failure or a lost creation race. FR-E3 — every refire feeds flap damping: crossing the threshold trips `flapping` and demotes a not-yet-dispatched approved ticket to backlog (in-flight tickets only get the flag — "if RCA has not yet run"); a refire after the quiet period ends the episode and restores ONLY a flap-parked ticket to approved (budget-gated again — restoring is a dispatch). FR-E4 — intakeResolved marks the member resolvedAt (a refire clears it via upsertMember), and ONLY with ALERT_AUTO_RESOLVE=true a fully-resolved still-backlog ticket completes as self-resolved; approved-or-beyond tickets never auto-close. Genesis stamps the claiming rule's rootFilter (Stage B) so FR-D4's step 1 has real per-rule declarations
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | createIncidentTicket now stamps ownerSub: ALERT_INTAKE_OWNER_SUB. The alert path is a machine caller with no user identity, so the owner-RLS WITH CHECK refused every INSERT and the ladder could not open a single ticket on a live box; a NULL owner_sub fails the predicate even once the connection is identity-stamped, so both halves ship together (the route stamps the same constant on the connection).
 */

import { randomUUID } from 'crypto';
import type {
  CreateInternalTicketInput,
  InternalTicket,
  TicketPriority,
  TicketStatusMetadata,
  TicketType,
} from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import {
  ALERT_BUNDLE_CANDIDATE_LIMIT,
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_INTAKE_OWNER_SUB,
  TERMINAL_TICKET_STATES,
  autoResolveEnabled,
  consolidationTtlSeconds,
  isWithinConsolidationTtl,
  maxIncidentMembers,
} from './alert-triage-constants';
import { priorityRank, severityToPriority, type CanonicalAlert } from './canonical-alert';
import { AlertBundlingService, type BundleTarget } from './alert-bundling';
import { observeRefireForFlap, type FlapVerdict } from './flap-damping';
import {
  allMembersResolved,
  incidentOf,
  markMemberResolved,
  type IncidentMember,
  type IncidentRecord,
} from './incident-record';
import { BUDGET_PARK_FLAG, RcaBudgetGate, type RcaReservation } from './rca-budget-gate';

const logger = createChildLogger({ module: 'alert-consolidation' });

/** @description The `flags[]` / label value FR-E4 stamps on an auto-closed ticket (spec §5). */
const SELF_RESOLVED_FLAG = 'self-resolved';

/** @description Ticket-status side effect a refire's flap verdict may demand (FR-E3). */
type FlapStatusAction = 'demote' | 'restore' | null;

/**
 * @description The minimal ticket surface consolidation needs, expressed structurally so
 * this feature slice never imports the ticketing slice (FSD: no same-layer cross-imports).
 * `TicketService` satisfies it as-is; the app layer wires the two together.
 */
export interface TriageTicketGateway {
  createTicket(input: CreateInternalTicketInput): Promise<InternalTicket>;
  updateTicket(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt' | 'status'>>): Promise<void>;
  updateStatus(ticketId: string, status: InternalTicket['status'], metadata?: TicketStatusMetadata): Promise<void>;
  recordActivity(ticketId: string, metadata: TicketStatusMetadata): Promise<void>;
  findLatestTicketByMetadataKey(key: string, value: string): Promise<InternalTicket | null>;
  listTickets(options?: { ticketType?: TicketType; limit?: number }): Promise<InternalTicket[]>;
}

/** @description Ticket presentation fields the route resolves (title/body/intake policy). */
export interface AlertTicketShape {
  title: string;
  ticketType: TicketType;
  description: string;
  intakeStatus: 'approved' | 'backlog';
  externalUrl: string | null;
  /** The claiming rule's ordered FR-D4 root filter (P3 Stage B), stamped at genesis. */
  rootFilter?: readonly string[];
}

/** @description What consolidation did with one firing alert. */
export interface ConsolidationOutcome {
  decision: 'created' | 'consolidated' | 'bundled';
  ticketId: string;
  updateCount: number;
  /** True when FR-E2 parked an intended auto-flow create in backlog (visible, promotable). */
  budgetParked?: boolean;
}

/**
 * @description Later of two ISO timestamps; an unparseable candidate never wins, an
 * unparseable current value is replaced.
 * @param current - Current ISO timestamp.
 * @param candidate - Candidate ISO timestamp.
 * @returns The later timestamp.
 */
function laterIso(current: string, candidate: string): string {
  const currentMs = Date.parse(current);
  const candidateMs = Date.parse(candidate);
  if (!Number.isFinite(candidateMs)) return current;
  if (!Number.isFinite(currentMs)) return candidate;
  return candidateMs > currentMs ? candidate : current;
}

/**
 * @description Upserts the member entry for an alert's fingerprint (FR-C3/FR-D5: the member
 * entry records its own count; membership is recorded at attach time) under the member cap
 * (overflow counted, never silent — spec §9.5).
 * @param incident - The incident record (mutated).
 * @param alert - The canonical alert.
 * @param seenAt - When this alert fired.
 * @param attachReason - Reason recorded on a NEWLY attached member (FR-D5). Existing
 *   members keep their original reason.
 */
function upsertMember(incident: IncidentRecord, alert: CanonicalAlert, seenAt: string, attachReason = 'same-incident-key'): void {
  const existing = incident.members.find((m) => m.fingerprint === alert.fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = laterIso(existing.lastSeen, seenAt);
    // A firing member is not resolved anymore (FR-E4): a refire clears the resolution so a
    // later full-resolution check never counts a re-burning member as resolved.
    delete existing.resolvedAt;
    if (priorityRank(severityToPriority(alert.severity)) > priorityRank(severityToPriority(existing.severity))) {
      existing.severity = alert.severity;
    }
    return;
  }
  if (incident.members.length >= maxIncidentMembers()) {
    incident.membersOverflow += 1;
    return;
  }
  incident.members.push({
    fingerprint: alert.fingerprint,
    alertname: alert.alertname,
    target: alert.target,
    severity: alert.severity,
    firstSeen: seenAt,
    lastSeen: seenAt,
    count: 1,
    attachReason,
  });
}

/**
 * @description Builds the genesis member for a brand-new incident ticket.
 * @param alert - The canonical alert opening the incident.
 * @param firstSeen - Genesis timestamp.
 * @returns The genesis member entry.
 */
function genesisMember(alert: CanonicalAlert, firstSeen: string): IncidentMember {
  return {
    fingerprint: alert.fingerprint,
    alertname: alert.alertname,
    target: alert.target,
    severity: alert.severity,
    firstSeen,
    lastSeen: firstSeen,
    count: 1,
    attachReason: 'genesis',
  };
}

/**
 * @description Applies the severity-only-escalates rule (FR-C4) to an incident: when the
 * arriving alert outranks the ticket's priority, the incident's severity advances and the
 * escalation is recorded. Shared by the refire and attach paths so both rank identically.
 * @param incident - The incident record (mutated on escalation).
 * @param ticket - The ticket carrying the current priority.
 * @param alert - The arriving canonical alert.
 * @param nowIso - Timestamp for the escalation entry.
 * @returns The new (higher) priority when escalating, else null.
 */
function escalateSeverity(incident: IncidentRecord, ticket: InternalTicket, alert: CanonicalAlert, nowIso: string): TicketPriority | null {
  const alertPriority = severityToPriority(alert.severity);
  if (priorityRank(alertPriority) <= priorityRank(ticket.priority)) return null;
  incident.severity = alert.severity;
  incident.escalations.push({ at: nowIso, fromPriority: ticket.priority, toPriority: alertPriority, severity: alert.severity });
  return alertPriority;
}

/**
 * @description Stage C consolidator + Stage D bundler. One instance per intake route; all
 * intake mutation is serialized through one in-process lock domain (Stage D correlates
 * across incident keys, so per-key serialization is not enough), and the durable
 * one-open-ticket-per-key claim is the DB's (external_provider, external_id) unique index —
 * the in-memory lock is optimization, the DB is the restart-safe state (spec §9.7).
 */
export class AlertConsolidationService {
  private readonly locks = new Map<string, Promise<unknown>>();

  /** @description The single serialization domain for intake work (see class doc). */
  private static readonly INTAKE_LOCK_DOMAIN = 'alert-intake';

  /**
   * @param tickets - Ticket operations (structurally satisfied by TicketService).
   * @param bundling - Stage D correlation logic (FR-D1/D2/D3/D4). Default wires the static
   *   compose-topology dependency map; an ADR-045 graph-backed resolver can be injected.
   * @param budget - FR-E2 analyst cost guard. The default (no spend reader) is an explicit
   *   pass-through; the app layer wires the cost-ledger reader.
   */
  constructor(
    private readonly tickets: TriageTicketGateway,
    private readonly bundling: AlertBundlingService = new AlertBundlingService(),
    private readonly budget: RcaBudgetGate = new RcaBudgetGate(),
  ) {}

  /**
   * @description Intakes one canonical FIRING alert: updates the open incident ticket for
   * its key (Stage C), attaches to an open RELATED incident (Stage D), or creates a new
   * ticket (recurrence-linked when the prior went terminal within the TTL), gated by the
   * Stage E dispatch gates (FR-E2 budget park, FR-E3 flap damping). A refire or attach can
   * never RE-dispatch analysis (FR-E1/FR-D7): the only status writes this path ever makes
   * are the FR-E3 demote/restore of a not-yet-dispatched ticket — deferring or un-deferring
   * a dispatch that has not happened, never re-running one.
   * @param alert - Canonical firing alert.
   * @param shape - Ticket presentation fields from the route.
   * @returns What happened and to which ticket.
   */
  async intake(alert: CanonicalAlert, shape: AlertTicketShape): Promise<ConsolidationOutcome> {
    return this.withKeyLock(AlertConsolidationService.INTAKE_LOCK_DOMAIN, () => this.intakeLocked(alert, shape));
  }

  /**
   * @description Serializes work per lock key with a promise chain so a concurrent burst
   * becomes one create + N-1 updates (FR-C2) and counter increments never race.
   * @param key - Lock key (the intake domain).
   * @param fn - The work to run under the lock.
   * @returns The work's result.
   */
  private async withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /**
   * @description The serialized intake decision ladder: open same-key ticket → consolidate
   * (Stage C); open related incident inside the correlation window → attach (Stage D);
   * otherwise create (recurrence-aware).
   * @param alert - Canonical firing alert.
   * @param shape - Ticket presentation fields.
   * @returns Consolidation outcome.
   */
  private async intakeLocked(alert: CanonicalAlert, shape: AlertTicketShape): Promise<ConsolidationOutcome> {
    const latest = await this.tickets.findLatestTicketByMetadataKey(ALERT_INCIDENT_KEY_FIELD, alert.incidentKey);
    if (latest && !TERMINAL_TICKET_STATES.has(latest.status)) {
      return this.consolidateInto(latest, alert);
    }
    const bundle = await this.findBundleTarget(alert, shape);
    if (bundle) {
      return this.attachToBundle(bundle, alert, shape);
    }
    return this.createIncidentTicket(alert, shape, latest);
  }

  /**
   * @description Stage D candidate lookup (FR-D1): lists recent tickets of the alert
   * queue's type (newest-first, bounded) and asks the bundling service whether any OPEN
   * incident with activity inside the correlation window correlates with this alert.
   * @param alert - Canonical firing alert.
   * @param shape - Ticket presentation fields (carries the queue's ticketType).
   * @returns The bundle target, or null when nothing correlates.
   */
  private async findBundleTarget(alert: CanonicalAlert, shape: AlertTicketShape): Promise<BundleTarget | null> {
    const candidates = await this.tickets.listTickets({ ticketType: shape.ticketType, limit: ALERT_BUNDLE_CANDIDATE_LIMIT });
    return this.bundling.findBundleTarget(candidates, alert, Date.now());
  }

  /**
   * @description Stage D attach (FR-D5/FR-D7): records the arriving alert as a member of
   * the open related incident at attach time — never reconstructed later — with its
   * attachReason, recomputes the root candidate (FR-D4), and applies escalate-only severity
   * (FR-C4). NEVER touches ticket status: attach to backlog stays backlog, attach to an
   * in-flight ticket never re-dispatches RCA; an auto-flow member arriving on a backlog
   * bundle sets the needs-attention flag for the operator instead (FR-D7).
   * @param bundle - The open incident to attach to, with the attach reason.
   * @param alert - The canonical arriving alert.
   * @param shape - Ticket presentation fields (carries the member's own intake policy).
   * @returns Consolidation outcome ('bundled' for a new member, 'consolidated' for a
   *   refire of an already-bundled member).
   */
  private async attachToBundle(bundle: BundleTarget, alert: CanonicalAlert, shape: AlertTicketShape): Promise<ConsolidationOutcome> {
    const { ticket, attachReason } = bundle;
    const nowIso = new Date().toISOString();
    const seenAt = alert.firedAt ?? nowIso;
    const incident = incidentOf(ticket) ?? this.migratedIncident(ticket, alert);
    const isRefire = incident.members.some((m) => m.fingerprint === alert.fingerprint);
    // FR-E3: only a REFIRE is flap evidence; a first-time attach is new information, not
    // flapping. Observed before lastSeen advances (the quiet check needs the prior value).
    const flap = isRefire ? observeRefireForFlap(incident, seenAt) : null;
    incident.lastSeen = laterIso(incident.lastSeen, seenAt);
    if (isRefire) incident.updateCount += 1;
    upsertMember(incident, alert, seenAt, attachReason);
    if (!isRefire) {
      incident.rootCandidate = await this.bundling.chooseRootCandidate(incident.members, incident.rootFilter ?? []);
      if (shape.intakeStatus === 'approved' && ticket.status === 'backlog' && !incident.flags.includes('needs-attention')) {
        incident.flags.push('needs-attention');
      }
    }
    const escalatedTo = escalateSeverity(incident, ticket, alert, nowIso);
    const statusAction = flap ? await this.resolveFlapStatusAction(ticket, incident, flap) : null;
    await this.persistIncident(ticket, incident, alert, escalatedTo);
    await this.applyFlapStatusAction(ticket, statusAction);
    const reason = isRefire
      ? `alert refire consolidated (×${incident.updateCount}${escalatedTo ? `, priority → ${escalatedTo}` : ''})`
      : `alert bundled onto related incident (${attachReason}; root candidate: ${incident.rootCandidate?.target ?? 'n/a'})`;
    await this.recordIncidentActivity(ticket.ticketId, alert, incident, reason);
    logger.info(
      { ticketId: ticket.ticketId, incidentKey: incident.key, attachReason, isRefire, rootCandidate: incident.rootCandidate ?? null },
      isRefire ? 'Bundled member refire consolidated onto the incident ticket' : 'Alert bundled onto open related incident (Stage D)',
    );
    return { decision: isRefire ? 'consolidated' : 'bundled', ticketId: ticket.ticketId, updateCount: incident.updateCount };
  }

  /**
   * @description Creates the incident ticket for a key with no open incident, running the
   * FR-E2 budget gate first when the intake policy wants auto-flow: over budget the ticket
   * is created PARKED in backlog carrying the visible `analysis-skipped:budget` flag+label
   * (an operator promote overrides — the gate never runs on promotes); within budget the
   * p95 estimate is reserved BEFORE the create and released again on create failure or a
   * lost creation race, so a retry can proceed and the winner's own reservation is the only
   * one standing. The DB claim id is `<incidentKey>#<instanceSeq>` — if a concurrent
   * creator won the unique-index race, the store returns the winner instead of a new row
   * and this alert folds into it as a consolidation update (FR-C2 release-on-failure).
   * @param alert - Canonical firing alert.
   * @param shape - Ticket presentation fields.
   * @param priorTerminal - Newest terminal ticket on this key, if any (recurrence candidate).
   * @returns Consolidation outcome.
   */
  private async createIncidentTicket(
    alert: CanonicalAlert,
    shape: AlertTicketShape,
    priorTerminal: InternalTicket | null,
  ): Promise<ConsolidationOutcome> {
    const nowIso = new Date().toISOString();
    const claimNonce = randomUUID();
    let intakeStatus = shape.intakeStatus;
    let budgetParked = false;
    let reservation: RcaReservation | null = null;
    if (intakeStatus === 'approved') {
      const verdict = await this.budget.evaluate(shape.ticketType);
      if (verdict.park) {
        intakeStatus = 'backlog';
        budgetParked = true;
      } else {
        reservation = this.budget.reserve(verdict.estimateUsd);
      }
    }
    const incident = this.buildGenesisIncident(alert, nowIso, claimNonce, priorTerminal, shape.rootFilter);
    if (budgetParked) incident.flags.push(BUDGET_PARK_FLAG);
    let created: InternalTicket;
    try {
      created = await this.tickets.createTicket({
        title: shape.title,
        ticketType: shape.ticketType,
        description: shape.description,
        externalProvider: 'prometheus',
        externalId: `${alert.incidentKey}#${incident.instanceSeq}`,
        externalUrl: shape.externalUrl,
        status: intakeStatus,
        // The machine owner (see ALERT_INTAKE_OWNER_SUB). Without it the owner-RLS WITH
        // CHECK refuses the row even when the connection is correctly identity-stamped:
        // the predicate is `owner_sub = current_setting('oshal.current_sub')`, and a NULL
        // owner_sub never equals the stamped sub. The route stamps the SAME constant on the
        // connection, so the two halves are one source of truth.
        ownerSub: ALERT_INTAKE_OWNER_SUB,
        workspaceId: null,
        assignedAgentId: null,
        parentTicketId: null,
        priority: severityToPriority(alert.severity),
        labels: [
          'prometheus',
          'incident',
          'self-healing',
          'rca-requested',
          `severity:${alert.severity}`,
          `target:${alert.target || 'unknown-target'}`,
          `intake:${intakeStatus}`,
          ...(budgetParked ? [BUDGET_PARK_FLAG] : []),
        ],
        metadata: {
          source: 'prometheus',
          alertFingerprint: alert.fingerprint,
          alertname: alert.alertname,
          severity: alert.severity,
          target: alert.target || 'unknown-target',
          intake: intakeStatus,
          startsAt: alert.firedAt,
          rawLabels: alert.labels,
          [ALERT_INCIDENT_KEY_FIELD]: alert.incidentKey,
          incident,
        },
      });
    } catch (err) {
      reservation?.release();
      logger.error({ err, incidentKey: alert.incidentKey }, 'Incident ticket create failed — budget reservation released so a retry can proceed');
      throw err;
    }
    if (incidentOf(created)?.claimNonce !== claimNonce) {
      reservation?.release();
      logger.info(
        { incidentKey: alert.incidentKey, winnerTicketId: created.ticketId },
        'Lost the incident-key creation race — folding alert into the winning ticket (FR-C2 release-on-failure)',
      );
      return this.consolidateInto(created, alert);
    }
    logger.info(
      { ticketId: created.ticketId, incidentKey: alert.incidentKey, recurrenceOf: incident.recurrenceOf ?? null, budgetParked },
      budgetParked
        ? 'Opened consolidated incident ticket PARKED by the RCA budget gate (FR-E2 — promote to dispatch)'
        : 'Opened consolidated incident ticket',
    );
    return { decision: 'created', ticketId: created.ticketId, updateCount: 0, ...(budgetParked ? { budgetParked: true } : {}) };
  }

  /**
   * @description Builds the genesis incident record (FR-C6: genesis fields written once,
   * here and never again). Recurrence: when the newest prior ticket on this key went terminal
   * inside ALERT_CONSOLIDATION_TTL, the new incident links it via recurrenceOf and increments
   * the recurrence count (FR-C5 — recurrence is signal, not a fresh mystery).
   * @param alert - Canonical firing alert.
   * @param nowIso - Creation timestamp.
   * @param claimNonce - Nonce proving this process authored the stored record.
   * @param priorTerminal - Newest terminal ticket on this key, if any.
   * @param rootFilter - The claiming rule's ordered FR-D4 root filter (P3 Stage B) — stamped
   *   at genesis so the incident's root-candidate policy is stable across attaches.
   * @returns The genesis incident record.
   */
  private buildGenesisIncident(
    alert: CanonicalAlert,
    nowIso: string,
    claimNonce: string,
    priorTerminal: InternalTicket | null,
    rootFilter?: readonly string[],
  ): IncidentRecord {
    const firstSeen = alert.firedAt ?? nowIso;
    const priorIncident = priorTerminal ? incidentOf(priorTerminal) : null;
    const incident: IncidentRecord = {
      key: alert.incidentKey,
      firstSeen,
      lastSeen: firstSeen,
      updateCount: 0,
      instanceSeq: priorTerminal ? (priorIncident?.instanceSeq ?? 0) + 1 : 0,
      severity: alert.severity,
      members: [genesisMember(alert, firstSeen)],
      membersOverflow: 0,
      escalations: [],
      flags: [],
      claimNonce,
      ...(rootFilter && rootFilter.length > 0 ? { rootFilter: [...rootFilter] } : {}),
    };
    if (priorTerminal && isWithinConsolidationTtl(priorTerminal.updatedAt, Date.now(), consolidationTtlSeconds())) {
      incident.recurrenceOf = priorTerminal.ticketId;
      incident.recurrenceCount = (priorIncident?.recurrenceCount ?? 0) + 1;
    }
    return incident;
  }

  /**
   * @description Applies a refire to the open incident ticket (FR-C3): updateCount and the
   * member's own count increment, lastSeen advances, and a strictly-higher severity raises
   * priority with the escalation recorded (FR-C4 — never lowered). Genesis fields untouched
   * (FR-C6); status untouched (FR-E1). This REPLACES the pre-P1 silent `skipped++`.
   * @param ticket - The open incident ticket.
   * @param alert - The canonical refire.
   * @returns Consolidation outcome with the new updateCount.
   */
  private async consolidateInto(ticket: InternalTicket, alert: CanonicalAlert): Promise<ConsolidationOutcome> {
    const nowIso = new Date().toISOString();
    const seenAt = alert.firedAt ?? nowIso;
    const incident = incidentOf(ticket) ?? this.migratedIncident(ticket, alert);
    // FR-E3: observe the refire BEFORE lastSeen advances (the quiet check needs the gap).
    const flap = observeRefireForFlap(incident, seenAt);
    incident.updateCount += 1;
    incident.lastSeen = laterIso(incident.lastSeen, seenAt);
    upsertMember(incident, alert, seenAt);

    const escalatedTo = escalateSeverity(incident, ticket, alert, nowIso);
    const statusAction = await this.resolveFlapStatusAction(ticket, incident, flap);
    await this.persistIncident(ticket, incident, alert, escalatedTo);
    await this.applyFlapStatusAction(ticket, statusAction);
    await this.recordIncidentActivity(
      ticket.ticketId,
      alert,
      incident,
      `alert refire consolidated (×${incident.updateCount}${escalatedTo ? `, priority → ${escalatedTo}` : ''})`,
    );
    logger.info(
      { ticketId: ticket.ticketId, incidentKey: incident.key, updateCount: incident.updateCount, escalatedTo },
      'Alert refire consolidated onto the open incident ticket',
    );
    return { decision: 'consolidated', ticketId: ticket.ticketId, updateCount: incident.updateCount };
  }

  /**
   * @description FR-E3 status policy for one refire's flap verdict. Demote ONLY on the
   * trip transition of a still-`approved` (not-yet-dispatched) ticket — an in-flight
   * ticket only carries the flag ("if RCA has not yet run"), and continued flapping never
   * re-demotes, so an operator promote mid-episode sticks. Restore ONLY a ticket the flap
   * gate itself parked (`flap.parked` provenance) that is still in backlog when the quiet
   * period ends — and restoring is a dispatch, so the FR-E2 budget gate runs again: over
   * budget the ticket stays parked, now carrying the visible budget flag instead.
   * @param ticket - The incident ticket (pre-update snapshot).
   * @param incident - The incident record (mutated: park provenance, budget flag).
   * @param flap - The refire's flap verdict.
   * @returns The status action to apply after the record persists.
   */
  private async resolveFlapStatusAction(
    ticket: InternalTicket,
    incident: IncidentRecord,
    flap: FlapVerdict,
  ): Promise<FlapStatusAction> {
    if (flap.becameQuiet && incident.flap?.parked) {
      incident.flap.parked = false;
      if (ticket.status !== 'backlog') return null; // an operator already moved it — theirs to run
      const verdict = await this.budget.evaluate(ticket.ticketType);
      if (verdict.park) {
        if (!incident.flags.includes(BUDGET_PARK_FLAG)) incident.flags.push(BUDGET_PARK_FLAG);
        logger.warn(
          { ticketId: ticket.ticketId, incidentKey: incident.key },
          'Flap episode ended but the RCA budget is exhausted — ticket stays parked, now visibly budget-parked (FR-E3→FR-E2)',
        );
        return null;
      }
      this.budget.reserve(verdict.estimateUsd);
      return 'restore';
    }
    if (flap.tripped && ticket.status === 'approved') {
      incident.flap = { ...(incident.flap ?? { recent: [] }), parked: true };
      return 'demote';
    }
    return null;
  }

  /**
   * @description Applies a flap status action (FR-E3). Best-effort AFTER the incident
   * record persisted: a dispatch race (the queue manager grabbing the ticket between our
   * read and this write) makes the transition invalid — logged at ERROR, never fatal, and
   * the flag on the record still tells the truth.
   * @param ticket - The incident ticket.
   * @param action - demote | restore | null.
   */
  private async applyFlapStatusAction(ticket: InternalTicket, action: FlapStatusAction): Promise<void> {
    if (!action) return;
    const [status, reason] =
      action === 'demote'
        ? (['backlog', 'flap damping — dispatch deferred until quiet or an operator promote (FR-E3)'] as const)
        : (['approved', 'flap episode ended after the quiet period — auto-flow restored (FR-E3)'] as const);
    try {
      await this.tickets.updateStatus(ticket.ticketId, status, { source: 'prometheus', reason });
      logger.info({ ticketId: ticket.ticketId, action, status }, 'Flap damping adjusted ticket status (FR-E3)');
    } catch (err) {
      logger.error({ err, ticketId: ticket.ticketId, action }, 'Flap damping status change failed (likely a dispatch race) — flag state stands, status untouched');
    }
  }

  /**
   * @description FR-E4 resolved handling: marks the matching member resolved on the open
   * incident that holds it (found by incident key first, then by fingerprint across open
   * bundles — a member may ride a related incident under another key). Auto-close happens
   * ONLY when ALERT_AUTO_RESOLVE is enabled AND the ticket is still `backlog` AND every
   * recorded member is resolved with none overflowed — the ticket completes carrying
   * `self-resolved`. A ticket at `approved` or beyond never auto-closes: if the analyst is
   * already engaged, a human decides. No open incident holding the member = a counted
   * no-op (the route already recorded the FR-A3 `resolved` decision).
   * @param alert - The canonical resolved alert.
   * @param ticketType - The alert queue's ticket type (bounds the bundle scan).
   */
  async intakeResolved(alert: CanonicalAlert, ticketType: TicketType): Promise<void> {
    return this.withKeyLock(AlertConsolidationService.INTAKE_LOCK_DOMAIN, () => this.intakeResolvedLocked(alert, ticketType));
  }

  /**
   * @description The serialized FR-E4 path (see intakeResolved).
   * @param alert - The canonical resolved alert.
   * @param ticketType - The alert queue's ticket type.
   */
  private async intakeResolvedLocked(alert: CanonicalAlert, ticketType: TicketType): Promise<void> {
    const nowIso = new Date().toISOString();
    const resolvedAt = alert.resolvedAt ?? nowIso;
    const located = await this.findOpenIncidentHoldingMember(alert, ticketType);
    if (!located) {
      logger.info({ fingerprint: alert.fingerprint, incidentKey: alert.incidentKey }, 'Resolved alert matches no open incident member — nothing to mark (FR-E4)');
      return;
    }
    const { ticket, incident } = located;
    markMemberResolved(incident, alert.fingerprint, resolvedAt);
    incident.lastSeen = laterIso(incident.lastSeen, resolvedAt);
    const closing = autoResolveEnabled() && ticket.status === 'backlog' && allMembersResolved(incident);
    if (closing && !incident.flags.includes(SELF_RESOLVED_FLAG)) incident.flags.push(SELF_RESOLVED_FLAG);
    const metadata: Record<string, unknown> = {
      ...((ticket.metadata as Record<string, unknown> | undefined) ?? {}),
      [ALERT_INCIDENT_KEY_FIELD]: incident.key,
      incident,
    };
    await this.tickets.updateTicket(
      ticket.ticketId,
      closing
        ? { metadata, labels: [...new Set([...(ticket.labels ?? []), SELF_RESOLVED_FLAG])] }
        : { metadata },
    );
    if (closing) {
      await this.tickets.updateStatus(ticket.ticketId, 'complete', {
        source: 'prometheus',
        reason: 'every member resolved while still in backlog — self-resolved auto-close (FR-E4, ALERT_AUTO_RESOLVE)',
      });
    }
    await this.recordIncidentActivity(
      ticket.ticketId,
      alert,
      incident,
      closing
        ? 'alert resolved — every member resolved; backlog ticket self-resolved (FR-E4)'
        : `alert resolved — member marked resolved (${alert.fingerprint})`,
    );
    logger.info(
      { ticketId: ticket.ticketId, incidentKey: incident.key, fingerprint: alert.fingerprint, closed: closing },
      closing ? 'Backlog incident self-resolved — all members resolved (FR-E4)' : 'Incident member marked resolved (FR-E4)',
    );
  }

  /**
   * @description Locates the open incident holding this alert as a member: the incident-key
   * ticket first (the common case), then a bounded scan of open tickets for the fingerprint
   * (a bundled member rides a ticket keyed by ANOTHER alert's incident key).
   * @param alert - The canonical resolved alert.
   * @param ticketType - The alert queue's ticket type.
   * @returns The holding ticket + parsed incident, or null.
   */
  private async findOpenIncidentHoldingMember(
    alert: CanonicalAlert,
    ticketType: TicketType,
  ): Promise<{ ticket: InternalTicket; incident: IncidentRecord } | null> {
    const holds = (ticket: InternalTicket): { ticket: InternalTicket; incident: IncidentRecord } | null => {
      if (TERMINAL_TICKET_STATES.has(ticket.status)) return null;
      const incident = incidentOf(ticket);
      return incident?.members.some((m) => m.fingerprint === alert.fingerprint) ? { ticket, incident } : null;
    };
    const latest = await this.tickets.findLatestTicketByMetadataKey(ALERT_INCIDENT_KEY_FIELD, alert.incidentKey);
    if (latest) {
      const hit = holds(latest);
      if (hit) return hit;
    }
    const candidates = await this.tickets.listTickets({ ticketType, limit: ALERT_BUNDLE_CANDIDATE_LIMIT });
    for (const candidate of candidates) {
      const hit = holds(candidate);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * @description Persists an updated incident record onto its ticket's metadata (and the
   * escalated priority when FR-C4 fired). Never touches ticket status (FR-E1/FR-D7).
   * @param ticket - The incident ticket.
   * @param incident - The updated incident record.
   * @param alert - The arriving alert (its severity is surfaced on escalation).
   * @param escalatedTo - New priority when escalating, else null.
   */
  private async persistIncident(
    ticket: InternalTicket,
    incident: IncidentRecord,
    alert: CanonicalAlert,
    escalatedTo: TicketPriority | null,
  ): Promise<void> {
    const metadata: Record<string, unknown> = {
      ...((ticket.metadata as Record<string, unknown> | undefined) ?? {}),
      [ALERT_INCIDENT_KEY_FIELD]: incident.key,
      incident,
      ...(escalatedTo ? { severity: alert.severity } : {}),
    };
    await this.tickets.updateTicket(
      ticket.ticketId,
      escalatedTo ? { metadata, priority: escalatedTo } : { metadata },
    );
  }

  /**
   * @description Synthesizes an incident record for a pre-P1 alert ticket that predates
   * `metadata.incident` (defensive — the consolidation lookup only matches tickets carrying
   * the incident key, but the race-loser fold-in path must never crash on a partial record).
   * @param ticket - The legacy ticket.
   * @param alert - The refire that reached it.
   * @returns A genesis-shaped incident record derived from the ticket's own fields.
   */
  private migratedIncident(ticket: InternalTicket, alert: CanonicalAlert): IncidentRecord {
    const meta = (ticket.metadata as Record<string, unknown> | undefined) ?? {};
    const genesis: CanonicalAlert = {
      ...alert,
      fingerprint: typeof meta.alertFingerprint === 'string' ? meta.alertFingerprint : alert.fingerprint,
      severity: typeof meta.severity === 'string' ? meta.severity : alert.severity,
    };
    return {
      key: alert.incidentKey,
      firstSeen: ticket.createdAt,
      lastSeen: ticket.createdAt,
      updateCount: 0,
      instanceSeq: 0,
      severity: genesis.severity,
      members: [{ ...genesisMember(genesis, ticket.createdAt), attachReason: 'genesis-migrated' }],
      membersOverflow: 0,
      escalations: [],
      flags: [],
      claimNonce: '',
    };
  }

  /**
   * @description Leaves the operator-visible activity trail on the ticket's history.
   * Best-effort: the incident update already persisted, so a history failure logs at
   * ERROR and does not fail the intake.
   * @param ticketId - Ticket identifier.
   * @param alert - The canonical alert.
   * @param incident - The updated incident record.
   * @param reason - Human-readable activity line (refire vs attach).
   */
  private async recordIncidentActivity(
    ticketId: string,
    alert: CanonicalAlert,
    incident: IncidentRecord,
    reason: string,
  ): Promise<void> {
    try {
      await this.tickets.recordActivity(ticketId, {
        source: 'prometheus',
        reason,
        severity: alert.severity,
        alertname: alert.alertname,
        fingerprint: alert.fingerprint,
        incidentKey: incident.key,
      });
    } catch (err) {
      logger.error({ err, ticketId, incidentKey: incident.key }, 'Failed to record incident activity on the ticket');
    }
  }
}
