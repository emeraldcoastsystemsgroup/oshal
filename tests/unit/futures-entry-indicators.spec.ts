/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 entry-indicator ports: Laguerre oscillator warmup/zero-RMS/sign behavior + differential check vs a direct C# transliteration, Laguerre filter convergence + the l4f-skip proof, MFI bar-0/zero-negative→50/window math, adaptive Laguerre filter seeds and flat-range alpha carry.
 */
import { describe, it, expect } from 'vitest';
import { laguerreOscillator, laguerreFilter, mfi, adaptiveLaguerreFilter } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

function bar(h: number, l: number, c: number, v = 1000): OhlcvBar {
  return { o: c, h, l, c, v };
}

/** Direct transliteration of atcLaguerreOscillatorCalc.cs OnBarUpdate for differential testing. */
function referenceLagOsc(values: number[], period: number, gamma: number, rmsLength: number): number[] {
  const n = values.length;
  const us = new Array(n).fill(0); const l1o = new Array(n).fill(0); const sq = new Array(n).fill(0);
  const out = new Array(n).fill(0);
  const a1 = Math.exp((-1.414 * Math.PI) / period);
  const c2 = 2 * a1 * Math.cos((1.414 * Math.PI) / period);
  const c3 = -a1 * a1;
  const c1 = (1 + c2 - c3) / 4;
  for (let i = 4; i < n; i++) {
    us[i] = (1 - c1) * values[i] + (2 * c1 - c2) * values[i - 1] - (c1 + c3) * values[i - 2] + c2 * us[i - 1] + c3 * us[i - 2];
    l1o[i] = us[i - 1] + gamma * (l1o[i - 1] - us[i]);
    const diff = us[i] - l1o[i];
    sq[i] = diff * diff;
    // NT SMA over the series including zero warmup slots
    const from = Math.max(0, i - rmsLength + 1);
    let sum = 0;
    for (let j = from; j <= i; j++) sum += sq[j];
    const rms = Math.sqrt(sum / (i - from + 1));
    out[i] = rms !== 0 ? diff / rms : 0;
  }
  return out;
}

describe('laguerreOscillator — atcLaguerreOscillatorCalc parity', () => {
  it('emits 0 for bars 0–3 (unwritten NT slots)', () => {
    const out = laguerreOscillator([100, 101, 102, 103, 104, 105]);
    expect(out.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('matches a direct transliteration of the C# on a mixed series', () => {
    const values = Array.from({ length: 80 }, (_, i) => 100 + 5 * Math.sin(i / 5) + i * 0.1);
    const ours = laguerreOscillator(values, { period: 30, gamma: 0.5, rmsLength: 30 });
    const ref = referenceLagOsc(values, 30, 0.5, 30);
    for (let i = 0; i < values.length; i++) expect(ours[i]).toBeCloseTo(ref[i], 10);
  });

  it('is positive in a persistent rise and flips negative after a reversal', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 140 - i);
    const out = laguerreOscillator([...up, ...down], { rmsLength: 30 });
    expect(out[39]).toBeGreaterThan(0);
    expect(out[79]).toBeLessThan(0);
  });

  it('emits exactly 0 when the RMS is 0 (all-zero input) and stays finite on a flat series', () => {
    // A zero series keeps diff ≡ 0 exactly → the rms==0 rule emits 0 (the source's ternary).
    expect(laguerreOscillator(Array(50).fill(0), { rmsLength: 30 }).every((v) => v === 0)).toBe(true);
    // A flat NONZERO series still produces 0-seed transients (us seeds at 0, as in NT) — finite, not NaN.
    const flat = laguerreOscillator(Array(50).fill(100), { rmsLength: 30 });
    expect(flat.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('laguerreFilter — atcLaguerreFilterCalc parity', () => {
  it('emits 0 for bars 0–3 and converges to a constant input', () => {
    const out = laguerreFilter(Array(200).fill(100));
    expect(out.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(out[199]).toBeCloseTo(100, 6);
  });

  it('skips l4f in the output weighting (the source quirk) — differs from the true binomial', () => {
    // On a ramp, compute one bar both ways from identical stage values; they must differ.
    const values = Array.from({ length: 60 }, (_, i) => 100 + i);
    const g = 0.5; const g1 = 0.5;
    // Re-run the cascade to capture stage values at the last bar.
    const a1 = Math.exp((-1.414 * Math.PI) / 30);
    const c2 = 2 * a1 * Math.cos((1.414 * Math.PI) / 30);
    const c3 = -a1 * a1; const c1 = (1 + c2 - c3) / 4;
    const us = new Array(values.length).fill(0);
    for (let i = 4; i < values.length; i++) {
      us[i] = (1 - c1) * values[i] + (2 * c1 - c2) * values[i - 1] - (c1 + c3) * values[i - 2] + c2 * us[i - 1] + c3 * us[i - 2];
    }
    const l = [0, 0, 0, 0, 0]; const lp = [0, 0, 0, 0, 0];
    let sourceStyle = 0; let binomial = 0;
    for (let i = 4; i < values.length; i++) {
      l[0] = g1 * us[i - 1] + g * lp[0];
      l[1] = g1 * lp[0] + g * lp[1];
      l[2] = g1 * lp[1] + g * lp[2];
      l[3] = g1 * lp[2] + g * lp[3];
      l[4] = g1 * lp[3] + g * lp[4];
      sourceStyle = (us[i] + 4 * l[0] + 6 * l[1] + 4 * l[2] + l[4]) / 16;
      binomial = (us[i] + 4 * l[0] + 6 * l[1] + 4 * l[2] + l[3]) / 16;
      for (let s = 0; s < 5; s++) lp[s] = l[s];
    }
    const out = laguerreFilter(values);
    expect(out[59]).toBeCloseTo(sourceStyle, 10);
    expect(out[59]).not.toBeCloseTo(binomial, 6); // proves the port kept the quirk
  });
});

describe('mfi — atcMFICalc parity', () => {
  it('bar 0 emits 50', () => {
    expect(mfi([bar(101, 99, 100)])[0]).toBe(50);
  });

  it('a monotone-up window hits the zero-negative rule → 50, NOT 100', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(101 + i, 99 + i, 100 + i));
    const out = mfi(bars);
    expect(out[19]).toBe(50);
  });

  it('matches NT8 SUM associativity BIT-EXACTLY: (sum + new) − old, never sum + (new − old)', () => {
    // The source branches on sumNegative == 0 EXACTLY, so float residue from NT's grouping is
    // load-bearing (residue → MFI ≈ 100; exact cancellation → 50). Differential vs an explicit
    // NT-ordered reference over a deterministic pseudo-random walk, compared with ===.
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const bars: OhlcvBar[] = [];
    let px = 100;
    for (let i = 0; i < 200; i++) {
      px += (rnd() - 0.5) * 0.7;
      bars.push(bar(px + rnd() * 0.3, px - rnd() * 0.3, px, Math.floor(rnd() * 5000) + 1));
    }
    const period = 14;
    const posArr = new Array<number>(bars.length).fill(0);
    const negArr = new Array<number>(bars.length).fill(0);
    let sp = 0; let sn = 0;
    const ref: number[] = [50];
    for (let i = 1; i < bars.length; i++) {
      const t0 = (bars[i].h + bars[i].l + bars[i].c) / 3;
      const t1 = (bars[i - 1].h + bars[i - 1].l + bars[i - 1].c) / 3;
      negArr[i] = t0 < t1 ? t0 * bars[i].v : 0;
      posArr[i] = t0 > t1 ? t0 * bars[i].v : 0;
      sp = sp + posArr[i] - (i >= period ? posArr[i - period] : 0); // NT ordering
      sn = sn + negArr[i] - (i >= period ? negArr[i - period] : 0);
      ref.push(sn === 0 ? 50 : 100.0 - 100.0 / (1 + sp / sn));
    }
    const ours = mfi(bars, period);
    for (let i = 0; i < bars.length; i++) expect(Object.is(ours[i], ref[i])).toBe(true);
  });

  it('mixed flow lands between the extremes and follows the flow ratio', () => {
    // up bar then down bar, hand-computed inside a 14 window
    const bars = [bar(101, 99, 100), bar(103, 101, 102, 500), bar(101, 98, 99, 200)];
    const t1 = (103 + 101 + 102) / 3; // up vs bar0 typical 100 → positive = t1·500
    const t2 = (101 + 98 + 99) / 3; // down vs t1 → negative = t2·200
    const expected = 100 - 100 / (1 + (t1 * 500) / (t2 * 200));
    expect(mfi(bars)[2]).toBeCloseTo(expected, 10);
  });
});

describe('adaptiveLaguerreFilter — atcAdaptiveLaguerreFilterCalc parity', () => {
  it('bar 0 emits the input and a flat series stays put (alpha carries through hh==ll)', () => {
    const out = adaptiveLaguerreFilter(Array(30).fill(100));
    expect(out[0]).toBe(100);
    expect(out.every((v) => Math.abs(v - 100) < 1e-9)).toBe(true);
  });

  it('tracks a trending series with lag and never explodes', () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 + i + 3 * Math.sin(i / 4));
    const out = adaptiveLaguerreFilter(values);
    for (let i = 20; i < 120; i++) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(Math.abs(out[i] - values[i])).toBeLessThan(30);
    }
    // Rising overall
    expect(out[119]).toBeGreaterThan(out[40]);
  });

  it('period 1 degenerates to the input itself (the source early-return)', () => {
    const values = [100, 105, 95, 110];
    expect(adaptiveLaguerreFilter(values, 1)).toEqual(values);
  });
});
