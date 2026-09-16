/**
 * Walk-forward evidence rail — ADR-116 Phase 1.
 *
 * Every futures number this project has published so far is IN-SAMPLE: constants frozen by hand,
 * run once over the whole archive, written down. That measures the archive, not the strategy. This
 * module is the splitter and the driver that produce the project's first OUT-OF-SAMPLE number.
 *
 * The contract, and the reason the splitter is a separate pure function with its own guard:
 *
 * - **A window's out-of-sample period starts exactly where its in-sample period ends.** `oosStart`
 *   IS `isEnd`, byte-identical, and bar slicing is half-open `[start, end)` on both sides — so no
 *   bar can ever appear in both halves of the same window. A look-ahead leak here would silently
 *   make every OOS number a second in-sample number, which is worse than having none.
 * - **Out-of-sample periods never overlap each other.** `stepMonths >= oosMonths` is enforced, not
 *   assumed: a smaller step re-scores the same unseen bars in several windows and inflates the
 *   aggregate. In-sample periods DO overlap across windows — that is the rolling design.
 * - **Constants are frozen.** No optimizer lives here. One config runs unchanged over every window,
 *   so the OOS/IS comparison measures the STRATEGY, not a parameter search. The staged optimizer
 *   (Phase 2) injects its own runner and calls this splitter; it does not get to change it.
 *
 * Honest limit, stated here because it will be quoted from the report: each window's series is
 * sliced COLD. Indicators warm up from scratch inside every window (the longest warmup in the stack
 * is the 100-bar wave-stops RMS), so the opening bars of both halves are warmup rather than
 * tradable. In-sample and out-of-sample are treated identically, so the comparison is fair, but a
 * six-month OOS window carries proportionally more warmup than a twenty-four-month IS window and
 * the trade counts reflect that. Prepending a warmup prefix would require dropping the trades it
 * opens, which is a change to the accounting, not to the splitter — deliberately not done here.
 *
 * Also here: the small amount of experiment plumbing both evidence scripts share — the deep merge
 * that turns a `--config` file into a `BacktestConfig` without ever manufacturing a `NaN`, the
 * cartesian grid expansion the sweep runner walks, and the named-fitness lookup that refuses an
 * unknown objective instead of silently defaulting to one.
 *
 * Scope: pure. Bars and a config in, numbers out. No I/O, no clock, no process.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-116 Phase 1 walk-forward rail: walkForwardWindows (month-anchored, half-open, oosStart === isEnd, non-overlapping OOS enforced), walkForward (frozen-constant driver over an injected runner, per-window and aggregate IS/OOS evidence, per-month-normalized degradation), plus the shared experiment plumbing — mergeBacktestConfig (undefined dropped, null refused), expandGrid (cartesian product over dotted keys, empty axis refused) and resolveFitness (unknown name throws with the valid set).
 *
 * @module futures-walk-forward
 */

import type { FuturesBar } from './futures-contract';
import {
  runFuturesBacktest, type BacktestConfig, type BacktestResult,
} from './futures-backtester';
import {
  FITNESS_FUNCTIONS, fitnessNames, type FitnessFunction, type FitnessTrade,
} from './futures-fitness';

/** How the archive is cut into rolling in-sample / out-of-sample pairs. All values in months. */
export interface WalkForwardSplit {
  /** Length of the in-sample (training) period. The trader's own protocol uses 24. */
  inSampleMonths: number;
  /** Length of the unseen out-of-sample period that immediately follows it. */
  oosMonths: number;
  /**
   * How far the whole pair advances between windows. MUST be `>= oosMonths` — a shorter step makes
   * consecutive out-of-sample periods overlap, which scores the same unseen bars more than once.
   */
  stepMonths: number;
}

/**
 * One in-sample / out-of-sample pair. All four stamps are ISO-8601 UTC month boundaries; `isEnd`
 * and `oosEnd` are EXCLUSIVE, and `oosStart` is identical to `isEnd` by construction.
 */
export interface WalkForwardWindow {
  index: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
}

/** The backtest entry point, injectable so the driver can be tested without the simulator. */
export type BacktestRunner = (
  chartBars: FuturesBar[], ltfBars: FuturesBar[], config: BacktestConfig, dailyBars: FuturesBar[],
) => BacktestResult;

/** The three series a run consumes: the chart series, the higher-timeframe filter, the regime feed. */
export interface WalkForwardSeries {
  chart: FuturesBar[];
  ltf: FuturesBar[];
  /** Daily bars for the regime gate. Empty is fine while the gate is disabled (its default). */
  daily?: FuturesBar[];
}

/** Driver options. Everything except the split has a default. */
export interface WalkForwardOptions {
  split: WalkForwardSplit;
  /** Defaults to the real simulator. */
  runner?: BacktestRunner;
  /** Defaults to net profit. A named objective comes from {@link resolveFitness}. */
  fitness?: (result: BacktestResult) => number;
  /**
   * Divide each half's fitness by its length in months before comparing. Default TRUE, because the
   * default fitness is net profit and a 24-month in-sample half would otherwise look four times
   * better than a 6-month out-of-sample half for purely arithmetic reasons. Set FALSE for a
   * ratio-shaped objective (AvgMFE/AvgMAE and friends), which is already period-independent.
   */
  normalizeByMonths?: boolean;
}

/** Evidence from one window. Both halves reported side by side; neither is ever merged. */
export interface WalkForwardWindowEvidence {
  window: WalkForwardWindow;
  isBars: number;
  isTrades: number;
  isNet: number;
  isMaxDD: number;
  isFitness: number;
  oosBars: number;
  oosTrades: number;
  oosNet: number;
  oosMaxDD: number;
  oosFitness: number;
  /** `oosFitness / isFitness` (period-normalized), or null when the in-sample half scored <= 0. */
  degradation: number | null;
}

/** The whole report — what gets written to `--out` and quoted in the doc. */
export interface WalkForwardReport {
  split: WalkForwardSplit;
  windows: WalkForwardWindowEvidence[];
  isNet: number;
  isTrades: number;
  oosNet: number;
  oosTrades: number;
  /**
   * The WORST single-window out-of-sample drawdown, not a stitched-curve drawdown: each window is
   * an independent account here, so the numbers must not be added up into a portfolio claim.
   */
  oosMaxDD: number;
  isFitness: number;
  oosFitness: number;
  /** Aggregate `oosFitness / isFitness` (period-normalized), or null when in-sample scored <= 0. */
  degradation: number | null;
}

/** A partial config as JSON gives it to us: nested plain objects, no `undefined`. */
export type ConfigPatch = Record<string, unknown>;

/** UTC month start of a timestamp. */
function monthStart(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Add whole months in UTC, landing on the 1st at midnight. */
function addUtcMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}

/** A positive whole number, or a loud throw — a NaN here silently produces zero windows. */
function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`walk-forward: ${name} must be a positive whole number of months (got ${value}).`);
  }
  return value;
}

/**
 * @description Cut a bar series into rolling in-sample / out-of-sample windows anchored to UTC
 * month boundaries. A window is emitted only when its out-of-sample period is COVERED by the data:
 * a partial trailing window would report an unseen period the archive cannot fill and read as a
 * real result.
 * @param bars Chart bars, any order; only the first and last timestamps are used.
 * @param split In-sample / out-of-sample / step lengths in months.
 * @returns Windows in chronological order, each with `oosStart === isEnd`.
 * @throws RangeError when a length is not a positive integer, or when `stepMonths < oosMonths`
 * (which would make consecutive out-of-sample periods overlap).
 */
export function walkForwardWindows(bars: FuturesBar[], split: WalkForwardSplit): WalkForwardWindow[] {
  const inSampleMonths = positiveInt('inSampleMonths', split.inSampleMonths);
  const oosMonths = positiveInt('oosMonths', split.oosMonths);
  const stepMonths = positiveInt('stepMonths', split.stepMonths);
  if (stepMonths < oosMonths) {
    throw new RangeError(
      `walk-forward: stepMonths (${stepMonths}) < oosMonths (${oosMonths}) would make consecutive `
      + 'out-of-sample periods overlap, scoring the same unseen bars twice.',
    );
  }
  if (!bars.length) return [];
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const b of bars) {
    const t = Date.parse(b.t);
    if (!Number.isFinite(t)) throw new RangeError(`walk-forward: unparseable bar timestamp '${b.t}'.`);
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const anchor = monthStart(first);
  const windows: WalkForwardWindow[] = [];
  for (let i = 0; ; i++) {
    const isStart = addUtcMonths(anchor, i * stepMonths);
    const isEnd = addUtcMonths(isStart, inSampleMonths);
    const oosEnd = addUtcMonths(isEnd, oosMonths);
    // The out-of-sample period must be fully inside the data. `<=` on the last bar, because the
    // window end is exclusive and a bar exactly at it belongs to the NEXT period.
    if (oosEnd.getTime() > last) break;
    windows.push({
      index: windows.length,
      isStart: isStart.toISOString(),
      isEnd: isEnd.toISOString(),
      oosStart: isEnd.toISOString(),
      oosEnd: oosEnd.toISOString(),
    });
  }
  return windows;
}

/** Half-open `[start, end)` slice, order preserving. */
function sliceBars(bars: FuturesBar[], startIso: string, endIso: string): FuturesBar[] {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return bars.filter((b) => {
    const t = Date.parse(b.t);
    return t >= start && t < end;
  });
}

/**
 * @description Score a finished backtest with one of the trader's objectives, mapping the simulator's
 * trade shape onto the fitness module's and carrying the account aggregates the drawdown-aware
 * objectives need.
 * @param result A finished backtest.
 * @param fitness The objective to apply.
 * @returns The objective's value.
 */
export function scoreBacktest(result: BacktestResult, fitness: FitnessFunction): number {
  const trades: FitnessTrade[] = result.trades.map((t) => ({
    profit: t.profit, mfe: t.mfe, mae: t.mae, mfePct: t.mfePct, maePct: t.maePct, exitName: t.exitName,
  }));
  return fitness(trades, { maxDrawdown: result.maxDrawdown, netProfit: result.netProfit });
}

/** Run both halves of one window and fold them into an evidence row. */
function runWindow(
  w: WalkForwardWindow, series: WalkForwardSeries, config: BacktestConfig,
  runner: BacktestRunner, score: (r: BacktestResult) => number, perMonth: (v: number, m: number) => number,
  split: WalkForwardSplit,
): WalkForwardWindowEvidence {
  const daily = series.daily ?? [];
  const half = (from: string, to: string): BacktestResult => runner(
    sliceBars(series.chart, from, to), sliceBars(series.ltf, from, to), config, sliceBars(daily, from, to),
  );
  const inSample = half(w.isStart, w.isEnd);
  const outOfSample = half(w.oosStart, w.oosEnd);
  // Structural belt-and-braces: the slicer is half-open, so an out-of-sample trade can never be
  // entered before the in-sample period ended. If one ever is, the run is void, not "interesting".
  const leak = outOfSample.trades.find((t) => Date.parse(t.entryTime) < Date.parse(w.isEnd));
  if (leak) {
    throw new Error(`walk-forward: window ${w.index} out-of-sample trade entered at ${leak.entryTime}, before the in-sample end ${w.isEnd} — look-ahead.`);
  }
  const isFitness = perMonth(score(inSample), split.inSampleMonths);
  const oosFitness = perMonth(score(outOfSample), split.oosMonths);
  return {
    window: w,
    isBars: inSample.barsProcessed, isTrades: inSample.trades.length,
    isNet: inSample.netProfit, isMaxDD: inSample.maxDrawdown, isFitness,
    oosBars: outOfSample.barsProcessed, oosTrades: outOfSample.trades.length,
    oosNet: outOfSample.netProfit, oosMaxDD: outOfSample.maxDrawdown, oosFitness,
    degradation: isFitness > 0 ? oosFitness / isFitness : null,
  };
}

/**
 * @description Run ONE frozen configuration over every walk-forward window and report each half
 * separately. This is the measurement that turns "it made money on the archive" into "it made this
 * much on periods it had never seen", which is the only version of the claim worth publishing.
 * @param series Chart, higher-timeframe and (optional) daily regime bars for one market.
 * @param config The frozen backtest configuration — unchanged across every window, by design.
 * @param options Split lengths, and optionally an injected runner, objective and normalization.
 * @returns Per-window and aggregate in-sample / out-of-sample evidence.
 * @throws Error when a sliced out-of-sample run somehow enters a trade before its in-sample end.
 */
export function walkForward(
  series: WalkForwardSeries, config: BacktestConfig, options: WalkForwardOptions,
): WalkForwardReport {
  const runner = options.runner ?? runFuturesBacktest;
  const score = options.fitness ?? ((r: BacktestResult): number => r.netProfit);
  const normalize = options.normalizeByMonths !== false;
  const perMonth = (v: number, m: number): number => (normalize ? v / m : v);
  const windows = walkForwardWindows(series.chart, options.split)
    .map((w) => runWindow(w, series, config, runner, score, perMonth, options.split));
  const sum = (pick: (e: WalkForwardWindowEvidence) => number): number => windows.reduce((a, e) => a + pick(e), 0);
  const isFitness = sum((e) => e.isFitness);
  const oosFitness = sum((e) => e.oosFitness);
  return {
    split: options.split,
    windows,
    isNet: sum((e) => e.isNet),
    isTrades: sum((e) => e.isTrades),
    oosNet: sum((e) => e.oosNet),
    oosTrades: sum((e) => e.oosTrades),
    oosMaxDD: windows.reduce((a, e) => Math.max(a, e.oosMaxDD), 0),
    isFitness,
    oosFitness,
    degradation: isFitness > 0 ? oosFitness / isFitness : null,
  };
}

/** Plain object test — arrays, dates and class instances all replace rather than merge. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** Recursive merge of `patch` onto `base`, dropping `undefined` and refusing `null`. */
function mergeInto(base: Record<string, unknown>, patch: ConfigPatch, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const here = path ? `${path}.${key}` : key;
    // A key that is present but undefined is the caller saying nothing, not the caller saying
    // "erase the default" — erasing it is how a config file turns a period into NaN.
    if (value === undefined) continue;
    if (value === null) {
      throw new TypeError(`config merge: '${here}' is null. Omit the key to keep the default; null is not a value here.`);
    }
    const existing = out[key];
    out[key] = isPlainObject(value) && isPlainObject(existing)
      ? mergeInto(existing, value, here)
      : (isPlainObject(value) ? mergeInto({}, value, here) : value);
  }
  return out;
}

/**
 * @description Deep-merge a partial configuration (a `--config` file, or one grid combination) over
 * a complete base configuration. Nested plain objects merge key by key; arrays and scalars replace
 * wholesale. An `undefined` value is skipped so an absent key can never overwrite a default with
 * `NaN`, and an explicit `null` is refused loudly rather than becoming one.
 * @param base The complete configuration the runner would otherwise use.
 * @param patch Partial overrides.
 * @returns A new configuration; neither argument is mutated.
 * @throws TypeError when the patch carries an explicit null.
 */
export function mergeBacktestConfig(base: BacktestConfig, patch: ConfigPatch): BacktestConfig {
  return mergeInto(base as unknown as Record<string, unknown>, patch, '') as unknown as BacktestConfig;
}

/**
 * @description Build a nested patch object from a dotted key path, e.g.
 * `entry.ensembleConfirmation.retentionPct` → `{entry:{ensembleConfirmation:{retentionPct: v}}}`.
 * @param path Dot-separated key path; every segment must be non-empty.
 * @param value The value to place at the leaf.
 * @returns A single-branch nested object.
 * @throws RangeError on an empty path or an empty segment.
 */
export function patchFromDottedKey(path: string, value: unknown): ConfigPatch {
  const parts = path.split('.');
  if (!path || parts.some((p) => !p)) {
    throw new RangeError(`config grid: '${path}' is not a valid dotted key path.`);
  }
  return parts.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as ConfigPatch;
}

/**
 * @description Expand a parameter grid into the full cartesian product of its axes, each
 * combination returned as a nested config patch. Cardinality is exactly the product of the axis
 * lengths — an axis with no values is refused, because it would silently collapse the whole sweep
 * to zero combinations and look like "the sweep found nothing".
 * @param grid Dotted config key → the values to try on that axis.
 * @returns One patch per combination, in odometer order with the LAST axis varying fastest.
 * @throws RangeError when an axis is empty or a key is not a valid dotted path.
 */
export function expandGrid(grid: Record<string, unknown[]>): ConfigPatch[] {
  const axes = Object.entries(grid);
  for (const [key, values] of axes) {
    if (!Array.isArray(values) || !values.length) {
      throw new RangeError(`config grid: axis '${key}' has no values — an empty axis makes the whole sweep empty.`);
    }
    // Validate the key shape now, not on the first combination: a typo'd axis should abort the
    // sweep before it spends an hour building series.
    patchFromDottedKey(key, null);
  }
  let combos: ConfigPatch[] = [{}];
  for (const [key, values] of axes) {
    const next: ConfigPatch[] = [];
    for (const base of combos) {
      for (const value of values) next.push(mergeInto(base, patchFromDottedKey(key, value), ''));
    }
    combos = next;
  }
  return combos;
}

/**
 * @description Look up one of the trader's objectives by its registered name. An unknown name is a
 * misconfigured study, and a study that silently falls back to a default objective produces numbers
 * nobody can attribute — so this throws with the valid set in hand instead.
 * @param name A key of the fitness registry.
 * @returns The objective function.
 * @throws RangeError naming every registered objective.
 */
export function resolveFitness(name: string): FitnessFunction {
  const fn = FITNESS_FUNCTIONS[name];
  if (!fn) {
    throw new RangeError(`unknown fitness '${name}'. Registered: ${fitnessNames().join(', ')}.`);
  }
  return fn;
}
