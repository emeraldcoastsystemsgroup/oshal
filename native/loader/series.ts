/**
 * The ABI contract, JS side — series indices, param packing, and the config that drives both
 * implementations.
 *
 * THIS FILE IS HALF OF A CONTRACT. Its mirror is `native/crates/oshal-kernel/src/lib.rs`
 * (`mod S`, `mod P`, `SERIES_COUNT`, `PARAM_COUNT`). Change one side and you must change the other;
 * the loader cross-checks the COUNTS at instantiation and the kernel exports an ABI VERSION for
 * the case counts stay equal but meanings move. A reordered column read as the old one is a
 * silently wrong backtest, which is the failure mode both guards exist to prevent.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — series/param index mirrors, IndicatorConfig with ADR-116 defaults, SuperSmoother coefficients computed JS-side for bit parity, and the param-buffer packer.
 *
 * @module native/loader/series
 */

/** ABI revision this loader speaks. Must equal the kernel's `kernel_abi_version()`. */
export const ABI_VERSION = 1;

/** Number of params the kernel expects. Must equal the kernel's `PARAM_COUNT`. */
export const PARAM_COUNT = 36;

/** Number of output series the kernel writes. Must equal the kernel's `SERIES_COUNT`. */
export const SERIES_COUNT = 40;

/**
 * Output series indices, mirroring `mod S` in the kernel. The output buffer is column-major:
 * series `s` for `n` bars occupies `out[s*n .. (s+1)*n]`.
 */
export const SERIES = {
  ATR: 0,
  ADX: 1,
  PLUS_DI: 2,
  MINUS_DI: 3,
  LARSI: 4,
  LARSI_AVG: 5,
  MEDIAN_CLOSE: 6,
  CHAND_STOP_LONG: 7,
  CHAND_STOP_SHORT: 8,
  CHAND_TREND: 9,
  ST_STOP_DOT: 10,
  ST_TREND: 11,
  PSAR: 12,
  PSAR_IS_LONG: 13,
  LAG_OSC: 14,
  LAG_FILTER: 15,
  MFI: 16,
  ADAPTIVE_LAG: 17,
  MACD_LINE: 18,
  MACD_SIGNAL: 19,
  MACD_IS_BULL: 20,
  MACD_IS_BEAR: 21,
  MACD_BEAR_LOW: 22,
  MACD_BULL_HIGH: 23,
  DMIW_FAST: 24,
  DMIW_SLOW: 25,
  DMIW_IS_BULL: 26,
  DMIW_IS_BEAR: 27,
  DMIW_BEAR_LOW: 28,
  DMIW_BULL_HIGH: 29,
  DMIW_ADX: 30,
  EHL_TRIGGER: 31,
  EHL_ITREND: 32,
  EHL_IS_BULL: 33,
  EHL_IS_BEAR: 34,
  EHL_BEAR_LOW: 35,
  EHL_BULL_HIGH: 36,
  LWS_STOP: 37,
  LWS_BULL_PAT: 38,
  LWS_BEAR_PAT: 39,
} as const;

/** Param buffer indices, mirroring `mod P` in the kernel. */
const P = {
  ATR_PERIOD: 0, DMI_DI_LENGTH: 1, DMI_ADX_SMOOTHING: 2,
  LARSI_ALPHA: 3, LARSI_SMOOTHING: 4, MEDIAN_PERIOD: 5,
  CHAND_PERIOD: 6, CHAND_MULTIPLIER: 7, CHAND_USE_HIGH_LOW: 8, TICK_SIZE: 9,
  ST_BASE_PERIOD: 10, ST_RANGE_PERIOD: 11, ST_MULTIPLIER: 12,
  SAR_ACCEL: 13, SAR_STEP: 14, SAR_MAX: 15,
  OSC_GAMMA: 16, OSC_RMS_LENGTH: 17, OSC_C1: 18, OSC_C2: 19, OSC_C3: 20,
  FILT_GAMMA: 21, FILT_C1: 22, FILT_C2: 23, FILT_C3: 24,
  MFI_PERIOD: 25, ADAPTIVE_PERIOD: 26,
  MACD_FAST: 27, MACD_SLOW: 28, MACD_SMOOTH: 29,
  EHLERS_ALPHA: 30,
  LWS_GAMMA: 31, LWS_RMS_LENGTH: 32, LWS_C1: 33, LWS_C2: 34, LWS_C3: 35,
} as const;

/**
 * The full indicator configuration. Defaults are the ADR-116 strategy-effective values — the same
 * numbers `INDICATOR_DEFAULTS` carries in futures-backtester.ts. One config object drives BOTH the
 * WASM kernel and the TS reference path, which is what makes the parity guard meaningful: a config
 * that only reached one side would compare two different studies.
 */
export interface IndicatorConfig {
  atrPeriod: number;
  dmiDiLength: number;
  dmiAdxSmoothing: number;
  larsiAlpha: number;
  larsiSmoothing: number;
  medianPeriod: number;
  chandPeriod: number;
  chandMultiplier: number;
  chandUseHighLow: boolean;
  tickSize: number;
  stBasePeriod: number;
  stRangePeriod: number;
  stMultiplier: number;
  sarAccel: number;
  sarStep: number;
  sarMax: number;
  oscPeriod: number;
  oscGamma: number;
  oscRmsLength: number;
  filtPeriod: number;
  filtGamma: number;
  mfiPeriod: number;
  adaptivePeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSmooth: number;
  ehlersAlpha: number;
  lwsPeriod: number;
  lwsGamma: number;
  lwsRmsLength: number;
}

/** ADR-116 strategy-effective defaults. */
export const DEFAULT_CONFIG: IndicatorConfig = {
  atrPeriod: 14, dmiDiLength: 14, dmiAdxSmoothing: 14,
  larsiAlpha: 0.5, larsiSmoothing: 7, medianPeriod: 8,
  chandPeriod: 22, chandMultiplier: 2.0, chandUseHighLow: true, tickSize: 0.25,
  stBasePeriod: 8, stRangePeriod: 15, stMultiplier: 2.5,
  sarAccel: 0.02, sarStep: 0.02, sarMax: 0.2,
  oscPeriod: 30, oscGamma: 0.5, oscRmsLength: 30,
  filtPeriod: 30, filtGamma: 0.5,
  mfiPeriod: 14, adaptivePeriod: 20,
  macdFast: 12, macdSlow: 26, macdSmooth: 9,
  ehlersAlpha: 0.07,
  lwsPeriod: 30, lwsGamma: 0.5, lwsRmsLength: 100,
};

/**
 * @description 2-pole SuperSmoother coefficients (Ehlers). COMPUTED HERE, NOT IN RUST, and this is
 * deliberate: the formula needs `exp` and `cos`, and Rust's libm is not guaranteed bit-identical to
 * V8's Math. A one-ULP difference in c1/c2/c3 feeds an IIR filter and compounds, so parity would
 * degrade with series length and the guard would have to accept a loose tolerance. Passing the
 * coefficients in makes the two implementations agree to the last bit instead.
 * @param period - SuperSmoother period.
 * @returns The three coefficients the kernel consumes.
 */
export function superSmootherCoeffs(period: number): { c1: number; c2: number; c3: number } {
  const a1 = Math.exp((-1.414 * Math.PI) / period);
  const c2 = 2.0 * a1 * Math.cos((1.414 * Math.PI) / period);
  const c3 = -a1 * a1;
  return { c1: (1.0 + c2 - c3) / 4.0, c2, c3 };
}

/**
 * @description Pack an {@link IndicatorConfig} into the flat f64 param buffer the kernel reads,
 * computing the three SuperSmoother coefficient triples on the way.
 * @param cfg - The configuration to pack.
 * @returns A `PARAM_COUNT`-long Float64Array.
 */
export function packParams(cfg: IndicatorConfig): Float64Array {
  const p = new Float64Array(PARAM_COUNT);
  p[P.ATR_PERIOD] = cfg.atrPeriod;
  p[P.DMI_DI_LENGTH] = cfg.dmiDiLength;
  p[P.DMI_ADX_SMOOTHING] = cfg.dmiAdxSmoothing;
  p[P.LARSI_ALPHA] = cfg.larsiAlpha;
  p[P.LARSI_SMOOTHING] = cfg.larsiSmoothing;
  p[P.MEDIAN_PERIOD] = cfg.medianPeriod;
  p[P.CHAND_PERIOD] = cfg.chandPeriod;
  p[P.CHAND_MULTIPLIER] = cfg.chandMultiplier;
  p[P.CHAND_USE_HIGH_LOW] = cfg.chandUseHighLow ? 1 : 0;
  p[P.TICK_SIZE] = cfg.tickSize;
  p[P.ST_BASE_PERIOD] = cfg.stBasePeriod;
  p[P.ST_RANGE_PERIOD] = cfg.stRangePeriod;
  p[P.ST_MULTIPLIER] = cfg.stMultiplier;
  p[P.SAR_ACCEL] = cfg.sarAccel;
  p[P.SAR_STEP] = cfg.sarStep;
  p[P.SAR_MAX] = cfg.sarMax;

  const osc = superSmootherCoeffs(cfg.oscPeriod);
  p[P.OSC_GAMMA] = cfg.oscGamma;
  p[P.OSC_RMS_LENGTH] = cfg.oscRmsLength;
  p[P.OSC_C1] = osc.c1; p[P.OSC_C2] = osc.c2; p[P.OSC_C3] = osc.c3;

  const filt = superSmootherCoeffs(cfg.filtPeriod);
  p[P.FILT_GAMMA] = cfg.filtGamma;
  p[P.FILT_C1] = filt.c1; p[P.FILT_C2] = filt.c2; p[P.FILT_C3] = filt.c3;

  p[P.MFI_PERIOD] = cfg.mfiPeriod;
  p[P.ADAPTIVE_PERIOD] = cfg.adaptivePeriod;
  p[P.MACD_FAST] = cfg.macdFast;
  p[P.MACD_SLOW] = cfg.macdSlow;
  p[P.MACD_SMOOTH] = cfg.macdSmooth;
  p[P.EHLERS_ALPHA] = cfg.ehlersAlpha;

  const lws = superSmootherCoeffs(cfg.lwsPeriod);
  p[P.LWS_GAMMA] = cfg.lwsGamma;
  p[P.LWS_RMS_LENGTH] = cfg.lwsRmsLength;
  p[P.LWS_C1] = lws.c1; p[P.LWS_C2] = lws.c2; p[P.LWS_C3] = lws.c3;

  return p;
}

/** Human-readable name per series index — used by the parity guard's failure messages. */
export const SERIES_NAMES: readonly string[] = Object.entries(SERIES)
  .sort((a, b) => a[1] - b[1])
  .map(([name]) => name);
