/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Rotation entry guards. Born from the 2026-07-14 live open: the autopilot stopped IBM out at -23.8% (Q2 revenue-miss gap) and RE-BOUGHT it in the same fire. Two independent causes, two guards: (1) SAME-FIRE RE-ENTRY — runAutopilot's protective leg knows which names it is exiting, but rotation never saw that set, so it re-bought the name the stop had just sold; (2) GAP-DOWN — the ranker scores on 1Day closes, which PREDATE today's gap, so a name that cratered overnight still ranks on stale data and gets bought mid-crash. Deterministic and price-only: no news wire, no LLM (the event-pop family is closed — a commentary wire does not precede price; a gap does, because it IS the price).
 *
 * @module entry-guards
 */

import type { DatedClose } from './market-data';

/** Default gap-down bar: a candidate that opened ≥8% below its prior close is not a rotation buy. */
export const DEFAULT_MAX_GAP_DOWN_PCT = 8;

/**
 * @description The gap-down bar, in percent, read from TRADING_ROTATION_MAX_GAP_DOWN_PCT. A candidate
 *   whose current price sits this far (or further) below its PRIOR SESSION CLOSE is refused as a
 *   rotation buy target. `0` (or a negative/NaN value) disables the guard entirely — an explicit
 *   operator off-switch, since a guard you cannot turn off is a guard you cannot backtest against.
 * @returns The gap-down bar as a POSITIVE percent (8 = "block at -8% or worse"); 0 = disabled.
 */
export function maxGapDownPct(): number {
  const raw = Number(process.env.TRADING_ROTATION_MAX_GAP_DOWN_PCT ?? DEFAULT_MAX_GAP_DOWN_PCT);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

/**
 * @description Percent move from a prior close to the current price. Negative = gapped DOWN.
 *   Returns null when the reference close is unusable (0, negative, missing), so callers can tell
 *   "no opinion" apart from "flat" and fail OPEN rather than blocking a name on bad data.
 * @param current - Current/last price.
 * @param priorClose - The prior SESSION's official close (never today's forming bar).
 * @returns The signed percent gap, or null when it cannot be computed.
 */
export function gapPct(current: number, priorClose: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(priorClose) || priorClose <= 0 || current <= 0) return null;
  return ((current - priorClose) / priorClose) * 100;
}

/**
 * @description The prior session's close for a symbol: the last daily bar STRICTLY BEFORE today's
 *   ET session date. This is the whole point of the guard — using the last element of a daily series
 *   would silently pick up today's own forming bar mid-session, which makes the gap compute as ~0 and
 *   the guard a no-op exactly when it matters (at the open, on the day of the gap).
 * @param closes - Dated daily closes, ascending.
 * @param todayEt - Today's ET session date as YYYY-MM-DD.
 * @returns The prior session close, or null when the series has no bar before today.
 */
export function priorSessionClose(closes: DatedClose[] | undefined, todayEt: string): number | null {
  if (!closes || !closes.length) return null;
  for (let i = closes.length - 1; i >= 0; i--) {
    const bar = closes[i];
    if (bar && bar.d < todayEt && Number.isFinite(bar.c) && bar.c > 0) return bar.c;
  }
  return null;
}

/** Today's session date in America/New_York as YYYY-MM-DD — the market's day, not the server's. */
export function etSessionDate(nowMs: number = Date.now()): string {
  return new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Why a candidate was refused a rotation buy (null = allowed). */
export type EntryBlockReason = 'exiting-this-fire' | 'gap-down';

/** A refused candidate, with the number that refused it (gapPct is null for the re-entry guard). */
export interface EntryBlock {
  symbol: string;
  reason: EntryBlockReason;
  gapPct: number | null;
}

/** Everything the guards need to judge one candidate. */
export interface EntryGuardInput {
  /** Symbols the protective leg is exiting IN THIS SAME FIRE (stop-loss / take-profit / trailing). */
  exiting: Set<string>;
  /** Prior-session close per symbol (see priorSessionClose). Missing = no opinion = allowed. */
  priorCloses: Map<string, number>;
  /** Current price per symbol. Missing = no opinion = allowed. */
  currentPrices: Map<string, number>;
  /** The gap-down bar as a positive percent; 0 disables the gap guard. */
  maxGapDownPct: number;
}

/**
 * @description Judge ONE rotation buy candidate. Two independent refusals:
 *
 *   1. `exiting-this-fire` — the protective leg is selling this name RIGHT NOW (stop/TP/trailing).
 *      Buying it back in the same fire is incoherent on its face: it converts a risk exit into a
 *      round-trip, and re-buying a name sold at a loss inside 30 days is a WASH SALE, which
 *      disallows the loss for tax. The stop must be allowed to mean what it says.
 *
 *   2. `gap-down` — the name is trading ≥maxGapDownPct BELOW its prior close. The ranker scores on
 *      daily closes, so on a gap day it is ranking a stock that no longer exists at that price. This
 *      guard is the ranker's missing eyes, not a view on whether the gap will mean-revert.
 *
 *   Fails OPEN on missing data (no price, no prior close) — a data hole must never silently empty
 *   the sleeve. Held names are unaffected: this gates BUYS only; protective exits always run.
 *
 * @param symbol - Candidate symbol (case-insensitive).
 * @param input - Guard inputs (exiting set, prior closes, current prices, the bar).
 * @returns The block, or null when the candidate may be bought.
 */
export function entryBlock(symbol: string, input: EntryGuardInput): EntryBlock | null {
  const sym = symbol.toUpperCase();
  if (input.exiting.has(sym)) return { symbol: sym, reason: 'exiting-this-fire', gapPct: null };
  if (input.maxGapDownPct <= 0) return null;
  const prior = input.priorCloses.get(sym);
  const current = input.currentPrices.get(sym);
  if (prior == null || current == null) return null; // no opinion → allowed
  const gap = gapPct(current, prior);
  if (gap == null) return null;
  if (gap <= -input.maxGapDownPct) return { symbol: sym, reason: 'gap-down', gapPct: gap };
  return null;
}

/**
 * @description Walk a ranked candidate list strongest-first and take the first `n` that survive the
 *   guards. Refused names FREE THEIR SLOT to the next-best candidate rather than shrinking the
 *   sleeve — a blocked leader must not leave the book sitting in cash (the 2026-07-07 lesson: an
 *   open that bought nothing burned the day's only buy window).
 * @param ranked - Candidate symbols, already sorted strongest-first and already filtered for
 *   score/blocklist by the caller.
 * @param n - How many names the sleeve should hold.
 * @param input - Guard inputs.
 * @returns The surviving target list (length ≤ n) and every refusal, for the run log.
 */
export function selectEntryTargets(
  ranked: string[], n: number, input: EntryGuardInput,
): { targets: string[]; blocked: EntryBlock[] } {
  const targets: string[] = [];
  const blocked: EntryBlock[] = [];
  for (const sym of ranked) {
    if (targets.length >= n) break;
    const block = entryBlock(sym, input);
    if (block) { blocked.push(block); continue; }
    targets.push(sym.toUpperCase());
  }
  return { targets, blocked };
}
