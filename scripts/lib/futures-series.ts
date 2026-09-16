/**
 * Shared continuous-series construction for the ADR-116 futures evidence runners.
 *
 * Both `oshal-futures-backtest.ts` and `oshal-futures-sweep.ts` need the SAME series before they
 * can produce comparable numbers: the same source selection (`minute/` for intraday, `daily/` for
 * 1Day/1Week), the same front-month clamp, the same unclamped basis probe for overlap-measured roll
 * seams, and the same daily→minute resampling fallback. Two copies of that would be two chances to
 * quietly diverge, and a sweep whose series differs from the reference run's is a sweep whose
 * winners cannot be compared to it.
 *
 * Nothing here decides anything about the strategy — bars in, bars out.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — extracted verbatim from oshal-futures-backtest.ts so the Phase 1 sweep runner builds byte-identical series: sourceFor (minute/daily directory pick, front-month clamp, unclamped basis probe) and buildMarketSeries (chart + LTF with the daily-files-missing resample fallback).
 *
 * @module scripts/lib/futures-series
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MockFuturesDataSource, KibotFuturesDataSource, KibotFileDataSource, buildContinuousSeries,
  type Timeframe, type FuturesDataSource, type ContinuousSeries,
} from '@/features/trading';

/** Everything the series builder needs that is not the root symbol. */
export interface SeriesRequest {
  source: 'mock' | 'kibot' | 'kibot-file';
  dataDir: string;
  adjust: 'panama' | 'none';
  minVolume: number;
  tf: Timeframe;
  ltfTf: Timeframe;
  start: Date;
  end: Date;
}

/** Per-timeframe bar source plus the unclamped probe used for overlap seam measurement. */
export interface SourcePair { src: FuturesDataSource; probe?: FuturesDataSource }

/**
 * @description Build the source (and seam probe) for one timeframe. `kibot-file` picks `minute/`
 * for intraday and `daily/` for 1Day/1Week, falling back to `minute/` (which resamples) when no
 * daily directory exists. The probe is the same directory WITHOUT the front-month clamp or volume
 * floor — the incoming contract's pre-roll bars are back-month bars, which is exactly what seam
 * measurement needs.
 * @param req Source selection, data directory and volume floor.
 * @param tf The timeframe this source will serve.
 * @param forceMinute Force the `minute/` directory even for a daily timeframe (the resample path).
 * @returns The source, and a basis probe when the file source can supply one.
 */
export function sourceFor(req: SeriesRequest, tf: Timeframe, forceMinute = false): SourcePair {
  if (req.source === 'mock') return { src: new MockFuturesDataSource() };
  // NOTE: the live HTTP source gets no basis probe — every seam it feeds falls back to the noisier
  // 'adjacent' measurement. Acceptable while that path is credential-gated and unverified; wire a
  // probe when it goes live.
  if (req.source === 'kibot') return { src: new KibotFuturesDataSource() };
  const wantDaily = (tf === '1Day' || tf === '1Week') && !forceMinute;
  const dailyDir = join(req.dataDir, 'daily');
  const minuteDir = join(req.dataDir, 'minute');
  const dirExists = (d: string): boolean => { try { return statSync(d).isDirectory(); } catch { return false; } };
  const dir = wantDaily && dirExists(dailyDir) ? dailyDir : minuteDir;
  return {
    src: new KibotFileDataSource({ dir, minVolume: req.minVolume }),
    probe: new KibotFileDataSource({ dir, frontMonthOnly: false, minVolume: 0 }),
  };
}

/** One market's two series, plus whether the LTF had to be resampled from minute files. */
export interface MarketSeries {
  chart: ContinuousSeries;
  ltf: ContinuousSeries;
  ltfResampledFromMinute: boolean;
}

/**
 * @description Build one root's chart and higher-timeframe continuous series over the requested
 * window. A `daily/` directory existing is not the same as it covering THIS root, so an empty LTF
 * on the file source retries from `minute/` (which resamples) before the caller is told the series
 * is empty — an empty LTF gates every entry, so the distinction matters.
 * @param req Window, timeframes and adjustment mode.
 * @param root Futures root symbol (ES, CL, …).
 * @param chartSrc Source pair for the chart timeframe.
 * @param ltfSrc Source pair for the higher timeframe.
 * @returns Both series and the resample flag.
 */
export async function buildMarketSeries(
  req: SeriesRequest, root: string, chartSrc: SourcePair, ltfSrc: SourcePair,
): Promise<MarketSeries> {
  const opts = { adjust: req.adjust };
  const chart = await buildContinuousSeries(
    chartSrc.src, root, req.tf, req.start, req.end, { ...opts, basisProbe: chartSrc.probe },
  );
  let ltf = await buildContinuousSeries(
    ltfSrc.src, root, req.ltfTf, req.start, req.end, { ...opts, basisProbe: ltfSrc.probe },
  );
  let ltfResampledFromMinute = false;
  if (!ltf.bars.length && req.source === 'kibot-file') {
    const alt = sourceFor(req, req.ltfTf, /* forceMinute */ true);
    ltf = await buildContinuousSeries(
      alt.src, root, req.ltfTf, req.start, req.end, { ...opts, basisProbe: alt.probe },
    );
    ltfResampledFromMinute = ltf.bars.length > 0;
  }
  return { chart, ltf, ltfResampledFromMinute };
}
