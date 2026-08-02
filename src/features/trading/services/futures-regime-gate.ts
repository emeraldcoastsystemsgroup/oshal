/**
 * Daily ADX regime gate — R10, ADR-116.
 *
 * The source trader's own written spec (`EntryEnsemble.md`) defines `DailyRegimeAdxThreshold = 20`:
 * daily ADX(14) above 20 to allow trading, otherwise stand aside. His `ATCEnsembleGen.cs` never
 * implements it — it gates on the lower-timeframe trend filter instead. This module is that
 * unshipped gate, built from his spec rather than inferred from his code, which is unusual enough
 * to state plainly: the threshold is HIS number, the implementation is ours, and neither has ever
 * been run before this port.
 *
 * The measured case it exists for is crude 2024, where entry quality collapsed (stage-1 MFE/MAE
 * 0.442, 52% win rate, entries alone −$85,885) — a year in which the model could not read the
 * regime at all. Whether standing aside in low-ADX daily conditions actually recovers any of that
 * is an EMPIRICAL question; the gate ships default-OFF and the answer belongs in a measured report
 * with a paper/live label, never in this file's prose.
 *
 * NO LOOK-AHEAD, enforced structurally: a daily bar counts as informing a chart bar only once its
 * SUCCESSOR has opened. Taking the last-opened daily bar would feed every intraday decision a daily
 * ADX computed from the very session still in progress — the same leak the LTF index was fixed for.
 * Before any daily bar has closed with a finite ADX the gate BLOCKS (fail-closed): an unknown
 * regime is not a permissive regime.
 *
 * Scope: pure; bars in, a per-chart-bar boolean mask out. The backtester owns what to do with it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — R10 daily ADX regime gate: buildDailyRegimeGate maps closed daily bars onto chart bars with no look-ahead, applies the spec's DailyRegimeAdxThreshold (default 20, default DISABLED), fails closed through warmup, and reports the daily ADX actually consulted per bar so a study can attribute blocked signals.
 *
 * @module futures-regime-gate
 */

import type { FuturesBar } from './futures-contract';
import { dmiAdx } from './futures-indicators';

/** Configuration for the daily ADX regime gate. */
export interface RegimeGateConfig {
  /**
   * Enable the gate. DEFAULT FALSE — it is an unproven addition to a ported strategy, and a filter
   * that silently removes entries is the worst kind of default.
   */
  enabled?: boolean;
  /** DI length for the daily DMI/ADX (spec: 14). */
  diLength?: number;
  /** ADX smoothing for the daily DMI/ADX (spec: 14). */
  adxSmoothing?: number;
  /** The spec's `DailyRegimeAdxThreshold` (default 20). Sweepable. */
  threshold?: number;
  /**
   * Which side of the threshold trades. 'trend' (default, his spec) admits daily ADX ≥ threshold.
   * 'chop' inverts it — not an alternative strategy but the NULL TEST: if inverting the gate helps
   * as much as applying it, the gate is fitting noise, not regime.
   */
  mode?: 'trend' | 'chop';
}

/** The gate's shipped defaults — his threshold, our default-off posture. */
export const REGIME_GATE_DEFAULTS = Object.freeze({
  enabled: false,
  diLength: 14,
  adxSmoothing: 14,
  threshold: 20,
  mode: 'trend' as 'trend' | 'chop',
});

/** Per-chart-bar gate output. */
export interface RegimeGateSeries {
  /** True when entries are admissible on that chart bar. */
  allowed: boolean[];
  /**
   * The daily ADX actually consulted for that chart bar, NaN where none had closed yet. Kept so a
   * study can report WHY bars were blocked rather than only how many.
   */
  dailyAdx: number[];
  /** Chart bars the gate blocked (includes warmup bars). */
  blockedBars: number;
  /** Chart bars blocked specifically because no daily bar had closed yet (warmup, not regime). */
  warmupBars: number;
}

/**
 * @description Builds the per-chart-bar regime mask from a daily series.
 *
 * The mapping is the same closed-bar discipline the higher-timeframe filter uses: walk the daily
 * bars forward alongside the chart closes, track the last daily bar to have OPENED at or before the
 * chart bar's close, and consult the one BEFORE it — the last bar guaranteed complete.
 * @param chartCloseTimes - ISO close stamps for each chart bar, ascending (the backtester's `closeTimes`).
 * @param dailyBars - Ascending daily bars for the same market. Empty means the gate can decide
 *   nothing, which fails closed to all-blocked when the gate is enabled.
 * @param config - Gate configuration.
 * @returns The mask, the consulted daily ADX per bar, and blocked/warmup counts.
 */
export function buildDailyRegimeGate(
  chartCloseTimes: string[],
  dailyBars: FuturesBar[],
  config: RegimeGateConfig = {},
): RegimeGateSeries {
  const cfg = { ...REGIME_GATE_DEFAULTS, ...stripUndefined(config) };
  const n = chartCloseTimes.length;
  if (!cfg.enabled) {
    return { allowed: new Array<boolean>(n).fill(true), dailyAdx: new Array<number>(n).fill(NaN), blockedBars: 0, warmupBars: 0 };
  }
  const adx = dailyBars.length ? dmiAdx(dailyBars, cfg.diLength, cfg.adxSmoothing).adx : [];
  const allowed = new Array<boolean>(n).fill(false);
  const dailyAdx = new Array<number>(n).fill(NaN);
  let blockedBars = 0;
  let warmupBars = 0;
  let opened = -1;
  for (let i = 0; i < n; i++) {
    const t = Date.parse(chartCloseTimes[i]);
    while (opened + 1 < dailyBars.length && Date.parse(dailyBars[opened + 1].t) <= t) opened++;
    // The last OPENED daily bar is still forming; the last CLOSED one is the bar before it.
    const j = opened - 1;
    const value = j >= 0 && j < adx.length ? adx[j] : NaN;
    dailyAdx[i] = value;
    if (!Number.isFinite(value)) {
      warmupBars++;
      blockedBars++;
      continue;
    }
    const trending = value >= cfg.threshold;
    allowed[i] = cfg.mode === 'chop' ? !trending : trending;
    if (!allowed[i]) blockedBars++;
  }
  return { allowed, dailyAdx, blockedBars, warmupBars };
}

/**
 * Drop explicit-undefined keys before merging over the frozen defaults — `{ threshold: undefined }`
 * typechecks and a plain spread would turn the threshold into NaN, which compares false against
 * everything and would silently block every bar.
 */
function stripUndefined(cfg: RegimeGateConfig): RegimeGateConfig {
  return Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)) as RegimeGateConfig;
}
