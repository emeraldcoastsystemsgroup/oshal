/**
 * Deterministic synthetic bar generator for the native-kernel benchmarks and parity tests.
 *
 * WHY SYNTHETIC: the benchmark measures COMPUTE THROUGHPUT of the indicator kernel, which is
 * a pure function of bar count and not of whether the prices are real. Real Kibot ES/CL tick
 * data is a paid feed and is not present on every dev box, so a benchmark that depended on it
 * would silently skip — and a skipped benchmark is a benchmark that does not exist. This
 * generator is seeded and branch-free, so a run on any machine is comparable to any other.
 *
 * WHY IT IS ALSO THE PARITY FIXTURE: the parity guard needs inputs that exercise the
 * indicators' warmup branches, sign flips and zero-denominator guards. A random walk with
 * per-bar range crosses all of them within a few thousand bars, and being seeded means a
 * parity failure is reproducible from the seed alone.
 *
 * This is NOT a market simulator and must never be used to produce a strategy result — the
 * price process has no drift, no volatility clustering and no session structure. Studies use
 * the real data sources in src/features/trading/. See ARCHITECTURE.md "What this is not".
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — seeded LCG bar generator shared by the benchmark harness and the parity guard.
 *
 * @module native/bench/bars
 */

/** One OHLCV bar, matching the `OhlcvBar` shape the indicator functions consume. */
export interface Bar { o: number; h: number; l: number; c: number; v: number }

/**
 * @description Generate `n` deterministic OHLCV bars via a seeded linear congruential
 * generator. Never uses Math.random, so two runs with the same seed are bit-identical — which
 * is what makes both the benchmark comparable across machines and a parity failure
 * reproducible. Prices are floored at 100 so the percent-basis math in the consumers cannot
 * divide by a non-positive entry price.
 * @param n - Number of bars to generate.
 * @param seed - LCG seed; the same seed always yields the same series.
 * @returns Ascending (oldest-first) bar array of length `n`.
 */
export function makeBars(n: number, seed = 12345): Bar[] {
  let s = seed >>> 0;
  let px = 4500;
  const bars: Bar[] = new Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = (s / 0x100000000 - 0.5) * 4;
    px = Math.max(100, px + r);
    const wick = Math.abs(r) * 0.8;
    bars[i] = { o: px - r * 0.3, h: px + wick, l: px - wick, c: px, v: 1000 + (s % 5000) };
  }
  return bars;
}

/**
 * @description Extract the close series from bars — the input shape the value-series
 * indicators (Laguerre family, moving median) take.
 * @param bars - Bars to project.
 * @returns Closes, index-aligned with `bars`.
 */
export function closesOf(bars: Bar[]): number[] {
  return bars.map((b) => b.c);
}
