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
 *
 * @module futures-stop-engine
 */

import type { OhlcvBar } from './market-data';

/** Trade direction the engine manages. */
export type FuturesDirection = 'long' | 'short';

/** Which second condition arms the Strangle latch alongside ADX ≥ threshold. */
export type StrangleGateMode =
  /** As shipped: directional DI below ADX, or ADX falling (ATCEntryCountDynStops.cs). */
  | 'adx-di-or-falling'
  /** As dictated: Laguerre RSI at/above the exhaustion threshold. */
  | 'adx-laguerre'
  /** Either of the above. */
  | 'adx-any';

/** How a latched Strangle level is enforced. */
export type StrangleExitMode =
  /** As shipped: a CLOSE beyond the level cancels the resting stop and market-exits next bar. */
  | 'close-breach-market'
  /** Alternative under test: the level rides as a plain resting stop (intrabar fills). */
  | 'resting-stop';

/** Base-trail arming mode (the source's TrailingStopMode enum, sans None=manual). */
export type TrailMode = 'none' | 'ts' | 'ts-with-risk-goal';

/** Engine configuration. Defaults mirror the newest NT8 generation's shipped values. */
export interface StopEngineConfig {
  direction: FuturesDirection;
  /** Instrument tick size (ES 0.25). */
  tickSize: number;
  /** Initial-stop ATR multiple (source default 1.5). */
  initialStopAtrMultiple?: number;
  /** Initial-stop buffer in ticks (newest gen 3; older gen 2). */
  initialStopBufferTicks?: number;
  /** ATR-fallback anchor: 'low' (newest gen + dictation) or 'close' (older gen). */
  initialStopFallbackAnchor?: 'low' | 'close';
  /**
   * Candidate admission: 'none' (newest gen — wave candidates are regime-vetted upstream, every
   * finite one competes) or 'beyond-bar-extreme' (older gen — SuperTrend/PSAR must sit beyond the
   * entry bar's low/high to count). Pair 'beyond-bar-extreme' with raw SuperTrend/PSAR candidates.
   */
  initialStopCandidateFilter?: 'none' | 'beyond-bar-extreme';
  /** Widen the stop to at least atrMultiple·ATR from entry (newest gen: true). */
  initialStopMinRiskFloor?: boolean;
  /** Cap risk at factor × (atrMultiple·ATR); null disables (newest gen: 4). */
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
  const buffer = p.tickSize * p.bufferTicks;
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
  const cfg = {
    initialStopAtrMultiple: 1.5,
    initialStopBufferTicks: 3,
    initialStopFallbackAnchor: 'low' as const,
    initialStopCandidateFilter: 'none' as const,
    initialStopMinRiskFloor: true,
    initialStopMaxRiskAtrFactor: 4 as number | null,
    trailMode: 'ts' as TrailMode,
    pctOrigRisk: 1.0,
    useStrangleTrail: true,
    strangleAdxThreshold: 30,
    strangleGateMode: 'adx-di-or-falling' as StrangleGateMode,
    strangleLaguerreRsiThreshold: 80,
    strangleBufferTicks: 2,
    strangleLookbackCapBars: 255,
    strangleExitMode: 'close-breach-market' as StrangleExitMode,
    ...config,
  };
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
    const buf = cfg.tickSize * cfg.strangleBufferTicks;
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
    const dictated = input.laguerreRsi != null && input.laguerreRsi >= cfg.strangleLaguerreRsiThreshold;
    if (cfg.strangleGateMode === 'adx-di-or-falling') return shipped;
    if (cfg.strangleGateMode === 'adx-laguerre') return dictated;
    return shipped || dictated;
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
