/**
 * Gravity 2 — world-intelligence MASS derivation (ADR-054, the faithful model).
 *
 * Gravity 1 (algorithms.ts `gravity`) derives masses from PRICE only. This module derives the masses the
 * model was actually designed for: real-world forces (news, insider, congress, short interest) pulled
 * from the world-intelligence per-ticker series. Each becomes a gravity mass with a **polarity** (pull
 * up / draw down), a configurable **mass** (magnitude × reach), a **CALCULATED proximity** (how directly
 * the force hits THIS stock — the physics: a huge force far away barely moves price; a smaller force
 * close by moves it a lot), and a **half-life** (decay). The shared `displacement()` then sums them.
 *
 * Pure: a function of (symbol, world-metric snapshot, config). No I/O — the app layer fetches the
 * snapshot (one batched read) and feeds it here, so this stays deterministic + unit-testable.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — world→mass mapping with calculated proximity (directness/focus/reliability/saturation), configurable per-source mass, polarity, half-life.
 *
 * @module gravity-world
 */

import type { Mass } from './algorithms';

/** A world-metric snapshot for one ticker: metric name → average value (+ how many points backed it). */
export type WorldSnapshot = Record<string, { avg: number; points: number }>;

/** Per-source dials. `massScale` is literally "how big this source's mass is" — the tuning knob. */
export interface SourceConfig { enabled: boolean; massScale: number; halfLifeDays: number; }

/** The full, tunable Gravity-2 config (env-overridable via GRAVITY2_*). */
export interface Gravity2Config {
  windowDays: number;
  proximity: { kComention: number; kDispersion: number; volRef: number; floor: number };
  sources: { news: SourceConfig; insider: SourceConfig; congress: SourceConfig; short: SourceConfig };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const num = (s: WorldSnapshot, k: string): number | null => (s[k] && Number.isFinite(s[k].avg) ? s[k].avg : null);
const pts = (s: WorldSnapshot, k: string): number => (s[k] ? s[k].points : 0);
const envNum = (k: string, d: number): number => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const envBool = (k: string, d: boolean): boolean => { const v = process.env[k]; return v == null ? d : v.toLowerCase() === 'true'; };

/** @description The default config, with every dial env-overridable so it tunes without a code change. */
export function defaultGravity2Config(): Gravity2Config {
  return {
    windowDays: envNum('GRAVITY2_WINDOW_DAYS', 7),
    proximity: {
      kComention: envNum('GRAVITY2_PROX_KCOMENTION', 0.0015), // comention_degree runs ~30–800, so a small k
      kDispersion: envNum('GRAVITY2_PROX_KDISPERSION', 1.0),
      volRef: envNum('GRAVITY2_PROX_VOLREF', 20),
      floor: envNum('GRAVITY2_PROX_FLOOR', 0.1),
    },
    sources: {
      news: { enabled: envBool('GRAVITY2_NEWS_ENABLED', true), massScale: envNum('GRAVITY2_NEWS_SCALE', 1.0), halfLifeDays: envNum('GRAVITY2_NEWS_HALFLIFE', 5) },
      insider: { enabled: envBool('GRAVITY2_INSIDER_ENABLED', true), massScale: envNum('GRAVITY2_INSIDER_SCALE', 1.2), halfLifeDays: envNum('GRAVITY2_INSIDER_HALFLIFE', 21) },
      congress: { enabled: envBool('GRAVITY2_CONGRESS_ENABLED', true), massScale: envNum('GRAVITY2_CONGRESS_SCALE', 0.8), halfLifeDays: envNum('GRAVITY2_CONGRESS_HALFLIFE', 30) },
      short: { enabled: envBool('GRAVITY2_SHORT_ENABLED', false), massScale: envNum('GRAVITY2_SHORT_SCALE', 0.5), halfLifeDays: envNum('GRAVITY2_SHORT_HALFLIFE', 10) },
    },
  };
}

/** Saturation: enough evidence to be "real/close" (0..1). A handful of points ⇒ uncertain ⇒ farther. */
function saturation(volume: number, volRef: number): number { return clamp(volume / Math.max(1, volRef), 0, 1); }

/**
 * News-mass proximity — the full four-factor calc (§3 of the design spec):
 * directness (is it about THIS stock vs co-mentioned everywhere), focus (tight agreement vs scatter),
 * reliability (trustworthy sources), saturation (enough evidence). Each in (0,1]; product is the pull.
 */
function newsProximity(s: WorldSnapshot, sentiment: number, cfg: Gravity2Config): number {
  const co = num(s, 'comention_degree') ?? 0;
  const directness = 1 / (1 + cfg.proximity.kComention * Math.max(0, co));
  const consensus = num(s, 'sentiment_consensus');
  const dispersion = num(s, 'sentiment_dispersion');
  const focus = consensus != null
    ? clamp(consensus / (1 + cfg.proximity.kDispersion * Math.max(0, dispersion ?? 0)), 0, 1)
    : 0.6; // neutral when no consensus metric
  const rw = num(s, 'reliability_weighted_sentiment');
  const reliability = rw == null ? 0.7
    : (Math.sign(rw) === Math.sign(sentiment) ? clamp(0.4 + 0.6 * Math.min(1, Math.abs(rw) / (Math.abs(sentiment) + 1e-6)), 0.3, 1) : 0.4);
  const vol = Math.max(pts(s, 'sentiment'), num(s, 'mention_count') ?? 0);
  const sat = saturation(vol, cfg.proximity.volRef);
  // A live catalyst (earnings/M&A/guidance) makes the force more "in orbit" — small proximity boost.
  const catalyst = 1 + Math.min(0.3, (num(s, 'event_earnings') ?? 0) + (num(s, 'event_ma') ?? 0) + (num(s, 'event_guidance') ?? 0));
  return clamp(directness * focus * reliability * sat * catalyst, cfg.proximity.floor, 1);
}

/** A direct (company-specific) source's proximity: factual + about THIS company, scaled by how much
 *  activity backs it. Used for insider/congress/short — no co-mention dilution, no scatter. */
function directProximity(volume: number, base: number, cfg: Gravity2Config): number {
  return clamp(base * saturation(volume, cfg.proximity.volRef), cfg.proximity.floor, 1);
}

/**
 * @description Derive the world-intelligence gravity masses for a symbol from its metric snapshot.
 * Pure. Each enabled source that has data contributes one mass (polarity + configurable mass +
 * calculated proximity + half-life); sources with no data are skipped.
 * @param symbol - Ticker (for labels).
 * @param s - The world-metric snapshot (metric → {avg, points}).
 * @param cfg - Gravity-2 config (defaults from defaultGravity2Config()).
 * @returns The world masses to add to the price masses before displacement.
 */
export function deriveWorldMasses(symbol: string, s: WorldSnapshot, cfg: Gravity2Config = defaultGravity2Config()): Mass[] {
  const masses: Mass[] = [];
  const SYM = symbol.toUpperCase();

  // News sentiment — the loud, fast force.
  const sent = num(s, 'sentiment');
  if (cfg.sources.news.enabled && sent != null && Math.abs(sent) > 1e-3) {
    const reach = saturation(Math.max(pts(s, 'sentiment'), num(s, 'mention_velocity') ?? 0), cfg.proximity.volRef);
    const mass = clamp(Math.min(1, Math.abs(sent)) * (0.5 + 0.5 * reach) * cfg.sources.news.massScale, 0, 1);
    masses.push({ source: 'world/news', label: `${SYM} news sent ${sent.toFixed(2)}`, mass, polarity: sent >= 0 ? 1 : -1, proximity: newsProximity(s, sent, cfg), halfLifeDays: cfg.sources.news.halfLifeDays, t0Day: 0 });
  }

  // Insider buy/sell — direct smart-money. Use the BOUNDED insider_sentiment ((buys−sells)/total ∈ −1..1)
  // for polarity+magnitude; the raw buy/sell counts give reach. (Raw insider_net runs ±9 → would saturate.)
  const ins = num(s, 'insider_sentiment');
  if (cfg.sources.insider.enabled && ins != null && Math.abs(ins) > 1e-3) {
    const vol = (num(s, 'insider_buys') ?? 0) + (num(s, 'insider_sells') ?? 0) + pts(s, 'insider_sentiment');
    const mass = clamp(Math.min(1, Math.abs(ins)) * cfg.sources.insider.massScale, 0, 1);
    masses.push({ source: 'world/insider', label: `${SYM} insider ${ins.toFixed(2)}`, mass, polarity: ins >= 0 ? 1 : -1, proximity: directProximity(vol, 0.95, cfg), halfLifeDays: cfg.sources.insider.halfLifeDays, t0Day: 0 });
  }

  // Congress buy/sell — slow, direct. Bounded congress_sentiment for polarity+magnitude; notional = reach.
  const con = num(s, 'congress_sentiment');
  if (cfg.sources.congress.enabled && con != null && Math.abs(con) > 1e-3) {
    const notional = Math.abs(num(s, 'congress_notional') ?? 0);
    const reach = clamp(notional / 1e6, 0, 1); // $1M+ of trades ⇒ full reach
    const mass = clamp(Math.min(1, Math.abs(con)) * (0.5 + 0.5 * reach) * cfg.sources.congress.massScale, 0, 1);
    masses.push({ source: 'world/congress', label: `${SYM} congress ${con.toFixed(2)}`, mass, polarity: con >= 0 ? 1 : -1, proximity: directProximity(pts(s, 'congress_sentiment') + reach * cfg.proximity.volRef, 0.85, cfg), halfLifeDays: cfg.sources.congress.halfLifeDays, t0Day: 0 });
  }

  // Short interest — bearish pressure (configurable; off by default, ambiguous squeeze risk).
  const shortRatio = num(s, 'short_vol_ratio');
  if (cfg.sources.short.enabled && shortRatio != null && shortRatio > 0.2) {
    const mass = clamp((shortRatio - 0.2) / 0.4 * cfg.sources.short.massScale, 0, 1); // 0.2→0, 0.6→full
    masses.push({ source: 'world/short', label: `${SYM} short ratio ${shortRatio.toFixed(2)}`, mass, polarity: -1, proximity: directProximity(pts(s, 'short_vol_ratio'), 0.8, cfg), halfLifeDays: cfg.sources.short.halfLifeDays, t0Day: 0 });
  }

  return masses;
}

/** The metric names Gravity 2 reads (for the batched world snapshot). */
export const GRAVITY2_METRICS: string[] = [
  'sentiment', 'reliability_weighted_sentiment', 'sentiment_consensus', 'sentiment_dispersion',
  'comention_degree', 'mention_velocity', 'mention_count',
  'insider_sentiment', 'insider_buys', 'insider_sells',
  'congress_sentiment', 'congress_notional', 'short_vol_ratio',
  'event_earnings', 'event_ma', 'event_guidance',
];
