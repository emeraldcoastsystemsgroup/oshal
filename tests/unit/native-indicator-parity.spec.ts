/**
 * Guard: the native WASM indicator kernel agrees with the TypeScript reference, bit for bit.
 *
 * WHY THIS GUARD EXISTS (guard-per-fix, CLAUDE.md). The native kernel is a SECOND implementation of
 * ~900 lines of numeric code whose whole value is being interchangeable with the first. The failure
 * mode is not a crash — it is a plausible, slightly-different backtest that nobody notices until a
 * strategy decision has been made on it. So parity is asserted at 0 ULP, not at an epsilon: the
 * SuperSmoother coefficients are computed JS-side precisely so exact agreement is achievable, and
 * anything less than exact means a real divergence to find, not a tolerance to widen.
 *
 * IF THIS FAILS: the TypeScript is right and the Rust is wrong. `npx tsx native/bench/parity.ts`
 * prints the per-series table with the first diverging bar index.
 *
 * WHEN THE ARTIFACT IS ABSENT this spec asserts the FALLBACK CONTRACT instead of skipping — that
 * the loader returns null and the reference path still produces well-formed output. A spec that
 * silently skips is a guard that does not exist (CLAUDE.md), and the artifact is untracked, so the
 * absent case is the common one on a fresh clone.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — 0-ULP parity across all 40 series, non-degeneracy assertion, ABI cross-check, and the artifact-absent fallback contract.
 */

import { describe, expect, it } from 'vitest';
import { loadKernel } from '../../native/loader';
import { computeReference } from '../../native/loader/reference';
import {
  DEFAULT_CONFIG, SERIES, SERIES_COUNT, SERIES_NAMES, packParams, PARAM_COUNT,
  type IndicatorConfig,
} from '../../native/loader/series';
import { makeBars } from '../../native/bench/bars';

/** Bars to compare. Large enough that every warmup branch and several wave cycles are crossed. */
const N = 8_000;

/** Two configs: the shipped defaults, and an off-default set to catch hard-coded constants. */
const CONFIGS: ReadonlyArray<{ name: string; cfg: IndicatorConfig }> = [
  { name: 'defaults', cfg: DEFAULT_CONFIG },
  {
    name: 'off-default periods',
    cfg: {
      ...DEFAULT_CONFIG,
      atrPeriod: 9, dmiDiLength: 7, dmiAdxSmoothing: 21,
      larsiAlpha: 0.3, larsiSmoothing: 5, medianPeriod: 6,
      chandPeriod: 11, chandMultiplier: 3.5, chandUseHighLow: false, tickSize: 0.5,
      stBasePeriod: 5, stRangePeriod: 21, stMultiplier: 1.75,
      oscPeriod: 20, oscRmsLength: 55, filtPeriod: 40,
      mfiPeriod: 20, adaptivePeriod: 12,
      macdFast: 8, macdSlow: 17, macdSmooth: 5,
      ehlersAlpha: 0.12, lwsPeriod: 45, lwsRmsLength: 60,
    },
  },
];

/** Units in the last place between two doubles; 0 means bit-identical. */
function ulpDiff(a: number, b: number): number {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  const buf = new ArrayBuffer(8);
  const f = new Float64Array(buf);
  const i = new BigInt64Array(buf);
  f[0] = a; const ia = i[0];
  f[0] = b; const ib = i[0];
  const key = (x: bigint): bigint => (x < 0n ? -9223372036854775808n - x : x);
  const d = key(ia) - key(ib);
  return Number(d < 0n ? -d : d);
}

/** Series whose value set is legitimately tiny (regime flags, enum pattern codes). */
const LOW_CARDINALITY_OK: ReadonlySet<number> = new Set([
  SERIES.CHAND_TREND, SERIES.ST_TREND, SERIES.PSAR_IS_LONG,
  SERIES.MACD_IS_BULL, SERIES.MACD_IS_BEAR,
  SERIES.DMIW_IS_BULL, SERIES.DMIW_IS_BEAR,
  SERIES.EHL_IS_BULL, SERIES.EHL_IS_BEAR,
  SERIES.LWS_BULL_PAT, SERIES.LWS_BEAR_PAT,
]);

const kernel = loadKernel();
const bars = makeBars(N);

describe('native indicator kernel — ABI contract', () => {
  it('packs exactly PARAM_COUNT params with no NaN holes', () => {
    const packed = packParams(DEFAULT_CONFIG);
    expect(packed).toHaveLength(PARAM_COUNT);
    // A NaN in the param buffer means an unpacked slot, which would silently poison a series.
    const nanAt = [...packed].findIndex((v) => Number.isNaN(v));
    expect(nanAt, `param slot ${nanAt} is NaN — packParams missed a field`).toBe(-1);
  });

  it('names every series index exactly once', () => {
    expect(SERIES_NAMES).toHaveLength(SERIES_COUNT);
    expect(new Set(SERIES_NAMES).size).toBe(SERIES_COUNT);
    expect(new Set(Object.values(SERIES)).size).toBe(SERIES_COUNT);
  });
});

describe('TypeScript reference path', () => {
  it('produces SERIES_COUNT series of the right length', () => {
    const ref = computeReference(bars, DEFAULT_CONFIG);
    expect(ref).toHaveLength(SERIES_COUNT);
    for (const s of ref) expect(s).toHaveLength(N);
  });

  it('produces series that actually vary — a constant series makes parity vacuous', () => {
    const ref = computeReference(bars, DEFAULT_CONFIG);
    for (let s = 0; s < SERIES_COUNT; s++) {
      if (LOW_CARDINALITY_OK.has(s)) continue;
      const distinct = new Set([...ref[s]].filter(Number.isFinite)).size;
      expect(distinct, `${SERIES_NAMES[s]} has ${distinct} distinct finite values`).toBeGreaterThan(1);
    }
  });
});

// The artifact is a build product and untracked, so BOTH branches are supported states and both
// carry real assertions. Neither is a skip.
if (!kernel) {
  describe('native kernel absent — fallback contract', () => {
    it('loadKernel returns null rather than throwing', () => {
      expect(loadKernel()).toBeNull();
    });

    it('the reference path is usable on its own, so the platform runs unchanged', () => {
      const ref = computeReference(bars, DEFAULT_CONFIG);
      expect(ref).toHaveLength(SERIES_COUNT);
      expect([...ref[SERIES.ATR]].every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    });
  });
} else {
  describe.each(CONFIGS)('native kernel parity — $name', ({ cfg }) => {
    // Copy out of linear memory: the views are invalidated by a later compute, and the
    // comparison holds both sides simultaneously.
    const nat = kernel.compute(bars, cfg).map((v) => Float64Array.from(v));
    const ref = computeReference(bars, cfg);

    it('returns SERIES_COUNT series of the right length', () => {
      expect(nat).toHaveLength(SERIES_COUNT);
      for (const s of nat) expect(s).toHaveLength(N);
    });

    it.each(SERIES_NAMES.map((name, idx) => ({ name, idx })))(
      '$name matches the TS reference bit for bit',
      ({ idx }) => {
        let worstUlp = 0;
        let worstAt = -1;
        let nanMismatches = 0;
        let firstNanAt = -1;
        for (let i = 0; i < N; i++) {
          const a = ref[idx][i];
          const b = nat[idx][i];
          if (Number.isNaN(a) !== Number.isNaN(b)) {
            nanMismatches++;
            if (firstNanAt < 0) firstNanAt = i;
            continue;
          }
          const u = ulpDiff(a, b);
          if (u > worstUlp) { worstUlp = u; worstAt = i; }
        }
        expect(
          nanMismatches,
          `NaN-ness differs at ${nanMismatches} bars, first at ${firstNanAt} `
          + `(ts=${ref[idx][firstNanAt]}, wasm=${nat[idx][firstNanAt]})`,
        ).toBe(0);
        expect(
          worstUlp,
          `diverges by ${worstUlp} ULP at bar ${worstAt} `
          + `(ts=${ref[idx][worstAt]}, wasm=${nat[idx][worstAt]}). `
          + 'The TS is the reference — fix the Rust, do not widen this tolerance.',
        ).toBe(0);
      },
    );
  });

  describe('native kernel — buffer reuse across calls', () => {
    it('a smaller series after a larger one still matches the reference', () => {
      // The loader only reallocates when n grows, so the second call reads a buffer sized for the
      // first. A stale-tail bug would show up here and nowhere else.
      kernel.compute(makeBars(4_000), DEFAULT_CONFIG);
      const small = makeBars(900);
      const nat = kernel.compute(small, DEFAULT_CONFIG).map((v) => Float64Array.from(v));
      const ref = computeReference(small, DEFAULT_CONFIG);
      for (let s = 0; s < SERIES_COUNT; s++) {
        for (let i = 0; i < small.length; i++) {
          expect(ulpDiff(ref[s][i], nat[s][i]), `${SERIES_NAMES[s]}[${i}]`).toBe(0);
        }
      }
    });

    it('an empty series returns empty output rather than throwing', () => {
      const out = kernel.compute([], DEFAULT_CONFIG);
      expect(out).toHaveLength(SERIES_COUNT);
      for (const s of out) expect(s).toHaveLength(0);
    });
  });
}
