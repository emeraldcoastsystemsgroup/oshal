/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Rotation entry guards. Born from the 2026-07-14 live open: the autopilot stopped IBM out at -23.8% (Q2 revenue-miss gap) and RE-BOUGHT it in the same fire. Two independent causes, two guards: (1) SAME-FIRE RE-ENTRY — runAutopilot's protective leg knows which names it is exiting, but rotation never saw that set, so it re-bought the name the stop had just sold; (2) GAP-DOWN — the ranker scores on 1Day closes, which PREDATE today's gap, so a name that cratered overnight still ranks on stale data and gets bought mid-crash. Deterministic and price-only: no news wire, no LLM (the event-pop family is closed — a commentary wire does not precede price; a gap does, because it IS the price).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-052 addendum — the MARKET-WIDE gap-down entry filter's pure half: marketGapBlock (SPY now vs its prior session close against a pre-registered bar, fail-open on missing data) and marketGapFilterPct, the ONE resolver the dispatch and the Strategy Lab both read (a finite StrategyConfig knob decides; an absent knob inherits the mode-aware TRADING_MARKET_GAP_FILTER / TRADING_MARKET_GAP_PCT env default, OFF unless armed; a Lab walk has no book, so absent = off there). modeArmed is the shared paper|live|both|true parser the exit-plan resolver reuses. The per-name rotation guard above is unchanged.
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

/* ── Market-wide gap-down entry filter (ADR-052 addendum, paper-to-live parity) ─────────────────
 * The per-name guard above reads ONE candidate's own gap. This reads the whole tape: when SPY is
 * trading at or beyond a pre-registered bar below its prior session close, the autopilot's ENTRY
 * legs hold for the fire; protective exits never do. The bar is pre-registered, not fitted. */

/** Pre-registered bar (percent) — the same 1.0% line the trading watchdog's pre-market gap alert
 *  (check F, GapAlertPct) already pages the operator on, so the automated filter and its interim
 *  human stand-in judge the same tape. */
export const DEFAULT_MARKET_GAP_PCT = 1;

/** The ceiling a knob or env value is clamped to: a wider bar is indistinguishable from "off". */
const MAX_MARKET_GAP_PCT = 50;

/**
 * @description Mode-aware arming for a paper-to-live parity feature, parsed exactly as the earnings
 * gate parses TRADING_EARNINGS_GATE: `paper` or `live` arms that one book kind, `both` or `true` arms
 * both, anything else (including unset) is off. Paper-first soaks arm `paper`.
 * @param envName - The environment variable holding the arm.
 * @param mode - The book kind firing.
 * @returns True when the variable arms this book kind.
 */
export function modeArmed(envName: string, mode: 'paper' | 'live'): boolean {
  const v = String(process.env[envName] ?? 'false').trim().toLowerCase();
  return v === 'true' || v === 'both' || v === mode;
}

/**
 * @description The market-wide gap-down bar for one book or one Strategy Lab walk — the ONE resolver
 * both read, so the paper book, the live book and the Lab run the same rule from the same knob.
 * Precedence: a finite `knob` (StrategyConfig.marketGapFilterPct on the applied strategy) decides —
 * 0 is an explicit off, a positive value arms at that percent. An absent knob (null/undefined, the
 * default for every strategy saved before the knob existed) inherits the book's mode-aware env
 * default: TRADING_MARKET_GAP_FILTER arms the book kind, TRADING_MARKET_GAP_PCT sets the bar
 * (default {@link DEFAULT_MARKET_GAP_PCT}). A Lab walk passes mode null and has no env default, so an
 * absent knob is off there.
 * @param knob - The applied StrategyConfig's marketGapFilterPct (null/undefined = inherit).
 * @param mode - The book kind firing, or null for a Lab walk.
 * @returns The bar as a positive percent; 0 means the filter is off.
 */
export function marketGapFilterPct(knob: number | null | undefined, mode: 'paper' | 'live' | null): number {
  if (knob !== null && knob !== undefined) {
    const k = Number(knob);
    return Number.isFinite(k) && k > 0 ? Math.min(MAX_MARKET_GAP_PCT, k) : 0;
  }
  if (!mode || !modeArmed('TRADING_MARKET_GAP_FILTER', mode)) return 0;
  const raw = Number(process.env.TRADING_MARKET_GAP_PCT ?? DEFAULT_MARKET_GAP_PCT);
  return Number.isFinite(raw) && raw > 0 ? Math.min(MAX_MARKET_GAP_PCT, raw) : 0;
}

/** The market-wide verdict for one fire (or one Lab session), with the numbers that produced it. */
export interface MarketGapVerdict {
  /** True when the entry legs hold this fire. */
  blocked: boolean;
  /** SPY's signed percent move from its prior session close; null when either price is missing. */
  gapPct: number | null;
  /** The SPY price judged (current print, or the session open in the Lab). */
  spyPrice: number | null;
  /** SPY's prior SESSION close (never today's forming bar). */
  spyPriorClose: number | null;
  /** The bar applied, as a positive percent (0 = off). */
  thresholdPct: number;
}

/**
 * @description Judge the whole tape once: block entries when SPY sits at or beyond `thresholdPct`
 * below its prior session close. Fails OPEN — a missing or unusable price yields `blocked: false` —
 * because a data hole must never silently stop the book from buying (the entry-guard doctrine above).
 * A threshold of 0 is the off switch and never blocks.
 * @param spyPrice - SPY's current print (the dispatch) or session open (the Lab).
 * @param spyPriorClose - SPY's prior session close.
 * @param thresholdPct - The bar as a positive percent; 0 = off.
 * @returns The verdict, carrying the gap it measured.
 */
export function marketGapBlock(spyPrice: number | null, spyPriorClose: number | null, thresholdPct: number): MarketGapVerdict {
  const gap = spyPrice != null && spyPriorClose != null ? gapPct(spyPrice, spyPriorClose) : null;
  return {
    blocked: thresholdPct > 0 && gap != null && gap <= -thresholdPct,
    gapPct: gap, spyPrice: spyPrice ?? null, spyPriorClose: spyPriorClose ?? null, thresholdPct,
  };
}
