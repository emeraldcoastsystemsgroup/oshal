/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The dispatch ledger reader/writer over oshal_alert_dispatch: the append-only record of every outbound decision, the row-computed hourly apply cap and once-per-identity refusal (both therefore restart-proof and replica-safe), and the three-bucket read model whose buckets are disjoint AND exhaustive so a failing handler surfaces as failures rather than as zeros.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  PIPELINE_OWNER_SUB,
  type DispatchAction,
  type DispatchChannel,
  type DispatchRecord,
} from './alert-pipeline-types';

const logger = createChildLogger({ module: 'dispatch-log' });

/**
 * The channel/action pair that means "the pipeline changed the world". Both autonomy meters
 * — the hourly cap and the once-per-identity refusal — are scoped to exactly this pair, so a
 * ticket write or a notification can never consume an apply budget.
 */
const APPLY_CHANNEL: DispatchChannel = 'self-heal';
const APPLY_ACTION: DispatchAction = 'apply';

/**
 * @description The three mutually exclusive outcomes a dispatch row can have. Every row lands in
 * exactly one, and the three together cover every row — `total` is always their sum. There is no
 * fourth "other" bucket to quietly absorb the rows nobody thought about.
 */
export type DispatchBucket = 'suppressed' | 'delivered' | 'failed';

/**
 * @description The minimum a row must carry to be classified. Narrowed to the three decision
 * columns so the classifier can run over a database row, a `DispatchRecord` about to be written,
 * or a synthetic row in a test without any of them needing to be a full record.
 */
export type DispatchClassifiable = Pick<DispatchRecord, 'attempted' | 'suppressed' | 'success'>;

/** @description The bucket tally over one window. `total === suppressed + delivered + failed`. */
export interface DispatchBucketCounts {
  total: number;
  suppressed: number;
  delivered: number;
  failed: number;
}

/**
 * @description Optional narrowing for a bucket read. Every field is an equality match; an omitted
 * or null field matches every row. Supplied as bind parameters, never spliced into the statement.
 */
export interface DispatchBucketFilter {
  incidentId?: string | null;
  dedupKey?: string | null;
  targetChannel?: DispatchChannel | null;
  action?: DispatchAction | null;
}

/**
 * @description Decide which of the three buckets a dispatch row belongs to. This is the single
 * definition of the partition: the SQL in `bucketCounts` mirrors it clause for clause, so a
 * rendered tally and a locally classified row can never disagree.
 *
 * The order of the tests is the whole point. `suppressed` is decided first because a suppressed
 * row is a deliberate non-action and nothing about its `success` column is meaningful. Everything
 * that was actually attempted is then split on strict success: only `success === true` counts as
 * delivered, so a null (never answered) and a false (answered with a failure) both land in
 * `failed`. That is what keeps a misconfigured handler visible — it attempts, it fails, and it is
 * reported as ten failures rather than as "ten attempts, zero sent, zero deduplicated".
 *
 * The classifier is total: it returns a bucket for any input rather than throwing, because it also
 * runs over historical rows on a read path where a refusal to classify would blank a surface. A row
 * that claims neither attempt nor suppression is a broken row and is reported as `failed`, which is
 * the answer that gets it looked at.
 * @param row - The three decision columns of a dispatch row.
 * @returns The bucket the row belongs to.
 */
export function classifyDispatch(row: DispatchClassifiable): DispatchBucket {
  if (row.suppressed) return 'suppressed';
  if (row.attempted && row.success === true) return 'delivered';
  return 'failed';
}

/**
 * @description Reject a window that cannot describe a time range. A caller that passes NaN or a
 * negative window is asking a meaningless question, and answering it with a number would hand back
 * a count over an undefined range that reads exactly like a real one.
 * @param minutes - Candidate window in minutes.
 * @param method - Calling method name, for the error message.
 * @returns The validated window.
 */
function requireWindowMinutes(minutes: number, method: string): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      `DispatchLog.${method}: sinceMinutes must be a finite number greater than zero (received ${String(minutes)})`,
    );
  }
  return minutes;
}

/**
 * @description Read one aggregate column. Counts arrive as strings because they are `bigint`, and
 * a missing column means the statement did not return what this code expects.
 * @param row - The single aggregate row.
 * @param column - Column name to read.
 * @returns The count as a number.
 */
function readCount(row: Record<string, unknown>, column: string): number {
  const raw = row[column];
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`DispatchLog: aggregate column "${column}" was not a number (received ${String(raw)})`);
  }
  return parsed;
}

/**
 * @description Enforce the bucket invariant at the write, not only at the constraint. A row is
 * either an attempt or a suppression — never both, never neither.
 *
 * The database `CHECK` already refuses these rows, but a constraint violation surfaces as an opaque
 * driver error at the bottom of a stack, long after the caller that built the contradictory record
 * has returned. Checking here names the mistake at the call site that made it.
 * @param entry - The record about to be appended.
 * @returns Nothing; throws when the invariant is broken.
 */
function assertExactlyOneBucket(entry: DispatchRecord): void {
  if (entry.attempted !== entry.suppressed) return;
  const shape = entry.attempted
    ? 'both attempted and suppressed'
    : 'neither attempted nor suppressed';
  throw new Error(
    `DispatchLog.record: a dispatch row must be exactly one of attempted or suppressed, but this one is ${shape} `
    + `(channel=${entry.targetChannel} action=${entry.action})`,
  );
}

/**
 * @description The append-only ledger of outbound decisions, and the read models computed from it.
 *
 * Every autonomy limit in the pipeline is derived from these rows rather than from process memory.
 * That is what makes the hourly apply cap survive a restart and hold when a second replica is
 * running: both replicas count the same rows, and a restart loses nothing because nothing was ever
 * held in a counter.
 */
export class DispatchLog {
  /**
   * @description Bind the ledger to a connection pool.
   * @param pool - Pool whose connections carry the identity the row-level policy expects.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description Append one outbound decision. Called for suppressions as loudly as for attempts —
   * a decision not to act is evidence, and a ledger that records only the actions taken cannot
   * explain why the pipeline went quiet.
   * @param entry - The decision, with exactly one of `attempted` / `suppressed` set.
   * @returns Nothing. Throws when the invariant is broken or the append fails.
   */
  async record(entry: DispatchRecord): Promise<void> {
    assertExactlyOneBucket(entry);
    try {
      await this.pool.query(
        `INSERT INTO oshal_alert_dispatch (
           incident_id, dedup_key, target_channel, action,
           attempted, suppressed, success, status_code, error,
           ticket_id, ttl_seconds, payload, owner_sub
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
        [
          entry.incidentId,
          entry.dedupKey,
          entry.targetChannel,
          entry.action,
          entry.attempted,
          entry.suppressed,
          entry.success,
          entry.statusCode,
          entry.error,
          entry.ticketId,
          entry.ttlSeconds,
          entry.payload === undefined || entry.payload === null ? null : JSON.stringify(entry.payload),
          PIPELINE_OWNER_SUB,
        ],
      );
    } catch (err) {
      logger.error(
        {
          err,
          dedupKey: entry.dedupKey,
          targetChannel: entry.targetChannel,
          action: entry.action,
          bucket: classifyDispatch(entry),
        },
        'Dispatch ledger append failed — the decision happened but is unrecorded, so the apply cap and the once-per-identity check are now short a row',
      );
      throw err;
    }
  }

  /**
   * @description Count the self-heal applies ATTEMPTED in the trailing window. This is the hourly
   * cap: because it is a query over rows rather than an in-process tally, it is the same number for
   * every replica and it is unchanged by a restart mid-burst.
   *
   * Attempts are counted, not successes. An apply that failed still touched the system, so it spends
   * budget — counting only successes would let a handler that fails halfway through retry without
   * limit.
   * @param sinceMinutes - Trailing window in minutes.
   * @returns Number of attempted applies in the window. Throws when the ledger is unreadable — the
   * caller must treat that as being AT the cap, because an unknown apply count is not a zero one.
   */
  async countApplies(sinceMinutes: number): Promise<number> {
    const minutes = requireWindowMinutes(sinceMinutes, 'countApplies');
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*)::bigint AS applies
           FROM oshal_alert_dispatch
          WHERE target_channel = $2
            AND action = $3
            AND attempted
            AND at > now() - make_interval(mins => $1)`,
        [minutes, APPLY_CHANNEL, APPLY_ACTION],
      );
      return readCount(result.rows[0] ?? {}, 'applies');
    } catch (err) {
      logger.error(
        { err, sinceMinutes: minutes },
        'Apply-cap count failed — the cap cannot be evaluated and the caller must refuse the apply',
      );
      throw err;
    }
  }

  /**
   * @description Answer whether this identity has already had an apply attempted inside its TTL.
   * The once-per-identity check: the same incident identity gets one corrective action per window,
   * so a restart loop that keeps refiring cannot drive an endless sequence of restarts.
   *
   * FAIL SAFE. If the ledger cannot be read, this returns TRUE — the apply is refused. The
   * alternative is a database blip silently converting "I already restarted this five seconds ago"
   * into "no predecessor found", which is precisely when a second apply does the most damage. An
   * empty identity is refused for the same reason: a blank dedup key identifies nothing, so no
   * predecessor could be found for it even if one existed.
   * @param dedupKey - The incident identity being considered for an apply.
   * @param ttlSeconds - Length of the once-per-identity window, in seconds.
   * @returns True when an apply was already attempted in the window, or when the answer is unknown.
   */
  async hasAppliedWithin(dedupKey: string, ttlSeconds: number): Promise<boolean> {
    if (!dedupKey) {
      logger.warn({ ttlSeconds }, 'Once-per-identity check called with an empty dedup key — refusing the apply');
      return true;
    }
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
      logger.warn({ dedupKey, ttlSeconds }, 'Once-per-identity check called with an unusable TTL — refusing the apply');
      return true;
    }
    try {
      const result = await this.pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM oshal_alert_dispatch
            WHERE dedup_key = $1
              AND target_channel = $3
              AND action = $4
              AND attempted
              AND at > now() - make_interval(secs => $2)
         ) AS applied`,
        [dedupKey, ttlSeconds, APPLY_CHANNEL, APPLY_ACTION],
      );
      return result.rows[0]?.applied === true;
    } catch (err) {
      logger.error(
        { err, dedupKey, ttlSeconds },
        'Once-per-identity check failed — refusing the apply (fail-safe): an unreadable predecessor must never permit a second apply',
      );
      return true;
    }
  }

  /**
   * @description Tally the three buckets over a window, optionally narrowed to one incident,
   * identity, channel, or action.
   *
   * All four numbers come from ONE statement with `FILTER` clauses, so they describe the same set of
   * rows at the same instant. Four separate counts would drift against a ledger that is being
   * appended to while they run, and the drift would present as the invariant breaking.
   *
   * This method throws rather than returning zeros when the read fails, because zeros are a
   * legitimate answer here and a fabricated one is indistinguishable from a genuinely quiet hour.
   * @param sinceMinutes - Trailing window in minutes.
   * @param filter - Optional equality narrowing; omitted fields match every row.
   * @returns The four counts, where `total` equals the sum of the other three.
   */
  async bucketCounts(sinceMinutes: number, filter: DispatchBucketFilter = {}): Promise<DispatchBucketCounts> {
    const minutes = requireWindowMinutes(sinceMinutes, 'bucketCounts');
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE suppressed)::bigint AS suppressed,
                COUNT(*) FILTER (WHERE attempted AND success IS TRUE)::bigint AS delivered,
                COUNT(*) FILTER (WHERE attempted AND success IS NOT TRUE)::bigint AS failed
           FROM oshal_alert_dispatch
          WHERE at > now() - make_interval(mins => $1)
            AND ($2::uuid IS NULL OR incident_id = $2::uuid)
            AND ($3::text IS NULL OR dedup_key = $3::text)
            AND ($4::text IS NULL OR target_channel = $4::text)
            AND ($5::text IS NULL OR action = $5::text)`,
        [
          minutes,
          filter.incidentId ?? null,
          filter.dedupKey ?? null,
          filter.targetChannel ?? null,
          filter.action ?? null,
        ],
      );
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return {
        total: readCount(row, 'total'),
        suppressed: readCount(row, 'suppressed'),
        delivered: readCount(row, 'delivered'),
        failed: readCount(row, 'failed'),
      };
    } catch (err) {
      logger.error({ err, sinceMinutes: minutes, filter }, 'Dispatch bucket tally failed');
      throw err;
    }
  }

  /**
   * @description The most recent non-empty error recorded against an identity.
   *
   * Surface this ONLY when the failed bucket for the same identity is non-zero. On its own the last
   * error is a stale artefact — an identity that failed an hour ago and has been delivering ever
   * since still has one, and showing it implies a problem that is over.
   *
   * A read failure here returns null rather than throwing: this is the explanatory detail beside a
   * count, and the count itself comes from `bucketCounts`, which does throw. A non-zero failed
   * bucket therefore can never be rendered as a silent zero because this call went quiet.
   * @param dedupKey - The incident identity to explain.
   * @returns The most recent error text, or null when there is none or it could not be read.
   */
  async lastError(dedupKey: string): Promise<string | null> {
    if (!dedupKey) return null;
    try {
      const result = await this.pool.query(
        `SELECT error
           FROM oshal_alert_dispatch
          WHERE dedup_key = $1
            AND error IS NOT NULL
            AND error <> ''
          ORDER BY at DESC, dispatch_id DESC
          LIMIT 1`,
        [dedupKey],
      );
      const value = result.rows[0]?.error;
      return typeof value === 'string' && value !== '' ? value : null;
    } catch (err) {
      logger.error({ err, dedupKey }, 'Last dispatch error lookup failed — reporting no detail alongside the failed count');
      return null;
    }
  }
}
