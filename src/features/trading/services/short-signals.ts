/**
 * Short signals — purpose-built bearish entry/exit signals + the market-regime gate (ADR-053 kin).
 *
 * Why this module exists: the 2026-07-08 short backtest proved the engine's LONG signals carry no
 * short edge — "not a buy" mostly means "no signal", and shorting its absence lost money in every
 * variant (see [[short-strategy-verdict]] / scripts/oshal-trading-short-backtest.ts). A short book
 * needs signals DESIGNED for the short side, and — the part most short strategies get wrong — a
 * regime gate that keeps the book EMPTY while the market drifts up, because the up-drift plus
 * borrow is a structural tax no stock-picking overcomes.
 *
 * DESIGN DISCIPLINE — parameters are the CLASSIC literature values, not fitted to our data:
 * Donchian 55/20 (the turtle breakout pair, mirrored downward), 200-day SMA for the market regime,
 * 63-day (one quarter) relative strength. Nothing here was tuned against the backtest window; if a
 * strategy built from these fails the multi-year test, the honest conclusion is "no edge", not
 * "try other parameters" — parameter search on the same window is how backtests lie.
 *
 * All functions are PURE over ascending close series (newest last) so the same code runs in the
 * autopilot, the backtest, and unit tests.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — marketBearGate (SPY < SMA200), donchianBreakdown 55-low entry / 20-high cover, relativeReturn (63d vs market), trendBroken (SMA20<SMA50 + price below both). Classic untuned parameters by design; built for the bear-regime-validated short strategy the 07-08 verdict requires.
 *
 * @module short-signals
 */

/** Simple moving average of the last `n` values, or null when the series is too short. */
export function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

/**
 * @description The market-regime gate: shorts are allowed ONLY while the market trades below its
 * long trend. The single most load-bearing rule of any equity short strategy — in an up-drifting
 * tape (the 2026 window that killed every naive variant) it keeps the short book EMPTY, which is
 * the correct position; in 2022-style regimes it opens.
 * @param marketCloses - Ascending closes of the market proxy (SPY).
 * @param n - Trend length in sessions (default 200 — the classic long-trend line).
 * @returns True when the latest close is below the n-session SMA (bear regime → shorts allowed).
 */
export function marketBearGate(marketCloses: number[], n = 200): boolean {
  const m = sma(marketCloses, n);
  if (m == null) return false; // not enough history to know the regime → fail CLOSED (no shorts)
  return marketCloses[marketCloses.length - 1] < m;
}

/**
 * @description Donchian breakdown — the turtle 55-day breakout, mirrored downward: today's close
 * printing STRICTLY below the lowest close of the prior `n` sessions. A trend-following short
 * entry: it never anticipates, it joins a downtrend already breaking to new lows.
 * @param closes - Ascending closes (newest last).
 * @param n - Channel length in sessions (default 55; prior window EXCLUDES today).
 * @returns True when today's close is a fresh n-session breakdown.
 */
export function donchianBreakdown(closes: number[], n = 55): boolean {
  if (closes.length < n + 1) return false;
  const today = closes[closes.length - 1];
  let lo = Infinity;
  for (let i = closes.length - 1 - n; i < closes.length - 1; i++) lo = Math.min(lo, closes[i]);
  return today < lo;
}

/**
 * @description Donchian cover — the matching turtle exit: today's close printing above the highest
 * close of the prior `n` sessions ends the downtrend claim, so the short covers.
 * @param closes - Ascending closes (newest last).
 * @param n - Channel length in sessions (default 20; prior window EXCLUDES today).
 * @returns True when today's close breaks the n-session high (cover the short).
 */
export function donchianCover(closes: number[], n = 20): boolean {
  if (closes.length < n + 1) return false;
  const today = closes[closes.length - 1];
  let hi = -Infinity;
  for (let i = closes.length - 1 - n; i < closes.length - 1; i++) hi = Math.max(hi, closes[i]);
  return today > hi;
}

/**
 * @description Trend break — price below BOTH its 20- and 50-session SMAs with the 20 below the 50
 * (the swing-scale death-cross posture). Used as entry CONFIRMATION: a breakdown inside an intact
 * uptrend is usually noise; one inside a broken trend is the move continuing.
 * @param closes - Ascending closes (newest last).
 * @returns True when the trend is broken to the downside.
 */
export function trendBroken(closes: number[]): boolean {
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  if (s20 == null || s50 == null) return false;
  const px = closes[closes.length - 1];
  return s20 < s50 && px < s20 && px < s50;
}

/**
 * @description Relative return — the name's trailing `n`-session return minus the market's. The
 * backtest ranks candidates by this (weakest first): in a falling tape the weakest names fall
 * hardest, and in any tape it avoids shorting names that are merely pausing while strong.
 * @param closes - Ascending closes of the name.
 * @param marketCloses - Ascending closes of the market proxy over the same sessions.
 * @param n - Lookback in sessions (default 63 — one quarter).
 * @returns Relative return (negative = weaker than market), or null when either series is short.
 */
export function relativeReturn(closes: number[], marketCloses: number[], n = 63): number | null {
  if (closes.length < n + 1 || marketCloses.length < n + 1) return null;
  const r = closes[closes.length - 1] / closes[closes.length - 1 - n] - 1;
  const m = marketCloses[marketCloses.length - 1] / marketCloses[marketCloses.length - 1 - n] - 1;
  return r - m;
}

/**
 * @description The composed short-entry signal: market in bear regime (checked by the caller once
 * per day, not per name), the name's own trend broken, AND a fresh Donchian breakdown printing
 * today. Trend-following on all three axes — nothing anticipates, everything joins.
 * @param closes - Ascending closes of the name.
 * @returns True when the name qualifies as a short entry TODAY (regime gate applied separately).
 */
export function shortEntrySignal(closes: number[]): boolean {
  return trendBroken(closes) && donchianBreakdown(closes);
}
