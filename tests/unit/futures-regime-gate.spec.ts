/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the R10 daily-ADX regime gate (BACKLOG row 415): default-off passthrough, the threshold applied to the last CLOSED daily bar only (no look-ahead onto the session still forming), fail-closed warmup and fail-closed on a missing daily series, threshold monotonicity, and the 'chop' inversion used as the null test.
 */
import { describe, it, expect } from 'vitest';
import { buildDailyRegimeGate, dmiAdx, REGIME_GATE_DEFAULTS } from '../../src/features/trading';
import type { FuturesBar } from '../../src/features/trading';

const DAY_MS = 86_400_000;

/** Daily bars from a close path; each bar spans ±`range` around the move. */
function dailySeries(path: number[], range = 1, startIso = '2026-01-05T00:00:00.000Z'): FuturesBar[] {
  const t0 = Date.parse(startIso);
  return path.map((c, i) => {
    const o = i === 0 ? c : path[i - 1];
    return { t: new Date(t0 + i * DAY_MS).toISOString(), o, h: Math.max(o, c) + range, l: Math.min(o, c) - range, c, v: 1000 };
  });
}

/**
 * Hourly chart CLOSE stamps covering days [fromDay, toDay) of the same origin. Studies start at
 * `fromDay` 16 so every consulted daily bar is past Wilder's 14-bar DMI warmup — the gate's own
 * warmup behavior is pinned separately rather than smeared through the threshold tests.
 */
function hourlyCloses(fromDay: number, toDay: number, startIso = '2026-01-05T00:00:00.000Z'): string[] {
  const t0 = Date.parse(startIso);
  const out: string[] = [];
  for (let h = fromDay * 24 + 1; h <= toDay * 24; h++) out.push(new Date(t0 + h * 3_600_000).toISOString());
  return out;
}

/**
 * A strong one-way trend (ADX saturates at 100 — a frictionless test tape has −DM ≡ 0) and a real
 * chop. The chop is a sum of two out-of-phase sinusoids, NOT a ±0.2 alternation: an alternation
 * produces identical highs and lows on every bar, so +DM = −DM = 0 and the degenerate DX also
 * saturates at 100. That fixture would have "passed" a broken gate.
 */
const TREND = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
const CHOP = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 1.7) * 3 + Math.cos(i / 0.9) * 2);

describe('buildDailyRegimeGate — default posture', () => {
  it('is OFF by default and lets every bar through untouched', () => {
    const closes = hourlyCloses(0, 10);
    const g = buildDailyRegimeGate(closes, dailySeries(CHOP));
    expect(REGIME_GATE_DEFAULTS.enabled).toBe(false);
    expect(g.allowed.every(Boolean)).toBe(true);
    expect(g.blockedBars).toBe(0);
  });

  it('carries the source spec\'s threshold of 20', () => {
    expect(REGIME_GATE_DEFAULTS.threshold).toBe(20);
  });
});

describe('buildDailyRegimeGate — the gate itself', () => {
  it('ADMITS a trending daily tape and REFUSES a chopping one at the same threshold', () => {
    const closes = hourlyCloses(16, 60);
    const trend = buildDailyRegimeGate(closes, dailySeries(TREND), { enabled: true, threshold: 20 });
    const chop = buildDailyRegimeGate(closes, dailySeries(CHOP), { enabled: true, threshold: 20 });
    // The whole point of the gate: the same configuration must separate these two tapes.
    expect(trend.allowed.every(Boolean)).toBe(true);
    expect(chop.allowed.some(Boolean)).toBe(false);
    expect(chop.blockedBars).toBe(closes.length);
  });

  it('raising the threshold is monotonically more restrictive', () => {
    const closes = hourlyCloses(16, 60);
    const at = (threshold: number): number =>
      buildDailyRegimeGate(closes, dailySeries(TREND), { enabled: true, threshold }).allowed.filter(Boolean).length;
    expect(at(10)).toBeGreaterThanOrEqual(at(20));
    expect(at(20)).toBeGreaterThanOrEqual(at(60));
    expect(at(200)).toBe(0); // unreachable by construction
  });

  it('consults the LAST CLOSED daily bar, never the session still forming (no look-ahead)', () => {
    // The chop tape is used deliberately: its daily ADX values are all DISTINCT, so an off-by-one
    // in the mapping is visible. On the saturated trend tape every value is 100 and this test
    // could not tell `opened` from `opened - 1` — the exact shape of a vacuous guard.
    const daily = dailySeries(CHOP);
    const closes = hourlyCloses(16, 60);
    const g = buildDailyRegimeGate(closes, daily, { enabled: true, threshold: 20 });
    const adx = dmiAdx(daily, 14, 14).adx;
    let checked = 0;
    for (let i = 0; i < closes.length; i++) {
      const t = Date.parse(closes[i]);
      // Independently derived (reduce, not the module's while-loop): the last daily bar to have
      // OPENED by this chart close. The gate must consult the one BEFORE it.
      const opened = daily.reduce((acc, b, k) => (Date.parse(b.t) <= t ? k : acc), -1);
      expect(g.dailyAdx[i]).toBe(adx[opened - 1]);
      expect(g.dailyAdx[i]).not.toBe(adx[opened]); // the forming bar must never be read
      checked++;
    }
    expect(checked).toBeGreaterThan(1000); // the loop above certifies something, unlike an empty one
  });

  it('FAILS CLOSED through warmup — an unknown regime is not a permissive one', () => {
    // Chart bars in the first two days precede any CLOSED daily bar.
    const g = buildDailyRegimeGate(hourlyCloses(0, 60), dailySeries(TREND), { enabled: true, threshold: 20 });
    expect(g.warmupBars).toBeGreaterThan(0);
    let asserted = 0;
    for (let i = 0; i < g.allowed.length; i++) {
      if (Number.isFinite(g.dailyAdx[i])) continue;
      expect(g.allowed[i]).toBe(false);
      asserted++;
    }
    expect(asserted).toBe(g.warmupBars);
  });

  it('FAILS CLOSED when enabled with NO daily series — never trades unfiltered', () => {
    const closes = hourlyCloses(0, 10);
    const g = buildDailyRegimeGate(closes, [], { enabled: true, threshold: 20 });
    expect(g.allowed.some(Boolean)).toBe(false);
    expect(g.blockedBars).toBe(closes.length);
    expect(g.warmupBars).toBe(closes.length);
  });

  it("'chop' mode is the exact inverse of 'trend' on every non-warmup bar — the null test", () => {
    const closes = hourlyCloses(16, 60);
    const daily = dailySeries(TREND);
    const t = buildDailyRegimeGate(closes, daily, { enabled: true, threshold: 20, mode: 'trend' });
    const c = buildDailyRegimeGate(closes, daily, { enabled: true, threshold: 20, mode: 'chop' });
    for (let i = 0; i < closes.length; i++) {
      if (!Number.isFinite(t.dailyAdx[i])) continue;
      expect(c.allowed[i]).toBe(!t.allowed[i]);
    }
  });

  it('an explicit-undefined threshold uses the default rather than blocking everything', () => {
    const closes = hourlyCloses(16, 60);
    const a = buildDailyRegimeGate(closes, dailySeries(TREND), { enabled: true, threshold: undefined });
    const b = buildDailyRegimeGate(closes, dailySeries(TREND), { enabled: true, threshold: REGIME_GATE_DEFAULTS.threshold });
    expect(a.allowed).toEqual(b.allowed);
    expect(a.allowed.some(Boolean)).toBe(true);
  });
});
