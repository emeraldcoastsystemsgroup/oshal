/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 increment B guard — the RF math actually works: multilateration recovers a synthetic transmitter from clean samples (and stays close under noise); IDW interpolation behaves (returns the sample value at a sample, interpolates between); and a sparse (<3) sample set does not throw. Guards against shipping an overlay whose transmitter marker / coverage volume is nonsense.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Audit-fix guards: sanitizeRfSamples rejects NaN/short-vector/typed-wrong uploads (a NaN position defeated the distance clamp and persisted corrupt sidecars) and MIN_TX_SAMPLES stays >= 4 (4 unknowns — a 3-sample fit is underdetermined with rmse~0 false confidence).
 */

import { describe, expect, it } from 'vitest';
import {
  estimateTransmitter,
  idwRssi,
  syntheticRssi,
  expectedRssi,
  coverageColor,
  dimSplat,
  buildOverlaySplat,
  packSplat,
  sanitizeRfSamples,
  MIN_TX_SAMPLES,
  DEFAULT_PATH_LOSS_EXP,
} from '@/features/spatial-mapping';

type Vec3 = [number, number, number];

// A ring of sample positions around a room, at head height, plus a couple off-ring.
const POSITIONS: Vec3[] = [
  [0, 1.4, 0], [3, 1.4, 0], [3, 1.4, 3], [0, 1.4, 3],
  [1.5, 1.4, 0], [1.5, 1.4, 3], [0, 1.4, 1.5], [3, 1.4, 1.5],
];
const TX: Vec3 = [2.4, 2.2, 0.6]; // the "router" up in a corner
const TX_POWER = -30;
const N = DEFAULT_PATH_LOSS_EXP;

describe('rf-model: multilateration', () => {
  it('recovers a synthetic transmitter from clean samples', () => {
    const rssi = syntheticRssi(POSITIONS, TX, TX_POWER, N, () => 0);
    const fit = estimateTransmitter(POSITIONS, rssi, N);
    const err = Math.hypot(fit.position[0] - TX[0], fit.position[1] - TX[1], fit.position[2] - TX[2]);
    expect(err).toBeLessThan(0.5);            // within half a metre on clean data
    expect(Math.abs(fit.txPowerDbm - TX_POWER)).toBeLessThan(2);
    expect(fit.rmseDb).toBeLessThan(0.5);
  });

  it('stays room-level under a few dB of noise', () => {
    // deterministic pseudo-noise (no Math.random) so the test is stable
    const noise = (i: number) => ((i * 2654435761) % 1000) / 1000 * 4 - 2; // ~[-2,2] dB
    const rssi = syntheticRssi(POSITIONS, TX, TX_POWER, N, noise);
    const fit = estimateTransmitter(POSITIONS, rssi, N);
    const err = Math.hypot(fit.position[0] - TX[0], fit.position[1] - TX[1], fit.position[2] - TX[2]);
    expect(err).toBeLessThan(2.0);            // room-level, the honest RSSI ceiling
  });

  it('does not throw on a sparse (<3) sample set', () => {
    expect(() => estimateTransmitter([[0, 0, 0], [1, 0, 0]], [-40, -50], N)).not.toThrow();
  });
});

describe('rf-overlay: upload validation', () => {
  it('rejects NaN, short vectors, and wrong types — keeps only well-formed samples', () => {
    const good = { bssid: 'ap', rssiDbm: -50, position: [1, 2, 3] };
    const bad: unknown[] = [
      { rssiDbm: Number.NaN, position: [1, 2, 3] },        // NaN reading
      { rssiDbm: '-50', position: [1, 2, 3] },              // string reading
      { rssiDbm: -50, position: [1, 2] },                   // short vector
      { rssiDbm: -50, position: 'here' },                   // non-array position
      { rssiDbm: -50, position: [1, Number.NaN, 3] },       // NaN component
      { rssiDbm: -50, keyframeIndex: -1 },                  // negative index
      { rssiDbm: -50, keyframeIndex: 1.5 },                 // non-integer index
      null,
      'sample',
    ];
    const kept = sanitizeRfSamples([good, ...bad]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toEqual(good);
  });

  it('keeps the transmitter-fit sample floor at >= 4 (4 unknowns)', () => {
    expect(MIN_TX_SAMPLES).toBeGreaterThanOrEqual(4);
  });
});

describe('rf-model: coverage interpolation', () => {
  it('returns the sample value at a sample point and interpolates between', () => {
    const pos: Vec3[] = [[0, 0, 0], [4, 0, 0]];
    const rssi = [-40, -80];
    expect(idwRssi(pos, rssi, [0, 0, 0])).toBeCloseTo(-40, 1);
    const mid = idwRssi(pos, rssi, [2, 0, 0]);
    expect(mid).toBeLessThan(-40);
    expect(mid).toBeGreaterThan(-80);
  });
});

describe('rf-model: path-loss model', () => {
  it('drops ~6 dB per doubling of distance at n=2', () => {
    const near = expectedRssi(-30, 2, 1);
    const far = expectedRssi(-30, 2, 2);
    expect(near - far).toBeCloseTo(6.02, 1);
  });
});

describe('rf-overlay: splat compositing', () => {
  it('colours strong signal greener than weak signal', () => {
    const strong = coverageColor(-40); // ~green
    const weak = coverageColor(-85);   // ~red
    expect(strong[1]).toBeGreaterThan(strong[0]); // green channel dominates when strong
    expect(weak[0]).toBeGreaterThan(weak[1]);      // red channel dominates when weak
  });

  it('dims a room splat (lowers alpha) without changing its record count', () => {
    const room = packSplat([{ pos: [0, 0, 0], scale: [0.05, 0.05, 0.05], color: [255, 255, 255, 255] }]);
    const dim = dimSplat(room);
    expect(dim.length).toBe(room.length);
    expect(dim[27]).toBeLessThan(255); // alpha reduced
  });

  it('builds an overlay = dimmed room + one heat point per sample + a marker cluster', () => {
    const room = packSplat([{ pos: [0, 0, 0], scale: [0.05, 0.05, 0.05], color: [200, 200, 200, 255] }]);
    const pos: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 0, 1]];
    const rssi = [-40, -60, -80];
    const { buffer, count } = buildOverlaySplat(room, pos, rssi, [[0.5, 1, 0.5]]);
    expect(buffer.length % 32).toBe(0);
    // 1 room + 3 heat + 10 marker gaussians
    expect(count).toBe(1 + 3 + 10);
    expect(buffer.length / 32).toBe(count);
  });
});
