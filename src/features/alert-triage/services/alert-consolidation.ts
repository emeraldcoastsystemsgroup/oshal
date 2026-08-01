/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P1 (ADR-119) Stage C: identity-based consolidation. Exactly one open ticket per incident key (FR-C2 — per-key serialization in-process + the tickets table's (external_provider, external_id) unique claim in the DB, release-on-failure by folding the loser into the winner); a refire is a visible consolidation update — updateCount/lastSeen/member counts — never a silent skip (FR-C3); severity only escalates priority, never lowers it (FR-C4); a refire after the prior incident went terminal within the TTL opens a NEW ticket linked recurrenceOf (FR-C5); genesis fields are write-once (FR-C6). Consolidation updates never touch ticket status, so RCA structurally runs once per incident (FR-E1)
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
  ALERT_INCIDENT_KEY_FIELD,
  ALERT_MAX_INCIDENT_MEMBERS,
  TERMINAL_TICKET_STATES,
  consolidationTtlSeconds,
  isWithinConsolidationTtl,
} from './alert-triage-constants';
import { priorityRank, severityToPriority, type CanonicalAlert } from './canonical-alert';

const logger = createChildLogger({ module: 'alert-consolidation' });

/**
 * @description The minimal ticket surface consolidation needs, expressed structurally so
 * this feature slice never imports the ticketing slice (FSD: no same-layer cross-imports).
 * `TicketService` satisfies it as-is; the app layer wires the two together.
 */
export interface TriageTicketGateway {
  createTicket(input: CreateInternalTicketInput): Promise<InternalTicket>;
  updateTicket(ticketId: string, updates: Partial<Omit<InternalTicket, 'ticketId' | 'createdAt' | 'status'>>): Promise<void>;
  recordActivity(ticketId: string, metadata: TicketStatusMetadata): Promise<void>;
  findLatestTicketByMetadataKey(key: string, value: string): Promise<InternalTicket | null>;
}

/** @description One member of a consolidated incident (spec §5), recorded at attach time. */
export interface IncidentMember {
  fingerprint: string;
  alertname: string;
  target: string;
  severity: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  attachReason: string;
}

/** @description A recorded priority escalation (FR-C4 — "records the escalation"). */
export interface IncidentEscalation {
  at: string;
  fromPriority: TicketPriority;
  toPriority: TicketPriority;
  severity: string;
}

/**
 * @description The consolidated incident record riding `metadata.incident` (spec §5).
 * `firstSeen` is genesis and write-once (FR-C6); `updateCount` counts suppressed refires
 * (the source platform's `update_count`); `instanceSeq` numbers successive incidents on the
 * same key so each gets a distinct DB claim id; `claimNonce` proves creation-race outcomes.
 */
export interface IncidentRecord {
  key: string;
  firstSeen: string;
  lastSeen: string;
  updateCount: number;
  instanceSeq: number;
  severity: string;
  members: IncidentMember[];
  membersOverflow: number;
  escalations: IncidentEscalation[];
  flags: string[];
  claimNonce: string;
  recurrenceOf?: string;
  recurrenceCount?: number;
}

/** @description Ticket presentation fields the route resolves (title/body/intake policy). */
export interface AlertTicketShape {
  title: string;
  ticketType: TicketType;
  description: string;
  intakeStatus: 'approved' | 'backlog';
  externalUrl: string | null;
}

/** @description What consolidation did with one firing alert. */
export interface ConsolidationOutcome {
  decision: 'created' | 'consolidated';
  ticketId: string;
  updateCount: number;
}

/**
 * @description Reads the incident record off a ticket's metadata, tolerating partial/older
 * shapes (missing fields default rather than throw — a malformed record must not wedge the
 * intake). Returns null when no incident record exists at all.
 * @param ticket - The ticket to read.
 * @returns The incident record or null.
 */
export function incidentOf(ticket: InternalTicket): IncidentRecord | null {
  const raw = (ticket.metadata as Record<string, unknown> | undefined)?.incident;
  if (!raw || typeof raw !== 'object') return null;
  const inc = raw as Partial<IncidentRecord>;
  if (typeof inc.key !== 'string' || !inc.key) return null;
  return {
    key: inc.key,
    firstSeen: typeof inc.firstSeen === 'string' ? inc.firstSeen : ticket.createdAt,
    lastSeen: typeof inc.lastSeen === 'string' ? inc.lastSeen : ticket.createdAt,
    updateCount: typeof inc.updateCount === 'number' ? inc.updateCount : 0,
    instanceSeq: typeof inc.instanceSeq === 'number' ? inc.instanceSeq : 0,
    severity: typeof inc.severity === 'string' ? inc.severity : 'warning',
    members: Array.isArray(inc.members) ? (inc.members as IncidentMember[]) : [],
    membersOverflow: typeof inc.membersOverflow === 'number' ? inc.membersOverflow : 0,
    escalations: Array.isArray(inc.escalations) ? (inc.escalations as IncidentEscalation[]) : [],
    flags: Array.isArray(inc.flags) ? (inc.flags as string[]) : [],
    claimNonce: typeof inc.claimNonce === 'string' ? inc.claimNonce : '',
    ...(typeof inc.recurrenceOf === 'string' ? { recurrenceOf: inc.recurrenceOf } : {}),
    ...(typeof inc.recurrenceCount === 'number' ? { recurrenceCount: inc.recurrenceCount } : {}),
  };
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
 * @description Upserts the member entry for a refire's fingerprint (FR-C3: the member entry
 * records its own count) under the member cap (overflow counted, never silent — spec §9.5).
 * @param incident - The incident record (mutated).
 * @param alert - The canonical refire.
 * @param seenAt - When this refire fired.
 */
function upsertMember(incident: IncidentRecord, alert: CanonicalAlert, seenAt: string): void {
  const existing = incident.members.find((m) => m.fingerprint === alert.fingerprint);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = laterIso(existing.lastSeen, seenAt);
    if (priorityRank(severityToPriority(alert.severity)) > priorityRank(severityToPriority(existing.severity))) {
      existing.severity = alert.severity;
    }
    return;
  }
  if (incident.members.length >= ALERT_MAX_INCIDENT_MEMBERS) {
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
    attachReason: 'same-incident-key',
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
 * @description Stage C consolidator. One instance per intake route; all mutation of a given
 * incident key is serialized through `withKeyLock`, and the durable one-open-ticket-per-key
 * claim is the DB's (external_provider, external_id) unique index — the in-memory lock is
 * optimization, the DB is the restart-safe state (spec §9.7).
 */
export class AlertConsolidationService {
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * @param tickets - Ticket operations (structurally satisfied by TicketService).
   */
  constructor(private readonly tickets: TriageTicketGateway) {}

  /**
   * @description Consolidates one canonical FIRING alert: updates the open incident ticket
   * for its key, or creates a new one (recurrence-linked when the prior went terminal within
   * the TTL). Never touches ticket status — a refire on a dispatched ticket can never
   * re-dispatch analysis (FR-E1).
   * @param alert - Canonical firing alert.
   * @param shape - Ticket presentation fields from the route.
   * @returns What happened and to which ticket.
   */
  async intake(alert: CanonicalAlert, shape: AlertTicketShape): Promise<ConsolidationOutcome> {
    return this.withKeyLock(alert.incidentKey, () => this.intakeLocked(alert, shape));
  }

  /**
   * @description Serializes work per incident key with a promise chain so a concurrent burst
   * on one key becomes one create + N-1 updates (FR-C2) and counter increments never race.
   * @param key - Incident key.
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
   * @description The serialized intake decision: open ticket → consolidate; otherwise create
   * (recurrence-aware).
   * @param alert - Canonical firing alert.
   * @param shape - Ticket presentation fields.
   * @returns Consolidation outcome.
   */
  private async intakeLocked(alert: CanonicalAlert, shape: AlertTicketShape): Promise<ConsolidationOutcome> {
    const latest = await this.tickets.findLatestTicketByMetadataKey(ALERT_INCIDENT_KEY_FIELD, alert.incidentKey);
    if (latest && !TERMINAL_TICKET_STATES.has(latest.status)) {
      return this.consolidateInto(latest, alert);
    }
    return this.createIncidentTicket(alert, shape, latest);
  }

  /**
   * @description Creates the incident ticket for a key with no open incident. The DB claim id
   * is `<incidentKey>#<instanceSeq>` — if a concurrent creator won the unique-index race, the
   * store returns the winner instead of a new row and this alert folds into it as a
   * consolidation update (FR-C2 release-on-failure: no lost alert, no duplicate ticket).
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
    const incident = this.buildGenesisIncident(alert, nowIso, claimNonce, priorTerminal);
    const created = await this.tickets.createTicket({
      title: shape.title,
      ticketType: shape.ticketType,
      description: shape.description,
      externalProvider: 'prometheus',
      externalId: `${alert.incidentKey}#${incident.instanceSeq}`,
      externalUrl: shape.externalUrl,
      status: shape.intakeStatus,
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
        `intake:${shape.intakeStatus}`,
      ],
      metadata: {
        source: 'prometheus',
        alertFingerprint: alert.fingerprint,
        alertname: alert.alertname,
        severity: alert.severity,
        target: alert.target || 'unknown-target',
        intake: shape.intakeStatus,
        startsAt: alert.firedAt,
        rawLabels: alert.labels,
        [ALERT_INCIDENT_KEY_FIELD]: alert.incidentKey,
        incident,
      },
    });
    if (incidentOf(created)?.claimNonce !== claimNonce) {
      logger.info(
        { incidentKey: alert.incidentKey, winnerTicketId: created.ticketId },
        'Lost the incident-key creation race — folding alert into the winning ticket (FR-C2 release-on-failure)',
      );
      return this.consolidateInto(created, alert);
    }
    logger.info(
      { ticketId: created.ticketId, incidentKey: alert.incidentKey, recurrenceOf: incident.recurrenceOf ?? null },
      'Opened consolidated incident ticket',
    );
    return { decision: 'created', ticketId: created.ticketId, updateCount: 0 };
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
   * @returns The genesis incident record.
   */
  private buildGenesisIncident(
    alert: CanonicalAlert,
    nowIso: string,
    claimNonce: string,
    priorTerminal: InternalTicket | null,
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
    incident.updateCount += 1;
    incident.lastSeen = laterIso(incident.lastSeen, seenAt);
    upsertMember(incident, alert, seenAt);

    const refirePriority = severityToPriority(alert.severity);
    const escalate = priorityRank(refirePriority) > priorityRank(ticket.priority);
    if (escalate) {
      incident.severity = alert.severity;
      incident.escalations.push({ at: nowIso, fromPriority: ticket.priority, toPriority: refirePriority, severity: alert.severity });
    }

    const metadata: Record<string, unknown> = {
      ...((ticket.metadata as Record<string, unknown> | undefined) ?? {}),
      [ALERT_INCIDENT_KEY_FIELD]: incident.key,
      incident,
      ...(escalate ? { severity: alert.severity } : {}),
    };
    await this.tickets.updateTicket(
      ticket.ticketId,
      escalate ? { metadata, priority: refirePriority } : { metadata },
    );
    await this.recordRefireActivity(ticket.ticketId, alert, incident, escalate ? refirePriority : null);
    logger.info(
      { ticketId: ticket.ticketId, incidentKey: incident.key, updateCount: incident.updateCount, escalatedTo: escalate ? refirePriority : null },
      'Alert refire consolidated onto the open incident ticket',
    );
    return { decision: 'consolidated', ticketId: ticket.ticketId, updateCount: incident.updateCount };
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
   * @description Leaves the operator-visible refire trail on the ticket's activity history.
   * Best-effort: the consolidation update already persisted, so a history failure logs at
   * ERROR and does not fail the intake.
   * @param ticketId - Ticket identifier.
   * @param alert - The canonical refire.
   * @param incident - The updated incident record.
   * @param escalatedTo - New priority when this refire escalated, else null.
   */
  private async recordRefireActivity(
    ticketId: string,
    alert: CanonicalAlert,
    incident: IncidentRecord,
    escalatedTo: TicketPriority | null,
  ): Promise<void> {
    try {
      await this.tickets.recordActivity(ticketId, {
        source: 'prometheus',
        reason: `alert refire consolidated (×${incident.updateCount}${escalatedTo ? `, priority → ${escalatedTo}` : ''})`,
        severity: alert.severity,
        alertname: alert.alertname,
        fingerprint: alert.fingerprint,
        incidentKey: incident.key,
      });
    } catch (err) {
      logger.error({ err, ticketId, incidentKey: incident.key }, 'Failed to record refire activity on the incident ticket');
    }
  }
}
