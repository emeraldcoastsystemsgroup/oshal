/**
 * Futures data completeness — the rollover-aware gap check (ADR-116).
 *
 * This is the friend's gap-checker, moved upstream. His pipeline downloaded first and hunted gaps
 * afterward against the CME calendar + rollover buckets; here the instrument model
 * (futures-contract.ts) already knows a contract's active window and its EXPECTED bar count, so a
 * fetched bar set is graded the instant it arrives: expected vs received, plus interior gap runs that
 * ignore the weekend maintenance halt (a weekend is not a gap). What survives after a bounded re-fetch
 * loop is, as he put it, "all the data the vendor has" — genuinely-absent thin/holiday sessions, not a
 * broken download.
 *
 * Session/holiday note: gap runs count only buckets the Globex session calendar
 * (futures-session-calendar.ts) says SHOULD trade — so the Friday-close → Sunday-open halt, the
 * daily 17:00–18:00 maintenance break, full-closure holidays, and 13:00 early closes never read as
 * missing data, while a genuinely absent mid-session hour still does.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-contract completeness (expected/received/missing/ratio), weekend-discounted interior gap-run detection, and the re-fetch convergence test that ends the patch loop when a re-download yields no new bars.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gap detection is session-calendar-aware: interior runs count missing SESSION buckets, not missing weekday buckets — the daily maintenance halt stopped reading as a phantom one-bar gap every single trading day of real Kibot data, and holidays stopped reading as broken downloads.
 *
 * @module futures-completeness
 */

import type { Timeframe } from './market-data';
import { barMinutes, expectedBarCount, type FuturesBar, type FuturesContract, type FuturesRoot } from './futures-contract';
import { countSessionBuckets } from './futures-session-calendar';

/** A detected interior gap run — a stretch of missing bars inside the active window, session-discounted. */
export interface BarGap {
  /** Start of the gap (the last present bar before it), ISO-8601 UTC. */
  fromIso: string;
  /** End of the gap (the first present bar after it), ISO-8601 UTC. */
  toIso: string;
  /** Estimated missing bars in the run (session buckets only). */
  missingBars: number;
}

/** The completeness verdict for one contract at one timeframe. */
export interface ContractCompleteness {
  symbol: string;
  timeframe: Timeframe;
  /** Expected bars over the (clamped) active window per the instrument model. */
  expected: number;
  /** Distinct bar buckets actually received inside the active window. */
  received: number;
  /** max(0, expected − received) — the headline "N buckets missing". */
  missing: number;
  /** received / expected, clamped to [0, 1]. */
  completeness: number;
  /** Interior gap runs (in-session buckets only), largest first. */
  gaps: BarGap[];
  /** True when completeness ≥ threshold (the contract is "whole enough"). */
  complete: boolean;
}

/** Default completeness threshold — allows a couple percent of genuinely-absent thin/holiday sessions. */
export const DEFAULT_COMPLETENESS_THRESHOLD = 0.98;

const MS_PER_DAY = 86_400_000;

/**
 * @description Grade a fetched bar set for one contract against its expected coverage.
 * @param contract - The dated contract (carries its active window).
 * @param tf - Bar timeframe.
 * @param root - Root metadata (session hours drive the expected count).
 * @param bars - The fetched bars (any order; filtered to the active window internally).
 * @param opts - Optional clamp window + completeness threshold.
 * @returns The completeness verdict, including session-discounted interior gap runs.
 */
export function assessContractCompleteness(
  contract: FuturesContract,
  tf: Timeframe,
  root: FuturesRoot,
  bars: FuturesBar[],
  opts: { windowStart?: Date; windowEnd?: Date; threshold?: number } = {},
): ContractCompleteness {
  const barMs = barMinutes(tf) * 60_000;
  const winStart = Math.max((opts.windowStart ?? contract.activeStart).getTime(), contract.activeStart.getTime());
  const winEnd = Math.min((opts.windowEnd ?? contract.activeEnd).getTime(), contract.activeEnd.getTime());
  const buckets = distinctBucketsInWindow(bars, barMs, winStart, winEnd);
  const expected = expectedBarCount(contract, tf, root, new Date(winStart), new Date(winEnd));
  const received = buckets.length;
  const completeness = expected > 0 ? Math.min(1, received / expected) : (received > 0 ? 1 : 0);
  const gaps = detectGaps(buckets, barMs).sort((a, b) => b.missingBars - a.missingBars);
  const threshold = opts.threshold ?? DEFAULT_COMPLETENESS_THRESHOLD;
  return {
    symbol: contract.symbol, timeframe: tf, expected, received,
    missing: Math.max(0, expected - received), completeness, gaps,
    complete: completeness >= threshold,
  };
}

/** Sorted, de-duplicated bar-bucket start times (epoch-ms) that fall inside [winStart, winEnd). */
function distinctBucketsInWindow(bars: FuturesBar[], barMs: number, winStart: number, winEnd: number): number[] {
  const seen = new Set<number>();
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (Number.isNaN(t) || t < winStart || t >= winEnd) continue;
    seen.add(Math.floor(t / barMs) * barMs);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Interior gap runs between consecutive present buckets, counting only in-session buckets. */
function detectGaps(buckets: number[], barMs: number): BarGap[] {
  const gaps: BarGap[] = [];
  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1];
    const cur = buckets[i];
    if (cur - prev <= barMs) continue;
    const missing = countSessionBuckets(prev + barMs, cur, barMs);
    if (missing > 0) gaps.push({ fromIso: new Date(prev).toISOString(), toIso: new Date(cur).toISOString(), missingBars: missing });
  }
  return gaps;
}

/**
 * @description Aggregate a set of per-contract verdicts into a patch list — the contracts still short
 * of the threshold, which a re-fetch loop should download again.
 * @param verdicts - Per-contract completeness verdicts.
 * @returns The symbols that are not yet complete, worst completeness first.
 */
export function patchList(verdicts: ContractCompleteness[]): ContractCompleteness[] {
  return verdicts.filter((v) => !v.complete).sort((a, b) => a.completeness - b.completeness);
}

/**
 * @description Convergence test for the re-fetch loop: a re-download that yields no NEW bars means the
 * vendor has no more data, so stop chasing this contract (the byte-size-equal rule from the friend's
 * pipeline, expressed in bars rather than file bytes).
 * @param prevReceived - Distinct buckets from the prior fetch.
 * @param nextReceived - Distinct buckets from the latest fetch.
 * @returns True when the latest fetch added nothing — the contract has converged.
 */
export function ingestConverged(prevReceived: number, nextReceived: number): boolean {
  return nextReceived <= prevReceived;
}

/** True when a timestamp falls on a weekend (used by callers building expected-empty allowances). */
export function isWeekendUtc(iso: string): boolean {
  const dow = new Date(Date.parse(iso)).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Whole-window span in days for a contract (diagnostic for reports). */
export function activeWindowDays(contract: FuturesContract): number {
  return Math.round((contract.activeEnd.getTime() - contract.activeStart.getTime()) / MS_PER_DAY);
}
