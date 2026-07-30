/**
 * TS baseline profile — which indicator passes actually cost anything?
 *
 * This exists to keep the native port HONEST and data-driven. The rule for this folder is that
 * nothing gets ported to Rust until this profile shows it costs real time; a native rewrite of
 * a pass that takes 3ms on 500k bars is pure liability (a second implementation to keep in
 * parity, for nothing). Run this first, port the top of the list, re-run.
 *
 * Usage:
 *   npx tsx native/bench/profile-ts.ts [bars]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-indicator timing harness over the ADR-116 indicator layer.
 *
 * @module native/bench/profile-ts
 */

import { wilderAtr, dmiAdx, laguerreRsi, movingMedian } from '../../src/features/trading/services/futures-indicators';
import { chandelierBands, superTrendM11, parabolicSar } from '../../src/features/trading/services/futures-trail-stops';
import {
  laguerreOscillator, laguerreFilter, mfi, adaptiveLaguerreFilter,
} from '../../src/features/trading/services/futures-entry-indicators';
import {
  macdWave, dmiWave, ehlersInstTrendWave, laguerreWaveStops,
} from '../../src/features/trading/services/futures-wave-tracking';
import { makeBars, closesOf } from './bars';

const N = Number(process.argv[2] || 200_000);
const TICK = 0.25;

const bars = makeBars(N);
const closes = closesOf(bars);

interface Row { label: string; ms: number }
const rows: Row[] = [];

/**
 * @description Time one indicator pass: run once to let V8 tier it up, then take the measured
 * run. A single warm iteration is deliberate — these passes are hundreds of milliseconds at
 * benchmark sizes, so JIT warmup is already amortized and repeating would only lengthen the run.
 * @param label - Display name for the pass.
 * @param fn - The pass to time; its return value is discarded but must be used to defeat DCE.
 * @returns void — appends to the module-level `rows`.
 */
function time(label: string, fn: () => unknown): void {
  let sink = fn();
  const t0 = process.hrtime.bigint();
  sink = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (sink === undefined) throw new Error(`${label} returned undefined — bad harness wiring`);
  rows.push({ label, ms });
}

time('wilderAtr(14)', () => wilderAtr(bars, 14));
time('dmiAdx(14,14)', () => dmiAdx(bars, 14, 14));
time('laguerreRsi', () => laguerreRsi(closes, 0.5, 7));
time('movingMedian(8)', () => movingMedian(closes, 8));
time('chandelierBands(22)', () => chandelierBands(bars, { period: 22, multiplier: 2.0, tickSize: TICK }));
time('superTrendM11', () => superTrendM11(bars, {
  basePeriod: 8, rangePeriod: 15, multiplier: 2.5, tickSize: TICK,
}));
time('parabolicSar', () => parabolicSar(bars));
time('laguerreOscillator', () => laguerreOscillator(closes));
time('laguerreFilter', () => laguerreFilter(closes));
time('mfi(14)', () => mfi(bars, 14));
time('adaptiveLaguerreFilter', () => adaptiveLaguerreFilter(closes));
time('macdWave', () => macdWave(bars, 12, 26, 9));
time('dmiWave', () => dmiWave(bars, 14, 14));
time('ehlersInstTrendWave', () => ehlersInstTrendWave(bars));
time('laguerreWaveStops', () => laguerreWaveStops(bars, { rmsLength: 100 }));

rows.sort((a, b) => b.ms - a.ms);
const total = rows.reduce((s, r) => s + r.ms, 0);

console.log(`\n=== TS indicator profile — ${N.toLocaleString()} bars ===\n`);
console.log(`${'pass'.padEnd(24)}${'ms'.padStart(10)}${'share'.padStart(9)}${'ns/bar'.padStart(10)}`);
console.log('-'.repeat(53));
for (const r of rows) {
  const share = `${((r.ms / total) * 100).toFixed(1)}%`;
  const nsPerBar = ((r.ms * 1e6) / N).toFixed(0);
  console.log(`${r.label.padEnd(24)}${r.ms.toFixed(1).padStart(10)}${share.padStart(9)}${nsPerBar.padStart(10)}`);
}
console.log('-'.repeat(53));
console.log(`${'TOTAL'.padEnd(24)}${total.toFixed(1).padStart(10)}`);
console.log(`\nfull-stack throughput: ${((N / total) * 1000 / 1e6).toFixed(2)} M bars/s`);
console.log(`one 5y ES 1-min run (~1.7M bars): ${((total / N) * 1_700_000 / 1000).toFixed(1)} s\n`);
