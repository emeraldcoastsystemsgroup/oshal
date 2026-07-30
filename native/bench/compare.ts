/**
 * The headline benchmark: full indicator layer, TypeScript reference vs WASM kernel.
 *
 * WHAT IS BEING TIMED, precisely. Both sides compute all 40 series for the same bars with the same
 * config. The WASM side's time INCLUDES marshalling the bars into linear memory and packing the
 * params — that is real work the TS path does not do, and excluding it would flatter the kernel.
 * It does NOT include copying the 40 result series out, because the loader hands back zero-copy
 * views and a real caller reads through them. The `--copy-out` flag adds that cost for callers who
 * need to retain results past the next call.
 *
 * Usage:
 *   npx tsx native/bench/compare.ts [bars] [--copy-out] [--json]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — side-by-side TS/WASM timing over several series sizes, with marshalling counted and a 5-year-run projection.
 *
 * @module native/bench/compare
 */

import { loadKernel, kernelStatus } from '../loader';
import { computeReference } from '../loader/reference';
import { DEFAULT_CONFIG } from '../loader/series';
import { makeBars, type Bar } from './bars';

const args = process.argv.slice(2);
const sizes = args.filter((a) => /^\d+$/.test(a)).map(Number);
const SIZES = sizes.length ? sizes : [25_000, 100_000, 400_000];
const COPY_OUT = args.includes('--copy-out');
const AS_JSON = args.includes('--json');

const kernel = loadKernel();
if (!kernel) {
  console.error(`\nnative kernel ${kernelStatus()}`);
  console.error('Build it first: node native/build.js\n');
  process.exit(1);
}

/** min / median / max of repeated timings, in ms. */
interface Timing { min: number; med: number; max: number }

/**
 * Time `fn` `runs` times and report the SPREAD, not just a midpoint.
 *
 * The spread is reported because it is large and load-bearing here: the TS path allocates ~40
 * arrays per call (≈128MB at 400k bars) so it is GC-bound and its own timings drift, while the WASM
 * path reuses one buffer. A single median hides that and invites quoting a best-case speedup as if
 * it were typical — an early draft of this benchmark reported 11x from what turned out to be an
 * outlier run whose true value was ~5x.
 */
function time(fn: () => unknown, runs: number): Timing {
  fn(); // warm: let V8 tier up the TS path and fault in the WASM pages
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t0 = process.hrtime.bigint();
    const sink = fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (sink === undefined) throw new Error('benchmark target returned undefined');
  }
  samples.sort((a, b) => a - b);
  return {
    min: samples[0],
    med: samples[Math.floor(samples.length / 2)],
    max: samples[samples.length - 1],
  };
}

interface Result {
  n: number; ts: Timing; wasm: Timing;
  speedup: number; speedupLow: number; speedupHigh: number;
}
const results: Result[] = [];

for (const n of SIZES) {
  const bars: Bar[] = makeBars(n);
  const runs = n <= 100_000 ? 9 : 7;

  const ts = time(() => computeReference(bars, DEFAULT_CONFIG), runs);
  const wasm = time(() => {
    const out = kernel.compute(bars, DEFAULT_CONFIG);
    return COPY_OUT ? out.map((v) => Float64Array.from(v)) : out;
  }, runs);

  results.push({
    n, ts, wasm,
    speedup: ts.med / wasm.med,
    // Worst case for the kernel: its slowest run against the TS's fastest, and vice versa.
    speedupLow: ts.min / wasm.max,
    speedupHigh: ts.max / wasm.min,
  });
}

if (AS_JSON) {
  console.log(JSON.stringify({
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    copyOut: COPY_OUT,
    wasmBytes: kernel.memoryBytes(),
    results,
  }, null, 2));
  process.exit(0);
}

console.log('\n=== indicator layer: TypeScript vs WASM kernel ===');
console.log(`node ${process.version} · ${process.platform}-${process.arch} · `
  + `read-out: ${COPY_OUT ? 'copied' : 'zero-copy views'}\n`);
console.log(`${'bars'.padStart(9)}${'TS med'.padStart(9)}${'TS range'.padStart(15)}`
  + `${'WASM med'.padStart(10)}${'WASM range'.padStart(15)}${'speedup'.padStart(9)}${'range'.padStart(13)}`);
console.log('-'.repeat(80));
for (const r of results) {
  const tsRange = `${r.ts.min.toFixed(0)}-${r.ts.max.toFixed(0)}`;
  const wRange = `${r.wasm.min.toFixed(0)}-${r.wasm.max.toFixed(0)}`;
  console.log(
    `${r.n.toLocaleString().padStart(9)}${r.ts.med.toFixed(0).padStart(9)}${tsRange.padStart(15)}`
    + `${r.wasm.med.toFixed(0).padStart(10)}${wRange.padStart(15)}`
    + `${`${r.speedup.toFixed(1)}x`.padStart(9)}`
    + `${`${r.speedupLow.toFixed(1)}-${r.speedupHigh.toFixed(1)}x`.padStart(13)}`,
  );
}
console.log('-'.repeat(80));

const biggest = results[results.length - 1];
const FIVE_YEAR_ES_BARS = 1_700_000; // ~5y of 1-minute ES bars
const tsProj = (biggest.ts.med / biggest.n) * FIVE_YEAR_ES_BARS / 1000;
const wasmProj = (biggest.wasm.med / biggest.n) * FIVE_YEAR_ES_BARS / 1000;
console.log(`\nprojected 5y ES 1-min run (${FIVE_YEAR_ES_BARS.toLocaleString()} bars):`);
console.log(`  TypeScript  ${tsProj.toFixed(1)} s`);
console.log(`  WASM        ${wasmProj.toFixed(1)} s`);
console.log(`\na 500-combination parameter sweep over that series:`);
console.log(`  TypeScript  ${(tsProj * 500 / 60).toFixed(0)} min`);
console.log(`  WASM        ${(wasmProj * 500 / 60).toFixed(0)} min\n`);
