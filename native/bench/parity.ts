/**
 * Parity report — WASM kernel vs the TypeScript reference, series by series.
 *
 * This is the DEVELOPER-FACING view (a table you can read while porting). The machine-checked
 * version that must stay green is `tests/unit/native-indicator-parity.spec.ts`; this script exists
 * because when a series disagrees you want to see WHERE and BY HOW MUCH, not just a failed assert.
 *
 * Usage:
 *   npx tsx native/bench/parity.ts [bars]
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — per-series max-ULP / max-abs-delta parity table with first-divergence reporting.
 *
 * @module native/bench/parity
 */

import { loadKernel, kernelStatus } from '../loader';
import { computeReference } from '../loader/reference';
import { DEFAULT_CONFIG, SERIES_NAMES } from '../loader/series';
import { makeBars } from './bars';

const N = Number(process.argv[2] || 50_000);

const kernel = loadKernel();
if (!kernel) {
  console.error(`\nnative kernel ${kernelStatus()}`);
  console.error('Nothing to compare. Build it first: node native/build.js\n');
  process.exit(1);
}

const bars = makeBars(N);
const cfg = DEFAULT_CONFIG;

const ref = computeReference(bars, cfg);
// Copy out of WASM memory: the views are only valid until the next compute, and the comparison
// below holds both sides at once.
const nat = kernel.compute(bars, cfg).map((v) => Float64Array.from(v));

/** Units in the last place between two finite doubles — the only scale-free float comparison. */
function ulpDiff(a: number, b: number): number {
  if (a === b) return 0;
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const i = new BigInt64Array(buf);
  f[0] = a; const ia = i[0];
  f[0] = b; const ib = i[0];
  // Map the sign-magnitude representation onto a monotone integer ordering.
  const key = (x: bigint): bigint => (x < 0n ? -9223372036854775808n - x : x);
  const d = key(ia) - key(ib);
  return Number(d < 0n ? -d : d);
}

/**
 * Distinct finite values in a series. A "bit-exact" verdict is VACUOUS if both sides produced a
 * constant (or all-NaN) series — two implementations that agree on nothing but zeros have not been
 * tested. Every series is required to vary, and the report fails if one does not.
 */
function distinctFinite(v: Float64Array): number {
  const seen = new Set<number>();
  for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) seen.add(v[i]);
  return seen.size;
}

interface Row {
  name: string; maxUlp: number; maxAbs: number; firstBad: number; nanMismatch: number;
  distinct: number;
}
const rows: Row[] = [];

for (let s = 0; s < ref.length; s++) {
  let maxUlp = 0; let maxAbs = 0; let firstBad = -1; let nanMismatch = 0;
  for (let i = 0; i < N; i++) {
    const a = ref[s][i]; const b = nat[s][i];
    const aNan = Number.isNaN(a); const bNan = Number.isNaN(b);
    if (aNan !== bNan) {
      nanMismatch++;
      if (firstBad < 0) firstBad = i;
      continue;
    }
    if (aNan && bNan) continue;
    const u = ulpDiff(a, b);
    if (u > maxUlp) maxUlp = u;
    const abs = Math.abs(a - b);
    if (abs > maxAbs) maxAbs = abs;
    if (u > 0 && firstBad < 0) firstBad = i;
  }
  rows.push({
    name: SERIES_NAMES[s], maxUlp, maxAbs, firstBad, nanMismatch,
    distinct: distinctFinite(ref[s]),
  });
}

/** Series legitimately allowed to be near-constant — regime flags and pattern codes are enums. */
const LOW_CARDINALITY_OK = new Set([
  'CHAND_TREND', 'ST_TREND', 'PSAR_IS_LONG',
  'MACD_IS_BULL', 'MACD_IS_BEAR', 'DMIW_IS_BULL', 'DMIW_IS_BEAR',
  'EHL_IS_BULL', 'EHL_IS_BEAR', 'LWS_BULL_PAT', 'LWS_BEAR_PAT',
]);

console.log(`\n=== parity: WASM kernel vs TS reference — ${N.toLocaleString()} bars ===\n`);
console.log(`${'series'.padEnd(20)}${'max ULP'.padStart(9)}${'max abs'.padStart(13)}${'NaN mism'.padStart(10)}${'distinct'.padStart(10)}`);
console.log('-'.repeat(66));

let exact = 0; let close = 0; let bad = 0; let vacuous = 0;
for (const r of rows) {
  const mismatched = r.nanMismatch > 0 || r.maxUlp > 4;
  // A constant series makes an "exact" verdict meaningless — treat it as a harness failure.
  const degenerate = r.distinct < 2 && !LOW_CARDINALITY_OK.has(r.name);
  const status = mismatched ? 'FAIL' : degenerate ? 'VACUOUS' : '';
  if (mismatched) bad++;
  else if (degenerate) vacuous++;
  else if (r.maxUlp === 0 && r.nanMismatch === 0) exact++;
  else close++;
  const abs = r.maxAbs === 0 ? '0' : r.maxAbs.toExponential(2);
  console.log(
    `${r.name.padEnd(20)}${String(r.maxUlp).padStart(9)}${abs.padStart(13)}`
    + `${String(r.nanMismatch).padStart(10)}${String(r.distinct).padStart(10)}  ${status}`,
  );
}
console.log('-'.repeat(66));
console.log(`bit-exact: ${exact}/${rows.length}   within 4 ULP: ${close}   FAILING: ${bad}   VACUOUS: ${vacuous}`);
if (vacuous > 0) {
  console.log('\nVACUOUS means the series never varied, so agreement proves nothing about it.');
}
console.log('');
process.exit(bad > 0 || vacuous > 0 ? 1 : 0);
