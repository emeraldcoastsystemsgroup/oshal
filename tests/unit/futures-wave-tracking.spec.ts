/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 wave-tracking ports: shared machine cross-bar exclusion/seeding + first-wave NaN, MACD signal 0-seed proof (sig[26] = k·macd[26]), DMI wave start bar, Ehlers spurious bar-2 bull wave, Laguerre wave stops first-trend NaN + non-monotone re-base + NHH first-trend quirk.
 */
import { describe, it, expect } from 'vitest';
import { macdWave, dmiWave, ehlersInstTrendWave, laguerreWaveStops, laguerreOscillator, WavePattern } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

function bar(h: number, l: number, c: number): OhlcvBar {
  return { o: c, h, l, c, v: 1000 };
}

/** n rising bars from start, then m falling, alternating as requested. */
function trendBars(segments: Array<{ n: number; step: number }>, start = 100): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  let px = start;
  for (const seg of segments) {
    for (let i = 0; i < seg.n; i++) {
      px += seg.step;
      out.push(bar(px + 0.5, px - 0.5, px));
    }
  }
  return out;
}

describe('macdWave — atcMACDCalc parity', () => {
  it('macd line is 0 below bar `slow` and the signal EMA is genuinely 0-seeded: sig[26] = k·macd[26]', () => {
    const bars = trendBars([{ n: 60, step: 1 }]);
    const { fast, slow } = macdWave(bars);
    for (let i = 0; i < 26; i++) expect(fast[i]).toBe(0);
    expect(fast[26]).not.toBe(0);
    const k = 2 / (1 + 9);
    expect(slow[26]).toBeCloseTo(k * fast[26], 12); // prior signal = 0, the unwritten-slot artifact
  });

  it('publishes flags from bar `slow` but runs waves only from `slow`+1', () => {
    const bars = trendBars([{ n: 60, step: 1 }]);
    const w = macdWave(bars);
    for (let i = 0; i < 26; i++) { expect(w.isBullish[i]).toBe(false); expect(w.isBearish[i]).toBe(false); }
    expect(w.isBullish[26]).toBe(true); // rising market: macd > 0-contaminated signal
  });

  it('freezes the completed bear wave low on a bullish cross, EXCLUDING the cross bar', () => {
    // Long fall then strong rise → bearish regime then a bullish cross.
    const bars = trendBars([{ n: 40, step: 1 }, { n: 25, step: -2 }, { n: 25, step: 3 }]);
    const w = macdWave(bars);
    // Find the bullish cross after the fall: first bar where lastBearWaveLow becomes non-NaN.
    const crossIdx = w.lastBearWaveLow.findIndex((v) => !Number.isNaN(v));
    expect(crossIdx).toBeGreaterThan(40);
    // The frozen low = min low from the bear wave's bars, which must exclude the cross bar itself.
    const frozen = w.lastBearWaveLow[crossIdx];
    const minLowUpToPrior = Math.min(...bars.slice(0, crossIdx).map((b) => b.l));
    expect(frozen).toBe(minLowUpToPrior);
    expect(frozen).toBeLessThanOrEqual(Math.min(...bars.slice(0, crossIdx + 1).map((b) => b.l)));
    // Frozen value persists until the next completion
    expect(w.lastBearWaveLow[crossIdx + 5]).toBe(frozen);
  });
});

describe('dmiWave — atcDMCalc parity', () => {
  it('publishes false/false through bar diLength inclusive, then tracks the regime', () => {
    const bars = trendBars([{ n: 40, step: 1 }]);
    const w = dmiWave(bars);
    for (let i = 0; i <= 14; i++) { expect(w.isBullish[i]).toBe(false); expect(w.isBearish[i]).toBe(false); }
    expect(w.isBullish[30]).toBe(true);
    expect(w.adx[30]).toBeGreaterThan(25);
  });

  it('completes a bull wave on the DI cross-down after a reversal (a wave needs a CROSS to start)', () => {
    // A market that opens already-bullish never fires a bullish CROSS (fast[i−1] ≤ slow[i−1] fails),
    // so the source opens no wave — start with a decline so the rally produces a genuine cross.
    const bars = trendBars([{ n: 25, step: -1 }, { n: 40, step: 1.5 }, { n: 35, step: -2 }]);
    const w = dmiWave(bars);
    const idx = w.lastBullWaveHigh.findIndex((v) => !Number.isNaN(v)); // the bearish cross that completes it
    expect(idx).toBeGreaterThan(25);
    // Find the bullish cross that started the wave: false→true transition of the regime flag.
    let bullStart = -1;
    for (let i = 16; i < idx; i++) if (w.isBullish[i] && !w.isBullish[i - 1]) bullStart = i;
    expect(bullStart).toBeGreaterThan(0);
    // Frozen high = max high over [bullStart .. idx−1] — the cross bar itself is excluded.
    expect(w.lastBullWaveHigh[idx]).toBe(Math.max(...bars.slice(bullStart, idx).map((b) => b.h)));
  });
});

describe('ehlersInstTrendWave — atcEhlersInstTrendCalc parity', () => {
  it('ALWAYS opens in a bull wave at bar 2 on positive prices (the unwritten-slot cross)', () => {
    const bars = trendBars([{ n: 30, step: -1 }], 200); // even a FALLING series
    const w = ehlersInstTrendWave(bars);
    expect(w.isBullish[2]).toBe(true); // trigger = 2·itrend > itrend for positive itrend
    // The first real bearish cross freezes lastBullWaveHigh = max high since bar 2.
    const idx = w.lastBullWaveHigh.findIndex((v) => !Number.isNaN(v));
    expect(idx).toBeGreaterThan(2);
    expect(w.lastBullWaveHigh[idx]).toBe(Math.max(...bars.slice(2, idx).map((b) => b.h)));
  });

  it('uses median price and the Ehlers IIR from bar 7', () => {
    const bars = trendBars([{ n: 50, step: 1 }]);
    const w = ehlersInstTrendWave(bars);
    // In a clean rise the trigger leads the trendline → bullish throughout post-warmup.
    for (let i = 10; i < 50; i++) expect(w.isBullish[i]).toBe(true);
  });
});

describe('laguerreWaveStops — atcLaguerreWaveStopsCalc parity', () => {
  const RMS = 30; // shorter rms for test-scale series (strategy passes 100 with 30-bar warmup gates)
  const opts = { period: 10, gamma: 0.5, rmsLength: RMS };
  const bars = trendBars([{ n: 40, step: 1 }, { n: 40, step: -1 }, { n: 40, step: 1 }], 500);
  const closes = bars.map((b) => b.c);
  const osc = laguerreOscillator(closes, opts);
  const w = laguerreWaveStops(bars, opts);

  /** Oscillator sign transitions replicated from the source's cross rules for structural checks. */
  function transitions(): Array<{ i: number; dir: 'bull' | 'bear' }> {
    const t: Array<{ i: number; dir: 'bull' | 'bear' }> = [];
    let inBull = false; let inBear = false;
    for (let i = 1; i < osc.length; i++) {
      if (!inBull && osc[i] > 0 && osc[i - 1] <= 0) { t.push({ i, dir: 'bull' }); inBull = true; inBear = false; }
      else if (!inBear && osc[i] < 0 && osc[i - 1] >= 0) { t.push({ i, dir: 'bear' }); inBear = true; inBull = false; }
    }
    return t;
  }

  it('the stop is NaN through the ENTIRE first trend and real from the second onward', () => {
    const t = transitions();
    expect(t.length).toBeGreaterThanOrEqual(3);
    const [first, second] = t;
    for (let i = first.i; i < second.i; i++) expect(Number.isNaN(w.stop[i])).toBe(true);
    for (let i = second.i; i < t[2].i; i++) expect(Number.isNaN(w.stop[i])).toBe(false);
  });

  it('re-bases the stop to the just-completed opposite cycle extreme, cross bar excluded', () => {
    const t = transitions();
    const [first, second] = t; // first = bull (rising start), second = bear
    // At the bear transition, the completed bull cycle's high = max high over [first.i .. second.i−1].
    const expected = Math.max(...bars.slice(first.i, second.i).map((b) => b.h));
    expect(w.stop[second.i]).toBe(expected);
    // Constant within the trend:
    expect(w.stop[second.i + 5]).toBe(expected);
  });

  it('the stop is NOT monotone across trends (re-base, never ratchet)', () => {
    // Skip the 0-seed warmup wobble; the last two transitions are the real reversal crosses.
    const t = transitions();
    expect(t.length).toBeGreaterThanOrEqual(3);
    const bearT = t[t.length - 2]; // completes the long rise → stop = peak high
    const bullT = t[t.length - 1]; // completes the fall → stop RE-BASES far below the prior stop
    expect(w.stop[bearT.i]).toBe(Math.max(...bars.slice(t[t.length - 3].i, bearT.i).map((b) => b.h)));
    expect(w.stop[bullT.i]).toBe(Math.min(...bars.slice(bearT.i, bullT.i).map((b) => b.l)));
    expect(w.stop[bullT.i]).toBeLessThan(w.stop[bearT.i]); // stepped DOWN — nothing ratchets it
  });

  it('fires the spurious NHH on the first bull trend (currLagHH inherits the 0.0 slot)', () => {
    const t = transitions();
    const first = t[0];
    expect(first.dir).toBe('bull');
    // During the first bull trend, bearWavePat should read NHH (High > 0.0 carried slot).
    expect(w.bearWavePat[first.i + 2]).toBe(WavePattern.NHH);
  });

  it('produces an LL bull pattern when a bear cycle undercuts its predecessor', () => {
    // down, up, deeper down, up → the second bear cycle makes a lower low → LL on its completion.
    const seq = trendBars([{ n: 30, step: -1 }, { n: 20, step: 1.5 }, { n: 30, step: -2 }, { n: 25, step: 2 }], 600);
    const ww = laguerreWaveStops(seq, opts);
    expect(ww.bullWavePat.some((p) => p === WavePattern.LL)).toBe(true);
  });
});
