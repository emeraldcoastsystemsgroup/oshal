/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard for the dispatch bucket invariant: classifyDispatch partitions a generated 200-row mix into three disjoint, exhaustive buckets whose sum is the total and which agree row-for-row with the SQL predicates in DispatchLog.bucketCounts; the misconfigured-handler shape (attempted with success=false) is reported as FAILED rather than as a suppression or a silent zero; DispatchLog.record refuses a row that is both attempted and suppressed, or neither, before it can reach the database; and hasAppliedWithin fails SAFE on an unreadable ledger while the tallies refuse to fabricate a zero. Pure — no database, no network.
 */

import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  DispatchLog,
  classifyDispatch,
  type DispatchBucket,
  type DispatchBucketCounts,
  type DispatchClassifiable,
} from '@/features/alert-pipeline/services/dispatch-log';
import type { DispatchRecord } from '@/features/alert-pipeline/services/alert-pipeline-types';

/** The complete bucket vocabulary. A classifier answer outside this set is a failure by itself. */
const BUCKETS: readonly DispatchBucket[] = ['suppressed', 'delivered', 'failed'] as const;

/** One synthetic ledger row, carrying an id so set membership can be checked by identity. */
interface SyntheticRow extends DispatchClassifiable {
  id: number;
  shape: string;
}

/**
 * Every row shape the ledger can hold, under the `attempted <> suppressed` constraint the table
 * enforces. Named so a failure says which shape broke rather than which array index did.
 */
const ROW_SHAPES: ReadonlyArray<Omit<SyntheticRow, 'id'>> = [
  { shape: 'delivered', attempted: true, suppressed: false, success: true },
  { shape: 'handler-answered-failure', attempted: true, suppressed: false, success: false },
  { shape: 'handler-never-answered', attempted: true, suppressed: false, success: null },
  { shape: 'suppressed-clean', attempted: false, suppressed: true, success: null },
  { shape: 'suppressed-carrying-false', attempted: false, suppressed: true, success: false },
  { shape: 'suppressed-carrying-true', attempted: false, suppressed: true, success: true },
];

/**
 * A deterministic 32-bit generator. The mix must be varied but reproducible: a guard that draws a
 * different sample on every run reports a different failure on every run.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw `count` rows from the shape table in a fixed pseudo-random order. */
function generateRows(count: number, seed = 0x0a1e27): SyntheticRow[] {
  const rng = makeRng(seed);
  const rows: SyntheticRow[] = [];
  for (let id = 0; id < count; id += 1) {
    const shape = ROW_SHAPES[Math.floor(rng() * ROW_SHAPES.length) % ROW_SHAPES.length];
    rows.push({ id, ...shape });
  }
  return rows;
}

/**
 * The buckets exactly as `DispatchLog.bucketCounts` computes them in SQL:
 * `suppressed`, `attempted AND success IS TRUE`, `attempted AND success IS NOT TRUE`.
 * Holding this beside the classifier is what stops the two definitions drifting apart.
 */
function tallyBySqlPredicates(rows: readonly DispatchClassifiable[]): DispatchBucketCounts {
  return {
    total: rows.length,
    suppressed: rows.filter((r) => r.suppressed).length,
    delivered: rows.filter((r) => r.attempted && r.success === true).length,
    failed: rows.filter((r) => r.attempted && r.success !== true).length,
  };
}

/** The same four numbers, derived only from `classifyDispatch`. */
function tallyByClassifier(rows: readonly DispatchClassifiable[]): DispatchBucketCounts {
  const counts = { total: rows.length, suppressed: 0, delivered: 0, failed: 0 };
  for (const row of rows) counts[classifyDispatch(row)] += 1;
  return counts;
}

/** A dispatch record with sane defaults; overrides carry whatever the case is proving. */
function dispatchRecord(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    incidentId: null,
    dedupKey: 'SwarmContainerDown::oshal-local-email-bot',
    targetChannel: 'self-heal',
    action: 'apply',
    attempted: true,
    suppressed: false,
    success: true,
    statusCode: 200,
    error: null,
    ticketId: 'TCK-1001',
    ttlSeconds: 900,
    payload: { restart: 'oshal-local-email-bot' },
    ...overrides,
  };
}

/**
 * A pool that records every statement it is asked to run and answers with an empty result. Counting
 * calls is what proves the refusal happens at the call site rather than as a constraint violation
 * one round trip later — and that a valid row still gets through.
 */
function recordingPool(): { pool: Pool; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push([text, values]);
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    },
  } as unknown as Pool;
  return { pool, calls };
}

/** A pool whose every read fails, standing in for an unreachable or wedged database. */
function unreadablePool(): Pool {
  return {
    query: async () => {
      throw new Error('connection terminated unexpectedly');
    },
  } as unknown as Pool;
}

describe('dispatch bucket invariant (oshal_alert_dispatch)', () => {
  it('partitions a 200-row mix into three disjoint, exhaustive buckets whose sum is the total', () => {
    const rows = generateRows(200);
    const members = new Map<DispatchBucket, Set<number>>(BUCKETS.map((b) => [b, new Set<number>()]));

    for (const row of rows) {
      const bucket = classifyDispatch(row);
      expect(BUCKETS).toContain(bucket); // never a fourth answer
      members.get(bucket)!.add(row.id);
    }

    // Exhaustive: every row landed somewhere.
    const placed = BUCKETS.reduce((sum, b) => sum + members.get(b)!.size, 0);
    expect(placed).toBe(rows.length);

    // Disjoint: no id appears in two buckets. Checked pairwise on the sets, not on the counts —
    // equal totals can hide a row double-counted against another row dropped.
    for (const [left, right] of [
      ['suppressed', 'delivered'],
      ['suppressed', 'failed'],
      ['delivered', 'failed'],
    ] as Array<[DispatchBucket, DispatchBucket]>) {
      const overlap = [...members.get(left)!].filter((id) => members.get(right)!.has(id));
      expect(overlap).toEqual([]);
    }

    // The union is exactly the input, so no row was invented either.
    const union = new Set<number>(BUCKETS.flatMap((b) => [...members.get(b)!]));
    expect(union.size).toBe(rows.length);
    expect([...union].sort((a, b) => a - b)).toEqual(rows.map((r) => r.id));

    // total = suppressed + delivered + failed.
    const tally = tallyByClassifier(rows);
    expect(tally.suppressed + tally.delivered + tally.failed).toBe(tally.total);
    expect(tally.total).toBe(200);

    // Every bucket is genuinely exercised — a degenerate sample would pass the arithmetic above.
    expect(tally.suppressed).toBeGreaterThan(0);
    expect(tally.delivered).toBeGreaterThan(0);
    expect(tally.failed).toBeGreaterThan(0);
    for (const shape of ROW_SHAPES) {
      expect(rows.some((r) => r.shape === shape.shape)).toBe(true);
    }
  });

  it('agrees row-for-row with the SQL predicates bucketCounts uses, so a rendered tally and a locally classified row cannot disagree', () => {
    const rows = generateRows(200, 0x51d3ac);
    expect(tallyByClassifier(rows)).toEqual(tallyBySqlPredicates(rows));

    // And per shape, so an offsetting pair of errors cannot cancel out in the totals.
    for (const shape of ROW_SHAPES) {
      const slice = rows.filter((r) => r.shape === shape.shape);
      expect(slice.length).toBeGreaterThan(0);
      expect(tallyByClassifier(slice)).toEqual(tallyBySqlPredicates(slice));
    }
  });

  it('reports a misconfigured handler as FAILED — never as a suppression and never as a silent zero', () => {
    // Ten attempts against a handler that answers with a failure: the shape that renders as
    // "10 attempts (0 sent / 0 deduplicated)" the moment the failed bucket is dropped.
    const rows: DispatchClassifiable[] = Array.from({ length: 10 }, () => ({
      attempted: true,
      suppressed: false,
      success: false,
    }));

    for (const row of rows) expect(classifyDispatch(row)).toBe('failed');

    const tally = tallyByClassifier(rows);
    expect(tally).toEqual({ total: 10, suppressed: 0, delivered: 0, failed: 10 });
    expect(tally).toEqual(tallyBySqlPredicates(rows));
    // The load-bearing assertion: the attempts are visible as failures, not absorbed into nothing.
    expect(tally.failed).not.toBe(0);
    expect(tally.suppressed + tally.delivered).toBe(0);
    expect(tally.total).toBe(tally.failed);

    // An attempt that was never answered is the same class of problem and is bucketed the same way.
    expect(classifyDispatch({ attempted: true, suppressed: false, success: null })).toBe('failed');
    // A genuine suppression is still a suppression, so the failed bucket does not swallow dedup.
    expect(classifyDispatch({ attempted: false, suppressed: true, success: null })).toBe('suppressed');
    // And only a strict success is a delivery.
    expect(classifyDispatch({ attempted: true, suppressed: false, success: true })).toBe('delivered');
  });

  it('record() refuses a row that is both attempted and suppressed, or neither, before it reaches the database', async () => {
    const both = recordingPool();
    await expect(
      new DispatchLog(both.pool).record(dispatchRecord({ attempted: true, suppressed: true, success: null })),
    ).rejects.toThrow(/exactly one of attempted or suppressed/);
    expect(both.calls).toHaveLength(0); // rejected at the call site, not as a constraint violation

    const neither = recordingPool();
    await expect(
      new DispatchLog(neither.pool).record(dispatchRecord({ attempted: false, suppressed: false, success: null })),
    ).rejects.toThrow(/exactly one of attempted or suppressed/);
    expect(neither.calls).toHaveLength(0);

    // The message names which way the row is wrong — the two mistakes have different causes.
    await expect(
      new DispatchLog(recordingPool().pool).record(dispatchRecord({ attempted: true, suppressed: true })),
    ).rejects.toThrow(/both attempted and suppressed/);
    await expect(
      new DispatchLog(recordingPool().pool).record(dispatchRecord({ attempted: false, suppressed: false })),
    ).rejects.toThrow(/neither attempted nor suppressed/);

    // A guard that rejected everything would satisfy the assertions above: both legal shapes must
    // still reach the ledger, each as exactly one INSERT.
    const attempted = recordingPool();
    await new DispatchLog(attempted.pool).record(dispatchRecord({ attempted: true, suppressed: false }));
    expect(attempted.calls).toHaveLength(1);
    expect(String(attempted.calls[0][0])).toContain('INSERT INTO oshal_alert_dispatch');

    const suppressed = recordingPool();
    await new DispatchLog(suppressed.pool).record(
      dispatchRecord({ attempted: false, suppressed: true, success: null, statusCode: null }),
    );
    expect(suppressed.calls).toHaveLength(1);
    // The row is written with its own bucket columns, bound rather than spliced into the statement.
    const values = suppressed.calls[0][1] as unknown[];
    expect(values).toContain(true);
    expect(values.filter((v) => v === false)).toHaveLength(1);
  });

  it('hasAppliedWithin fails SAFE — an unreadable predecessor refuses the apply instead of permitting a second one', async () => {
    const log = new DispatchLog(unreadablePool());

    // The read fails. The answer is "refuse", never "no predecessor found".
    await expect(log.hasAppliedWithin('SwarmContainerDown::oshal-local-email-bot', 900)).resolves.toBe(true);
    // An identity that identifies nothing cannot be checked, so it is refused too.
    await expect(log.hasAppliedWithin('', 900)).resolves.toBe(true);
    // So is a TTL that cannot describe a window.
    await expect(log.hasAppliedWithin('SwarmContainerDown::oshal-local-email-bot', Number.NaN)).resolves.toBe(true);
    await expect(log.hasAppliedWithin('SwarmContainerDown::oshal-local-email-bot', -1)).resolves.toBe(true);

    // The other reads must NOT fabricate an answer: zero is a legitimate tally and a legitimate
    // apply count, so inventing one would be indistinguishable from a genuinely quiet window.
    await expect(log.countApplies(60)).rejects.toThrow(/connection terminated/);
    await expect(log.bucketCounts(60)).rejects.toThrow(/connection terminated/);

    // A window that cannot describe a time range is rejected before any statement runs.
    const unused = recordingPool();
    const withPool = new DispatchLog(unused.pool);
    await expect(withPool.countApplies(Number.NaN)).rejects.toThrow(/sinceMinutes/);
    await expect(withPool.bucketCounts(0)).rejects.toThrow(/sinceMinutes/);
    await expect(withPool.bucketCounts(-5)).rejects.toThrow(/sinceMinutes/);
    expect(unused.calls).toHaveLength(0);
  });
});
