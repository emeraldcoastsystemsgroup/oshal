/**
 * Multi-timeframe trend engine — the autopilot's deterministic decision core (ADR-052/053/054).
 *
 * The trading bot wakes every 5 minutes and, for each watched ticker, reads its trend across
 * FIVE timeframes — 5-minute, hourly, daily, weekly, and quarterly (3-month bars) — then folds
 * them into ONE risk-aware call. Each timeframe is scored by the SAME deterministic algorithm
 * ensemble (momentum/gravity/donchian/meanrev in algorithms.ts); the timeframes are then
 * combined with fixed weights that favour the longer, higher-conviction trends.
 *
 * "Weight risk" is concrete here, not a slogan:
 *  - Longer timeframes (weekly + quarterly) define the REGIME. A buy is only allowed when the
 *    regime is not bearish, and a sell only when it is not bullish — the bot never fights the
 *    higher timeframe. That alignment gate is the primary risk control.
 *  - The combined score must clear a band (|score| > 0.2) before any action — small, ambiguous
 *    signals resolve to HOLD.
 *
 * No LLM, no randomness: same bars in → same decision out. The bot's accountable cost lands when
 * the controller records the decision + order on its node, exactly like the single-timeframe
 * algo path; this module only computes the call.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — multi-timeframe (5Min/1Hour/1Day/1Week/3Month) confluence over the deterministic ensemble, regime-alignment risk gate, batched scan for a ~100-name universe, and the default sector-diversified universe.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add isShortTermBreakdown — flags a held name breaking down hard on BOTH short timeframes (5Min+1Hour) even while the regime is still up, so the autopilot can protect the book on a fast news-driven intraday crash the regime-weighted score is too slow to catch.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add SKHY (SK Hynix ADR, Nasdaq IPO 2026-07-10) to DEFAULT_UNIVERSE per operator request — note it stays HOLD until enough bar history accumulates for the multi-timeframe ensemble (weekly/quarterly regimes need months).
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Universe 106 → 140 (operator request): +34 liquid up-and-comers (AI/semis, growth software, fintech, consumer growth, defense/space, AI-power) — the momentum pool the gravity rotation ranks. Sector map + world-pulse press names updated in the same commit.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Universe 140 → 159 (operator regime-change reweight): +9 materials/mining, +5 data-storage (memory/NAND supercycle pool beside MU/SKHY), +3 Buffett-13F gaps (MCO/VRSN/KHC), +2 politician-disclosure gaps (TEM/AB). Sector map (new materials + storage buckets) + press names updated in the same commit.
 *
 * @module multi-timeframe
 */

import { scoreSymbol, ensemble, type AlgoSignal, type StrategyParams } from './algorithms';
import { barsBatch, type Timeframe } from './market-data';

/** Per-timeframe weight (sums to 1.0). Longer trends carry more of the combined conviction. */
const TF_WEIGHTS: ReadonlyArray<{ tf: Timeframe; weight: number }> = [
  { tf: '5Min', weight: 0.10 },
  { tf: '1Hour', weight: 0.15 },
  { tf: '1Day', weight: 0.30 },
  { tf: '1Week', weight: 0.25 },
  { tf: '3Month', weight: 0.20 },
];

/** Timeframes that define the regime (the higher-timeframe trend the bot must align with). */
const HIGHER_TFS: ReadonlyArray<Timeframe> = ['1Week', '3Month'];

/** Combined-score band an action must clear; below it the call is HOLD. */
const ACTION_THRESHOLD = 0.2;
/** How far the regime may lean against a trade before it is vetoed (risk-alignment tolerance). */
const REGIME_TOLERANCE = 0.05;

/** The short timeframes that flag a FAST (intraday / news-driven) breakdown. */
const SHORT_TFS: ReadonlyArray<Timeframe> = ['5Min', '1Hour'];
/** Each short timeframe must be selling with at least this much conviction to count as a breakdown. */
const SHORT_BREAKDOWN_SCORE = 0.34;

const round = (n: number, d = 4): number => { const f = 10 ** d; return Math.round(n * f) / f; };

/** One timeframe's read for a symbol. */
export interface TimeframeView {
  timeframe: Timeframe;
  weight: number;
  action: 'buy' | 'sell' | 'hold';
  score: number;       // -1..1 signed agreement at this timeframe
  confidence: number;  // 0..1
  bars: number;        // how many bars were available
}

/** The multi-timeframe decision for one symbol. */
export interface MtfDecision {
  symbol: string;
  price: number | null;
  action: 'buy' | 'sell' | 'hold';
  side: 'buy' | 'sell' | null;
  score: number;         // -1..1 weighted across timeframes
  confidence: number;    // 0..1 weighted across timeframes
  regime: number;        // -1..1 higher-timeframe lean
  perTimeframe: TimeframeView[];
  rationale: string;
}

/**
 * @description Fold one symbol's per-timeframe close series into a risk-aware decision (pure —
 * exported for deterministic testing without market-data fetches).
 * @param symbol - Ticker.
 * @param closesByTf - Map of timeframe → close series for THIS symbol (missing/short series skipped).
 * @returns The combined multi-timeframe decision.
 */
export function decideSymbol(symbol: string, closesByTf: Map<Timeframe, number[]>, algoWeights: Record<string, number> = {}, params?: StrategyParams): MtfDecision {
  const views: TimeframeView[] = [];
  let price: number | null = null;
  for (const { tf, weight } of TF_WEIGHTS) {
    const closes = closesByTf.get(tf) || [];
    if (!closes.length) continue;
    if (tf === '5Min' || price == null) price = closes[closes.length - 1];
    // `algoWeights` are the OVERNIGHT-LEARNED per-algo masses: an algo that has been predictive
    // pulls harder in the vote; one that hasn't, less. Empty = every algo weight 1 (raw engine).
    // `params` are the APPROVED tuned strategy params (omitted = today's defaults).
    const ens = ensemble(scoreSymbol(symbol, closes, undefined, 'SPY', params), algoWeights, params?.ensembleThreshold);
    views.push({ timeframe: tf, weight, action: ens.action, score: ens.score, confidence: ens.confidence, bars: closes.length });
  }

  const totalW = views.reduce((s, v) => s + v.weight, 0) || 1;
  const score = round(views.reduce((s, v) => s + v.weight * v.score, 0) / totalW);
  const confidence = round(views.reduce((s, v) => s + v.weight * v.confidence, 0) / totalW);
  const higher = views.filter((v) => HIGHER_TFS.includes(v.timeframe));
  const regime = round(higher.length ? higher.reduce((s, v) => s + v.score, 0) / higher.length : 0);

  let action: 'buy' | 'sell' | 'hold' = 'hold';
  if (score > ACTION_THRESHOLD && regime >= -REGIME_TOLERANCE) action = 'buy';
  else if (score < -ACTION_THRESHOLD && regime <= REGIME_TOLERANCE) action = 'sell';

  const rationale = `MTF score ${score.toFixed(2)} (regime ${regime.toFixed(2)}, conf ${confidence.toFixed(2)}) → ${action}. `
    + views.map((v) => `${v.timeframe}:${v.action}(${v.score.toFixed(2)})`).join(', ')
    + (views.length < TF_WEIGHTS.length ? ` [${TF_WEIGHTS.length - views.length} tf w/o data]` : '');

  return { symbol, price, action, side: action === 'hold' ? null : action, score, confidence, regime, perTimeframe: views, rationale };
}

/**
 * @description True when a held name is breaking down hard on the SHORT timeframes — both 5-minute
 * and 1-hour decisively bearish — even if the longer-timeframe regime is still up. This is the
 * signature of a fast, news-driven intraday selloff that the regime-weighted combined score is too
 * slow to flag (it leans on daily/weekly/quarterly). Requires BOTH short TFs aligned bearish so
 * normal noise can't trigger a micro-loss churn — the dispatch turns a true breakdown into a
 * protective sell of the position.
 * @param d - The symbol's multi-timeframe decision (from the scan).
 * @param threshold - Min bearish |score| each short TF must clear (default SHORT_BREAKDOWN_SCORE).
 * @returns True if a protective breakdown exit is warranted.
 */
export function isShortTermBreakdown(d: MtfDecision, threshold = SHORT_BREAKDOWN_SCORE): boolean {
  const fast = d.perTimeframe.filter((v) => SHORT_TFS.includes(v.timeframe));
  if (fast.length < SHORT_TFS.length) return false; // need BOTH short TFs present to confirm
  return fast.every((v) => v.action === 'sell' && v.score <= -threshold);
}

/**
 * @description True when a name is POPPING on the 5-minute bar — a decisive intraday upside surge the
 * daily rank hasn't funded yet. The mirror of isShortTermBreakdown, but for ENTRIES and using the
 * 5-minute view ALONE (the 1-hour feed is truncated at scale, so requiring both short TFs — as the
 * breakdown does — would never fire for most names). Requires a genuine 5-min BUY past the threshold with
 * enough bars, so intraday noise can't trigger a chase. Lets the pop-catcher pull an unfunded watchlist
 * name IN the moment it actually moves.
 * @param d - The symbol's multi-timeframe decision (from the scan).
 * @param threshold - Min bullish 5-min score to confirm a pop (default SHORT_BREAKDOWN_SCORE).
 * @returns True if a 5-minute momentum pop is confirmed.
 */
export function isShortTermPop(d: MtfDecision, threshold = SHORT_BREAKDOWN_SCORE): boolean {
  const five = d.perTimeframe.find((v) => v.timeframe === '5Min');
  if (!five || five.bars < 12) return false; // need enough 5-min bars to trust the move
  return five.action === 'buy' && five.score >= threshold;
}

/**
 * @description Scan many symbols across all timeframes (batched: ~1 request per timeframe).
 * @param symbols - Tickers to assess.
 * @returns Map of UPPERCASE symbol → its multi-timeframe decision.
 */
export async function multiTimeframeScan(symbols: string[], algoWeights: Record<string, number> = {}, params?: StrategyParams): Promise<Map<string, MtfDecision>> {
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const fetched = await Promise.all(TF_WEIGHTS.map(async ({ tf }) => [tf, await barsBatch(uniq, tf)] as const));
  const byTf = new Map<Timeframe, Map<string, number[]>>(fetched);
  const out = new Map<string, MtfDecision>();
  for (const sym of uniq) {
    const closesByTf = new Map<Timeframe, number[]>();
    for (const { tf } of TF_WEIGHTS) {
      const series = byTf.get(tf)?.get(sym);
      if (series) closesByTf.set(tf, series);
    }
    out.set(sym, decideSymbol(sym, closesByTf, algoWeights, params));
  }
  return out;
}

/**
 * @description Convenience single-symbol multi-timeframe decision (used by the interactive route).
 * @param symbol - Ticker.
 * @returns The multi-timeframe decision.
 */
export async function multiTimeframeDecision(symbol: string): Promise<MtfDecision> {
  return (await multiTimeframeScan([symbol])).get(symbol.toUpperCase())
    ?? { symbol: symbol.toUpperCase(), price: null, action: 'hold', side: null, score: 0, confidence: 0, regime: 0, perTimeframe: [], rationale: 'no data' };
}

/** Re-export for callers that record the algo votes alongside a decision. */
export type { AlgoSignal };

/**
 * The default ~100-name universe the autopilot watches, diversified across the sectors the
 * operator asked for: technology, financials, blue-chip/consumer, energy, and pharma/health.
 * Liquid US large-caps with reliable multi-timeframe history.
 */
export const DEFAULT_UNIVERSE: string[] = [
  // Technology (25)
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'ORCL', 'CRM', 'ADBE',
  'AMD', 'INTC', 'CSCO', 'QCOM', 'TXN', 'IBM', 'NOW', 'INTU', 'AMAT', 'MU',
  'PANW', 'SNOW', 'SHOP', 'UBER', 'PLTR',
  // SK Hynix ADR — Nasdaq IPO 2026-07-10 (operator request). No usable multi-timeframe history
  // until bars accumulate; the ensemble returns HOLD ("no data") for it in the interim.
  'SKHY',
  // Financials (20)
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'SCHW', 'BLK', 'AXP', 'SPGI',
  'BX', 'V', 'MA', 'PYPL', 'COF', 'USB', 'PNC', 'TFC', 'CB', 'MMC',
  // Blue-chip / consumer (20)
  'WMT', 'COST', 'PG', 'KO', 'PEP', 'MCD', 'DIS', 'NKE', 'HD', 'LOW',
  'SBUX', 'TGT', 'CAT', 'GE', 'HON', 'UPS', 'BA', 'MMM', 'CL', 'PM',
  // Energy (15)
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PSX', 'MPC', 'VLO', 'OXY', 'WMB',
  'KMI', 'HAL', 'DVN', 'HES', 'BKR',
  // Pharma / health (20)
  'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'DHR', 'BMY', 'AMGN',
  'GILD', 'CVS', 'UNH', 'MDT', 'ISRG', 'VRTX', 'REGN', 'ZTS', 'BIIB', 'MRNA',
  // Biotech / genomics ETFs (operator request 2026-07-08) — sector-level biotech exposure the
  // single-name pharma block can't give; liquid funds, so the same bar-driven engine applies.
  'XBI', 'IBB', 'FBT', 'ARKG', 'GNOM',
  // Up-and-comers (operator request 2026-07-10, universe 106 → 140): liquid growth names across
  // AI/semis, software, fintech, consumer growth, defense/space, and AI-power — the momentum pool
  // the gravity rotation ranks. All have 60+ daily bars (rankUniverse's floor); recent IPOs enter
  // the leaderboard automatically once their history crosses it.
  'ARM', 'MRVL', 'TSM', 'ASML', 'LRCX', 'KLAC', 'MPWR', 'ANET', 'SMCI', 'VRT',
  'CRWD', 'DDOG', 'NET', 'MDB', 'ZS', 'APP',
  'COIN', 'HOOD', 'SOFI', 'NU', 'AFRM',
  'DASH', 'ABNB', 'RBLX', 'CVNA', 'DUOL',
  'AXON', 'RKLB', 'PWR', 'ETN',
  'VST', 'CEG', 'GEV', 'NRG',
  // Regime-change reweight (operator request 2026-07-26, universe 140 → 159): materials/mining,
  // the data-storage/memory pool (SNDK = SanDisk, WDC spin-off Feb 2025 — history clears the
  // 60-bar rotation floor), Buffett-13F names not already present, and politician-disclosure
  // names (TEM = Tempus AI, AB = AllianceBernstein, both in Pelosi's 2025-26 filings).
  'FCX', 'NEM', 'LIN', 'APD', 'SCCO', 'NUE', 'STLD', 'ALB', 'MP',
  'STX', 'WDC', 'SNDK', 'PSTG', 'NTAP',
  'MCO', 'VRSN', 'KHC',
  'TEM', 'AB',
];
