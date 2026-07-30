/**
 * The TypeScript reference path, projected into the kernel's 40-series output shape.
 *
 * WHY THIS FILE EXISTS. The parity guard has to compare like with like. The existing TS functions
 * return a dozen different object shapes (`{adx, plusDi, minusDi}`, `{stopLong, stopShort, trend}`,
 * booleans, enums); the kernel returns one column-major f64 block. This adapter calls the EXISTING,
 * UNMODIFIED TS functions and lays their results out in the kernel's layout, so a mismatch in the
 * guard is a real numeric disagreement rather than a shape-translation artifact.
 *
 * It is also the fallback path itself: a caller that gets `null` from `loadKernel` calls
 * [`computeReference`] and receives the identical structure, so downstream code never branches on
 * which implementation ran.
 *
 * NOTHING IN `src/features/trading/` IS MODIFIED BY THIS TRACK. This file imports it read-only.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TS reference projected into the kernel series layout, for the parity guard and the fallback path.
 *
 * @module native/loader/reference
 */

import {
  wilderAtr, dmiAdx, laguerreRsi, movingMedian,
} from '../../src/features/trading/services/futures-indicators';
import {
  chandelierBands, superTrendM11, parabolicSar,
} from '../../src/features/trading/services/futures-trail-stops';
import {
  laguerreOscillator, laguerreFilter, mfi, adaptiveLaguerreFilter,
} from '../../src/features/trading/services/futures-entry-indicators';
import {
  macdWave, dmiWave, ehlersInstTrendWave, laguerreWaveStops,
} from '../../src/features/trading/services/futures-wave-tracking';
import { SERIES, SERIES_COUNT, type IndicatorConfig } from './series';
import type { Bar } from './index';

/**
 * @description Compute every indicator series with the pure-TypeScript implementation, laid out in
 * the kernel's column-major series order.
 * @param bars - Ascending OHLCV bars.
 * @param cfg - The same config object the kernel receives.
 * @returns `SERIES_COUNT` Float64Arrays, each `bars.length` long, indexed by {@link SERIES}.
 */
export function computeReference(bars: readonly Bar[], cfg: IndicatorConfig): Float64Array[] {
  const n = bars.length;
  const out: Float64Array[] = Array.from({ length: SERIES_COUNT }, () => new Float64Array(n));
  if (n === 0) return out;

  const mutableBars = bars as Bar[];
  const closes = mutableBars.map((b) => b.c);

  /** Copy a number[] into the output slot. */
  const put = (slot: number, src: readonly number[]): void => { out[slot].set(src); };
  /** Copy a boolean[] into the output slot as 1/0, matching the kernel's f64 encoding. */
  const putBool = (slot: number, src: readonly boolean[]): void => {
    const dst = out[slot];
    for (let i = 0; i < n; i++) dst[i] = src[i] ? 1 : 0;
  };

  put(SERIES.ATR, wilderAtr(mutableBars, cfg.atrPeriod));

  const dmi = dmiAdx(mutableBars, cfg.dmiDiLength, cfg.dmiAdxSmoothing);
  put(SERIES.ADX, dmi.adx);
  put(SERIES.PLUS_DI, dmi.plusDi);
  put(SERIES.MINUS_DI, dmi.minusDi);

  const lr = laguerreRsi(closes, cfg.larsiAlpha, cfg.larsiSmoothing);
  put(SERIES.LARSI, lr.laRsi);
  put(SERIES.LARSI_AVG, lr.average);

  put(SERIES.MEDIAN_CLOSE, movingMedian(closes, cfg.medianPeriod));

  const chand = chandelierBands(mutableBars, {
    period: cfg.chandPeriod,
    multiplier: cfg.chandMultiplier,
    useHighLow: cfg.chandUseHighLow,
    tickSize: cfg.tickSize,
  });
  put(SERIES.CHAND_STOP_LONG, chand.stopLong);
  put(SERIES.CHAND_STOP_SHORT, chand.stopShort);
  put(SERIES.CHAND_TREND, chand.trend);

  const st = superTrendM11(mutableBars, {
    basePeriod: cfg.stBasePeriod,
    rangePeriod: cfg.stRangePeriod,
    multiplier: cfg.stMultiplier,
    tickSize: cfg.tickSize,
  });
  put(SERIES.ST_STOP_DOT, st.stopDot);
  put(SERIES.ST_TREND, st.trend);

  const sar = parabolicSar(mutableBars, {
    acceleration: cfg.sarAccel,
    accelerationStep: cfg.sarStep,
    accelerationMax: cfg.sarMax,
  });
  put(SERIES.PSAR, sar.psar);
  putBool(SERIES.PSAR_IS_LONG, sar.isLong);

  put(SERIES.LAG_OSC, laguerreOscillator(closes, {
    period: cfg.oscPeriod, gamma: cfg.oscGamma, rmsLength: cfg.oscRmsLength,
  }));
  put(SERIES.LAG_FILTER, laguerreFilter(closes, cfg.filtPeriod, cfg.filtGamma));
  put(SERIES.MFI, mfi(mutableBars, cfg.mfiPeriod));
  put(SERIES.ADAPTIVE_LAG, adaptiveLaguerreFilter(closes, cfg.adaptivePeriod));

  const mw = macdWave(mutableBars, cfg.macdFast, cfg.macdSlow, cfg.macdSmooth);
  put(SERIES.MACD_LINE, mw.fast);
  put(SERIES.MACD_SIGNAL, mw.slow);
  putBool(SERIES.MACD_IS_BULL, mw.isBullish);
  putBool(SERIES.MACD_IS_BEAR, mw.isBearish);
  put(SERIES.MACD_BEAR_LOW, mw.lastBearWaveLow);
  put(SERIES.MACD_BULL_HIGH, mw.lastBullWaveHigh);

  const dw = dmiWave(mutableBars, cfg.dmiDiLength, cfg.dmiAdxSmoothing);
  put(SERIES.DMIW_FAST, dw.fast);
  put(SERIES.DMIW_SLOW, dw.slow);
  putBool(SERIES.DMIW_IS_BULL, dw.isBullish);
  putBool(SERIES.DMIW_IS_BEAR, dw.isBearish);
  put(SERIES.DMIW_BEAR_LOW, dw.lastBearWaveLow);
  put(SERIES.DMIW_BULL_HIGH, dw.lastBullWaveHigh);
  put(SERIES.DMIW_ADX, dw.adx);

  const ew = ehlersInstTrendWave(mutableBars, cfg.ehlersAlpha);
  put(SERIES.EHL_TRIGGER, ew.fast);
  put(SERIES.EHL_ITREND, ew.slow);
  putBool(SERIES.EHL_IS_BULL, ew.isBullish);
  putBool(SERIES.EHL_IS_BEAR, ew.isBearish);
  put(SERIES.EHL_BEAR_LOW, ew.lastBearWaveLow);
  put(SERIES.EHL_BULL_HIGH, ew.lastBullWaveHigh);

  const lws = laguerreWaveStops(mutableBars, {
    period: cfg.lwsPeriod, gamma: cfg.lwsGamma, rmsLength: cfg.lwsRmsLength,
  });
  put(SERIES.LWS_STOP, lws.stop);
  put(SERIES.LWS_BULL_PAT, lws.bullWavePat as unknown as number[]);
  put(SERIES.LWS_BEAR_PAT, lws.bearWavePat as unknown as number[]);

  return out;
}
