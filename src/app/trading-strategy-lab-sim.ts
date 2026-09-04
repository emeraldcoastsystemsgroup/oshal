/**
 * Strategy Lab sim engine (ADR-092) — walk a saved strategy config over daily bars using the
 * LIVE engine's own pure functions (decideSymbol / rankUniverse + the portfolio money-manager),
 * exactly like the CLI harnesses, so a lab run measures the real strategy, not a re-implementation.
 *
 * One walk core serves BOTH modes: `runBacktest` initializes a book and walks a historical
 * window; `forwardStep` resumes a persisted book on sessions newer than its `lastDate`, so every
 * saved variation accrues an out-of-sample curve daily. Alignment is SPY-calendar with
 * carry-forward marking (a symbol missing a session marks at its last real close — how a live
 * book marks) and a real-bar eligibility gate (60+ real closes before a symbol can be ranked or
 * decided), which structurally prevents the NaN-poisoning failure the 2026-07-08 strict-filter
 * fix addressed. Data: SIP historical dailies (consolidated tape, free on the paper key) with
 * IEX fallback; the feed used is reported on every result.
 *
 * HONEST LIMITS (inherited from the harnesses, printed on every run row): daily bars only (the
 * 5-min/1-hour exit legs are not modeled), fills at the session close, no slippage/commission.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — config normalization, SPY-calendar aligned fetch (sip→iex), rotation + ensemble walk kinds with SPY-core sleeve, serializable walk state for forward continuation, and curve metrics (return/CAGR/Sharpe/maxDD/win-rate vs SPY).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BLEND kind (ADR-095 round 2 — "30% into this strategy, 20% into that one"): components are embedded rotation configs with weightPct; the sim walks each component as an INDEPENDENT sub-book on weight%×100k (component corePct ignored — the blend's remainder IS the core) and sums the curves; forward continuation persists per-component states under WalkState.parts. snapshotConfig resolves per-component universes so blend regressions replay deterministically.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session-shape metrics for the knob-sweep leaderboard: avgDailyPct (3dp — a real daily mean lives in the hundredths), bestDayPct, worstDayPct, all derived from the `rets` array the Sharpe already builds (no extra passes). Additive only — the regression drift check compares totalReturnPct/maxDrawdownPct/trades, so pre-existing baselines without these fields cannot false-drift.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | earningsGateDays knob (0=off, rotation kind only) — the live TRADING_EARNINGS_GATE as a LAB permutation, so gate-on/gate-off twin rows forward-walk side by side instead of the rule living untested outside the matrix. attachEarningsGate builds a per-session blackout map from world_events (scheduledEventsBetween; session-distance semantics on the walk's own calendar); the rotation branch excludes gated names from the leaderboard (never bought; a HELD printing name drops off and is sold — mirrors live rotateSleeve). Honest limits: calendar exists only from 2026-06-25 (earlier backtest segments are ungated = identical to the gate-off twin; the FORWARD walk is the real A/B), blends zero the knob (blendPartConfig) rather than silently ignoring it, and a calendar-read failure runs ungated exactly like the live gate.
 *
 * @module trading-strategy-lab-sim
 */

import {
  barsBatchSince, decideSymbol, DEFAULT_UNIVERSE, RISK_POLICIES,
  sizeEntry, exitsToRun, trailingExits, nextPeaks, rotationBenches,
} from '@/features/trading';
import type {
  DatedClose, Timeframe, RiskPosture, RiskPolicy, NameStrength, Position, BrokerAccount,
} from '@/features/trading';
import { rankUniverse } from './trading-schedule-dispatch';
import { createWorldIntelligenceService } from '@/features/world-data';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'trading-strategy-lab-sim' });

/** Every walk starts from the same notional so curves are comparable across strategies. */
export const LAB_START_CASH = 100_000;

/** One slice of a blend: an embedded (snapshot) rotation config running weightPct of the money.
 *  Embedded at blend-creation time — editing the source strategy later does NOT mutate the blend. */
export interface BlendComponent { name: string; weightPct: number; config: StrategyConfig }

/** A saved strategy variation — every knob the walk consumes. */
export interface StrategyConfig {
  /** Walk kind: 'rotation' = production rankUniverse rotation; 'ensemble' = decideSymbol scan
   *  sleeve; 'blend' = weighted portfolio of embedded rotation components (ADR-095 round 2). */
  kind: 'rotation' | 'ensemble' | 'blend';
  /** Blend components (kind 'blend' only): each runs weightPct of the money as its own sub-book;
   *  corePct is derived as 100 − Σ weights (component corePct is deliberately ignored). */
  components?: BlendComponent[];
  /** Risk-policy posture (sizing caps, stops, take-profit, trailing dials). */
  posture: RiskPosture;
  /** Percent of starting equity parked in coreSymbol at walk start and never touched (0 = none). */
  corePct: number;
  /** The core sleeve symbol (default SPY). */
  coreSymbol: string;
  /** Take-profit override in percent (null = the posture's own takeProfitPct). */
  takeProfitPct: number | null;
  /** Rotation ranking function (rotation kind only). */
  rank: 'gravity' | 'momentum' | 'ensemble' | 'blend';
  /** Rotation rebalance cadence in trading days (rotation kind only). */
  cadenceDays: number;
  /** Rotation leaderboard size (rotation kind only). */
  topN: number;
  /** Rotation goal weighting (rotation kind only). */
  weighting: 'conviction' | 'equal';
  /** Universe override; empty = DEFAULT_UNIVERSE. */
  universe: string[];
  /** Bars consumed before the first decision (rankUniverse needs 60+ closes). */
  warmupDays: number;
  /** Calendar-day lookback for a backtest fetch. */
  windowDays: number;
  /**
   * Earnings-blackout gate in SESSIONS (0 = off; rotation kind only). Mirrors the live
   * TRADING_EARNINGS_GATE: a name printing within this many sessions is excluded from the
   * leaderboard — so it is never bought AND a held printing name drops off and gets sold.
   * HONESTY NOTE: the calendar (world_events) only exists from 2026-06-25 onward, so backtest
   * segments before that are ungated (identical to the gate-off twin) — the FORWARD walk is
   * where gate-on/gate-off rows genuinely diverge. Sessions with no calendar rows are no-ops.
   */
  earningsGateDays: number;
}

/** One open lot in the walk book. */
export interface LabLot { qty: number; entry: number; peak: number }

/** Serializable walk state — everything a forward step needs to resume the book. */
export interface WalkState {
  cash: number;
  lots: Record<string, LabLot>;
  coreQty: number;
  /** Blend walks only: each component's own resumable sub-book, keyed by component index. */
  parts?: Record<string, WalkState>;
  /** Bars stepped since warmup — drives the rotation cadence across resumes. */
  barCount: number;
  peakEquity: number;
  maxDD: number;
  wins: number;
  losses: number;
  trades: number;
  /** Last session date applied (YYYY-MM-DD); forward steps only consume newer sessions. */
  lastDate: string;
  /** SPY close at walk start — anchors the benchmark line across backtest + forward segments. */
  spyAnchor: number;
}

/** One point on a strategy's equity timeline (strategy equity + SPY benchmark, both from 100k). */
export interface EquityPoint { d: string; e: number; s: number }

/** Metrics computed from a curve — the tearsheet numbers persisted on every run. */
export interface LabMetrics {
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  winRatePct: number;
  trades: number;
  spyReturnPct: number;
  alphaVsSpyPct: number;
  bars: number;
  /** Mean session-over-session return, percent (3dp — a typical daily mean is a few hundredths). */
  avgDailyPct: number;
  /** Best single session in the segment, percent. */
  bestDayPct: number;
  /** Worst single session in the segment, percent — the pair-mate that keeps bestDay honest. */
  worstDayPct: number;
}

/** A completed sim segment: the curve, its metrics, the resumable state, and data provenance. */
export interface SimResult {
  curve: EquityPoint[];
  metrics: LabMetrics;
  /** The capital this run started from (LAB_START_CASH unless the caller sized it to an account). */
  startCash?: number;
  state: WalkState;
  windowStart: string;
  windowEnd: string;
  bars: number;
  feed: 'sip' | 'iex';
  /** First aligned session of the fetch — regressions pin this to reproduce the run exactly. */
  fetchStart: string;
}

/**
 * @description Validates + defaults a raw config object into a walkable StrategyConfig. Throws
 * with a caller-safe message on junk so routes can 400 instead of walking garbage.
 * @param raw - Untrusted config (route body / DB row).
 * @returns The normalized config.
 */
export function normalizeConfig(raw: unknown): StrategyConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = r.kind === 'ensemble' ? 'ensemble' : r.kind === 'blend' ? 'blend' : 'rotation';
  const posture = (typeof r.posture === 'string' && r.posture in RISK_POLICIES ? r.posture : 'active') as RiskPosture;
  const num = (v: unknown, def: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  if (kind === 'blend') return normalizeBlend(r, num);
  const rank = (['gravity', 'momentum', 'ensemble', 'blend'] as const).includes(r.rank as never) ? (r.rank as StrategyConfig['rank']) : 'gravity';
  const universe = Array.isArray(r.universe)
    ? [...new Set(r.universe.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z.]{1,6}$/.test(s)))]
    : [];
  if (Array.isArray(r.universe) && r.universe.length && !universe.length) throw new Error('universe contained no valid tickers');
  const tp = r.takeProfitPct == null || r.takeProfitPct === '' ? null : num(r.takeProfitPct, 0, 1, 95);
  if (tp !== null && tp === 0) throw new Error('takeProfitPct must be 1–95 or null');
  return {
    kind, posture, rank, universe,
    corePct: num(r.corePct, 0, 0, 90),
    coreSymbol: typeof r.coreSymbol === 'string' && /^[A-Z.]{1,6}$/.test(r.coreSymbol.toUpperCase()) ? r.coreSymbol.toUpperCase() : 'SPY',
    takeProfitPct: tp,
    cadenceDays: Math.round(num(r.cadenceDays, 1, 1, 63)),
    topN: Math.round(num(r.topN, 12, 1, 64)),
    weighting: r.weighting === 'equal' ? 'equal' : 'conviction',
    warmupDays: Math.round(num(r.warmupDays, 80, 61, 220)),
    windowDays: Math.round(num(r.windowDays, 780, 200, 2000)),
    earningsGateDays: Math.round(num(r.earningsGateDays, 0, 0, 10)),
  };
}

/** Blend validation + derivation: components are embedded rotation configs; the blend's corePct is
 *  the unallocated remainder (100 − Σ weights); cadence/warmup derive from the components. */
function normalizeBlend(r: Record<string, unknown>, num: (v: unknown, def: number, min: number, max: number) => number): StrategyConfig {
  const rawComponents = Array.isArray(r.components) ? r.components : [];
  if (rawComponents.length < 2 || rawComponents.length > 6) throw new Error('a blend needs 2–6 components');
  const components: BlendComponent[] = rawComponents.map((c, i) => {
    const cc = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const config = normalizeConfig(cc.config);
    if (config.kind !== 'rotation') throw new Error(`blend component ${i + 1} must be a rotation strategy (got ${config.kind})`);
    const weightPct = Math.round(num(cc.weightPct, 0, 1, 95));
    if (weightPct < 1) throw new Error(`blend component ${i + 1} needs a weightPct of 1–95`);
    return { name: String(cc.name || `component ${i + 1}`).slice(0, 80), weightPct, config };
  });
  const totalWeight = components.reduce((s, c) => s + c.weightPct, 0);
  if (totalWeight > 100) throw new Error(`blend weights sum to ${totalWeight}% — must be ≤ 100`);
  return {
    kind: 'blend', components,
    posture: components[0].config.posture, // display only — walks use per-component policies
    corePct: Math.max(0, Math.min(95, 100 - totalWeight)),
    coreSymbol: typeof r.coreSymbol === 'string' && /^[A-Z.]{1,6}$/.test(String(r.coreSymbol).toUpperCase()) ? String(r.coreSymbol).toUpperCase() : 'SPY',
    takeProfitPct: null,
    rank: 'gravity', topN: 12, weighting: 'conviction', universe: [],
    cadenceDays: Math.min(...components.map((c) => c.config.cadenceDays)),
    warmupDays: Math.max(...components.map((c) => c.config.warmupDays)),
    windowDays: Math.round(num(r.windowDays, 780, 200, 2000)),
    earningsGateDays: 0, // blend walks are not gate-instrumented; components carry their own knob
  };
}

/** A component's config as the sub-walk runs it: its own knobs, but corePct 0 (the BLEND owns the
 *  core — a component's designed core would double-count ballast inside its slice) and
 *  earningsGateDays 0 (blend walks don't attach the calendar map — a component knob would be
 *  silently ignored, which is worse than an honest "not supported in blends"). */
export function blendPartConfig(c: BlendComponent): StrategyConfig {
  return { ...c.config, corePct: 0, earningsGateDays: 0 };
}

/** Resolved-universe snapshot for regression replay: DEFAULT_UNIVERSE changes between deploys, so
 *  the persisted config pins the names the run actually saw — per component for blends. */
export function snapshotConfig(cfg: StrategyConfig): StrategyConfig {
  if (cfg.kind === 'blend') {
    return {
      ...cfg,
      components: (cfg.components ?? []).map((c) => ({
        ...c, config: { ...c.config, universe: c.config.universe.length ? c.config.universe : [...DEFAULT_UNIVERSE] },
      })),
    };
  }
  return { ...cfg, universe: cfg.universe.length ? cfg.universe : [...DEFAULT_UNIVERSE] };
}

/** The effective risk policy for a config (posture dials + the take-profit override). For a blend
 *  this is the MOST CONSERVATIVE view (tightest stop, earliest take-profit) — the per-component
 *  policies drive the sub-walks; this composite is what book-level consumers (live exits) use. */
export function policyFor(cfg: StrategyConfig): RiskPolicy {
  if (cfg.kind === 'blend' && cfg.components?.length) {
    const policies = cfg.components.map((c) => policyFor(blendPartConfig(c)));
    const tightest = policies.reduce((a, b) => (b.stopLossPct < a.stopLossPct ? b : a));
    return { ...tightest, takeProfitPct: Math.min(...policies.map((p) => p.takeProfitPct)) };
  }
  const base = RISK_POLICIES[cfg.posture] ?? RISK_POLICIES.balanced;
  return cfg.takeProfitPct != null ? { ...base, takeProfitPct: cfg.takeProfitPct } : base;
}

/** SPY-calendar aligned series: closes per symbol carry-forward-filled from each one's first real bar. */
interface Aligned {
  dates: string[];
  spy: number[];
  /** symbol → { firstReal: calendar index of its first real bar, closes: aligned closes (defined from firstReal on) }. */
  series: Map<string, { firstReal: number; closes: number[] }>;
  feed: 'sip' | 'iex';
  /** Session date → symbols in earnings blackout on that session (attachEarningsGate; absent = ungated). */
  gate?: Map<string, Set<string>>;
}

/**
 * @description Builds the per-session earnings-blackout map onto an Aligned window: symbol S is
 * blocked on session D when a scheduled print falls within the next `gateDays` SESSIONS after D
 * (session distance measured on the walk's own aligned calendar — the sim twin of the live gate's
 * calendar-days lookahead). Reads world_events via the world service; best-effort by design — the
 * world layer being off, an empty calendar, or a read failure leaves the window ungated (exactly
 * like the live gate's failure mode) and pre-2026-06-25 sessions are always ungated because the
 * calendar was not collected yet.
 * @param a - The aligned window (mutated: a.gate is set).
 * @param gateDays - Blackout width in sessions (>=1).
 */
export async function attachEarningsGate(a: Aligned, gateDays: number): Promise<void> {
  try {
    const svc = createWorldIntelligenceService();
    if (!svc) { a.gate = new Map(); return; }
    const last = a.dates[a.dates.length - 1];
    // Events up to ~3 calendar weeks past the window end so the final sessions can see forward.
    const toIso = new Date(new Date(last + 'T00:00:00Z').getTime() + 21 * 86400e3).toISOString().slice(0, 10);
    const events = await svc.scheduledEventsBetween('earnings', a.dates[0], toIso + 'T23:59:59Z');
    const gate = new Map<string, Set<string>>();
    for (const ev of events) {
      const sym = ev.entityId.replace(/^world:ticker:/, '').toUpperCase();
      if (!sym || sym === ev.entityId.toUpperCase()) continue;
      const printDay = ev.scheduledAt.slice(0, 10);
      // First session index at/after the print; block the `gateDays` sessions BEFORE it. A print
      // beyond the last session still blocks the tail sessions inside its window.
      let i = a.dates.findIndex((d) => d >= printDay);
      if (i < 0) i = a.dates.length;
      for (let k = Math.max(0, i - gateDays); k < i; k++) {
        let set = gate.get(a.dates[k]);
        if (!set) { set = new Set(); gate.set(a.dates[k], set); }
        set.add(sym);
      }
    }
    a.gate = gate;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'earnings-gate calendar read failed — walk runs UNGATED (matches the live gate failure mode)');
    a.gate = new Map();
  }
}

/**
 * @description Fetches daily closes for a config's universe (+ core + SPY) since `startIso` and
 * aligns them to SPY's session calendar with carry-forward marking. SIP historical first, IEX on
 * failure — the caller records which tape produced the run.
 * @param cfg - The strategy config (universe + coreSymbol).
 * @param startIso - Inclusive fetch start.
 * @returns Aligned series + the feed that served them.
 */
export async function fetchAligned(cfg: StrategyConfig, startIso: string): Promise<Aligned> {
  // A blend fetches the UNION of its components' universes — each sub-walk reads its own slice.
  const universe = cfg.kind === 'blend'
    ? [...new Set((cfg.components ?? []).flatMap((c) => (c.config.universe.length ? c.config.universe : DEFAULT_UNIVERSE)))]
    : cfg.universe.length ? cfg.universe : DEFAULT_UNIVERSE;
  const symbols = [...new Set([...universe, cfg.coreSymbol, 'SPY'])];
  let raw: Map<string, DatedClose[]>;
  let feed: 'sip' | 'iex' = 'sip';
  try {
    raw = await barsBatchSince(symbols, startIso, 'sip');
    if (!(raw.get('SPY') || []).length) throw new Error('SIP returned no SPY bars');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'SIP historical fetch failed — falling back to IEX');
    feed = 'iex';
    raw = await barsBatchSince(symbols, startIso, 'iex');
  }
  const spyBars = raw.get('SPY') || [];
  if (spyBars.length < 70) throw new Error(`not enough SPY history (${spyBars.length} bars)`);
  const dates = spyBars.map((b) => b.d);
  const index = new Map(dates.map((d, i) => [d, i]));
  const series = new Map<string, { firstReal: number; closes: number[] }>();
  // SPY is the calendar AND a markable symbol (the default core sleeve prices off it) — found by
  // the 2026-07-13 live proof: excluding it made a SPY core sleeve unpriceable at warmup.
  series.set('SPY', { firstReal: 0, closes: spyBars.map((b) => b.c) });
  for (const [sym, bars] of raw) {
    if (sym === 'SPY' || !bars.length) continue;
    const closes = new Array<number>(dates.length);
    let firstReal = -1;
    for (const b of bars) {
      const i = index.get(b.d);
      if (i == null) continue; // a session SPY didn't print (half-day quirk) — skip
      closes[i] = b.c;
      if (firstReal < 0 || i < firstReal) firstReal = i;
    }
    if (firstReal < 0) continue;
    for (let i = firstReal + 1; i < closes.length; i++) if (closes[i] == null) closes[i] = closes[i - 1];
    series.set(sym, { firstReal, closes });
  }
  return { dates, spy: spyBars.map((b) => b.c), series, feed };
}

/** Resample a daily close series by taking every `n`th close, anchored at the NEWEST bar
 *  (ascending output — the post-`cad41dc5` orientation; the reversed variant voided two weeks
 *  of numbers, so this stays identical to the fixed harness). */
const resample = (c: number[], n: number): number[] => c.filter((_, i) => (c.length - 1 - i) % n === 0);

/** Real-history closes for a symbol up to calendar index t (empty if not yet listed). */
function closesTo(a: Aligned, sym: string, t: number): number[] {
  const s = a.series.get(sym);
  if (!s || t < s.firstReal) return [];
  return s.closes.slice(s.firstReal, t + 1);
}

/** Mark price at calendar index t (undefined before the symbol's first real bar). */
function priceAt(a: Aligned, sym: string, t: number): number | undefined {
  const s = a.series.get(sym);
  return !s || t < s.firstReal ? undefined : s.closes[t];
}

/** Walk-internal: positions view of the book at index t. */
function bookPositions(a: Aligned, state: WalkState, t: number): Position[] {
  return Object.entries(state.lots).map(([symbol, lot]) => {
    const px = priceAt(a, symbol, t) ?? lot.entry;
    return { symbol, qty: lot.qty, avgEntryPrice: lot.entry, currentPrice: px, marketValue: lot.qty * px, unrealizedPl: lot.qty * (px - lot.entry) };
  });
}

/** Walk-internal: total equity (cash + lots + core sleeve) at index t. */
function equityAt(a: Aligned, cfg: StrategyConfig, state: WalkState, t: number): number {
  const lots = Object.entries(state.lots).reduce((s, [sym, lot]) => s + lot.qty * (priceAt(a, sym, t) ?? lot.entry), 0);
  const core = state.coreQty * (priceAt(a, cfg.coreSymbol, t) ?? 0);
  return state.cash + lots + core;
}

/**
 * @description Advances the walk book through ONE session (calendar index t): mark + trailing
 * peaks, protective exits, then the config's own entry engine (rotation rebalance on cadence, or
 * the decideSymbol scan). Mutates `state` — the caller owns persistence.
 * @param a - Aligned bars.
 * @param cfg - The strategy config.
 * @param policy - Effective risk policy (posture + tp override).
 * @param state - The resumable walk state (mutated).
 * @param t - Calendar index of the session to apply.
 * @returns The book equity at that session's close.
 */
export function stepDay(a: Aligned, cfg: StrategyConfig, policy: RiskPolicy, state: WalkState, t: number): number {
  const universe = cfg.universe.length ? cfg.universe : DEFAULT_UNIVERSE;
  const exiting = new Set<string>();
  const sell = (sym: string): void => {
    const lot = state.lots[sym];
    if (!lot) return;
    const px = priceAt(a, sym, t) ?? lot.entry;
    state.cash += lot.qty * px;
    if (px >= lot.entry) state.wins++; else state.losses++;
    state.trades++;
    delete state.lots[sym];
    exiting.add(sym);
  };

  // Mark, roll trailing peaks, run protective exits (stop / take-profit / trailing) at the close.
  const positions = bookPositions(a, state, t);
  const peaks = nextPeaks(positions, new Map(Object.entries(state.lots).map(([s, l]) => [s, l.peak])));
  for (const [s, p] of peaks) { const l = state.lots[s]; if (l) l.peak = p; }
  for (const e of [...exitsToRun(positions, policy), ...trailingExits(positions, peaks, policy)]) {
    if (!exiting.has(e.symbol)) sell(e.symbol);
  }

  const eligible = (sym: string): boolean => closesTo(a, sym, t).length >= 60;
  const coreValue = state.coreQty * (priceAt(a, cfg.coreSymbol, t) ?? 0);

  if (cfg.kind === 'rotation') {
    // Production rotateSleeve shape: rank on cadence, hold top-N positive, rebalance to goals.
    if (state.barCount % cfg.cadenceDays === 0) {
      const barsToT = new Map<string, number[]>();
      for (const sym of universe) { if (eligible(sym)) barsToT.set(sym, closesTo(a, sym, t)); }
      const ranked = rankUniverse(cfg.rank, barsToT, new Set([cfg.coreSymbol]));
      ranked.sort((x, y) => y.score - x.score);
      // Earnings gate (earningsGateDays > 0 + attachEarningsGate ran): a name printing inside the
      // window is excluded from the leaderboard — never bought, and a HELD printing name drops off
      // targetSet and is sold by the drop-out loop below. Mirrors live rotateSleeve exactly.
      const gateSet = cfg.earningsGateDays > 0 ? a.gate?.get(a.dates[t]) : undefined;
      const target = ranked.filter((r) => r.score > 0 && !gateSet?.has(r.sym)).slice(0, cfg.topN);
      const targetSet = new Set(target.map((r) => r.sym));
      for (const sym of Object.keys(state.lots)) { if (!targetSet.has(sym) && !exiting.has(sym)) sell(sym); }
      const sleeveEquity = equityAt(a, cfg, state, t) - coreValue;
      const perName = (policy.maxPerNamePct / 100) * sleeveEquity;
      const scoreSum = target.reduce((s, r) => s + Math.max(0, r.score), 0);
      const dust = sleeveEquity * 0.005;
      for (const r of target) {
        const px = priceAt(a, r.sym, t);
        if (!px) continue;
        const goal = cfg.weighting === 'conviction' && scoreSum > 0
          ? Math.min(perName, (Math.max(0, r.score) / scoreSum) * sleeveEquity)
          : Math.min(perName, sleeveEquity / Math.max(1, cfg.topN));
        const cur = state.lots[r.sym] ? state.lots[r.sym].qty * px : 0;
        if (goal - cur > dust) {
          const qty = Math.floor(Math.min(goal - cur, state.cash) / px);
          if (qty >= 1) {
            const lot = state.lots[r.sym];
            if (lot) { lot.entry = (lot.entry * lot.qty + px * qty) / (lot.qty + qty); lot.qty += qty; lot.peak = Math.max(lot.peak, px); }
            else state.lots[r.sym] = { qty, entry: px, peak: px };
            state.cash -= qty * px;
          }
        } else if (cur - goal > dust) {
          const lot = state.lots[r.sym];
          const qty = Math.min(lot.qty, Math.floor((cur - goal) / px));
          if (qty >= 1) {
            state.cash += qty * px; lot.qty -= qty; state.trades++;
            if (px >= lot.entry) state.wins++; else state.losses++;
            if (lot.qty === 0) delete state.lots[r.sym];
          }
        }
      }
    }
  } else {
    // Ensemble scan sleeve: decideSymbol per name, rotation benches, technical sells, sized buys.
    const decisions = new Map<string, ReturnType<typeof decideSymbol>>();
    for (const sym of universe) {
      if (!eligible(sym)) continue;
      const win = closesTo(a, sym, t);
      const tf = new Map<Timeframe, number[]>([
        ['1Day', win.slice(-220)], ['1Week', resample(win, 5).slice(-60)], ['3Month', resample(win, 63).slice(-40)],
      ]);
      decisions.set(sym, decideSymbol(sym, tf));
    }
    const strength = new Map<string, NameStrength>([...decisions].map(([s, d]) => [s, { score: d.score, action: d.action }]));
    const livePos = bookPositions(a, state, t).filter((p) => !exiting.has(p.symbol));
    for (const b of rotationBenches(livePos, strength, policy)) { if (!exiting.has(b.symbol)) sell(b.symbol); }
    for (const [sym, d] of decisions) { if (d.action === 'sell' && state.lots[sym] && !exiting.has(sym)) sell(sym); }
    const sleeveEquity = equityAt(a, cfg, state, t) - coreValue;
    const account: BrokerAccount = { cash: state.cash, buyingPower: state.cash, equity: sleeveEquity, currency: 'USD' };
    const remaining = bookPositions(a, state, t);
    const buys = [...decisions.values()].filter((d) => d.action === 'buy' && !state.lots[d.symbol]).sort((x, y) => y.confidence - x.confidence);
    let placed = 0;
    for (const d of buys) {
      if (placed >= 8) break;
      const px = priceAt(a, d.symbol, t);
      if (!px) continue;
      const sized = sizeEntry(d.symbol, px, d.confidence, account, remaining, policy);
      if (sized.qty <= 0) continue;
      state.cash -= sized.qty * px;
      state.lots[d.symbol] = { qty: sized.qty, entry: px, peak: px };
      remaining.push({ symbol: d.symbol, qty: sized.qty, avgEntryPrice: px, currentPrice: px, marketValue: sized.qty * px, unrealizedPl: 0 });
      placed++;
    }
  }

  state.barCount++;
  state.lastDate = a.dates[t];
  const equity = equityAt(a, cfg, state, t);
  state.peakEquity = Math.max(state.peakEquity, equity);
  state.maxDD = Math.max(state.maxDD, state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0);
  return equity;
}

/**
 * @description Computes the tearsheet metrics for an equity curve segment.
 * @param curve - Dated equity points (strategy + SPY, both from LAB_START_CASH).
 * @param state - Walk state carrying trade/win/loss/maxDD tallies.
 * @returns Persistable metrics.
 */
export function metricsFor(curve: EquityPoint[], state: WalkState, startCash: number = LAB_START_CASH): LabMetrics {
  const n = curve.length;
  if (n < 2) {
    return { totalReturnPct: 0, cagrPct: 0, sharpe: 0, maxDrawdownPct: round2(state.maxDD * 100), winRatePct: 0, trades: state.trades, spyReturnPct: 0, alphaVsSpyPct: 0, bars: n, avgDailyPct: 0, bestDayPct: 0, worstDayPct: 0 };
  }
  const first = curve[0], last = curve[n - 1];
  const totalReturnPct = (last.e / startCash - 1) * 100;
  const spyReturnPct = first.s > 0 ? (last.s / startCash - 1) * 100 : 0;
  const growth = last.e / startCash;
  const cagrPct = growth > 0 ? (Math.pow(growth, 252 / n) - 1) * 100 : -100;
  const rets: number[] = [];
  for (let i = 1; i < n; i++) if (curve[i - 1].e > 0) rets.push(curve[i].e / curve[i - 1].e - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const closed = state.wins + state.losses;
  return {
    totalReturnPct: round2(totalReturnPct),
    cagrPct: round2(cagrPct),
    sharpe: round2(sharpe),
    maxDrawdownPct: round2(state.maxDD * 100),
    winRatePct: closed > 0 ? round2((state.wins / closed) * 100) : 0,
    trades: state.trades,
    spyReturnPct: round2(spyReturnPct),
    alphaVsSpyPct: round2(totalReturnPct - spyReturnPct),
    bars: n,
    // Session-level shape, from the same `rets` the Sharpe uses. avgDaily carries 3dp because a
    // real daily mean lives in the hundredths; best/worst are whole-percent-scale so 2dp is fine.
    avgDailyPct: rets.length ? round3(mean * 100) : 0,
    bestDayPct: rets.length ? round2(Math.max(...rets) * 100) : 0,
    worstDayPct: rets.length ? round2(Math.min(...rets) * 100) : 0,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Backtest window pinning: regressions replay the baseline's exact fetch window, because the
 *  decision functions read "all history up to t" — a different fetch start changes what the
 *  1Week/3Month resamples see and therefore the decisions. `fetchStart` is recorded on every
 *  result so a regression can reproduce the run bit-for-bit (modulo tape restatements). */
export interface BacktestWindow {
  windowDays?: number; endDate?: string; fetchStartDate?: string;
  /** Starting capital for THIS run (default LAB_START_CASH). Whole-share sizing means a $20K book and a
   *  $500K book do not trade the same — the operator's 2026-09-04 point. Forward walks and regressions
   *  keep the $100K reference unless the pinned baseline recorded another capital. */
  startCash?: number;
}
/** @description The capital a run should start from: a positive override, else the $100K reference. */
export function resolveStartCash(win: BacktestWindow): number { return win.startCash && Number.isFinite(win.startCash) && win.startCash > 0 ? win.startCash : LAB_START_CASH; }

/**
 * @description Runs a full backtest for a config: fetch, warm up, walk to the last session.
 * @param cfg - Normalized strategy config.
 * @param win - Optional window pinning (regressions pass the baseline's fetchStart/endDate).
 * @returns The curve, metrics, resumable state, and data provenance (incl. fetchStart).
 */
export async function runBacktest(cfg: StrategyConfig, win: BacktestWindow = {}): Promise<SimResult> {
  if (cfg.kind === 'blend') return runBlendBacktest(cfg, win);
  const windowDays = win.windowDays ?? cfg.windowDays;
  const startIso = win.fetchStartDate ?? new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const a = await fetchAligned(cfg, startIso);
  if (cfg.earningsGateDays > 0) await attachEarningsGate(a, cfg.earningsGateDays);
  let dates = a.dates;
  if (win.endDate) {
    const endDate = win.endDate;
    const cut = dates.findIndex((d) => d > endDate);
    if (cut >= 0) { dates = dates.slice(0, cut); a.dates = dates; a.spy = a.spy.slice(0, cut); }
  }
  if (dates.length < cfg.warmupDays + 10) throw new Error(`not enough history (${dates.length} sessions for warmup ${cfg.warmupDays})`);

  const w = cfg.warmupDays;
  const startCash = resolveStartCash(win);
  const corePx = priceAt(a, cfg.coreSymbol, w);
  const state: WalkState = {
    cash: startCash, lots: {}, coreQty: 0, barCount: 0,
    peakEquity: startCash, maxDD: 0, wins: 0, losses: 0, trades: 0,
    lastDate: dates[w - 1], spyAnchor: a.spy[w],
  };
  if (cfg.corePct > 0) {
    if (!corePx) throw new Error(`no ${cfg.coreSymbol} price at warmup for the core sleeve`);
    state.coreQty = Math.floor(((cfg.corePct / 100) * startCash) / corePx);
    state.cash -= state.coreQty * corePx;
  }

  const curve: EquityPoint[] = [];
  for (let t = w; t < dates.length; t++) {
    const e = stepDay(a, cfg, policyFor(cfg), state, t);
    curve.push({ d: dates[t], e: round2(e), s: round2(startCash * (a.spy[t] / state.spyAnchor)) });
  }
  return {
    curve, metrics: metricsFor(curve, state, startCash), state, startCash,
    windowStart: dates[w], windowEnd: dates[dates.length - 1], bars: curve.length, feed: a.feed,
    fetchStart: dates[0],
  };
}

/**
 * @description Advances a persisted walk on every session NEWER than its `lastDate` — the daily
 * out-of-sample forward test. Fetches enough history behind the resume point for decisions
 * (decideSymbol reads 220 dailies).
 * @param cfg - Normalized strategy config.
 * @param state - The persisted walk state (mutated + returned).
 * @returns New equity points (empty when no newer session has printed) + provenance.
 */
export async function forwardStep(cfg: StrategyConfig, state: WalkState): Promise<{ points: EquityPoint[]; state: WalkState; feed: 'sip' | 'iex' }> {
  if (cfg.kind === 'blend') return forwardBlendStep(cfg, state);
  const startIso = new Date(Date.now() - 550 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const a = await fetchAligned(cfg, startIso);
  if (cfg.earningsGateDays > 0) await attachEarningsGate(a, cfg.earningsGateDays);
  const points: EquityPoint[] = [];
  for (let t = 0; t < a.dates.length; t++) {
    if (a.dates[t] <= state.lastDate) continue;
    if (state.coreQty > 0 && priceAt(a, cfg.coreSymbol, t) == null) {
      logger.warn({ coreSymbol: cfg.coreSymbol, date: a.dates[t] }, 'core symbol missing from forward window — marking core at 0 would be wrong; skipping session');
      continue;
    }
    const e = stepDay(a, cfg, policyFor(cfg), state, t);
    points.push({ d: a.dates[t], e: round2(e), s: round2(LAB_START_CASH * (a.spy[t] / state.spyAnchor)) });
  }
  return { points, state, feed: a.feed };
}

/* ── Blend walks (ADR-095 round 2) — each component is an INDEPENDENT sub-book on its weight% of
 *    the money; the blend's own remainder holds the core; curves are the summed portfolio. This
 *    matches the operator's mental model ("move 30% of our money into this strategy") exactly;
 *    live execution nets overlapping names into one book with most-conservative exits, which is
 *    economically equivalent netting of the same sub-books (disclosed on every run). ─────────── */

/** Roll the blend-level tallies after a session: totals, drawdown on the SUMMED equity. */
function rollBlend(state: WalkState, parts: WalkState[], equity: number, date: string): void {
  state.barCount++;
  state.lastDate = date;
  state.peakEquity = Math.max(state.peakEquity, equity);
  state.maxDD = Math.max(state.maxDD, state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0);
  state.wins = parts.reduce((s, p) => s + p.wins, 0);
  state.losses = parts.reduce((s, p) => s + p.losses, 0);
  state.trades = parts.reduce((s, p) => s + p.trades, 0);
}

async function runBlendBacktest(cfg: StrategyConfig, win: BacktestWindow = {}): Promise<SimResult> {
  const components = cfg.components ?? [];
  if (!components.length) throw new Error('blend has no components');
  const windowDays = win.windowDays ?? cfg.windowDays;
  const startIso = win.fetchStartDate ?? new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const a = await fetchAligned(cfg, startIso);
  let dates = a.dates;
  if (win.endDate) {
    const endDate = win.endDate;
    const cut = dates.findIndex((d) => d > endDate);
    if (cut >= 0) { dates = dates.slice(0, cut); a.dates = dates; a.spy = a.spy.slice(0, cut); }
  }
  if (dates.length < cfg.warmupDays + 10) throw new Error(`not enough history (${dates.length} sessions for warmup ${cfg.warmupDays})`);

  const w = cfg.warmupDays;
  const startCash = resolveStartCash(win);
  const partCfgs = components.map(blendPartConfig);
  const partPolicies = partCfgs.map(policyFor);
  const parts: WalkState[] = components.map((c) => ({
    cash: (c.weightPct / 100) * startCash, lots: {}, coreQty: 0, barCount: 0,
    peakEquity: (c.weightPct / 100) * startCash, maxDD: 0, wins: 0, losses: 0, trades: 0,
    lastDate: dates[w - 1], spyAnchor: a.spy[w],
  }));
  const state: WalkState = {
    cash: startCash - components.reduce((s, c) => s + (c.weightPct / 100) * startCash, 0),
    lots: {}, coreQty: 0, barCount: 0, peakEquity: startCash, maxDD: 0, wins: 0, losses: 0, trades: 0,
    lastDate: dates[w - 1], spyAnchor: a.spy[w], parts: {},
  };
  if (cfg.corePct > 0) {
    const corePx = priceAt(a, cfg.coreSymbol, w);
    if (!corePx) throw new Error(`no ${cfg.coreSymbol} price at warmup for the blend core`);
    state.coreQty = Math.floor(((cfg.corePct / 100) * startCash) / corePx);
    state.cash -= state.coreQty * corePx;
  }

  const curve: EquityPoint[] = [];
  for (let t = w; t < dates.length; t++) {
    let e = state.cash + state.coreQty * (priceAt(a, cfg.coreSymbol, t) ?? 0);
    for (let i = 0; i < components.length; i++) e += stepDay(a, partCfgs[i], partPolicies[i], parts[i], t);
    rollBlend(state, parts, e, dates[t]);
    curve.push({ d: dates[t], e: round2(e), s: round2(startCash * (a.spy[t] / state.spyAnchor)) });
  }
  parts.forEach((p, i) => { (state.parts as Record<string, WalkState>)[String(i)] = p; });
  return {
    curve, metrics: metricsFor(curve, state, startCash), state, startCash,
    windowStart: dates[w], windowEnd: dates[dates.length - 1], bars: curve.length, feed: a.feed,
    fetchStart: dates[0],
  };
}

async function forwardBlendStep(cfg: StrategyConfig, state: WalkState): Promise<{ points: EquityPoint[]; state: WalkState; feed: 'sip' | 'iex' }> {
  const components = cfg.components ?? [];
  const parts = components.map((_, i) => state.parts?.[String(i)]);
  if (!components.length || parts.some((p) => !p)) {
    throw new Error('blend forward state does not match its components — config changed; the forward walk resets on the next init');
  }
  const partCfgs = components.map(blendPartConfig);
  const partPolicies = partCfgs.map(policyFor);
  const startIso = new Date(Date.now() - 550 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const a = await fetchAligned(cfg, startIso);
  const points: EquityPoint[] = [];
  for (let t = 0; t < a.dates.length; t++) {
    if (a.dates[t] <= state.lastDate) continue;
    if (state.coreQty > 0 && priceAt(a, cfg.coreSymbol, t) == null) {
      logger.warn({ coreSymbol: cfg.coreSymbol, date: a.dates[t] }, 'blend core symbol missing from forward window — skipping session');
      continue;
    }
    let e = state.cash + state.coreQty * (priceAt(a, cfg.coreSymbol, t) ?? 0);
    for (let i = 0; i < components.length; i++) e += stepDay(a, partCfgs[i], partPolicies[i], parts[i] as WalkState, t);
    rollBlend(state, parts as WalkState[], e, a.dates[t]);
    points.push({ d: a.dates[t], e: round2(e), s: round2(LAB_START_CASH * (a.spy[t] / state.spyAnchor)) });
  }
  return { points, state, feed: a.feed };
}
