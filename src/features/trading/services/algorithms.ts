/**
 * Trading algorithms — the DETERMINISTIC decision engine (ADR-052/053/054).
 *
 * Pure functions of market data: same inputs → same outputs, no LLM, no randomness. Each algorithm
 * reads a close series (+ an optional index series) and returns a directional signal; `ensemble`
 * folds the signals into a reproducible buy/sell/hold. This is what makes the trade path
 * "fairly deterministic" — the algorithms decide; the analyst bot (if used at all) only narrates.
 *
 * Algorithms: momentum (close vs SMA20), gravity (ADR-054 market-derived masses → displacement),
 * donchian (20-day breakout), meanrev (RSI-14). Add one by appending to ALGORITHMS.
 *
 * SHADOW algorithms (ADR-096): a second registry of standard indicators — MACD, Bollinger,
 * ATR-channel, ADX trend, stochastic, volume z-surge — that is RECORDED by the nightly
 * per-algo prediction loop (scoreSymbolShadow) but NEVER votes in the live ensemble
 * (scoreSymbol/ALGORITHMS untouched — the gravity2 head-to-head pattern, generalized).
 * Promotion = move a fn from SHADOW_ALGORITHMS into ALGORITHMS after its recorded hit-rate/
 * expectancy earns it (strategy-log row required, like any config change).
 *
 * Mirrors scripts/oshal-gravity.js + scripts/oshal-monitor.js (the research CLIs); this is the
 * in-app production copy the routes call.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — deterministic algo engine: momentum/gravity/donchian/meanrev pure functions, market-gravity mass derivation, and a weighted-vote ensemble. No LLM, no randomness.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-096 shadow indicators: SHADOW_ALGORITHMS (macd/bollinger/atr-channel/adx/stochastic/volsurge on OHLCV bars) + scoreSymbolShadow/shadowAlgoNames. Deliberately OUTSIDE the voting registry — recorded nightly, zero effect on live votes until operator promotion.
 *
 * @module algorithms
 */

import type { OhlcvBar } from './market-data';

/** A direction call. */
export type Direction = 'up' | 'down';

/** One algorithm's signal for a symbol at a point in time. */
export interface AlgoSignal {
  algo: string;
  dir: Direction;
  confidence: number; // 0..1
  basis: string;
}

/** The deterministic fold of all algo signals into an action. */
export interface EnsembleDecision {
  action: 'buy' | 'sell' | 'hold';
  side: 'buy' | 'sell' | null;
  confidence: number; // 0..1
  score: number;      // -1..1 (signed agreement)
  votes: AlgoSignal[];
}

/** The TUNABLE strategy parameters the nightly optimizer can tweak (defaults = the long-standing
 *  hardcoded constants, so an absent/empty param store reproduces today's behavior EXACTLY). */
export interface StrategyParams {
  momentumSma: number;        // momentum: close-vs-SMA window
  rsiLow: number;             // mean-rev: RSI oversold band (buy below)
  rsiHigh: number;            // mean-rev: RSI overbought band (sell above)
  donchianWindow: number;     // donchian: breakout/breakdown lookback
  ensembleThreshold: number;  // ensemble: |score| an action must clear (else hold)
}
export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  momentumSma: 20, rsiLow: 35, rsiHigh: 65, donchianWindow: 20, ensembleThreshold: 0.15,
};

/** A market-gravity mass (single-ticker form). Exported so Gravity 2 (gravity-world.ts) can build
 *  world masses against the same contract the displacement engine consumes. */
export interface Mass { source: string; label: string; mass: number; polarity: number; proximity: number; halfLifeDays: number; t0Day: number; antigravity?: boolean; }

const MAX_SWING = 0.6;
const round = (n: number, d = 4): number => { const f = 10 ** d; return Math.round(n * f) / f; };
const avg = (a: number[]): number => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const pctReturns = (c: number[]): number[] => { const r: number[] = []; for (let i = 1; i < c.length; i++) r.push((c[i] - c[i - 1]) / c[i - 1]); return r; };
function sma(c: number[], i: number, p: number): number | null { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k]; return s / p; }
function rsi(c: number[], i: number, n = 14): number | null { if (i < n) return null; let up = 0, dn = 0; for (let k = i - n + 1; k <= i; k++) { const d = c[k] - c[k - 1]; if (d > 0) up += d; else dn -= d; } return dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); if (n < 5) return 0;
  const ax = a.slice(-n), bx = b.slice(-n); const am = avg(ax), bm = avg(bx);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = ax[i] - am, y = bx[i] - bm; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}

/* ── gravity: derive market masses + displacement (ADR-054, deterministic) ────── */

/** Derive market-gravity masses from a symbol's closes (+ optional index closes). */
export function deriveMasses(symbol: string, closes: number[], indexCloses?: number[], indexName = 'index'): Mass[] {
  const masses: Mass[] = []; const n = closes.length; if (n < 25) return masses;
  const last = closes[n - 1];
  const sma50 = avg(closes.slice(-50)); const trend = (last - sma50) / sma50;
  masses.push({ source: 'market/trend', label: `${symbol} trend`, mass: Math.min(1, Math.abs(trend) * 6), polarity: trend >= 0 ? 1 : -1, proximity: 1, halfLifeDays: 30, t0Day: 0 });
  const rets = pctReturns(closes); const recent = rets.slice(-21); const mu = avg(recent);
  const sd = Math.sqrt(avg(recent.map((x) => (x - mu) ** 2))) || 1e-9; const z = (rets[rets.length - 1] - mu) / sd;
  if (Math.abs(z) > 1.5) masses.push({ source: 'market/shock', label: `${symbol} vol-shock z=${z.toFixed(1)}`, mass: Math.min(1, Math.abs(z) / 4), polarity: z >= 0 ? 1 : -1, proximity: 1, halfLifeDays: 5, t0Day: 0 });
  if (indexCloses && indexCloses.length > 25) {
    const c = pearson(rets, pctReturns(indexCloses)); const isma = avg(indexCloses.slice(-20));
    const imove = (indexCloses[indexCloses.length - 1] - isma) / isma;
    if (Math.abs(c) > 0.2 && Math.abs(imove) > 0.005) masses.push({ source: 'market/correlated-index', label: `${indexName} pull (ρ=${c.toFixed(2)})`, mass: Math.abs(c) * Math.min(1, Math.abs(imove) * 8), polarity: (imove >= 0 ? 1 : -1) * (c >= 0 ? 1 : -1), proximity: Math.abs(c), halfLifeDays: 20, t0Day: 0 });
  }
  const sma20 = avg(closes.slice(-20)); const gap = (last - sma20) / sma20;
  if (Math.abs(gap) > 0.08) masses.push({ source: 'market/mean-reversion', label: `${symbol} stretched ${(gap * 100).toFixed(0)}%`, mass: Math.min(1, Math.abs(gap) * 3), polarity: gap > 0 ? -1 : 1, proximity: 0.6, halfLifeDays: 10, t0Day: 0 });
  return masses;
}

/** Net fractional displacement of a mass set at day t (gravity damped by anti-gravity). */
export function displacement(masses: Mass[], t = 0): number {
  let pull = 0, damp = 0;
  for (const m of masses) {
    const decay = t < m.t0Day ? 0 : Math.pow(0.5, (t - m.t0Day) / Math.max(0.5, m.halfLifeDays));
    const c = m.polarity * m.mass * m.proximity * decay;
    if (m.antigravity) damp += Math.abs(c); else pull += c;
  }
  return Math.max(-MAX_SWING, Math.min(MAX_SWING, pull * Math.max(0, 1 - damp)));
}

/* ── the algorithms: (closes, indexCloses?) → AlgoSignal | null ────────────────
 * null = "no call" — the algo only votes when it fires. The symbol rides on `closes`. */
export interface AlgoContext { symbol: string; indexCloses?: number[]; indexName?: string; params?: StrategyParams }
type AlgoFn = (closes: number[], ctx: AlgoContext) => AlgoSignal | null;

const ALGORITHMS: Record<string, AlgoFn> = {
  momentum: (c, ctx) => { const w = ctx.params?.momentumSma ?? DEFAULT_STRATEGY_PARAMS.momentumSma; const i = c.length - 1; const m = sma(c, i, w); if (m == null) return null; const g = (c[i] - m) / m; return { algo: 'momentum', dir: g >= 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(g) * 12), basis: `close vs SMA${w} ${(g * 100).toFixed(1)}%` }; },
  gravity: (c, ctx) => { const masses = deriveMasses(ctx.symbol, c, ctx.indexCloses, ctx.indexName); const d = displacement(masses, 0); if (Math.abs(d) < 0.01) return null; return { algo: 'gravity', dir: d > 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(d) * 2), basis: `${masses.length} masses → ${(d * 100).toFixed(1)}%` }; },
  donchian: (c, ctx) => { const w = ctx.params?.donchianWindow ?? DEFAULT_STRATEGY_PARAMS.donchianWindow; const i = c.length - 1; if (i < w) return null; let hi = -Infinity, lo = Infinity; for (let k = i - w; k < i; k++) { hi = Math.max(hi, c[k]); lo = Math.min(lo, c[k]); } if (c[i] > hi) return { algo: 'donchian', dir: 'up', confidence: 0.7, basis: `${w}d breakout high` }; if (c[i] < lo) return { algo: 'donchian', dir: 'down', confidence: 0.7, basis: `${w}d breakdown low` }; return null; },
  meanrev: (c, ctx) => { const lo = ctx.params?.rsiLow ?? DEFAULT_STRATEGY_PARAMS.rsiLow; const hi = ctx.params?.rsiHigh ?? DEFAULT_STRATEGY_PARAMS.rsiHigh; const i = c.length - 1; const r = rsi(c, i, 14); if (r == null) return null; if (r < lo) return { algo: 'meanrev', dir: 'up', confidence: Math.min(1, (lo - r) / Math.max(1, lo)), basis: `RSI ${r.toFixed(0)} oversold` }; if (r > hi) return { algo: 'meanrev', dir: 'down', confidence: Math.min(1, (r - hi) / Math.max(1, 100 - hi)), basis: `RSI ${r.toFixed(0)} overbought` }; return null; },
};

/** Run every algorithm over the series; drop the ones that don't fire. Deterministic.
 *  `params` (optional) overrides the tunable constants; omitted = DEFAULT_STRATEGY_PARAMS (today's behavior). */
export function scoreSymbol(symbol: string, closes: number[], indexCloses?: number[], indexName = 'SPY', params?: StrategyParams): AlgoSignal[] {
  const ctx: AlgoContext = { symbol, indexCloses, indexName, params };
  return Object.values(ALGORITHMS).map((fn) => fn(closes, ctx)).filter((s): s is AlgoSignal => s != null);
}

/** The algorithm names (for schema, weights, reporting). */
export function algoNames(): string[] { return Object.keys(ALGORITHMS); }

/* ── SHADOW indicators (ADR-096) — standard technicals on OHLCV bars, recorded but never voting ──
 * Each is a pure function of ascending daily OHLCV bars; null = "no call" exactly like the live
 * algos. All require ≥ 60 bars. Kept OUT of ALGORITHMS so the live ensemble/scan path is
 * byte-identical; the assess loop records these beside gravity2 and the overnight review scores
 * their hit-rate/expectancy per name — the evidence a promotion decision reads. */

/** EMA series (classic 2/(n+1) smoothing, SMA-seeded). Returns [] when bars < n. */
function emaSeries(vals: number[], n: number): number[] {
  if (vals.length < n) return [];
  const k = 2 / (n + 1);
  const out: number[] = [];
  let e = avg(vals.slice(0, n));
  out.push(e);
  for (let i = n; i < vals.length; i++) { e = e + k * (vals[i] - e); out.push(e); }
  return out;
}

/** Wilder-smoothed series (ATR/ADX family): sm[0] = mean of first n, then (prev×(n−1) + x)/n. */
function wilderSeries(vals: number[], n: number): number[] {
  if (vals.length < n) return [];
  const out: number[] = [];
  let s = avg(vals.slice(0, n));
  out.push(s);
  for (let i = n; i < vals.length; i++) { s = (s * (n - 1) + vals[i]) / n; out.push(s); }
  return out;
}

/** True-range series (needs the prior close, so output is bars.length − 1 long). */
function trueRanges(b: OhlcvBar[]): number[] {
  const tr: number[] = [];
  for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  return tr;
}

type ShadowFn = (bars: OhlcvBar[], ctx: AlgoContext) => AlgoSignal | null;

const SHADOW_ALGORITHMS: Record<string, ShadowFn> = {
  /** MACD 12/26/9 — histogram direction, confidence by histogram size relative to price. */
  macd: (b) => {
    if (b.length < 60) return null;
    const closes = b.map((x) => x.c);
    const e12 = emaSeries(closes, 12).slice(-(closes.length - 25));
    const e26 = emaSeries(closes, 26);
    const macdLine = e26.map((v, i) => e12[e12.length - e26.length + i] - v);
    const signal = emaSeries(macdLine, 9);
    if (!signal.length) return null;
    const hist = macdLine[macdLine.length - 1] - signal[signal.length - 1];
    const px = closes[closes.length - 1];
    const histPct = hist / px;
    if (Math.abs(histPct) < 0.0004) return null; // noise floor — don't vote on a flat histogram
    return { algo: 'macd', dir: histPct > 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(histPct) * 250), basis: `MACD hist ${(histPct * 100).toFixed(2)}% of px` };
  },
  /** Bollinger 20/2σ — mean-reversion at the bands (the meanrev family, band-relative). */
  bollinger: (b) => {
    if (b.length < 60) return null;
    const closes = b.map((x) => x.c);
    const i = closes.length - 1;
    const win = closes.slice(-20);
    const mid = avg(win);
    const sd = Math.sqrt(avg(win.map((x) => (x - mid) ** 2)));
    if (sd <= 0) return null;
    const z = (closes[i] - mid) / sd;
    if (z <= -2) return { algo: 'bollinger', dir: 'up', confidence: Math.min(1, 0.4 + (Math.abs(z) - 2) * 0.4), basis: `close ${Math.abs(z).toFixed(1)}σ below SMA20` };
    if (z >= 2) return { algo: 'bollinger', dir: 'down', confidence: Math.min(1, 0.4 + (z - 2) * 0.4), basis: `close ${z.toFixed(1)}σ above SMA20` };
    return null;
  },
  /** ATR channel — volatility breakout: close beyond SMA20 ± 2×ATR14 (trend-following). */
  'atr-channel': (b) => {
    if (b.length < 60) return null;
    const closes = b.map((x) => x.c);
    const atr = wilderSeries(trueRanges(b), 14);
    if (!atr.length) return null;
    const a = atr[atr.length - 1];
    if (a <= 0) return null;
    const mid = avg(closes.slice(-20));
    const c = closes[closes.length - 1];
    if (c > mid + 2 * a) return { algo: 'atr-channel', dir: 'up', confidence: Math.min(1, (c - (mid + 2 * a)) / a + 0.5), basis: `close above SMA20+2×ATR14 (ATR ${(100 * a / c).toFixed(1)}%)` };
    if (c < mid - 2 * a) return { algo: 'atr-channel', dir: 'down', confidence: Math.min(1, ((mid - 2 * a) - c) / a + 0.5), basis: `close below SMA20−2×ATR14 (ATR ${(100 * a / c).toFixed(1)}%)` };
    return null;
  },
  /** ADX 14 — trend-strength gate: fires only when ADX ≥ 25, direction by +DI vs −DI. */
  adx: (b) => {
    if (b.length < 60) return null;
    const plusDM: number[] = []; const minusDM: number[] = [];
    for (let i = 1; i < b.length; i++) {
      const up = b[i].h - b[i - 1].h; const dn = b[i - 1].l - b[i].l;
      plusDM.push(up > dn && up > 0 ? up : 0);
      minusDM.push(dn > up && dn > 0 ? dn : 0);
    }
    const smTR = wilderSeries(trueRanges(b), 14);
    const smP = wilderSeries(plusDM, 14);
    const smM = wilderSeries(minusDM, 14);
    const n = Math.min(smTR.length, smP.length, smM.length);
    if (n < 15) return null;
    const dx: number[] = [];
    for (let i = 0; i < n; i++) {
      const tr = smTR[smTR.length - n + i];
      const pdi = tr > 0 ? (100 * smP[smP.length - n + i]) / tr : 0;
      const mdi = tr > 0 ? (100 * smM[smM.length - n + i]) / tr : 0;
      dx.push(pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
    }
    const adxS = wilderSeries(dx, 14);
    if (!adxS.length) return null;
    const adx = adxS[adxS.length - 1];
    if (adx < 25) return null; // no trend — no call
    const lastTR = smTR[smTR.length - 1];
    const pdi = lastTR > 0 ? (100 * smP[smP.length - 1]) / lastTR : 0;
    const mdi = lastTR > 0 ? (100 * smM[smM.length - 1]) / lastTR : 0;
    if (pdi === mdi) return null;
    return { algo: 'adx', dir: pdi > mdi ? 'up' : 'down', confidence: Math.min(1, 0.3 + (adx - 25) / 50), basis: `ADX ${adx.toFixed(0)} trending, ${pdi > mdi ? '+DI' : '−DI'} leads` };
  },
  /** Stochastic 14/3 — oversold/overbought TURNS (%K crossing its %D in the extreme zones). */
  stochastic: (b) => {
    if (b.length < 60) return null;
    const kSeries: number[] = [];
    for (let i = b.length - 5; i < b.length; i++) {
      const win = b.slice(i - 13, i + 1);
      const hh = Math.max(...win.map((x) => x.h));
      const ll = Math.min(...win.map((x) => x.l));
      kSeries.push(hh > ll ? (100 * (b[i].c - ll)) / (hh - ll) : 50);
    }
    const k = kSeries[kSeries.length - 1];
    const d = avg(kSeries.slice(-3));
    if (k < 20 && k > d) return { algo: 'stochastic', dir: 'up', confidence: Math.min(1, 0.4 + (20 - d) / 40), basis: `stoch %K ${k.toFixed(0)} turning up from oversold` };
    if (k > 80 && k < d) return { algo: 'stochastic', dir: 'down', confidence: Math.min(1, 0.4 + (d - 80) / 40), basis: `stoch %K ${k.toFixed(0)} turning down from overbought` };
    return null;
  },
  /** Volume z-surge — unusual volume CONFIRMING the day's direction (the 07-12 tape-quality
   *  lesson: never trust a move without volume; here volume is required, direction is price's). */
  volsurge: (b) => {
    if (b.length < 60) return null;
    const vols = b.slice(-21).map((x) => x.v);
    const base = vols.slice(0, 20);
    const mu = avg(base);
    const sd = Math.sqrt(avg(base.map((x) => (x - mu) ** 2)));
    if (sd <= 0 || mu <= 0) return null;
    const z = (vols[20] - mu) / sd;
    if (z < 2) return null;
    const chg = b[b.length - 1].c / b[b.length - 2].c - 1;
    if (Math.abs(chg) < 0.002) return null; // heavy tape but flat price — no direction to confirm
    return { algo: 'volsurge', dir: chg > 0 ? 'up' : 'down', confidence: Math.min(1, 0.2 + z / 5), basis: `volume z=${z.toFixed(1)} with ${(chg * 100).toFixed(1)}% move` };
  },
};

/**
 * @description Runs the SHADOW indicators over OHLCV bars; drops the ones that don't fire.
 * Recorded by the assess loop beside gravity2 — never consulted by the live ensemble.
 * @param symbol - Ticker.
 * @param bars - Ascending daily OHLCV bars (≥ 60).
 * @param params - Optional tunables (reserved; shadow algos currently use their standard constants).
 * @returns The firing shadow signals.
 */
export function scoreSymbolShadow(symbol: string, bars: OhlcvBar[], params?: StrategyParams): AlgoSignal[] {
  const ctx: AlgoContext = { symbol, params };
  return Object.values(SHADOW_ALGORITHMS).map((fn) => fn(bars, ctx)).filter((s): s is AlgoSignal => s != null);
}

/** The shadow algorithm names (reporting; deliberately NOT part of algoNames/the vote schema). */
export function shadowAlgoNames(): string[] { return Object.keys(SHADOW_ALGORITHMS); }

/**
 * @description Gravity 2 (ADR-054 faithful): the price masses Gravity 1 uses PLUS world-intelligence
 * masses (news/insider/congress — from gravity-world.ts), folded through the SAME displacement engine.
 * Standalone — deliberately NOT in the ensemble ALGORITHMS map, so it's recorded head-to-head against
 * `gravity` without changing the live vote. With no world masses it equals `gravity` exactly.
 * @param symbol - Ticker.
 * @param closes - Close series.
 * @param worldMasses - World masses from deriveWorldMasses (empty = pure price gravity).
 * @param indexCloses - Optional index series (SPY).
 * @param indexName - Index label.
 * @returns The gravity2 signal, or null when displacement is negligible.
 */
export function gravity2Signal(symbol: string, closes: number[], worldMasses: Mass[] = [], indexCloses?: number[], indexName = 'SPY'): AlgoSignal | null {
  const masses = deriveMasses(symbol, closes, indexCloses, indexName).concat(worldMasses);
  const d = displacement(masses, 0);
  if (Math.abs(d) < 0.01) return null;
  return { algo: 'gravity2', dir: d > 0 ? 'up' : 'down', confidence: Math.min(1, Math.abs(d) * 2), basis: `${masses.length} masses (${worldMasses.length} world) → ${(d * 100).toFixed(1)}%` };
}

/**
 * @description Deterministic ensemble: confidence-weighted vote across the signals.
 * @param signals - The per-algo signals (from scoreSymbol).
 * @param weights - Optional per-algo weight (e.g. recent hit-rate); defaults to 1 each.
 * @returns A reproducible buy/sell/hold with a signed agreement score.
 */
export function ensemble(signals: AlgoSignal[], weights: Record<string, number> = {}, threshold: number = DEFAULT_STRATEGY_PARAMS.ensembleThreshold): EnsembleDecision {
  if (!signals.length) return { action: 'hold', side: null, confidence: 0, score: 0, votes: [] };
  let score = 0, w = 0;
  for (const s of signals) { const wt = weights[s.algo] ?? 1; const c = s.confidence * wt; score += (s.dir === 'up' ? 1 : -1) * c; w += c; }
  const norm = w ? score / w : 0;
  const action = norm > threshold ? 'buy' : norm < -threshold ? 'sell' : 'hold';
  return { action, side: action === 'hold' ? null : action, confidence: round(Math.abs(norm)), score: round(norm), votes: signals };
}
