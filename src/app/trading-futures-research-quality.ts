/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Enforce declared bar-date freshness and per-window sample floors without claiming statistical or trading eligibility.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Classify stale-source refusals for owned notification receipts.
 */
import type { StagedOptimizerReport } from '@/features/trading';
import { FuturesSourceError } from './trading-futures-source-error';

/** @description Operator-selected research thresholds, not a live-trading permission. */
export interface FuturesQualityConfig { maxSourceLagDays: number; minOosTradesPerWindow: number }
/** @description Calendar-date lag in the source's bar-start convention, relative to the resolved study end. */
export interface FuturesSourceFreshness {
  referenceDate: string; timestampBasis: 'bar-start-calendar-date';
  chartLagDays: number; ltfLagDays: number; maxSourceLagDays: number;
}
/** @description Persist the declared gate and every under-sampled window, including zero-trade windows. */
export interface FuturesResearchQuality extends FuturesSourceFreshness {
  sampleStatus: 'meets_configured_floor' | 'insufficient';
  minOosTradesPerWindow: number;
  lowTradeWindows: Array<{ oosStart: string; oosEnd: string; trades: number }>;
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > maximum) throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  return n;
}

/** @description Validate console thresholds with conservative defaults. @param raw - Untrusted quality object. @returns Finite thresholds. */
export function normalizeFuturesQuality(raw: unknown): FuturesQualityConfig {
  if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new TypeError('Futures quality must be an object');
  const input = (raw ?? {}) as Record<string, unknown>;
  if (Object.keys(input).some(key => !['maxSourceLagDays', 'minOosTradesPerWindow'].includes(key))) throw new RangeError('Unknown Futures quality setting');
  return { maxSourceLagDays: boundedInteger(input.maxSourceLagDays, 7, 366, 'maxSourceLagDays'),
    minOosTradesPerWindow: boundedInteger(input.minOosTradesPerWindow, 10, 100_000, 'minOosTradesPerWindow') };
}

function calendarDay(value: string): number {
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day)) throw new Error('Futures source has no valid last-bar calendar date');
  return day;
}

/**
 * @description Refuse stale bars before optimizing this market. Kibot UTC fields encode exchange wall time: compare dates, not quote ages.
 * @param quality - Normalized console policy.
 * @param root - Market name for actionable refusal text.
 * @param end - Resolved study end, not today's clock for fixed historical studies.
 * @param chartAsOf - Last chart bar start in the source convention.
 * @param ltfAsOf - Last higher-timeframe bar start in that same convention.
 * @returns Evidence of the configured source-date gate; coarse timeframes may require a larger limit.
 */
export function assertFuturesSourceFreshness(quality: FuturesQualityConfig, root: string, end: string, chartAsOf: string, ltfAsOf: string): FuturesSourceFreshness {
  const day = calendarDay(end);
  const chartLagDays = (day - calendarDay(chartAsOf)) / 86_400_000;
  const ltfLagDays = (day - calendarDay(ltfAsOf)) / 86_400_000;
  if (chartLagDays < 0 || ltfLagDays < 0) throw new Error(`${root}: source bar date is beyond the study end`);
  const freshness: FuturesSourceFreshness = { referenceDate: end.slice(0, 10), timestampBasis: 'bar-start-calendar-date', chartLagDays, ltfLagDays, maxSourceLagDays: quality.maxSourceLagDays };
  if (Math.max(chartLagDays, ltfLagDays) > quality.maxSourceLagDays) {
    throw new FuturesSourceError(`${root}: stale Futures source; chart ${chartAsOf.slice(0, 10)} (${chartLagDays} days), higher timeframe ${ltfAsOf.slice(0, 10)} (${ltfLagDays} days), study end ${end.slice(0, 10)}, maximum bar-date lag ${quality.maxSourceLagDays} days. Refresh the archive or review the console's end/timeframe/lag settings. Optimizer not run for this market.`,
      { code: 'stale', root, chartDate: chartAsOf.slice(0, 10), ltfDate: ltfAsOf.slice(0, 10), freshness });
  }
  return freshness;
}

/** @description Evaluate all completed OOS windows, never just their aggregate. @param policy - Console sample floor. @param freshness - Source gate receipt. @param report - Deterministic optimizer evidence. @returns Explicit sample sufficiency, not profit or promotion authority. */
export function assessFuturesSample(policy: FuturesQualityConfig, freshness: FuturesSourceFreshness, report: StagedOptimizerReport): FuturesResearchQuality {
  const lowTradeWindows = report.windows.filter(window => window.outOfSampleTrades < policy.minOosTradesPerWindow)
    .map(window => ({ oosStart: window.window.oosStart, oosEnd: window.window.oosEnd, trades: window.outOfSampleTrades }));
  return { ...freshness, minOosTradesPerWindow: policy.minOosTradesPerWindow, lowTradeWindows,
    sampleStatus: report.windows.length > 0 && lowTradeWindows.length === 0 ? 'meets_configured_floor' : 'insufficient' };
}
