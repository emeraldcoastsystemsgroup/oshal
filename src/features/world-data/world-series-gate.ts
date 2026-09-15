/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — a process-wide bounded, coalescing gate in front of the world series-store reads. The market-hours pulse fans out over 184 entities and the scheduler ABANDONS a dispatch that overruns (schedule-service withDispatchTimeout leaves the promise running), so a per-run mapPool bounded nothing across runs: two overlapping pulses put 16+ aggregates on oshal-local-tsdb at once and the store spent 282% CPU answering the same statements twice.
 */

/**
 * @description The bounded, coalescing gate in front of every world SERIES-STORE read.
 *
 * Two different things saturate a time-series store, and a per-run concurrency limit fixes neither:
 *
 *  1. **Fan-out that outlives its run.** The market-hours ticker pulse rolls up every entity in the
 *     trading universe, and the scheduler's dispatch timeout ABANDONS a slow run rather than
 *     cancelling it (`schedule-service.withDispatchTimeout`: "the underlying promise is left to
 *     settle on its own"). The next pulse then starts on top of the previous one, so a limit that
 *     lives inside one run multiplies by however many runs are still in flight.
 *  2. **Duplicate work.** Two overlapping pulses ask for the SAME aggregate — same entity, same
 *     metric, same window — and the store computes it twice, concurrently, for one answer.
 *
 * This module is process-wide state on purpose: it is the only place that can see both. Reads pass
 * through `runSeriesRead(key, run)`, which
 *  - hands an in-flight read's promise to any later caller with the same key (no second statement),
 *  - and otherwise waits for one of `WORLD_SERIES_READ_CONCURRENCY` slots before issuing.
 *
 * It bounds READS only. Writes (the rollup's metric inserts, the archive upserts) are per-row and
 * idempotent-by-key; coalescing them would be wrong and bounding them is not what saturated the
 * store. The counters are cumulative so a caller can take a snapshot before and after its own work
 * and report what IT issued (the pulse completion log does exactly that).
 */

/** Slots when `WORLD_SERIES_READ_CONCURRENCY` is unset — small on purpose: the store answered 19
 *  concurrent aggregates at 282% CPU, and a read that waits 200ms is cheaper than one that queues
 *  behind 18 others inside the database. */
const DEFAULT_READ_CONCURRENCY = 4;

/** @description How many series-store read statements may be in flight process-wide.
 *  @param env - Environment to read (injectable so a spec can set the bound without a rebuild).
 *  @returns The configured slot count, or the small default when unset/invalid. */
export function seriesReadConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORLD_SERIES_READ_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_READ_CONCURRENCY;
}

/** What the gate has done since the last reset — the pulse log's "statements issued" comes from
 *  the delta of two snapshots. */
export interface SeriesReadStats {
  /** Statements actually sent to the store. */
  issued: number;
  /** Reads answered by an already-in-flight identical statement (the statements NOT sent). */
  coalesced: number;
  /** High-water mark of concurrent statements since the last reset. */
  maxInFlight: number;
  /** Statements in flight right now. */
  active: number;
  /** Callers waiting for a slot right now. */
  queued: number;
}

const inFlight = new Map<string, Promise<unknown>>();
const waiting: Array<() => void> = [];
let active = 0;
let issued = 0;
let coalesced = 0;
let maxInFlight = 0;

/** @description A stable key for one read statement. Two reads share a key only when they would
 *  return the same answer, so anything that changes the rows read must appear here.
 *  @param kind - The statement shape (e.g. 'sentiment-days').
 *  @param parts - The bound parameters that select rows (entity, metric, window).
 *  @returns The coalescing key. */
export function seriesReadKey(kind: string, ...parts: Array<string | number>): string {
  return [kind, ...parts.map(String)].join('|');
}

/** Take a slot, waiting in FIFO order when every slot is busy. */
async function acquire(): Promise<void> {
  if (active < seriesReadConcurrency()) {
    active += 1;
    if (active > maxInFlight) maxInFlight = active;
    return;
  }
  await new Promise<void>((resolve) => { waiting.push(resolve); });
}

/** Hand the slot to the next waiter, or give it back. */
function release(): void {
  const next = waiting.shift();
  if (next) { next(); return; } // the permit transfers; `active` is unchanged
  active = Math.max(0, active - 1);
}

/**
 * @description Run one series-store read under the process-wide bound, coalescing it onto an
 * identical read that is already in flight.
 *
 * A coalesced caller receives the FIRST caller's rows, which were computed at the first caller's
 * `now()`. That is only ever a sub-second difference on windows measured in days, and it is the
 * whole point: two pulses asking the same question get one answer instead of two scans. The key
 * is dropped as soon as the read settles, so this is de-duplication of concurrent work, never a
 * cache — the next caller re-reads.
 *
 * @param key - The coalescing key from `seriesReadKey` (same key = same answer).
 * @param run - Issues the statement. Called at most once per in-flight key.
 * @returns The statement's result, shared with every caller coalesced onto it.
 */
export function runSeriesRead<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    coalesced += 1;
    return existing;
  }
  const started = (async (): Promise<T> => {
    await acquire();
    try {
      issued += 1;
      return await run();
    } finally {
      inFlight.delete(key);
      release();
    }
  })();
  inFlight.set(key, started);
  return started;
}

/** @description Snapshot of the gate's cumulative counters plus its current occupancy.
 *  @returns The counters; subtract two snapshots to get one caller's own statement count. */
export function seriesReadStats(): SeriesReadStats {
  return { issued, coalesced, maxInFlight, active, queued: waiting.length };
}

/** @description Reset the cumulative counters and the high-water mark. In-flight reads are left
 *  alone — this measures, it does not cancel.
 *  @returns Nothing. */
export function resetSeriesReadStats(): void {
  issued = 0;
  coalesced = 0;
  maxInFlight = active;
}
