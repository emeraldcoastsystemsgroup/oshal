/**
 * Futures intraday backtester — ADR-116, the piece that makes the strategy port runnable.
 *
 * Walks completed intraday bars, drives the ported entry evaluator and stop engine, and
 * simulates fills with NinjaTrader's replay semantics — the missing link between "the logic is
 * ported" and "we can measure it". The equities Strategy-Lab sim is daily-bar/close-fill and
 * cannot express any of this.
 *
 * NT8 REPLAY SEMANTICS reproduced (these are what make results comparable to the trader's
 * NinjaTrader runs, and getting them wrong silently flatters or damns a strategy):
 *  - Signals are computed on a COMPLETED bar and the market order fills at the NEXT bar's OPEN.
 *    Indicator values used for sizing and the initial stop are the SIGNAL bar's, not the fill bar's.
 *  - A resting stop-market order triggers INTRABAR: for a long, the moment `low <= stop`. The fill
 *    is `min(stop, open)` — a gap through the level fills at the open, not the stop price.
 *  - The Strangle close-breach exit is a MARKET order submitted at the breach bar's close, so it
 *    fills at the next bar's open (gaps included). Same for the stage-1 timed exit.
 *  - Stop and market exits are checked in that order within a bar; a bar that both triggers the
 *    resting stop and would have market-exited resolves as the stop (it fires first, intrabar).
 *  - The stage-1 timed exit holds for exactly `timedBarsToExit` completed bars, then exits at the
 *    following open, labelled 'TimedExit' — the harness for optimizing entries in isolation.
 *
 * Costs are explicit and per-side: `slippageTicks` widens every fill against the trader (entries
 * pay up, exits pay down), and `commissionPerContract` is charged on entry and exit. Both default
 * to 0 so a cost-free run is reproducible, but a study that reports P&L without setting them is
 * reporting fiction — the CLI runner defaults them to realistic ES values.
 *
 * MFE/MAE are tracked per trade in BOTH currency and percent-of-entry, because the trader's
 * stage-1 objective (AvgMFE/AvgMAE) is percent-basis while every other fitness is currency.
 *
 * Scope: no I/O. Bars arrive from a FuturesDataSource / the `market_bars` store; the caller owns
 * persistence and reporting. Multi-market overlay lives here as pure equity-curve arithmetic
 * (`overlayEquityCurves`) because that view — several markets' curves summed on one axis — is
 * exactly what NinjaTrader will not draw and what the trader has been assembling by hand.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — intraday bar-walk backtester for the ADR-116 strategy port: indicator precompute, entry-evaluator/stop-engine wiring, NT8 fill semantics (next-bar-open entries, intrabar stop triggers with gap fills, next-bar market exits), stage-1 timed-exit mode, per-trade MFE/MAE in currency+percent, equity curve, summary stats, and multi-market overlay.
 *
 * @module futures-backtester
 */

import type { OhlcvBar } from './market-data';
import type { FuturesBar } from './futures-contract';
import { wilderAtr, dmiAdx, laguerreRsi } from './futures-indicators';
import { chandelierBands, superTrendM11, parabolicSar } from './futures-trail-stops';
import { laguerreOscillator, laguerreFilter, mfi, adaptiveLaguerreFilter } from './futures-entry-indicators';
import { macdWave, dmiWave, ehlersInstTrendWave, laguerreWaveStops, WavePattern } from './futures-wave-tracking';
import {
  createFuturesEntryEvaluator, type EntryEvaluatorConfig, type LtfSnapshot, type ChartIndicatorSnapshot,
} from './futures-entry-evaluator';
import {
  createFuturesStopEngine, type StopEngineConfig, type InitialStopCandidate, resolveInitialStop,
} from './futures-stop-engine';

/** One completed trade, with everything the fitness functions and a trade blotter need. */
export interface BacktestTrade {
  direction: 'long' | 'short';
  /** Bar index of the signal (the completed bar whose close produced the entry order). */
  signalBar: number;
  /** Bar index whose OPEN filled the entry. */
  entryBar: number;
  entryTime: string;
  entryPrice: number;
  exitBar: number;
  exitTime: string;
  exitPrice: number;
  quantity: number;
  /** Exit label — 'InitialStop' | 'TrailStop' | 'Strangle' | 'TimedExit' | 'EndOfData'. */
  exitName: string;
  /** Net P&L in currency after commission (multiplier-scaled). */
  profit: number;
  /** Gross P&L before commission, for cost attribution. */
  grossProfit: number;
  commission: number;
  /** Max favorable excursion in currency (multiplier-scaled, ≥ 0). */
  mfe: number;
  /** Max adverse excursion in currency as a POSITIVE magnitude. */
  mae: number;
  /** MFE as a percent of entry price (the stage-1 objective's basis). */
  mfePct: number;
  /** MAE as a percent of entry price, positive magnitude. */
  maePct: number;
  /** Completed bars held. */
  barsHeld: number;
}

/** A point on the equity curve — cumulative realized P&L after each closed trade. */
export interface EquityPoint { time: string; equity: number; tradeIndex: number }

/** Aggregate result of one backtest run. */
export interface BacktestResult {
  symbol: string;
  trades: BacktestTrade[];
  /** Cumulative realized equity after each trade (starts at startingEquity). */
  equityCurve: EquityPoint[];
  /** Net realized P&L in currency. */
  netProfit: number;
  /** Max peak-to-trough drawdown of the realized equity curve, POSITIVE magnitude. */
  maxDrawdown: number;
  winRate: number;
  /** Trades that never opened because sizing returned 0 — a config smell worth surfacing. */
  skippedZeroQty: number;
  barsProcessed: number;
}

/** Instrument economics the fill simulator needs. */
export interface BacktestInstrument {
  symbol: string;
  /** Dollars per full price point per contract (ES = 50). */
  multiplier: number;
  tickSize: number;
}

/** Cost model — both default to 0; a reported study should set them. */
export interface BacktestCosts {
  /** Ticks of slippage applied AGAINST the trader on every fill (entry and exit). */
  slippageTicks?: number;
  /** Currency charged per contract per side. */
  commissionPerContract?: number;
}

/** Full backtest configuration. */
export interface BacktestConfig {
  instrument: BacktestInstrument;
  /** Entry-evaluator config minus the instrument economics, which are taken from `instrument`. */
  entry: Omit<EntryEvaluatorConfig, 'tickSize' | 'pointValue'>;
  /** Stop-engine config minus direction/tickSize, set per trade. */
  stops: Omit<StopEngineConfig, 'direction' | 'tickSize'>;
  costs?: BacktestCosts;
  /** Starting equity; also the sizing base when compounding is off. */
  startingEquity?: number;
  /** Compound sizing on realized P&L (the DynStops generation's behavior). Default true. */
  compound?: boolean;
  /**
   * Stage-1 harness: hold every trade exactly N completed bars then market-exit ('TimedExit'),
   * suppressing all stop management. This is the trader's entry-optimization mode (his runs used
   * 25). 0 = disabled (normal stop-managed trading).
   */
  timedBarsToExit?: number;
  /** Indicator tuning; defaults are the trader's shipped values. */
  indicators?: IndicatorConfig;
}

/** Indicator periods/params — defaults are the constructor arguments the strategies actually pass. */
export interface IndicatorConfig {
  atrPeriod?: number;
  dmiDiLength?: number; dmiAdxSmoothing?: number;
  macdFast?: number; macdSlow?: number; macdSmooth?: number;
  mfiPeriod?: number;
  laguerrePeriod?: number; laguerreGamma?: number; laguerreRmsLength?: number;
  lagRsiAlpha?: number; lagRsiSmoothing?: number;
  adaptiveLagPeriod?: number;
  ehlersAlpha?: number;
  superTrendBasePeriod?: number; superTrendRangePeriod?: number; superTrendMultiplier?: number;
  chandelierPeriod?: number; chandelierMultiplier?: number;
  /** Wave-stops RMS length (the Export generation passes 100). */
  waveStopsRmsLength?: number;
}

const DEFAULT_INDICATORS: Required<IndicatorConfig> = {
  atrPeriod: 14, dmiDiLength: 14, dmiAdxSmoothing: 14,
  macdFast: 12, macdSlow: 26, macdSmooth: 9, mfiPeriod: 14,
  laguerrePeriod: 30, laguerreGamma: 0.5, laguerreRmsLength: 30,
  lagRsiAlpha: 0.5, lagRsiSmoothing: 7, adaptiveLagPeriod: 20, ehlersAlpha: 0.07,
  superTrendBasePeriod: 8, superTrendRangePeriod: 15, superTrendMultiplier: 2.5,
  chandelierPeriod: 22, chandelierMultiplier: 2.0, waveStopsRmsLength: 100,
};

/** Everything precomputed once over the chart series — vectorized, then sampled per bar. */
interface ChartSeries {
  atr: number[];
  adx: number[]; plusDi: number[]; minusDi: number[];
  lagOsc: number[]; lagFilter: number[]; mfiV: number[]; alf: number[];
  lagRsi: number[];
  macd: number[]; macdSignal: number[];
  eitTrigger: number[]; eitTrend: number[];
  stStopDot: number[];
  chandLong: number[]; chandShort: number[];
  psar: number[]; psarLong: boolean[];
  bullPat: WavePattern[]; bearPat: WavePattern[];
  /** Wave-tracker regimes + frozen extremes — the newest generation's initial-stop candidates. */
  macdBull: boolean[]; macdBear: boolean[]; macdBearLow: number[]; macdBullHigh: number[];
  dmiBull: boolean[]; dmiBear: boolean[]; dmiBearLow: number[]; dmiBullHigh: number[];
  eitBull: boolean[]; eitBear: boolean[]; eitBearLow: number[]; eitBullHigh: number[];
}

/**
 * @description Precomputes every indicator series over the chart bars in one pass, so the bar walk
 * is a cheap sampling loop rather than an O(n²) recompute. Uses the ported NT8-parity engines
 * throughout — the same functions the unit specs pin against the .cs sources.
 * @param bars - Ascending chart bars.
 * @param ind - Indicator configuration (defaults = the strategies' constructor arguments).
 * @param tickSize - Instrument tick size (the trail generators floor their ATR at one tick).
 * @returns All series, index-aligned with bars.
 */
function precomputeChart(bars: OhlcvBar[], ind: Required<IndicatorConfig>, tickSize: number): ChartSeries {
  const closes = bars.map((b) => b.c);
  const dmi = dmiAdx(bars, ind.dmiDiLength, ind.dmiAdxSmoothing);
  const st = superTrendM11(bars, {
    basePeriod: ind.superTrendBasePeriod, rangePeriod: ind.superTrendRangePeriod,
    multiplier: ind.superTrendMultiplier, tickSize,
  });
  const chand = chandelierBands(bars, {
    period: ind.chandelierPeriod, multiplier: ind.chandelierMultiplier, tickSize,
  });
  const sar = parabolicSar(bars);
  const mw = macdWave(bars, ind.macdFast, ind.macdSlow, ind.macdSmooth);
  const dw = dmiWave(bars, ind.dmiDiLength, ind.dmiAdxSmoothing);
  const ew = ehlersInstTrendWave(bars, ind.ehlersAlpha);
  const ws = laguerreWaveStops(bars, {
    period: ind.laguerrePeriod, gamma: ind.laguerreGamma, rmsLength: ind.waveStopsRmsLength,
  });
  return {
    atr: wilderAtr(bars, ind.atrPeriod),
    adx: dmi.adx, plusDi: dmi.plusDi, minusDi: dmi.minusDi,
    lagOsc: laguerreOscillator(closes, {
      period: ind.laguerrePeriod, gamma: ind.laguerreGamma, rmsLength: ind.laguerreRmsLength,
    }),
    lagFilter: laguerreFilter(closes, ind.laguerrePeriod, ind.laguerreGamma),
    mfiV: mfi(bars, ind.mfiPeriod),
    alf: adaptiveLaguerreFilter(closes, ind.adaptiveLagPeriod),
    lagRsi: laguerreRsi(closes, ind.lagRsiAlpha, ind.lagRsiSmoothing).laRsi,
    macd: mw.fast, macdSignal: mw.slow,
    eitTrigger: ew.fast, eitTrend: ew.slow,
    stStopDot: st.stopDot,
    chandLong: chand.stopLong, chandShort: chand.stopShort,
    psar: sar.psar, psarLong: sar.isLong,
    bullPat: ws.bullWavePat, bearPat: ws.bearWavePat,
    macdBull: mw.isBullish, macdBear: mw.isBearish, macdBearLow: mw.lastBearWaveLow, macdBullHigh: mw.lastBullWaveHigh,
    dmiBull: dw.isBullish, dmiBear: dw.isBearish, dmiBearLow: dw.lastBearWaveLow, dmiBullHigh: dw.lastBullWaveHigh,
    eitBull: ew.isBullish, eitBear: ew.isBearish, eitBearLow: ew.lastBearWaveLow, eitBullHigh: ew.lastBullWaveHigh,
  };
}

/** Precomputed LTF series for the higher-timeframe filter. */
interface LtfSeries { stopDot: number[]; lagOsc: number[]; lagRsiAvg: number[] }

/** Precomputes the LTF filter's three inputs over the higher-timeframe bars. */
function precomputeLtf(bars: OhlcvBar[], ind: Required<IndicatorConfig>, tickSize: number): LtfSeries {
  const closes = bars.map((b) => b.c);
  return {
    stopDot: superTrendM11(bars, {
      basePeriod: ind.superTrendBasePeriod, rangePeriod: ind.superTrendRangePeriod,
      multiplier: ind.superTrendMultiplier, tickSize,
    }).stopDot,
    lagOsc: laguerreOscillator(closes, {
      period: ind.laguerrePeriod, gamma: ind.laguerreGamma, rmsLength: ind.laguerreRmsLength,
    }),
    lagRsiAvg: laguerreRsi(closes, ind.lagRsiAlpha, ind.lagRsiSmoothing).average,
  };
}

/** Minutes since midnight from an ISO timestamp (the entry window's basis). */
function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * The modal bar spacing of an ascending series, in milliseconds — used to derive a bar's CLOSE
 * stamp from its OPEN stamp on the last bar, where there is no successor to read it from.
 * Modal rather than mean so session gaps and weekends do not skew it.
 */
function inferBarMs(bars: FuturesBar[]): number {
  if (bars.length < 2) return 60_000;
  const counts = new Map<number, number>();
  for (let i = 1; i < bars.length && i < 500; i++) {
    const d = Date.parse(bars[i].t) - Date.parse(bars[i - 1].t);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = 60_000; let bestN = 0;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  return best;
}

/**
 * Bar CLOSE timestamps. `FuturesBar.t` is the bar-OPEN stamp, but NT evaluates the entry window
 * (and multi-series sync) against the CLOSED bar's time — a 60-min bar covering 09:00–10:00 is
 * stamped 10:00 in NinjaTrader. Using the open stamp shifts the whole tradable window one full
 * bar later, which changes which signals are admissible at both ends of the session.
 */
function closeTimes(bars: FuturesBar[]): string[] {
  const barMs = inferBarMs(bars);
  return bars.map((b, i) => (i + 1 < bars.length ? bars[i + 1].t : new Date(Date.parse(b.t) + barMs).toISOString()));
}

/**
 * Maps each chart bar to the index of the latest LTF bar that had CLOSED by that chart bar's
 * close — NT's multi-series sync, and the difference between a filter and a look-ahead leak.
 * An LTF bar is closed only once its SUCCESSOR has opened; taking the last-opened bar would feed
 * every entry decision a higher-timeframe bar that is still forming (and whose close the decision
 * would therefore be peeking at).
 */
function mapLtfIndex(chartCloses: string[], ltf: FuturesBar[]): number[] {
  const out = new Array<number>(chartCloses.length).fill(-1);
  let opened = -1;
  for (let i = 0; i < chartCloses.length; i++) {
    const t = Date.parse(chartCloses[i]);
    while (opened + 1 < ltf.length && Date.parse(ltf[opened + 1].t) <= t) opened++;
    // The last OPENED bar is still in progress; the last CLOSED one is the bar before it.
    out[i] = opened - 1;
  }
  return out;
}

/** In-flight trade state during the walk. */
interface OpenTrade {
  direction: 'long' | 'short';
  signalBar: number;
  entryBar: number;
  entryTime: string;
  entryPrice: number;
  quantity: number;
  engine: ReturnType<typeof createFuturesStopEngine>;
  restingStop: number | null;
  restingStopName: string | null;
  /** Set when a market exit was ordered at a bar close; fills at the next open. */
  pendingMarketExit: string | null;
  mfe: number; mae: number;
  barsHeld: number;
}

/**
 * @description Runs one backtest over a chart series (with an optional higher-timeframe filter
 * series), driving the ported entry evaluator and stop engine with NinjaTrader replay semantics.
 * See the module doc for the exact fill rules — they are the difference between a comparable
 * result and a flattering one.
 * @param chartBars - Ascending intraday bars for the traded timeframe.
 * @param ltfBars - Ascending higher-timeframe bars for the trend filter (empty disables it).
 * @param config - Instrument, entry/stop configuration, costs, and stage-1 timed-exit mode.
 * @returns Trades, equity curve, and summary statistics.
 */
export function runFuturesBacktest(chartBars: FuturesBar[], ltfBars: FuturesBar[], config: BacktestConfig): BacktestResult {
  const ind = { ...DEFAULT_INDICATORS, ...config.indicators };
  const { multiplier, tickSize, symbol } = config.instrument;
  const slip = (config.costs?.slippageTicks ?? 0) * tickSize;
  const commission = config.costs?.commissionPerContract ?? 0;
  const startingEquity = config.startingEquity ?? 100_000;
  const compound = config.compound ?? true;
  const timedBars = config.timedBarsToExit ?? 0;
  // The caller's declaration stands: an EMPTY LTF series must GATE (the evaluator's ltf-warmup
  // rule produces zero trades), never silently downgrade to an unfiltered run — a missing
  // higher-timeframe feed is a data problem, and reporting a full unfiltered book would hide it.
  const useLtf = config.entry.useLtfTrendFilter !== false;

  const cs = precomputeChart(chartBars, ind, tickSize);
  const ls = ltfBars.length ? precomputeLtf(ltfBars, ind, tickSize) : null;
  const chartCloses = closeTimes(chartBars);
  const ltfIdx = ltfBars.length ? mapLtfIndex(chartCloses, ltfBars) : null;

  const evaluator = createFuturesEntryEvaluator({
    ...config.entry, tickSize, pointValue: multiplier, useLtfTrendFilter: useLtf,
  });

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [{ time: chartBars.length ? chartBars[0].t : '', equity: startingEquity, tradeIndex: -1 }];
  let realized = 0;
  let skippedZeroQty = 0;
  let open: OpenTrade | null = null;
  /** An entry ordered at a bar close, filling at the next bar's open. */
  let pendingEntry: { direction: 'long' | 'short'; quantity: number; signalBar: number } | null = null;

  /** Assemble the evaluator's chart snapshot for bar i (prev values with the source's fallbacks). */
  function snapshotAt(i: number): ChartIndicatorSnapshot {
    const p = Math.max(0, i - 1);
    return {
      plusDi0: cs.plusDi[i], minusDi0: cs.minusDi[i], adx0: cs.adx[i],
      macd0: cs.macd[i], macdAvg0: cs.macdSignal[i], macd1: cs.macd[p],
      mfi0: cs.mfiV[i], mfi1: cs.mfiV[p],
      lagOsc0: cs.lagOsc[i], lagOsc1: cs.lagOsc[p],
      lagFilter0: cs.lagFilter[i], lagFilter1: cs.lagFilter[p],
      eitTrigger0: cs.eitTrigger[i], eitTrend0: cs.eitTrend[i],
      stStopDot0: cs.stStopDot[i], stStopDot1: cs.stStopDot[p],
      lagRsi0: cs.lagRsi[i], lagRsi1: cs.lagRsi[p],
      alf0: cs.alf[i], alf1: cs.alf[p],
      bullWavePat: cs.bullPat[i], bearWavePat: cs.bearPat[i],
    };
  }

  /** The LTF snapshot as of chart bar i, or null when the filter is off / has no closed bar yet. */
  function ltfAt(i: number): LtfSnapshot | null {
    if (!ls || !ltfIdx) return null;
    const j = ltfIdx[i];
    if (j < 0) return null;
    const p = Math.max(0, j - 1);
    return {
      close: ltfBars[j].c, low: ltfBars[j].l, high: ltfBars[j].h,
      stopDot: ls.stopDot[j], stopDotPrev: ls.stopDot[p],
      lagOsc: ls.lagOsc[j], lagOscPrev: ls.lagOsc[p],
      lagRsiAvg: ls.lagRsiAvg[j], lagRsiAvgPrev: ls.lagRsiAvg[p],
    };
  }

  /** Initial-stop candidates: wave extremes (newest gen) plus SuperTrend/PSAR (older gen). */
  function candidatesAt(i: number, direction: 'long' | 'short'): InitialStopCandidate[] {
    const out: InitialStopCandidate[] = [];
    const long = direction === 'long';
    const push = (name: string, ok: boolean, value: number) => {
      if (ok && Number.isFinite(value)) out.push({ name, value });
    };
    push('macd-wave', long ? cs.macdBull[i] : cs.macdBear[i], long ? cs.macdBearLow[i] : cs.macdBullHigh[i]);
    push('dmi-wave', long ? cs.dmiBull[i] : cs.dmiBear[i], long ? cs.dmiBearLow[i] : cs.dmiBullHigh[i]);
    push('eit-wave', long ? cs.eitBull[i] : cs.eitBear[i], long ? cs.eitBearLow[i] : cs.eitBullHigh[i]);
    return out;
  }

  /** Sizing-time stop estimate for bar i, mirroring what the engine will place at the fill. */
  function estimateStop(i: number, direction: 'long' | 'short'): number {
    const s = config.stops;
    return resolveInitialStop({
      direction,
      entryPrice: chartBars[i].c,
      bar: chartBars[i],
      atr: cs.atr[i],
      candidates: candidatesAt(i, direction),
      tickSize,
      atrMultiple: s.initialStopAtrMultiple ?? 1.5,
      bufferTicks: s.initialStopBufferTicks ?? 3,
      fallbackAnchor: s.initialStopFallbackAnchor ?? 'low',
      candidateFilter: s.initialStopCandidateFilter ?? 'none',
      minRiskFloor: s.initialStopMinRiskFloor ?? true,
      maxRiskAtrFactor: s.initialStopMaxRiskAtrFactor ?? 4,
    });
  }

  /** Close the open trade at `price` on bar i and record it. */
  function closeTrade(i: number, price: number, exitName: string): void {
    if (!open) return;
    const long = open.direction === 'long';
    // Fold the EXIT FILL into the excursions. A market exit fills at the next bar's open, which is
    // never seen by the per-bar excursion update (the trade is already closed by then) — without
    // this a gap-open exit books a profit larger than its own recorded MFE, which is impossible
    // and silently corrupts the stage-1 AvgMFE/AvgMAE objective and every P/MFE capture ratio.
    const favAtExit = long ? price - open.entryPrice : open.entryPrice - price;
    if (favAtExit > open.mfe) open.mfe = favAtExit;
    if (-favAtExit > open.mae) open.mae = -favAtExit;
    const gross = (long ? price - open.entryPrice : open.entryPrice - price) * open.quantity * multiplier;
    const comm = commission * open.quantity * 2; // both sides
    const profit = gross - comm;
    realized += profit;
    trades.push({
      direction: open.direction,
      signalBar: open.signalBar, entryBar: open.entryBar, entryTime: open.entryTime, entryPrice: open.entryPrice,
      exitBar: i, exitTime: chartBars[i].t, exitPrice: price, quantity: open.quantity, exitName,
      profit, grossProfit: gross, commission: comm,
      mfe: open.mfe * open.quantity * multiplier,
      mae: open.mae * open.quantity * multiplier,
      mfePct: open.entryPrice > 0 ? (open.mfe / open.entryPrice) * 100 : 0,
      maePct: open.entryPrice > 0 ? (open.mae / open.entryPrice) * 100 : 0,
      barsHeld: open.barsHeld,
    });
    equityCurve.push({ time: chartBars[i].t, equity: startingEquity + realized, tradeIndex: trades.length - 1 });
    evaluator.onPositionClosed(open.direction);
    open = null;
  }

  for (let i = 0; i < chartBars.length; i++) {
    const bar = chartBars[i];

    // 1. A market exit ordered last bar fills at THIS bar's open (gaps included).
    if (open && open.pendingMarketExit) {
      const long = open.direction === 'long';
      closeTrade(i, bar.o + (long ? -slip : slip), open.pendingMarketExit);
    }

    // 2. An entry ordered last bar fills at THIS bar's open.
    if (!open && pendingEntry) {
      const long = pendingEntry.direction === 'long';
      const fill = bar.o + (long ? slip : -slip);
      const engine = createFuturesStopEngine({ ...config.stops, direction: pendingEntry.direction, tickSize });
      // The engine seeds from the SIGNAL bar's values (NT computes the stop from [0] at fill time).
      const sig = pendingEntry.signalBar;
      const first = engine.onEntry(fill, chartBars[sig], cs.atr[sig], candidatesAt(sig, pendingEntry.direction));
      open = {
        direction: pendingEntry.direction, signalBar: sig, entryBar: i, entryTime: bar.t, entryPrice: fill,
        quantity: pendingEntry.quantity, engine,
        restingStop: timedBars > 0 ? null : first.restingStop, // timed mode places no stops
        restingStopName: timedBars > 0 ? null : first.restingStopName,
        pendingMarketExit: null, mfe: 0, mae: 0, barsHeld: 0,
      };
      pendingEntry = null;
    }

    // 3. In-position: excursions, the resting stop (intrabar), then per-bar stop management.
    if (open) {
      const long = open.direction === 'long';
      const fav = long ? bar.h - open.entryPrice : open.entryPrice - bar.l;
      const adv = long ? open.entryPrice - bar.l : bar.h - open.entryPrice;
      if (fav > open.mfe) open.mfe = fav;
      if (adv > open.mae) open.mae = adv;

      // Resting stop triggers intrabar; a gap through it fills at the open, not the stop price.
      if (open.restingStop != null) {
        const hit = long ? bar.l <= open.restingStop : bar.h >= open.restingStop;
        if (hit) {
          const raw = long ? Math.min(open.restingStop, bar.o) : Math.max(open.restingStop, bar.o);
          // A fill from a resting STOP order must carry 'Stop' in its label: the fitness module's
          // stopEfficiency term matches on that substring, and the engine names its Strangle-level
          // resting stop just 'Strangle', which would otherwise never be counted as stopped.
          const raw2 = open.restingStopName ?? 'Stop';
          closeTrade(i, raw + (long ? -slip : slip), raw2 === 'Strangle' ? 'StrangleStop' : raw2);
        }
      }
    }

    if (open) {
      open.barsHeld++;
      if (timedBars > 0) {
        // Stage-1 harness: hold exactly N completed bars, then market-exit at the next open.
        if (open.barsHeld >= timedBars) open.pendingMarketExit = 'TimedExit';
      } else {
        const d = open.engine.onBar({
          bar,
          // Below its warmup the chandelier emits the bar CLOSE as a NaN-free sentinel, which the
          // engine would mistake for a real band and arm the trail against; withhold it instead.
          chandelierStop: i >= ind.chandelierPeriod
            ? (open.direction === 'long' ? cs.chandLong[i] : cs.chandShort[i])
            : undefined,
          adx: cs.adx[i], adxPrev: cs.adx[Math.max(0, i - 1)],
          plusDi: cs.plusDi[i], minusDi: cs.minusDi[i],
          laguerreRsi: cs.lagRsi[i],
        });
        open.restingStop = d.restingStop;
        open.restingStopName = d.restingStopName;
        // Act on the BREACH bar (NT submits the market order at this close → fills next open).
        // The engine's own `exitAtMarket` is a second one-bar deferral for callers that do not
        // model fills; honoring both would exit two bars late with the position unprotected.
        if (d.marketExitPending) open.pendingMarketExit = 'Strangle';
      }
    }

    // 4. Flat: evaluate entries on this completed bar (fills next bar's open).
    if (!open && !pendingEntry) {
      const equity = compound ? startingEquity + realized : startingEquity;
      const decision = evaluator.evaluate({
        bar,
        prevBar: chartBars[Math.max(0, i - 1)],
        chartBarNumber: i,
        ltfBarNumber: ltfIdx && ltfIdx[i] >= 0 ? ltfIdx[i] + 1 : undefined, // NT CurrentBars[1] = in-progress index
        timeOfDayMinutes: minutesOfDay(chartCloses[i]),
        indicators: snapshotAt(i),
        ltf: ltfAt(i),
        flat: true,
        equity,
        estimatedStopLong: estimateStop(i, 'long'),
        estimatedStopShort: estimateStop(i, 'short'),
      });
      if (decision.signal && decision.quantity >= 1 && i + 1 < chartBars.length) {
        pendingEntry = { direction: decision.signal, quantity: decision.quantity, signalBar: i };
      } else if (decision.reasons.some((r) => r.endsWith('qty-zero'))) {
        skippedZeroQty++;
      }
    } else if (open) {
      // Keep the evaluator's per-bar state (latches, previousLagOsc) advancing while in position.
      evaluator.evaluate({
        bar,
        prevBar: chartBars[Math.max(0, i - 1)],
        chartBarNumber: i,
        ltfBarNumber: ltfIdx && ltfIdx[i] >= 0 ? ltfIdx[i] + 1 : undefined, // NT CurrentBars[1] = in-progress index
        timeOfDayMinutes: minutesOfDay(chartCloses[i]),
        indicators: snapshotAt(i),
        ltf: ltfAt(i),
        flat: false,
        equity: compound ? startingEquity + realized : startingEquity,
      });
    }
  }

  // Close any runner at the last bar's close so the blotter balances.
  if (open && chartBars.length) {
    const last = chartBars.length - 1;
    const long = open.direction === 'long';
    closeTrade(last, chartBars[last].c + (long ? -slip : slip), 'EndOfData');
  }

  return {
    symbol,
    trades,
    equityCurve,
    netProfit: realized,
    maxDrawdown: maxDrawdownOf(equityCurve),
    winRate: trades.length ? trades.filter((t) => t.profit > 0).length / trades.length : 0,
    skippedZeroQty,
    barsProcessed: chartBars.length,
  };
}

/**
 * @description Max peak-to-trough drawdown of an equity curve as a POSITIVE magnitude — the
 * convention the fitness module expects (`emergencyExitFitness` / `positionSizingFitness`).
 * @param curve - Equity points in time order.
 * @returns The largest peak-to-trough decline, 0 for a monotonically rising curve.
 */
export function maxDrawdownOf(curve: EquityPoint[]): number {
  let peak = -Infinity; let dd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    const draw = peak - p.equity;
    if (draw > dd) dd = draw;
  }
  return dd;
}

/** One market's contribution to an overlay. */
export interface OverlayPoint { time: string; equity: number; perSymbol: Record<string, number> }

/**
 * @description Overlays several markets' equity curves onto one time axis — the portfolio view
 * NinjaTrader will not draw and the trader has been assembling by hand. Each curve is stepped
 * forward (a market holds its last realized equity between its own trades), so the sum is the
 * realized equity of trading all of them concurrently with independent per-market accounts.
 * @param results - One backtest result per market.
 * @param startingEquityEach - Starting equity used per market (for the baseline offset).
 * @returns Time-ordered overlay points with the combined equity and each market's contribution.
 */
export function overlayEquityCurves(results: BacktestResult[], startingEquityEach = 100_000): OverlayPoint[] {
  const times = Array.from(new Set(results.flatMap((r) => r.equityCurve.map((p) => p.time)))).sort();
  const cursor = new Map<string, number>();
  const idx = new Map<string, number>();
  for (const r of results) { cursor.set(r.symbol, startingEquityEach); idx.set(r.symbol, 0); }
  const out: OverlayPoint[] = [];
  for (const t of times) {
    const perSymbol: Record<string, number> = {};
    for (const r of results) {
      let k = idx.get(r.symbol) as number;
      while (k < r.equityCurve.length && r.equityCurve[k].time <= t) {
        cursor.set(r.symbol, r.equityCurve[k].equity);
        k++;
      }
      idx.set(r.symbol, k);
      perSymbol[r.symbol] = cursor.get(r.symbol) as number;
    }
    out.push({ time: t, equity: Object.values(perSymbol).reduce((a, b) => a + b, 0), perSymbol });
  }
  return out;
}
