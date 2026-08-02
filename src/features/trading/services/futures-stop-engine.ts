/**
 * Futures stop engine — ADR-116 stop-stack port, part 3 of 3.
 *
 * The per-trade stop state machine from the trader's newest NT8 strategy generation
 * (ATCEntryCountDynStops.cs), ported as pure logic with no order-management dependency:
 *
 *  1. INITIAL STOP on entry — candidate levels (SuperTrend/PSAR in the older generation, wave
 *     extremes in the newest) filtered to beyond the entry bar's extreme, combined widest;
 *     ATR-multiple fallback off the low (newest gen) or close (older gen); optional min-risk
 *     floor and 4× max-risk ceiling (newest gen).
 *  2. CHANDELIER BASE TRAIL with the literal breakeven gate — the band only becomes the active
 *     stop once it is better than entry by ≥ 1 tick; optional risk-goal arming (profit > 1R)
 *     delays it further. Tighten-only, always.
 *  3. STRANGLE EXHAUSTION TRAIL — the tight higher-close/lookback-low stop. Level tracking runs
 *     EVERY bar while the close is beyond entry (latch-independent); the ADX gate (profitable AND
 *     ADX ≥ threshold AND [DI < ADX or ADX falling — or Laguerre RSI ≥ 80 in the dictated mode])
 *     LATCHES once per trade; enforcement is profit-conditional (underwater → the chandelier
 *     resumes, the June-7/May-11 fixes); a CLOSE breach of the level triggers a market exit on
 *     the NEXT bar (or a plain resting stop in 'resting-stop' mode).
 *
 * Every stop the engine emits passes the source's ValidateAndAdjustStopPrice clamp (outside the
 * current bar's range by a 2-tick margin, 5-tick conservative fallback) and the resting stop
 * order itself only ever tightens. Config divergences between what the trader DICTATED and what
 * his code SHIPS are explicit knobs (gate mode, fallback anchor, exit mode) so optimization can
 * arbitrate rather than us guessing — see docs/apps/trading/futures-stop-engine.md.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — resolveInitialStop (candidates→widest, ATR fallback, floor/ceiling), validateStopPrice (2-tick clamp + 5-tick sanity), createFuturesStopEngine per-trade state machine (breakeven-gated chandelier trail, risk-goal arming, Strangle level tracking + ADX-gate latch + underwater stand-down + close-breach market exit). Ported from NT8Custom ATCEntryCountDynStops.cs / ATCEntryCountExport.cs for ADR-116.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The source trader's answers (2026-07-28) become defaults: Strangle gate defaults to 'adx-laguerre' (his stated "both conditions" = ADX + Laguerre RSI) and gains an 'adx-all' mode for the reading where both SECOND clauses are ANDed; initial-stop ATR multiple defaults to 3 (his "Initial Stop ATR Mult (i.e. 3)" floor minimum); new initialStopWaveSource knob defaulting to 'macd' because his current stop reads atcMACDWaveStops alone. Defaults extracted to the exported STOP_ENGINE_DEFAULTS so the backtester's sizing-time estimate cannot drift from the engine's real placement.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial-review fixes: explicit-undefined config values no longer clobber defaults (stripped before the merge — a NaN stop that never triggers was constructible); gateFires is an exhaustive switch whose default is the documented gate, never a silent 'adx-any'; initialStopWaveSource moved OFF StopEngineConfig (the engine never reads it) and lives only in STOP_ENGINE_DEFAULTS for the candidate-building caller.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The %ATR buffer variant the dictation asked for, as a sweepable config (BACKLOG "stop-stack remainder"): stopBufferMode 'ticks' (shipped code, default) | 'atr-percent' (dictated), resolveBuffer shared by the initial stop and the Strangle level, a one-tick floor so a quiet-tape buffer can never collapse to zero, and StopEngineBarInput.atr so the Strangle buffer can breathe with volatility per bar rather than being frozen at entry.
 *
 * @module futures-stop-engine
 */

import type { OhlcvBar } from './market-data';

/** Trade direction the engine manages. */
export type FuturesDirection = 'long' | 'short';

/**
 * Which second condition arms the Strangle latch alongside ADX ≥ threshold.
 *
 * The source trader confirmed (2026-07-28) that his INTENT is "both conditions" — ADX ≥ 30 together
 * with the Laguerre-RSI exhaustion reading — which is `adx-laguerre`, now the default. His shipped
 * C# gate tests the DI/ADX-falling clause instead; `adx-di-or-falling` preserves it for parity runs,
 * and `adx-all` requires every clause in case "both conditions" turns out to mean the two candidate
 * SECOND clauses ANDed (he said he would re-check his own code). The optimizer arbitrates.
 */
export type StrangleGateMode =
  /** As shipped: directional DI below ADX, or ADX falling (ATCEntryCountDynStops.cs). */
  | 'adx-di-or-falling'
  /** His stated intent (DEFAULT): Laguerre RSI at/above the exhaustion threshold. */
  | 'adx-laguerre'
  /** Either second clause. */
  | 'adx-any'
  /** Both second clauses: the Laguerre reading AND the DI/ADX-falling test. */
  | 'adx-all';

/** How a latched Strangle level is enforced. */
export type StrangleExitMode =
  /** As shipped: a CLOSE beyond the level cancels the resting stop and market-exits next bar. */
  | 'close-breach-market'
  /** Alternative under test: the level rides as a plain resting stop (intrabar fills). */
  | 'resting-stop';

/** Base-trail arming mode (the source's TrailingStopMode enum, sans None=manual). */
export type TrailMode = 'none' | 'ts' | 'ts-with-risk-goal';

/**
 * How the stop buffers (initial stop and Strangle level) are measured.
 *
 * The trader's SHIPPED C# uses fixed tick counts — 3 ticks under the initial-stop anchor, 2 ticks
 * beyond the Strangle swing extreme. His DICTATION asked for a percent-of-ATR buffer instead, so
 * that the same configuration breathes with volatility rather than being a constant that is
 * generous on ES and invisible on CL. Both readings ship; the optimizer arbitrates.
 *
 * 'atr-percent' floors at ONE TICK. A percent buffer on a quiet tape can round to zero, and a
 * zero-buffer stop sits exactly ON the swing extreme, where it is touched by the bar that made it.
 */
export type StopBufferMode =
  /** As shipped: `bufferTicks × tickSize` (DEFAULT). */
  | 'ticks'
  /** The dictated variant: `bufferAtrPercent% × ATR`, floored at one tick. */
  | 'atr-percent';

/** Engine configuration. Defaults mirror the newest NT8 generation's shipped values. */
export interface StopEngineConfig {
  direction: FuturesDirection;
  /** Instrument tick size (ES 0.25). */
  tickSize: number;
  /**
   * Initial-stop ATR multiple. Default 3 — the trader's stated current value ("a floor minimum that
   * is based on the ATR * Initial Stop ATR Mult (i.e. 3)", 2026-07-28). It does double duty: the
   * ATR-fallback distance when no wave candidate survives, and — with `initialStopMinRiskFloor` —
   * the MINIMUM stop distance from entry. Raising it therefore widens stops and shrinks risk-percent
   * position sizes; see the sizing note on {@link initialStopMaxRiskAtrFactor}.
   */
  initialStopAtrMultiple?: number;
  /** Initial-stop buffer in ticks (newest gen 3; older gen 2). Read only in 'ticks' buffer mode. */
  initialStopBufferTicks?: number;
  /**
   * Buffer measurement for BOTH the initial stop and the Strangle level (default 'ticks' = the
   * shipped code). Set 'atr-percent' to sweep the dictated variant; see {@link StopBufferMode}.
   * One knob covers both buffers deliberately — the dictation asked for a %ATR *convention*, and
   * two independent modes would let a sweep produce a hybrid he never described.
   */
  stopBufferMode?: StopBufferMode;
  /**
   * Initial-stop buffer as a percent of ATR at the entry bar, used when `stopBufferMode` is
   * 'atr-percent'. Default 10 (≈ the shipped 3-tick ES buffer at a typical hourly ATR, so a sweep
   * starts near parity rather than somewhere arbitrary) — a starting point to optimize, not a
   * ported constant: the dictation named no percentage.
   */
  initialStopBufferAtrPercent?: number;
  /**
   * Strangle-level buffer as a percent of ATR, used when `stopBufferMode` is 'atr-percent'.
   * Default 7 (≈ the shipped 2-tick buffer at the same reference). Evaluated per bar off
   * {@link StopEngineBarInput.atr}, so the level breathes as volatility changes inside a trade;
   * when the caller supplies no per-bar ATR it falls back to the entry bar's, which is the
   * dictation's spirit at worst-case staleness rather than a silent revert to ticks.
   */
  strangleBufferAtrPercent?: number;
  /** ATR-fallback anchor: 'low' (newest gen + dictation) or 'close' (older gen). */
  initialStopFallbackAnchor?: 'low' | 'close';
  /**
   * Candidate admission: 'none' (newest gen — wave candidates are regime-vetted upstream, every
   * finite one competes) or 'beyond-bar-extreme' (older gen — SuperTrend/PSAR must sit beyond the
   * entry bar's low/high to count). Pair 'beyond-bar-extreme' with raw SuperTrend/PSAR candidates.
   */
  initialStopCandidateFilter?: 'none' | 'beyond-bar-extreme';
  /**
   * Widen the stop to at least atrMultiple·ATR from entry (newest gen: true). This is the trader's
   * "floor minimum": a MINIMUM STOP DISTANCE, not a bound on the stop price — a wave low closer than
   * atrMultiple·ATR is pushed out to it.
   */
  initialStopMinRiskFloor?: boolean;
  /**
   * Cap risk at factor × (atrMultiple·ATR); null disables (newest gen: 4). Note the coupling: the cap
   * is a multiple of the FLOOR, so raising `initialStopAtrMultiple` raises both. At the default 3×4
   * the ceiling is 12·ATR, wide enough that a far wave low can still floor risk-percent sizing to
   * zero contracts — the backtester reports those as `skippedZeroQty`, watch it.
   */
  initialStopMaxRiskAtrFactor?: number | null;
  /** Base-trail mode (default 'ts'; 'ts-with-risk-goal' arms only past pctOrigRisk·1R). */
  trailMode?: TrailMode;
  /** Risk multiple for 'ts-with-risk-goal' (source default 1.0 = 1R). */
  pctOrigRisk?: number;
  /** Enable the Strangle exhaustion trail (the port's reason to exist — default true). */
  useStrangleTrail?: boolean;
  /** ADX arm threshold (source default 30; the trader optimizes 30–40). */
  strangleAdxThreshold?: number;
  /** Second arm condition (default the shipped 'adx-di-or-falling'). */
  strangleGateMode?: StrangleGateMode;
  /** Laguerre RSI exhaustion threshold for the dictated gate modes (0–100 scale, default 80). */
  strangleLaguerreRsiThreshold?: number;
  /** Strangle level buffer in ticks beyond the swing extreme (source: 2). */
  strangleBufferTicks?: number;
  /** Swing-scan cap in bars (source: MaximumBarsLookBack 255). */
  strangleLookbackCapBars?: number;
  /** Enforcement mode (default the shipped 'close-breach-market'). */
  strangleExitMode?: StrangleExitMode;
}

/**
 * The engine's default configuration — every value the trader's newest generation ships, plus the
 * intents he confirmed on 2026-07-28 (`strangleGateMode: 'adx-laguerre'`, `initialStopAtrMultiple: 3`,
 * `initialStopWaveSource: 'macd'`).
 *
 * Exported because more than one module needs these numbers: the engine places the real stop, and
 * the backtester independently estimates the same stop at sizing time. Those two MUST agree, and
 * duplicating literals is how they drift apart (the backtester carried its own `?? 1.5` while the
 * engine defaulted 1.5 — correct by luck, and silently wrong the moment either moved).
 */
export const STOP_ENGINE_DEFAULTS = Object.freeze({
  initialStopAtrMultiple: 3,
  /**
   * Which wave tracker's frozen extreme feeds the initial stop — consumed by the CALLER that builds
   * candidates (the backtester), never by the engine itself, which is why it lives here in the
   * shared defaults but NOT on StopEngineConfig: the engine's config surface only advertises what
   * the engine reads. 'macd' = the trader's current code (`atcMACDWaveStops` alone); 'all-waves'
   * also admits the DMI and Ehlers wave extremes, combined WIDEST.
   */
  initialStopWaveSource: 'macd' as 'macd' | 'all-waves',
  initialStopBufferTicks: 3,
  stopBufferMode: 'ticks' as StopBufferMode,
  initialStopBufferAtrPercent: 10,
  strangleBufferAtrPercent: 7,
  initialStopFallbackAnchor: 'low' as 'low' | 'close',
  initialStopCandidateFilter: 'none' as 'none' | 'beyond-bar-extreme',
  initialStopMinRiskFloor: true,
  initialStopMaxRiskAtrFactor: 4 as number | null,
  trailMode: 'ts' as TrailMode,
  pctOrigRisk: 1.0,
  useStrangleTrail: true,
  strangleAdxThreshold: 30,
  strangleGateMode: 'adx-laguerre' as StrangleGateMode,
  strangleLaguerreRsiThreshold: 80,
  strangleBufferTicks: 2,
  strangleLookbackCapBars: 255,
  strangleExitMode: 'close-breach-market' as StrangleExitMode,
});

/**
 * @description The one place a stop buffer is measured, shared by the initial stop and the Strangle
 * level so the two can never drift onto different conventions. In 'ticks' mode it is the shipped
 * `bufferTicks × tickSize`; in 'atr-percent' mode it is `percent% × ATR` floored at one tick.
 *
 * The floor is load-bearing, not defensive padding: on a quiet tape a small percentage of a small
 * ATR rounds toward zero, and a zero-buffer stop rests exactly ON the swing extreme that produced
 * it — the level is then taken out by the very bar that made it, converting the dictated variant
 * into a stop-loss generator. A non-finite ATR falls back to the tick buffer for the same reason.
 * @param mode - Buffer measurement mode.
 * @param tickSize - Instrument tick size.
 * @param bufferTicks - Tick count for 'ticks' mode.
 * @param atr - ATR to measure against in 'atr-percent' mode.
 * @param atrPercent - Percent of ATR for 'atr-percent' mode.
 * @returns The buffer distance in price units (always ≥ one tick).
 */
export function resolveStopBuffer(
  mode: StopBufferMode,
  tickSize: number,
  bufferTicks: number,
  atr: number,
  atrPercent: number,
): number {
  if (mode !== 'atr-percent') return tickSize * bufferTicks;
  if (!Number.isFinite(atr) || atr <= 0) return tickSize * bufferTicks;
  return Math.max(tickSize, atr * atrPercent / 100);
}

/** A named candidate level for the initial stop (SuperTrend dot, PSAR, wave extreme…). */
export interface InitialStopCandidate { name: string; value: number }

/** Per-bar indicator inputs the engine consumes (bar-close values). */
export interface StopEngineBarInput {
  /** The completed bar. */
  bar: OhlcvBar;
  /** Chandelier band value for the trade's direction (stopLong for longs, stopShort for shorts). */
  chandelierStop?: number;
  /** ADX at this bar and the prior bar (the gate needs both for the falling test). */
  adx?: number;
  adxPrev?: number;
  /** +DI / −DI at this bar (the gate reads the directional one). */
  plusDi?: number;
  minusDi?: number;
  /** Laguerre RSI 0–100 at this bar (only read by the dictated gate modes). */
  laguerreRsi?: number;
  /**
   * ATR at this bar. Read ONLY in 'atr-percent' buffer mode, where the Strangle level's buffer is
   * re-measured each bar so it tracks volatility inside the trade. Omitted (or non-finite) falls
   * back to the entry bar's ATR — the buffer then goes stale rather than silently reverting to
   * ticks, which would make a swept 'atr-percent' run secretly a 'ticks' run.
   */
  atr?: number;
}

/** What the engine wants done after a bar: the resting stop level and/or an immediate exit. */
export interface StopEngineDecision {
  /** Resting stop-market level to hold (null = no resting stop working, e.g. pending market exit). */
  restingStop: number | null;
  /** Name of the resting stop order ('InitialStop' | 'TrailStop' | 'Strangle'). */
  restingStopName: string | null;
  /** True exactly once: flatten at market NOW (the Strangle close-breach, executed next bar). */
  exitAtMarket: boolean;
  /**
   * True on the bar whose CLOSE breached the Strangle level — i.e. the bar on which NT submits the
   * market order. A caller that models fills itself should act on THIS (fill at the next bar's
   * open) and ignore `exitAtMarket`, which is the engine's own one-bar deferral for callers that
   * do not. Acting on both defers the exit twice and leaves the position unprotected for a bar.
   */
  marketExitPending: boolean;
  /** Whether the Strangle latch is set. */
  strangleLatched: boolean;
  /** The current Strangle level (NaN until seeded). */
  strangleLevel: number;
  /** Human-readable state transitions this bar (for logs/tests). */
  events: string[];
}

/**
 * @description The source's ValidateAndAdjustStopPrice: a long stop must sit at least 2 ticks
 * below the current bar's low (short: above the high); if the clamp lands absurdly far
 * (>20% beyond the bar), fall back to a conservative 5-tick margin.
 * @param direction - Trade direction.
 * @param proposed - Proposed stop level.
 * @param bar - The current bar (its low/high bound the clamp).
 * @param tickSize - Instrument tick size.
 * @returns The validated stop level.
 */
export function validateStopPrice(direction: FuturesDirection, proposed: number, bar: OhlcvBar, tickSize: number): number {
  const margin = Math.max(tickSize * 2, tickSize * 0.1);
  if (direction === 'long') {
    if (proposed >= bar.l - margin) {
      const adjusted = bar.l - margin;
      return adjusted < bar.l * 0.8 ? bar.l - tickSize * 5 : adjusted;
    }
    return proposed;
  }
  if (proposed <= bar.h + margin) {
    const adjusted = bar.h + margin;
    return adjusted > bar.h * 1.2 ? bar.h + tickSize * 5 : adjusted;
  }
  return proposed;
}

/** Parameters for {@link resolveInitialStop}. */
export interface InitialStopParams {
  direction: FuturesDirection;
  entryPrice: number;
  /** The entry bar (candidate filter + fallback anchor read it). */
  bar: OhlcvBar;
  /** ATR at the entry bar. */
  atr: number;
  /** Candidate levels (already direction-appropriate: stops below price for longs). */
  candidates: InitialStopCandidate[];
  tickSize: number;
  atrMultiple: number;
  bufferTicks: number;
  /** Buffer measurement (default 'ticks' — the shipped code — when the caller omits it). */
  bufferMode?: StopBufferMode;
  /** Percent of ATR for 'atr-percent' buffer mode. */
  bufferAtrPercent?: number;
  fallbackAnchor: 'low' | 'close';
  /** 'none' = accept every finite candidate (newest gen); 'beyond-bar-extreme' = older gen filter. */
  candidateFilter: 'none' | 'beyond-bar-extreme';
  minRiskFloor: boolean;
  maxRiskAtrFactor: number | null;
}

/**
 * @description Initial-stop resolver covering both NT8 generations. Candidate admission is
 * per-generation: the newest gen accepts every finite (regime-vetted) candidate, the older gen
 * requires candidates strictly beyond the entry bar's extreme (long: below the low). Survivors
 * combine WIDEST (the source takes Math.Min of the surviving levels for longs — its comment says
 * "tighter" but the code takes the farther level; we port the code). No survivor → fallback
 * anchor − atrMultiple·ATR.
 * A tick buffer widens either path. Optional floor (widen to ≥ atrMultiple·ATR from entry) and
 * ceiling (cap at factor × the floor distance — the ES far-wave sizing guard) mirror the newest
 * generation. Mirrored for shorts.
 * @param p - Resolver parameters.
 * @returns The initial stop level (pre order-validation).
 */
export function resolveInitialStop(p: InitialStopParams): number {
  const long = p.direction === 'long';
  const buffer = resolveStopBuffer(
    p.bufferMode ?? STOP_ENGINE_DEFAULTS.stopBufferMode,
    p.tickSize,
    p.bufferTicks,
    p.atr,
    p.bufferAtrPercent ?? STOP_ENGINE_DEFAULTS.initialStopBufferAtrPercent,
  );
  const anchor = p.fallbackAnchor === 'low' ? (long ? p.bar.l : p.bar.h) : p.bar.c;
  const surviving = p.candidates
    .map((c) => c.value)
    .filter((v) => Number.isFinite(v)
      && (p.candidateFilter === 'none' || (long ? v < p.bar.l : v > p.bar.h)));
  let stop: number;
  if (surviving.length) {
    stop = long ? Math.min(...surviving) : Math.max(...surviving);
  } else {
    stop = long ? anchor - p.atrMultiple * p.atr : anchor + p.atrMultiple * p.atr;
  }
  stop = long ? stop - buffer : stop + buffer;
  const minRisk = p.atrMultiple * p.atr;
  if (p.minRiskFloor) {
    const floorStop = long ? p.entryPrice - minRisk - buffer : p.entryPrice + minRisk + buffer;
    stop = long ? Math.min(stop, floorStop) : Math.max(stop, floorStop);
  }
  if (p.maxRiskAtrFactor != null) {
    const maxRisk = minRisk * p.maxRiskAtrFactor;
    if (maxRisk > p.tickSize) {
      const ceilingStop = long ? p.entryPrice - maxRisk - buffer : p.entryPrice + maxRisk + buffer;
      stop = long ? Math.max(stop, ceilingStop) : Math.min(stop, ceilingStop);
    }
  }
  return stop;
}

/** The per-trade stop engine. Create at entry, feed each completed bar, act on the decision. */
export interface FuturesStopEngine {
  /** Initialize on the entry fill; returns the initial decision (the resting InitialStop). */
  onEntry(entryPrice: number, entryBar: OhlcvBar, atr: number, candidates?: InitialStopCandidate[]): StopEngineDecision;
  /** Advance one completed bar; returns what to do with the stop (call after onEntry). */
  onBar(input: StopEngineBarInput): StopEngineDecision;
  /** The initial risk per unit (|entry − initial stop|), for sizing and the risk-goal gate. */
  initialRisk(): number;
}

/**
 * @description Creates the per-trade stop state machine (see module doc for the three layers).
 * Pure logic: the caller owns order placement and position state; the engine owns stop levels,
 * the breakeven/risk-goal gates, the Strangle latch lifecycle, and the tighten-only invariant.
 * @param config - Engine configuration (defaults = the newest NT8 generation's shipped values).
 * @returns A {@link FuturesStopEngine}.
 */
export function createFuturesStopEngine(config: StopEngineConfig): FuturesStopEngine {
  // Strip explicit-undefined values before merging: `{ initialStopAtrMultiple: undefined }`
  // typechecks (exactOptionalPropertyTypes is off) and a plain spread would let it overwrite the
  // frozen default, yielding a NaN stop that never triggers. Omitted and undefined must both mean
  // "use the default".
  const provided = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
  const cfg = { ...STOP_ENGINE_DEFAULTS, ...(provided as StopEngineConfig) };
  const long = cfg.direction === 'long';
  const bars: OhlcvBar[] = [];
  let entryPrice = NaN;
  let risk = NaN;
  let restingStop: number | null = null;
  let restingStopName: string | null = null;
  let latched = false;
  let pendingExit = false;
  let closed = false;
  let level = NaN;
  let extremeClose = NaN;
  let extremeBar = -1; // offset into bars[]
  /** ATR at entry — the 'atr-percent' Strangle buffer's fallback when a bar carries no ATR. */
  let entryAtr = NaN;
  /** ATR at the bar being processed, refreshed by onBar; drives the per-bar Strangle buffer. */
  let currentAtr = NaN;

  /** The Strangle-level buffer for the bar in hand, in the configured measurement. */
  function strangleBuffer(): number {
    const atr = Number.isFinite(currentAtr) ? currentAtr : entryAtr;
    return resolveStopBuffer(cfg.stopBufferMode, cfg.tickSize, cfg.strangleBufferTicks, atr, cfg.strangleBufferAtrPercent);
  }

  const beyondEntry = (close: number) => (long ? close > entryPrice : close < entryPrice);
  const profitSide = (v: number) => (long ? v > entryPrice : v < entryPrice);

  /** Lowest low (long) / highest high (short) from bar offset `from` through now, capped, inclusive. */
  function swingExtreme(from: number): number {
    const last = bars.length - 1;
    const start = Math.max(from, last - cfg.strangleLookbackCapBars, 0);
    let ext = long ? Infinity : -Infinity;
    for (let i = start; i <= last; i++) ext = long ? Math.min(ext, bars[i].l) : Math.max(ext, bars[i].h);
    return ext;
  }

  /** Ports UpdateStrangleTrailPrice: seed on first beyond-entry close, tighten on new extreme closes. */
  function updateStrangleLevel(events: string[]): void {
    const bar = bars[bars.length - 1];
    if (!beyondEntry(bar.c)) return;
    const buf = strangleBuffer();
    if (Number.isNaN(extremeClose) || extremeBar < 0) {
      extremeClose = bar.c;
      extremeBar = bars.length - 1;
      const swing = swingExtreme(0);
      level = long ? swing - buf : swing + buf;
      events.push(`strangle-seeded@${level}`);
      return;
    }
    const newExtreme = long ? bar.c > extremeClose : bar.c < extremeClose;
    if (!newExtreme) return;
    const proposed = long ? swingExtreme(extremeBar) - buf : swingExtreme(extremeBar) + buf;
    const tightens = Number.isNaN(level)
      || (long ? proposed >= level + cfg.tickSize : proposed <= level - cfg.tickSize);
    extremeClose = bar.c;
    extremeBar = bars.length - 1;
    if (tightens) {
      level = proposed;
      events.push(`strangle-tightened@${level}`);
    }
  }

  /** Ports ApplyTrailingStopOrder: validate, tighten-only, rename on layer change. */
  function applyStop(proposed: number, name: 'TrailStop' | 'Strangle', events: string[]): void {
    const bar = bars[bars.length - 1];
    if (name === 'Strangle' && !profitSide(proposed)) return;
    const validated = validateStopPrice(cfg.direction, proposed, bar, cfg.tickSize);
    if (name === 'Strangle' && !profitSide(validated)) return;
    if (restingStop != null) {
      const tightens = long ? validated >= restingStop + cfg.tickSize : validated <= restingStop - cfg.tickSize;
      if (!tightens) return;
    }
    restingStop = validated;
    restingStopName = name;
    if (name === 'Strangle') level = validated;
    events.push(`${name.toLowerCase()}@${validated}`);
  }

  /** Ports UpdateTrailingStop: risk-goal arming + the ≥1-tick-beyond-breakeven chandelier gate. */
  function updateChandelierTrail(input: StopEngineBarInput, events: string[]): void {
    if (cfg.trailMode === 'none') return;
    const close = input.bar.c;
    if (cfg.trailMode === 'ts-with-risk-goal') {
      if (!(risk > 0)) return;
      const openProfit = long ? close - entryPrice : entryPrice - close;
      if (!(openProfit > risk * cfg.pctOrigRisk)) return;
    }
    const band = input.chandelierStop;
    if (band == null || !Number.isFinite(band)) return;
    // The literal breakeven gate: the band must be better than entry by ≥ 1 tick.
    if (long ? band < entryPrice + cfg.tickSize : band > entryPrice - cfg.tickSize) return;
    applyStop(band, 'TrailStop', events);
  }

  /** Ports TryActivateStrangleGate plus the dictated Laguerre-RSI gate variants. */
  function gateFires(input: StopEngineBarInput): boolean {
    if (!cfg.useStrangleTrail || !beyondEntry(input.bar.c)) return false;
    const { adx, adxPrev } = input;
    if (adx == null || adxPrev == null || Number.isNaN(adx) || Number.isNaN(adxPrev)) return false;
    if (adx < cfg.strangleAdxThreshold) return false;
    const di = long ? input.plusDi : input.minusDi;
    const shipped = di != null && !Number.isNaN(di) && (di < adx || adx < adxPrev);
    const dictated = input.laguerreRsi != null && !Number.isNaN(input.laguerreRsi)
      && input.laguerreRsi >= cfg.strangleLaguerreRsiThreshold;
    // Exhaustive on purpose: an unexpected mode value must behave as the DOCUMENTED default, never
    // silently widen to 'adx-any' via a fallthrough.
    switch (cfg.strangleGateMode) {
      case 'adx-di-or-falling': return shipped;
      case 'adx-laguerre': return dictated;
      case 'adx-all': return shipped && dictated;
      case 'adx-any': return shipped || dictated;
      default: return dictated;
    }
  }

  /** Breach = the CLOSE is at/beyond the Strangle level (never intrabar, never when unseeded). */
  const breached = (close: number) => !Number.isNaN(level) && (long ? close <= level : close >= level);

  function decide(exitAtMarket: boolean, events: string[]): StopEngineDecision {
    return {
      restingStop, restingStopName, exitAtMarket,
      marketExitPending: pendingExit,
      strangleLatched: latched, strangleLevel: level, events,
    };
  }

  /** Ports the strategy's latched+profitable branch: breach → market exit, else apply-if-better. */
  function enforceStrangle(events: string[]): void {
    const bar = bars[bars.length - 1];
    if (cfg.strangleExitMode === 'close-breach-market' && breached(bar.c)) {
      pendingExit = true;
      restingStop = null; // CancelWorkingStopOrder — the market exit goes out next bar
      restingStopName = null;
      events.push('strangle-breach-pending-exit');
      return;
    }
    applyStop(level, 'Strangle', events);
  }

  return {
    onEntry(entry: number, entryBar: OhlcvBar, atr: number, candidates: InitialStopCandidate[] = []): StopEngineDecision {
      entryPrice = entry;
      entryAtr = atr;
      currentAtr = atr;
      bars.push(entryBar);
      const raw = resolveInitialStop({
        direction: cfg.direction,
        entryPrice: entry,
        bar: entryBar,
        atr,
        candidates,
        tickSize: cfg.tickSize,
        atrMultiple: cfg.initialStopAtrMultiple,
        bufferTicks: cfg.initialStopBufferTicks,
        bufferMode: cfg.stopBufferMode,
        bufferAtrPercent: cfg.initialStopBufferAtrPercent,
        fallbackAnchor: cfg.initialStopFallbackAnchor,
        candidateFilter: cfg.initialStopCandidateFilter,
        minRiskFloor: cfg.initialStopMinRiskFloor,
        maxRiskAtrFactor: cfg.initialStopMaxRiskAtrFactor,
      });
      restingStop = validateStopPrice(cfg.direction, raw, entryBar, cfg.tickSize);
      restingStopName = 'InitialStop';
      risk = Math.abs(entry - restingStop);
      return decide(false, [`initialstop@${restingStop}`]);
    },

    onBar(input: StopEngineBarInput): StopEngineDecision {
      const events: string[] = [];
      if (closed) return decide(false, events);
      if (pendingExit) {
        pendingExit = false;
        closed = true;
        return decide(true, ['strangle-market-exit']);
      }
      bars.push(input.bar); // per-trade engine: growth is bounded by trade duration; the swing SCAN is capped, storage need not be
      if (input.atr != null && Number.isFinite(input.atr)) currentAtr = input.atr;
      if (cfg.useStrangleTrail) updateStrangleLevel(events);
      const profitable = beyondEntry(input.bar.c);
      if (latched && profitable) {
        enforceStrangle(events);
      } else {
        updateChandelierTrail(input, events);
        if (!latched && gateFires(input)) {
          latched = true;
          events.push('strangle-latched');
          enforceStrangle(events);
        }
      }
      return decide(false, events);
    },

    initialRisk(): number {
      return risk;
    },
  };
}
