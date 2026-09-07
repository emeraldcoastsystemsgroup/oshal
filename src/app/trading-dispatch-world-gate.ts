/**
 * Trading autopilot — world-intelligence influence gate + earnings blackout (a leg of the dispatch loop).
 *
 * Carved VERBATIM out of trading-schedule-dispatch.ts (its CHANGE LOG SEQ 1-19 hold the history of
 * every function here; see SEQ 15 for the blackout, SEQ 16 for mode-aware arming, and SEQ 15 for the
 * TRADING_WORLD_SENTIMENT_CLEAN switch). Zero behavior change: every env read, default and log line
 * is byte-identical to the monolith. The logger keeps module 'trading-schedule-dispatch' on purpose —
 * the log stream is the watchdog/operator contract, and the file split must be invisible to it.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — decomposition of trading-schedule-dispatch.ts (890 code lines) along its section seams: the world-sentiment veto/tilt constants + reader and the TRADING_EARNINGS_GATE blackout move here unchanged. Env names unchanged: TRADING_WORLD_SENTIMENT_CLEAN, TRADING_WORLD_RANK_WEIGHT, TRADING_EARNINGS_BLACKOUT_DAYS, TRADING_EARNINGS_GATE. Golden-plan guard: tests/unit/trading-dispatch-golden-plan.spec.ts.
 *
 * @module trading-dispatch-world-gate
 */

import type { TradingMode } from '@/features/trading';
import type { WorldIntelligenceService } from '@/features/world-data';
import { createChildLogger } from '@/shared/logger';

// Module name kept as the monolith's: the log stream is the watchdog/operator contract.
const logger = createChildLogger({ module: 'trading-schedule-dispatch' });

// ── World-intelligence influence gate ──────────────────────────────────────────
// The shared world layer scores bias-aware news sentiment per ticker (world:ticker:<sym>). We let it
// VETO and TILT technical entries — don't buy a name the press/influencers are actively souring on, and
// size up/down with the mood — without ever forcing a trade the technicals didn't already want. Sells
// are never gated (you always get to exit). Neutral by construction: thin/absent coverage = no effect.
/** Skip a buy when avg world sentiment is at or below this (strongly negative). */
export const WORLD_SENT_VETO = -0.35;
/** Minimum sentiment data points before the gate acts at all (else neutral — no veto, no tilt). */
export const WORLD_SENT_MIN_POINTS = 3;
/** Lookback window for the ticker sentiment average. */
export const WORLD_SENT_DAYS = 30;
/** TRADING_WORLD_SENTIMENT_CLEAN (default false → today's behavior byte-identical): read the
 *  STRAINED sentiment series (`sentiment_clean`, ADR-096) instead of the raw one. The raw series
 *  counts EVERY headline, including the reactive commentary the 2026-07-14 wire-ceiling study
 *  proved is journalism ABOUT a move ("What's Going On With Intel Stock Friday?"), not news — the
 *  gate has been drinking reaction sentiment. `sentiment_clean` counts only headlines that pass the
 *  shared real-news gate. Both series accrue in parallel, so this is a live A/B: flip it only after
 *  the clean series has coverage and a strategy-log row says it's better. */
const worldSentMetric = (): string =>
  String(process.env.TRADING_WORLD_SENTIMENT_CLEAN ?? 'false').toLowerCase() === 'true' ? 'sentiment_clean' : 'sentiment';
/** TRADING_WORLD_RANK: how much the blended world score moves entry RANK (added to confidence 0..1). */
export const WORLD_RANK_WEIGHT = Number(process.env.TRADING_WORLD_RANK_WEIGHT || 0.25);

/* ── Earnings blackout (TRADING_EARNINGS_GATE, default OFF) ─────────────────────────────────────
 * The first SCHEDULED-event rule the evidence earned (2026-07-14 earnings-proximity study, 505
 * events / 12 months, market-adjusted, judged against a same-symbol random-time control):
 *
 *   holding THROUGH a print:  mean −0.070% · stdev 9.64 · 5th-pct −14.07%
 *   the same names, random:   mean +0.132% · stdev 5.11 · 5th-pct  −7.50%
 *   → 1.89× the volatility, 1.87× the left tail, and you are paid LESS than random (p=0.81).
 *
 * It is UNCOMPENSATED RISK: a binary event we can see on the calendar, that pays nothing on
 * average and doubles the tail. So: do not INITIATE into a name printing within N sessions.
 * Exits are never gated (you always get to leave), and existing holds are untouched unless the
 * operator also sets the trim (a separate, more aggressive decision).
 * Reads the world calendar we already ingest (world_events: 68 earnings in the next 30 days).
 * Neutral by construction: world layer off / read fails → empty set → today's behavior exactly. */
/** Sessions of blackout before a print (2 = the study's window; the gap is what hurts). */
export const EARNINGS_BLACKOUT_DAYS = Math.max(1, Math.min(10, Number(process.env.TRADING_EARNINGS_BLACKOUT_DAYS) || 3));
/**
 * @description True when the earnings no-initiate gate is armed FOR THIS BOOK. Mode-aware
 * (2026-07-17) so the platform's paper-first doctrine applies to gates too: `paper` or `live` arms
 * one book, `true`/`both` arms both, anything else is off. Lets the rule soak on the paper book —
 * with the gate-block ledger collecting its counterfactuals — before real money adopts it.
 * @param mode - Which book is firing.
 * @returns Whether the gate applies to this book's entries.
 */
function earningsGateEnabled(mode: TradingMode): boolean {
  const v = String(process.env.TRADING_EARNINGS_GATE ?? 'false').toLowerCase();
  return v === 'true' || v === 'both' || v === mode;
}
/**
 * @description Symbols with a scheduled earnings print inside the blackout window — never bought
 * fresh while the gate is armed. Best-effort: any failure returns an empty set (no gating).
 * @param svc - World-intelligence service (null when the layer is off).
 * @param mode - Which book is firing (the gate arms per book).
 * @returns Upper-cased symbols printing within EARNINGS_BLACKOUT_DAYS.
 */
export async function earningsBlackout(svc: WorldIntelligenceService | null, mode: TradingMode): Promise<Set<string>> {
  if (!svc || !earningsGateEnabled(mode)) return new Set();
  try {
    const evs = await svc.upcomingEvents(EARNINGS_BLACKOUT_DAYS);
    const out = new Set<string>();
    for (const e of evs) {
      if (e.eventType !== 'earnings') continue;
      const sym = e.entityId.replace(/^world:ticker:/, '').toUpperCase();
      if (sym && sym !== e.entityId.toUpperCase()) out.add(sym);
    }
    return out;
  } catch (e) {
    logger.warn({ err: e }, 'earnings blackout read failed — no gating this fire');
    return new Set();
  }
}

/**
 * @description Clamp a number into [lo, hi].
 * @param v - The value.
 * @param lo - Lower bound.
 * @param hi - Upper bound.
 * @returns The clamped value.
 */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A ticker's world-sentiment read: avg score in [-1,1] (null = no usable coverage) + point count. */
export interface WorldSent { score: number | null; points: number; }

/**
 * @description Read the bias-aware world sentiment for a ticker from the shared world series.
 * @param svc - World-intelligence service (null when the layer is disabled → neutral).
 * @param symbol - Ticker symbol.
 * @returns Avg sentiment + point count; {null,0} on any miss so the gate stays neutral.
 */
export async function worldSentiment(svc: WorldIntelligenceService | null, symbol: string): Promise<WorldSent> {
  if (!svc) return { score: null, points: 0 };
  try {
    const r = await svc.metricAvg(`world:ticker:${symbol.toLowerCase()}`, worldSentMetric(), WORLD_SENT_DAYS);
    return { score: r.avg, points: r.points };
  } catch {
    return { score: null, points: 0 };
  }
}
