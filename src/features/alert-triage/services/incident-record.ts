/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): the consolidated-incident record shape + tolerant reader, extracted verbatim from alert-consolidation.ts so the new bundling stage can read incident records off candidate tickets without an alert-consolidation <-> alert-bundling import cycle. P2 additions to the record itself: rootCandidate {target, reason} (FR-D4 — the ordered-policy winner and why it won) carried through the tolerant read
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (Stage B + E): members fill the spec §5 resolvedAt? slot (FR-E4 — a resolved event marks the member, a refire clears it); the record gains rootFilter (the claiming rule's ordered FR-D4 root filter, stamped at genesis so the incident's policy is stable) and flap (FR-E3 rolling refire observations + the parked provenance marker). markMemberResolved/allMembersResolved are the pure FR-E4 helpers — full resolution is UNPROVABLE while membersOverflow > 0, so auto-close conservatively refuses then
 */

import type { InternalTicket, TicketPriority } from '@/entities/ticket';

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
  /** Set by a resolved Alertmanager event (FR-E4); cleared again when the member refires. */
  resolvedAt?: string;
}

/**
 * @description FR-E3 flap-damping state riding the incident record: `recent` holds the
 * newest refire observation timestamps (pruned to the flap window, capped at the flap
 * threshold — enough to prove "≥ threshold inside the window" without unbounded metadata);
 * `parked` marks that the flap gate itself demoted this ticket from `approved`, which is
 * the ONLY provenance that permits the quiet-restore to promote it back — an operator- or
 * policy-parked backlog ticket is never auto-promoted (automation stays opt-in).
 */
export interface IncidentFlapState {
  recent: string[];
  parked?: boolean;
}

/** @description A recorded priority escalation (FR-C4 — "records the escalation"). */
export interface IncidentEscalation {
  at: string;
  fromPriority: TicketPriority;
  toPriority: TicketPriority;
  severity: string;
}

/**
 * @description The root-cause candidate for a bundled incident (FR-D4): which member target
 * the ordered policy picked, and the policy step that picked it (`root-filter:<pattern>` |
 * `deepest-dependency` | `earliest-first-seen`). A hint for the RCA prompt, never a verdict.
 */
export interface RootCandidate {
  target: string;
  reason: string;
}

/**
 * @description The consolidated incident record riding `metadata.incident` (spec §5).
 * `firstSeen` is genesis and write-once (FR-C6); `updateCount` counts suppressed refires
 * (the source platform's `update_count`); `instanceSeq` numbers successive incidents on the
 * same key so each gets a distinct DB claim id; `claimNonce` proves creation-race outcomes;
 * `rootCandidate` is the FR-D4 ordered-policy winner, recomputed when membership changes.
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
  rootCandidate?: RootCandidate;
  recurrenceOf?: string;
  recurrenceCount?: number;
  /** The claiming rule's ordered FR-D4 root filter, stamped at genesis (P3 Stage B). */
  rootFilter?: string[];
  /** FR-E3 flap-damping state (P3 Stage E). */
  flap?: IncidentFlapState;
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
    ...(isRootCandidate(inc.rootCandidate) ? { rootCandidate: { target: inc.rootCandidate.target, reason: inc.rootCandidate.reason } } : {}),
    ...(typeof inc.recurrenceOf === 'string' ? { recurrenceOf: inc.recurrenceOf } : {}),
    ...(typeof inc.recurrenceCount === 'number' ? { recurrenceCount: inc.recurrenceCount } : {}),
    ...(isStringArray(inc.rootFilter) ? { rootFilter: [...inc.rootFilter] } : {}),
    ...(isFlapState(inc.flap) ? { flap: { recent: [...inc.flap.recent], ...(inc.flap.parked === true ? { parked: true } : {}) } } : {}),
  };
}

/**
 * @description FR-E4: marks the member with this fingerprint resolved. A later timestamp
 * never regresses an earlier one on repeat resolved deliveries.
 * @param incident - The incident record (mutated).
 * @param fingerprint - The resolving alert's fingerprint.
 * @param resolvedAtIso - When the alert resolved (Alertmanager endsAt, or arrival time).
 * @returns True when a member matched and was marked.
 */
export function markMemberResolved(incident: IncidentRecord, fingerprint: string, resolvedAtIso: string): boolean {
  const member = incident.members.find((m) => m.fingerprint === fingerprint);
  if (!member) return false;
  if (!member.resolvedAt || Date.parse(resolvedAtIso) > Date.parse(member.resolvedAt)) {
    member.resolvedAt = resolvedAtIso;
  }
  return true;
}

/**
 * @description FR-E4 auto-close precondition: EVERY recorded member is resolved. While
 * membersOverflow > 0 some members were counted but never recorded, so full resolution is
 * unprovable — this returns false and auto-close conservatively refuses (a capped storm
 * must never self-close on partial evidence).
 * @param incident - The incident record.
 * @returns True when every member is resolved and none overflowed.
 */
export function allMembersResolved(incident: IncidentRecord): boolean {
  return (
    incident.members.length > 0 &&
    incident.membersOverflow === 0 &&
    incident.members.every((m) => typeof m.resolvedAt === 'string' && m.resolvedAt.length > 0)
  );
}

/**
 * @description Narrow-type check for a stored string array (tolerant read helper).
 * @param value - Raw metadata value.
 * @returns True for an array of strings.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * @description Narrow-type check for stored flap state (FR-E3) — malformed values drop
 * instead of propagating, like every other tolerant read here.
 * @param value - Raw metadata value.
 * @returns True for a well-formed IncidentFlapState.
 */
function isFlapState(value: unknown): value is IncidentFlapState {
  return !!value && typeof value === 'object' && isStringArray((value as IncidentFlapState).recent);
}

/**
 * @description Narrow-type check for a stored rootCandidate value (FR-D4) — the tolerant
 * read drops malformed values instead of propagating them.
 * @param value - Raw metadata value.
 * @returns True when the value is a well-formed RootCandidate.
 */
function isRootCandidate(value: unknown): value is RootCandidate {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as RootCandidate).target === 'string' &&
    typeof (value as RootCandidate).reason === 'string'
  );
}
