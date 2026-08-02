/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The consolidation heart of the Operations Stream: the three-arm reopen rule over oshal_incident (refire / reopen-in-window / archive-and-recur), optimistic-concurrency field updates, and the membership ledger that decides when an incident is provably fully resolved.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  PIPELINE_OWNER_SUB,
  type AlertEventRow,
  type AttachReason,
  type ConsolidationOutcome,
  type CorrelationEngine,
  type IncidentClosedBy,
  type IncidentRow,
  type IncidentState,
} from './alert-pipeline-types';

const logger = createChildLogger({ module: 'incident-store' });

/** SQLSTATE for a unique violation — the signal that a concurrent writer won a race. */
const UNIQUE_VIOLATION = '23505';

/**
 * How many times `consolidate` re-reads and re-routes after losing a race. Every loss is
 * another writer having already landed the identity, so the second pass sees a settled row
 * and takes an arm rather than racing again; four is generous headroom, not a spin budget.
 */
const CONSOLIDATE_MAX_ATTEMPTS = 4;

/** Ceiling on optimistic-concurrency retries — see {@link withRevisionRetry}. */
export const REVISION_MAX_ATTEMPTS = 5;

/**
 * @description The minimum query surface a `Pool` and a checked-out `PoolClient` share, so the
 * same statement runs on the pool for the single-statement path and on a pinned connection for
 * the transactional path without two copies of the SQL.
 */
interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * @description What consolidation needs beyond the event itself: how long a closed incident stays
 * reopenable, which claim rule admitted the event, and the intake status a newly created incident
 * starts in. Label, priority and owner are optional overrides for callers that carry them.
 */
export interface ConsolidateOptions {
  /** Grace period after a close during which a refire reopens the SAME row instead of recurring. */
  reopenWindowSeconds: number;
  /** The rule that admitted the event, recorded on the incident at genesis. */
  claimRuleId: string | null;
  /** Intake status a newly created incident starts in (`auto` dispatches, `backlog` parks). */
  intakeStatus: string;
  /** Human-facing label; defaults to `<alertname> on <target>`. */
  incidentLabel?: string;
  /** Priority at genesis. Never changed by a refire — priority is a triage decision, not a signal. */
  priority?: string;
  /** Row owner for RLS; defaults to the pipeline's machine owner. */
  ownerSub?: string;
}

/**
 * @description The columns `updateIncident` may write, keyed by the `IncidentRow` field name.
 * Identity, genesis and lifecycle-counter columns are deliberately absent: `dedup_key`,
 * `instance_seq`, `first_seen`, `reopen_count`, `recurrence_of` and `revision` are owned by
 * `consolidate` alone, so no caller can rewrite the history the reopen rule depends on.
 */
const PATCHABLE_COLUMNS = {
  incidentLabel: 'incident_label',
  state: 'state',
  severity: 'severity',
  severityNum: 'severity_num',
  priority: 'priority',
  lastSeen: 'last_seen',
  occurrenceCount: 'occurrence_count',
  memberCount: 'member_count',
  membersOverflow: 'members_overflow',
  resolvedAt: 'resolved_at',
  closedAt: 'closed_at',
  closedBy: 'closed_by',
  correlationGroupId: 'correlation_group_id',
  correlationEngine: 'correlation_engine',
  correlationDepth: 'correlation_depth',
  correlationVersion: 'correlation_version',
  rootCandidateTarget: 'root_candidate_target',
  rootCandidateReason: 'root_candidate_reason',
  rootCandidateAmbiguous: 'root_candidate_ambiguous',
  intakeStatus: 'intake_status',
  flags: 'flags',
  flapParked: 'flap_parked',
  ticketId: 'ticket_id',
} as const;

/** @description The `IncidentRow` fields a caller may patch through {@link IncidentStore.updateIncident}. */
export type PatchableIncidentField = keyof typeof PATCHABLE_COLUMNS;

/** @description A partial incident update carrying only patchable fields. */
export type IncidentPatch = Partial<Pick<IncidentRow, PatchableIncidentField>>;

/** @description One alert identity joining an incident, as the caller supplies it. */
export interface IncidentMemberInput {
  /** Stable identity of the member alert within the incident. */
  memberKey: string;
  alertname?: string;
  target?: string;
  severity?: string;
  severityNum?: number;
  fingerprint?: string | null;
  /** When this member was seen; defaults to now. */
  seenAt?: Date;
  /** Why it attached, recorded at attach time so composition is never re-derived later. */
  attachReason: AttachReason;
  /** Dependency hops from the incident's seed, when it attached through topology. */
  dependencyHops?: number | null;
}

/** Insert column list shared by the consolidation upsert and the recurrence insert. */
const GENESIS_COLUMNS = `
  dedup_key, identity_source, incident_label, instance_seq,
  state, primary_alertname, primary_target, claim_rule_id,
  severity, severity_num, priority,
  first_seen, last_seen, occurrence_count, member_count,
  intake_status, owner_sub`;

/**
 * Genesis VALUES for $1..$12. `instance_seq` is derived in SQL as one past the highest instance
 * ever recorded for the identity, so a fresh instance can never collide with an archived one on
 * uq_incident_identity_instance.
 */
const GENESIS_VALUES = `
  $1, $2, $3,
  COALESCE((SELECT MAX(i.instance_seq) FROM oshal_incident i WHERE i.dedup_key = $1), 0) + 1,
  'open', $4, $5, $6,
  $7, $8, $9,
  $10, $10, 1, 1,
  $11, $12`;

/**
 * Arms A and B in one statement. The conflict target is the predicate form of the
 * `uq_incident_live` partial unique index, so the database itself serializes a burst: the loser
 * of the race takes the DO UPDATE branch instead of writing a second live row.
 *
 * The CASE on the existing `state` is what separates the arms. Already open (arm A) keeps its
 * reopen history untouched and only advances the counters; resolved (arm B) flips back to open,
 * counts the reopen and clears the close so the row is coherent again.
 *
 * The DO UPDATE WHERE clause is the eligibility gate, evaluated against the row as it exists at
 * write time rather than against a value read earlier: an operator close, or a close older than
 * the reopen window, matches nothing, the statement returns no row, and the caller escalates to
 * the transactional recurrence path.
 */
const CONSOLIDATE_UPSERT_SQL = `
INSERT INTO oshal_incident (${GENESIS_COLUMNS})
VALUES (${GENESIS_VALUES})
ON CONFLICT (dedup_key) WHERE state IN ('open', 'resolved')
DO UPDATE SET
  state            = 'open',
  occurrence_count = oshal_incident.occurrence_count + 1,
  last_seen        = GREATEST(oshal_incident.last_seen, EXCLUDED.last_seen),
  severity         = CASE WHEN EXCLUDED.severity_num < oshal_incident.severity_num
                          THEN EXCLUDED.severity ELSE oshal_incident.severity END,
  severity_num     = LEAST(oshal_incident.severity_num, EXCLUDED.severity_num),
  reopen_count     = oshal_incident.reopen_count
                     + CASE WHEN oshal_incident.state = 'open' THEN 0 ELSE 1 END,
  reopened_at      = CASE WHEN oshal_incident.state = 'open'
                          THEN oshal_incident.reopened_at ELSE now() END,
  resolved_at      = CASE WHEN oshal_incident.state = 'open'
                          THEN oshal_incident.resolved_at ELSE NULL END,
  closed_at        = NULL,
  closed_by        = NULL,
  revision         = oshal_incident.revision + 1,
  updated_at       = now()
WHERE oshal_incident.state = 'open'
   OR (oshal_incident.closed_by IS DISTINCT FROM 'operator'
       AND now() - COALESCE(oshal_incident.closed_at,
                            oshal_incident.resolved_at,
                            oshal_incident.last_seen)
           <= make_interval(secs => $13::double precision))
RETURNING *,
  (xmax = 0) AS was_created,
  (xmax <> 0 AND reopened_at IS NOT NULL AND reopened_at = updated_at) AS was_reopened`;

/**
 * Arm C, second half: a fresh instance linked back to the one it supersedes. Runs after the
 * archive in the same transaction, so the derived `instance_seq` is exactly the archived row's
 * plus one.
 */
const RECUR_INSERT_SQL = `
INSERT INTO oshal_incident (${GENESIS_COLUMNS}, recurrence_of)
VALUES (${GENESIS_VALUES}, $13)
RETURNING *`;

/** Arm C, first half. */
const ARCHIVE_SQL = `
UPDATE oshal_incident
   SET state = 'archived', revision = revision + 1, updated_at = now()
 WHERE incident_id = $1`;

/**
 * Arm B for a row in state `closed`. A closed row sits outside the `uq_incident_live` index and
 * therefore cannot be an ON CONFLICT target, so the reopen is written directly against the row
 * held by the transaction's lock.
 */
const REOPEN_CLOSED_SQL = `
UPDATE oshal_incident SET
  state            = 'open',
  occurrence_count = occurrence_count + 1,
  last_seen        = GREATEST(last_seen, $2::timestamptz),
  severity         = CASE WHEN $4::smallint < severity_num THEN $3 ELSE severity END,
  severity_num     = LEAST(severity_num, $4::smallint),
  reopen_count     = reopen_count + 1,
  reopened_at      = now(),
  resolved_at      = NULL,
  closed_at        = NULL,
  closed_by        = NULL,
  revision         = revision + 1,
  updated_at       = now()
WHERE incident_id = $1
RETURNING *`;

const FIND_LIVE_SQL = `
SELECT * FROM oshal_incident
 WHERE dedup_key = $1 AND state IN ('open', 'resolved')
 LIMIT 1`;

/**
 * The newest instance that is not superseded. `archived` is excluded because an archived row is
 * history; `closed` is included because a closed row is still the identity's current instance and
 * is what arms B and C branch on.
 */
const FIND_LATEST_SQL = `
SELECT * FROM oshal_incident
 WHERE dedup_key = $1 AND state <> 'archived'
 ORDER BY instance_seq DESC
 LIMIT 1`;

const LIST_OPEN_SQL = `
SELECT * FROM oshal_incident
 WHERE state = 'open'
   AND last_seen >= now() - make_interval(secs => $1::double precision)
 ORDER BY last_seen DESC
 LIMIT $2`;

const MEMBER_UPSERT_SQL = `
INSERT INTO oshal_incident_member (
  incident_id, member_key, alertname, target, severity, severity_num,
  fingerprint, first_seen, last_seen, occurrence_count, attach_reason, dependency_hops
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, 1, $9, $10)
ON CONFLICT (incident_id, member_key) DO UPDATE SET
  last_seen        = GREATEST(oshal_incident_member.last_seen, EXCLUDED.last_seen),
  occurrence_count = oshal_incident_member.occurrence_count + 1,
  severity         = CASE WHEN EXCLUDED.severity_num < oshal_incident_member.severity_num
                          THEN EXCLUDED.severity ELSE oshal_incident_member.severity END,
  severity_num     = LEAST(oshal_incident_member.severity_num, EXCLUDED.severity_num),
  fingerprint      = COALESCE(EXCLUDED.fingerprint, oshal_incident_member.fingerprint),
  resolved_at      = NULL`;

const MEMBER_RESOLVE_SQL = `
UPDATE oshal_incident_member
   SET resolved_at = $3::timestamptz
 WHERE incident_id = $1 AND member_key = $2`;

/**
 * Full resolution needs three facts at once: the cap was never hit, at least one member was
 * actually recorded, and none of the recorded members is still firing. A `members_overflow`
 * above zero means members were counted and never written down, so their state is unknown and
 * the incident cannot be declared resolved from what is on disk.
 */
const ALL_MEMBERS_RESOLVED_SQL = `
SELECT
  i.members_overflow = 0
  AND EXISTS (SELECT 1 FROM oshal_incident_member m WHERE m.incident_id = i.incident_id)
  AND NOT EXISTS (
    SELECT 1 FROM oshal_incident_member m
     WHERE m.incident_id = i.incident_id AND m.resolved_at IS NULL
  ) AS all_resolved
FROM oshal_incident i
WHERE i.incident_id = $1`;

/** The $1..$12 genesis binds plus the derived values the transactional arms reuse. */
interface GenesisParams {
  dedupKey: string;
  eventTime: Date;
  severity: string;
  severityNum: number;
  reopenWindowSeconds: number;
  values: unknown[];
}

/**
 * @description Project a raw `oshal_incident` row onto the typed contract. `occurrence_count`
 * and `revision` are BIGINT and arrive as strings from the driver, so they are widened here once
 * rather than at every call site where a string would silently compare unequal to a number.
 * @param row - A raw result row selected with `*` from oshal_incident.
 * @returns The typed incident.
 */
function mapIncident(row: QueryResultRow): IncidentRow {
  return {
    incidentId: row.incident_id as string,
    dedupKey: row.dedup_key as string,
    identitySource: row.identity_source as string,
    incidentLabel: row.incident_label as string,
    instanceSeq: Number(row.instance_seq),
    state: row.state as IncidentState,
    primaryAlertname: row.primary_alertname as string,
    primaryTarget: row.primary_target as string,
    claimRuleId: (row.claim_rule_id as string | null) ?? null,
    severity: row.severity as string,
    severityNum: Number(row.severity_num),
    priority: row.priority as string,
    firstSeen: row.first_seen as Date,
    lastSeen: row.last_seen as Date,
    occurrenceCount: Number(row.occurrence_count),
    memberCount: Number(row.member_count),
    membersOverflow: Number(row.members_overflow),
    reopenCount: Number(row.reopen_count),
    reopenedAt: (row.reopened_at as Date | null) ?? null,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
    closedAt: (row.closed_at as Date | null) ?? null,
    closedBy: (row.closed_by as IncidentClosedBy | null) ?? null,
    recurrenceOf: (row.recurrence_of as string | null) ?? null,
    correlationGroupId: row.correlation_group_id as string,
    correlationEngine: row.correlation_engine as CorrelationEngine,
    correlationDepth: row.correlation_depth === null ? null : Number(row.correlation_depth),
    correlationVersion: (row.correlation_version as string | null) ?? null,
    rootCandidateTarget: (row.root_candidate_target as string | null) ?? null,
    rootCandidateReason: (row.root_candidate_reason as string | null) ?? null,
    rootCandidateAmbiguous: Boolean(row.root_candidate_ambiguous),
    intakeStatus: row.intake_status as string,
    flags: (row.flags as string[] | null) ?? [],
    flapParked: Boolean(row.flap_parked),
    ticketId: (row.ticket_id as string | null) ?? null,
    revision: Number(row.revision),
  };
}

/**
 * @description True while an incident occupies the live slot for its identity — the exact
 * predicate of `uq_incident_live`, so this and the database can never disagree about which row
 * an upsert will conflict with.
 * @param row - The incident to test.
 * @returns Whether the row is the identity's live instance.
 */
function isLive(row: IncidentRow): boolean {
  return row.state === 'open' || row.state === 'resolved';
}

/**
 * @description Whether a refire may reopen this exact row. An operator close is a human decision
 * and is never undone by a machine; otherwise the close must be recent enough that the refire is
 * the same episode rather than a new one. The reference instant walks `closed_at` → `resolved_at`
 * → `last_seen` so a row resolved without an explicit close is still judged on when it went quiet.
 * @param row - The candidate incident.
 * @param reopenWindowSeconds - Grace period after the close.
 * @param now - The instant to measure against.
 * @returns Whether arm B applies.
 */
function isReopenEligible(row: IncidentRow, reopenWindowSeconds: number, now: Date): boolean {
  if (row.closedBy === 'operator') return false;
  const reference = row.closedAt ?? row.resolvedAt ?? row.lastSeen;
  const windowMs = Math.max(0, reopenWindowSeconds) * 1000;
  return now.getTime() - reference.getTime() <= windowMs;
}

/**
 * @description True when a driver error is a unique violation, meaning a concurrent writer landed
 * the same identity first. Everything else is a real failure and must propagate.
 * @param error - The caught value.
 * @returns Whether the error is SQLSTATE 23505.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * @description Build the genesis binds once per consolidation so the upsert and the recurrence
 * insert write byte-identical values — a recurrence is a new instance of the same identity, not a
 * differently-shaped row.
 * @param dedupKey - The consolidation identity.
 * @param event - The normalized alert driving this consolidation.
 * @param options - Reopen window, claim rule and intake status.
 * @returns The bind set plus the derived values the transactional arms reuse.
 */
function buildGenesis(dedupKey: string, event: AlertEventRow, options: ConsolidateOptions): GenesisParams {
  const eventTime = event.startedAt ?? event.receivedAt ?? new Date();
  const label = options.incidentLabel
    ?? (event.target ? `${event.alertname} on ${event.target}` : event.alertname)
    ?? dedupKey;
  return {
    dedupKey,
    eventTime,
    severity: event.severity,
    severityNum: event.severityNum,
    reopenWindowSeconds: options.reopenWindowSeconds,
    values: [
      dedupKey,
      event.identitySource ?? '',
      label,
      event.alertname,
      event.target,
      options.claimRuleId,
      event.severity,
      event.severityNum,
      options.priority ?? 'medium',
      eventTime,
      options.intakeStatus,
      options.ownerSub ?? PIPELINE_OWNER_SUB,
    ],
  };
}

/**
 * @description Run an optimistically-concurrent update until it lands or the bound is spent. The
 * operation re-reads the current revision on each attempt and returns `null` when its `WHERE
 * revision = $n` matched nothing, which means another writer moved the row underneath it.
 * Exhausting the bound throws rather than returning `null`: a caller that cannot distinguish
 * "nothing to do" from "gave up under contention" writes the wrong thing next.
 * @param operation - One attempt; resolves to the updated value, or `null` if the revision moved.
 * @param options - `maxAttempts` (clamped to 1..{@link REVISION_MAX_ATTEMPTS}) and a `label` used in the error.
 * @returns The value from the first attempt that landed.
 */
export async function withRevisionRetry<T>(
  operation: (attempt: number) => Promise<T | null>,
  options: { maxAttempts?: number; label?: string } = {},
): Promise<T> {
  const label = options.label ?? 'incident update';
  const bound = Math.min(Math.max(1, options.maxAttempts ?? REVISION_MAX_ATTEMPTS), REVISION_MAX_ATTEMPTS);
  for (let attempt = 1; attempt <= bound; attempt += 1) {
    const result = await operation(attempt);
    if (result !== null) return result;
    logger.debug({ label, attempt, bound }, 'revision moved under an update; re-reading');
  }
  const error = new Error(`${label}: revision contention unresolved after ${bound} attempts`);
  logger.error({ err: error, label, bound }, 'optimistic concurrency budget exhausted');
  throw error;
}

/**
 * @description Reads and writes for `oshal_incident` and `oshal_incident_member` — the
 * consolidation decision, the field updates that carry a revision, and the membership ledger.
 * Exactly one incident is live per identity, and that is enforced by the `uq_incident_live`
 * partial unique index rather than by any lock this class holds, so it survives restarts and
 * holds across replicas.
 */
export class IncidentStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @description Fold one alert into its incident, taking exactly one of three arms: A, a refire
   * of a live incident (counters advance, severity may only escalate, the ticket is untouched);
   * B, a reopen of the same row inside the reopen window; C, a recurrence, where the superseded
   * instance is archived and a fresh one is opened pointing back at it. Arms A and B are a single
   * upsert so a burst cannot race two live rows in; arm C takes a transaction because archiving
   * and re-inserting must be indivisible.
   * @param event - The normalized alert. Its `dedupKey` is the consolidation identity.
   * @param options - Reopen window, the admitting claim rule, and the genesis intake status.
   * @returns The settled incident and which arm produced it.
   */
  async consolidate(event: AlertEventRow, options: ConsolidateOptions): Promise<ConsolidationOutcome> {
    const dedupKey = (event.dedupKey ?? '').trim();
    if (!dedupKey) {
      throw new Error('consolidate() requires a consolidation identity: event.dedupKey was empty');
    }
    const genesis = buildGenesis(dedupKey, event, options);
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= CONSOLIDATE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const prior = await this.findLatestInstance(this.pool, dedupKey, false);
        const fast = prior === null || isLive(prior) ? await this.upsertLive(this.pool, genesis) : null;
        const outcome = fast ?? (await this.consolidateContended(dedupKey, genesis, options));
        logger.debug(
          {
            dedupKey,
            incidentId: outcome.incident.incidentId,
            instanceSeq: outcome.incident.instanceSeq,
            wasCreated: outcome.wasCreated,
            wasReopened: outcome.wasReopened,
            wasRecurrence: outcome.wasRecurrence,
            attempt,
            durationMs: Date.now() - startedAt,
          },
          'alert consolidated into incident',
        );
        return outcome;
      } catch (error) {
        if (isUniqueViolation(error) && attempt < CONSOLIDATE_MAX_ATTEMPTS) {
          logger.warn({ dedupKey, attempt }, 'consolidation lost a race; re-reading and re-routing');
          continue;
        }
        logger.error({ err: error, dedupKey, attempt }, 'consolidation failed');
        throw error;
      }
    }
    const exhausted = new Error(`consolidate(): ${dedupKey} lost ${CONSOLIDATE_MAX_ATTEMPTS} consecutive races`);
    logger.error({ err: exhausted, dedupKey }, 'consolidation abandoned under sustained contention');
    throw exhausted;
  }

  /**
   * @description The identity's live incident, if it has one. This is the row an upsert would
   * conflict with, so callers can reason about the arm ahead of writing.
   * @param dedupKey - The consolidation identity.
   * @returns The live incident, or `null`.
   */
  async findLive(dedupKey: string): Promise<IncidentRow | null> {
    const result = await this.pool.query(FIND_LIVE_SQL, [dedupKey]);
    return result.rows.length > 0 ? mapIncident(result.rows[0]) : null;
  }

  /**
   * @description Incidents still open and still recent — the candidate set a bundler considers
   * before deciding two incidents are one. Served by `idx_incident_state_last_seen`, so the scan
   * stays proportional to the window rather than to history.
   * @param windowSeconds - How far back `last_seen` may be.
   * @param limit - Maximum rows returned, newest activity first.
   * @returns The candidate incidents.
   */
  async listOpen(windowSeconds: number, limit: number): Promise<IncidentRow[]> {
    const result = await this.pool.query(LIST_OPEN_SQL, [Math.max(0, windowSeconds), Math.max(1, limit)]);
    return result.rows.map(mapIncident);
  }

  /**
   * @description Apply a patch under optimistic concurrency. The update matches only while the
   * row still carries the revision the caller read, so two writers editing different fields can
   * never blind-overwrite each other the way a read-modify-write of a blob does.
   * @param incidentId - The incident to update.
   * @param revision - The revision the caller read.
   * @param patch - Fields to write; keys outside {@link PATCHABLE_COLUMNS} are rejected.
   * @returns The updated incident, or `null` when the revision had already moved.
   */
  async updateIncident(incidentId: string, revision: number, patch: IncidentPatch): Promise<IncidentRow | null> {
    const assignments: string[] = [];
    const values: unknown[] = [incidentId, revision];
    for (const [field, value] of Object.entries(patch)) {
      const column = PATCHABLE_COLUMNS[field as PatchableIncidentField];
      if (!column) throw new Error(`updateIncident(): "${field}" is not a patchable incident field`);
      values.push(value);
      // `column` is a literal from PATCHABLE_COLUMNS, never caller text; every VALUE is a bind.
      assignments.push(`${column} = $${values.length}`);
    }
    if (assignments.length === 0) throw new Error('updateIncident(): patch carried no fields');
    const sql = `UPDATE oshal_incident
   SET ${assignments.join(', ')}, revision = revision + 1, updated_at = now()
 WHERE incident_id = $1 AND revision = $2
 RETURNING *`;
    try {
      const result = await this.pool.query(sql, values);
      logger.debug({ incidentId, revision, fields: Object.keys(patch), applied: result.rowCount }, 'incident patch applied');
      return result.rows.length > 0 ? mapIncident(result.rows[0]) : null;
    } catch (error) {
      logger.error({ err: error, incidentId, revision, fields: Object.keys(patch) }, 'incident patch failed');
      throw error;
    }
  }

  /**
   * @description Record that an alert identity belongs to this incident, or that an existing
   * member fired again. A refire clears `resolved_at`: a member that starts firing after being
   * marked resolved is not resolved, and leaving the stamp in place would let the incident
   * auto-close over a live signal.
   * @param incidentId - The owning incident.
   * @param member - The member identity and why it attached.
   * @returns Nothing; the write is unconditional.
   */
  async upsertMember(incidentId: string, member: IncidentMemberInput): Promise<void> {
    try {
      await this.pool.query(MEMBER_UPSERT_SQL, [
        incidentId,
        member.memberKey,
        member.alertname ?? '',
        member.target ?? '',
        member.severity ?? 'warning',
        member.severityNum ?? 3,
        member.fingerprint ?? null,
        member.seenAt ?? new Date(),
        member.attachReason,
        member.dependencyHops ?? null,
      ]);
    } catch (error) {
      logger.error({ err: error, incidentId, memberKey: member.memberKey }, 'incident member upsert failed');
      throw error;
    }
  }

  /**
   * @description Stamp one member as no longer firing. Kept separate from the incident's own
   * state so an incident closes on evidence about every member rather than on the last member's
   * resolve arriving first.
   * @param incidentId - The owning incident.
   * @param memberKey - The member identity.
   * @param at - When the member resolved.
   * @returns Nothing.
   */
  async markMemberResolved(incidentId: string, memberKey: string, at: Date): Promise<void> {
    try {
      await this.pool.query(MEMBER_RESOLVE_SQL, [incidentId, memberKey, at]);
    } catch (error) {
      logger.error({ err: error, incidentId, memberKey }, 'incident member resolve failed');
      throw error;
    }
  }

  /**
   * @description Whether every member of the incident is provably resolved. False while any
   * recorded member is still firing, false while `members_overflow` is non-zero (members were
   * counted but never written down, so their state is unknown), and false when no member was
   * recorded at all — there is then no evidence to resolve on.
   * @param incidentId - The incident to test.
   * @returns Whether an auto-close is justified by the membership ledger.
   */
  async allMembersResolved(incidentId: string): Promise<boolean> {
    const result = await this.pool.query(ALL_MEMBERS_RESOLVED_SQL, [incidentId]);
    return result.rows.length > 0 && result.rows[0].all_resolved === true;
  }

  /**
   * Arms A and B: one statement, so the live-slot index decides the winner of a burst. Returns
   * `null` when the conflicting row exists but the eligibility gate refused it — the signal that
   * this identity needs arm C.
   */
  private async upsertLive(db: Queryable, genesis: GenesisParams): Promise<ConsolidationOutcome | null> {
    const result = await db.query(CONSOLIDATE_UPSERT_SQL, [...genesis.values, genesis.reopenWindowSeconds]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      incident: mapIncident(row),
      wasCreated: row.was_created === true,
      wasReopened: row.was_reopened === true,
      wasRecurrence: false,
    };
  }

  /**
   * The path that needs more than one statement: a closed row to reopen, or an instance to
   * archive before the next one opens. An advisory lock on the identity serializes arrivals that
   * land here, so two of them cannot both read the same prior instance and both archive it; the
   * row lock underneath holds that decision against any writer that reaches the row another way.
   */
  private async consolidateContended(
    dedupKey: string,
    genesis: GenesisParams,
    options: ConsolidateOptions,
  ): Promise<ConsolidationOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [dedupKey]);
      const prior = await this.findLatestInstance(client, dedupKey, true);
      const outcome = await this.resolveArmUnderLock(client, prior, genesis, options);
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      logger.error({ err: error, dedupKey }, 'transactional consolidation failed; rolling back');
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error({ err: rollbackError, dedupKey }, 'rollback after a failed consolidation also failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Choose the arm from the prior instance as it exists under the lock, then write it. */
  private async resolveArmUnderLock(
    client: PoolClient,
    prior: IncidentRow | null,
    genesis: GenesisParams,
    options: ConsolidateOptions,
  ): Promise<ConsolidationOutcome> {
    const now = new Date();
    const eligible = prior !== null && isReopenEligible(prior, options.reopenWindowSeconds, now);
    if (prior === null || prior.state === 'open' || (isLive(prior) && eligible)) {
      const settled = await this.upsertLive(client, genesis);
      if (settled) return settled;
      const contender = prior ?? (await this.findLatestInstance(client, genesis.dedupKey, true));
      if (!contender) {
        throw new Error(`consolidate(): ${genesis.dedupKey} was refused with no instance to supersede`);
      }
      return this.recur(client, contender, genesis);
    }
    if (eligible) return this.reopenInPlace(client, prior, genesis);
    return this.recur(client, prior, genesis);
  }

  /** Arm B against a closed row, which sits outside the live index and so cannot be upserted. */
  private async reopenInPlace(
    client: PoolClient,
    prior: IncidentRow,
    genesis: GenesisParams,
  ): Promise<ConsolidationOutcome> {
    const result = await client.query(REOPEN_CLOSED_SQL, [
      prior.incidentId,
      genesis.eventTime,
      genesis.severity,
      genesis.severityNum,
    ]);
    if (result.rows.length === 0) {
      throw new Error(`consolidate(): incident ${prior.incidentId} vanished while being reopened`);
    }
    return { incident: mapIncident(result.rows[0]), wasCreated: false, wasReopened: true, wasRecurrence: false };
  }

  /** Arm C: supersede the prior instance and open the next one pointing back at it. */
  private async recur(
    client: PoolClient,
    prior: IncidentRow,
    genesis: GenesisParams,
  ): Promise<ConsolidationOutcome> {
    await client.query(ARCHIVE_SQL, [prior.incidentId]);
    const result = await client.query(RECUR_INSERT_SQL, [...genesis.values, prior.incidentId]);
    return { incident: mapIncident(result.rows[0]), wasCreated: true, wasReopened: false, wasRecurrence: true };
  }

  /** The identity's current instance — live or closed, never an archived one. */
  private async findLatestInstance(
    db: Queryable,
    dedupKey: string,
    forUpdate: boolean,
  ): Promise<IncidentRow | null> {
    const sql = forUpdate ? `${FIND_LATEST_SQL} FOR UPDATE` : FIND_LATEST_SQL;
    const result = await db.query(sql, [dedupKey]);
    return result.rows.length > 0 ? mapIncident(result.rows[0]) : null;
  }
}
