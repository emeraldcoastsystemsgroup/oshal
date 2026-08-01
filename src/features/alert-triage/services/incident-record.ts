/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P2 (ADR-119 Stage D): the consolidated-incident record shape + tolerant reader, extracted verbatim from alert-consolidation.ts so the new bundling stage can read incident records off candidate tickets without an alert-consolidation <-> alert-bundling import cycle. P2 additions to the record itself: rootCandidate {target, reason} (FR-D4 — the ordered-policy winner and why it won) carried through the tolerant read
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
  };
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
