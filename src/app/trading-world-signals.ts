/**
 * Trading world-signals reader — folds the world-intelligence per-ticker series into ONE compact
 * summary + a blended directional score the trading legs can consume (ADR-052/056).
 *
 * The world layer already computes a rich per-ticker series (news sentiment, reliability-weighted
 * sentiment, sentiment momentum, INSIDER + CONGRESS smart-money, short interest, mention velocity,
 * days-to-earnings). Today the trading engine reads exactly ONE of those (`sentiment`) and only as a
 * veto/tilt on the autopilot. This module makes the whole basket available, behind two off-by-default
 * flags so it can be A/B'd in the paper book without changing the baseline:
 *   - TRADING_WORLD_SIGNALS  → the research/fast analyst gets a `world` signal row to reason over.
 *   - TRADING_WORLD_RANK     → the autopilot blends the world score into entry RANKING + sizing (a
 *                              positive conviction input, not just a brake).
 *
 * Reads via the shared WorldIntelligenceService (TSDB pool). Best-effort: any missing metric simply
 * drops out of the blend and the summary — it never throws, so a world outage can't break a trade leg.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — basket reader + blended score + summary; two A/B flags (world→analyst, world→autopilot ranking). Off by default.
 *
 * @module trading-world-signals
 */

import type { WorldIntelligenceService } from '@/features/world-data';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Metrics folded into the blended directional score (only the ones with data count; weights renormalized). */
const COMPONENTS: ReadonlyArray<{ metric: string; label: string; weight: number }> = [
  { metric: 'sentiment', label: 'news sentiment', weight: 0.35 },
  { metric: 'reliability_weighted_sentiment', label: 'reliable-source sentiment', weight: 0.20 },
  { metric: 'sentiment_shift', label: 'sentiment momentum', weight: 0.15 },
  { metric: 'insider_sentiment', label: 'insider buy/sell', weight: 0.20 },
  { metric: 'congress_sentiment', label: 'congress buy/sell', weight: 0.10 },
];

/** Read for context (shown to the analyst) but NOT folded into the directional score — ambiguous sign. */
const CONTEXT_METRICS: ReadonlyArray<{ metric: string; label: string }> = [
  { metric: 'short_vol_ratio', label: 'short-volume ratio' },
  { metric: 'mention_velocity', label: 'mention velocity' },
  { metric: 'days_to_earnings', label: 'days to earnings' },
];

/** The folded world read for one ticker. */
export interface WorldSignals {
  /** Blended directional score in [-1,1] over the available COMPONENTS (null when none have data). */
  score: number | null;
  /** Raw news sentiment avg — the existing veto/gate input (null when absent). */
  sentiment: number | null;
  /** Sentiment point count — the existing ≥N-points gate threshold. */
  points: number;
  /** One-line human/LLM-readable summary of everything that had data. */
  summary: string;
  /** All metrics that returned data: metric → { avg, points }. */
  metrics: Record<string, { avg: number; points: number }>;
}

/** @description True when the research/fast analyst should be handed a world signal row. */
export function worldSignalsEnabled(): boolean {
  return String(process.env.TRADING_WORLD_SIGNALS ?? 'false').toLowerCase() === 'true';
}
/** @description True when the autopilot should blend the world score into entry ranking + sizing. */
export function worldRankEnabled(): boolean {
  return String(process.env.TRADING_WORLD_RANK ?? 'false').toLowerCase() === 'true';
}

/** All metric names the basket reads (components + context) — the column set for the batch query. */
const ALL_METRICS: string[] = [...COMPONENTS, ...CONTEXT_METRICS].map((c) => c.metric);
const entityOf = (symbol: string): string => `world:ticker:${symbol.toLowerCase()}`;

/** Fold one ticker's metric map (metric → {avg,points}) into the blended score + summary. Pure. */
function foldMetrics(symbol: string, byMetric: Map<string, { avg: number; points: number }>): WorldSignals {
  const metrics: Record<string, { avg: number; points: number }> = {};
  for (const [k, v] of byMetric) metrics[k] = v;

  let num = 0, den = 0;
  for (const c of COMPONENTS) {
    const m = metrics[c.metric];
    if (m) { num += c.weight * clamp(m.avg, -1, 1); den += c.weight; }
  }
  const score = den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
  const sentiment = metrics.sentiment?.avg ?? null;
  const points = metrics.sentiment?.points ?? 0;

  const parts: string[] = [];
  for (const c of [...COMPONENTS, ...CONTEXT_METRICS]) {
    const m = metrics[c.metric];
    if (m) parts.push(`${c.label} ${m.avg >= 0 ? '+' : ''}${m.avg.toFixed(2)} (${m.points}pt)`);
  }
  const summary = score != null
    ? `World read for ${symbol.toUpperCase()}: blended ${score >= 0 ? '+' : ''}${score.toFixed(2)} — ${parts.join('; ')}.`
    : `World read for ${symbol.toUpperCase()}: no usable coverage.`;
  return { score, sentiment, points, summary, metrics };
}

/**
 * @description Read the world basket for MANY tickers in ONE batched query and fold each into its
 * blended score + summary. This is the efficient path — one indexed GROUP BY instead of
 * (symbols × metrics) single reads. Best-effort: a world error yields an empty map (callers no-op).
 * @param svc - The world-intelligence service (TSDB-backed).
 * @param symbols - Tickers.
 * @param days - Lookback window (default 30).
 * @returns Map of UPPERCASE symbol → its folded world signals (symbols with no data are absent).
 */
export async function readWorldSignalsBatch(svc: WorldIntelligenceService, symbols: string[], days = 30): Promise<Map<string, WorldSignals>> {
  const out = new Map<string, WorldSignals>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))];
  if (!uniq.length) return out;
  let batch: Map<string, Map<string, { avg: number; points: number }>>;
  try { batch = await svc.metricsBatch(uniq.map(entityOf), ALL_METRICS, days); }
  catch { return out; } // world outage → no signals; callers fall back to the baseline
  for (const sym of uniq) {
    const byMetric = batch.get(entityOf(sym));
    if (byMetric && byMetric.size) out.set(sym, foldMetrics(sym, byMetric));
  }
  return out;
}

/**
 * @description Single-ticker world read (one batched query under the hood). Used by the research/fast
 * analyst path. Returns a no-coverage result on any miss.
 * @param svc - The world-intelligence service.
 * @param symbol - Ticker.
 * @param days - Lookback window (default 30).
 * @returns The folded world signals for the symbol.
 */
export async function readWorldSignals(svc: WorldIntelligenceService, symbol: string, days = 30): Promise<WorldSignals> {
  const m = await readWorldSignalsBatch(svc, [symbol], days);
  return m.get(symbol.toUpperCase()) ?? { score: null, sentiment: null, points: 0, summary: `World read for ${symbol.toUpperCase()}: no usable coverage.`, metrics: {} };
}
