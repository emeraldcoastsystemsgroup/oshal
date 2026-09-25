/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prepare reproducible unadjusted front-month archive plans with strict rows, explicit clocks and truthful coverage.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { barMinutes, resampleBars, type FuturesBar, type FuturesContract, type FuturesDataSource, type Timeframe } from '@/features/trading';
import { ingestFutures } from './trading-futures-ingest';
import { readStrictFuturesArchive } from './trading-futures-prediction-source';
import { futuresWallTimeUtc, futuresUtcToWall } from './trading-futures-prediction-clock';
import { fingerprintFuturesEvidence } from './trading-futures-prediction-evidence';
import { normalizeFuturesArchiveConfig, type FuturesArchiveConfig } from './trading-futures-archive-config';

/** @description UTC raw bars for one dated contract; never an adjusted continuous series. */
export interface FuturesArchiveSeries { symbol: string; timeframe: '1Hour' | '1Day'; bars: FuturesBar[] }
/** @description Bounded preview evidence without source bytes or arrays of market bars. */
export interface FuturesArchiveManifest {
  symbol: string; timeframe: string; received: number; expected: number; missing: number; complete: boolean;
  first: string | null; last: string | null; fingerprint: string;
  gapCount: number; largestGaps: Array<{ fromIso: string; toIso: string; missingBars: number }>;
}
/** @description A content-bound approval preview; missing contracts and model completeness limits remain visible. */
export interface FuturesArchivePlan {
  version: 1; fingerprint: string; totalBars: number; incomplete: number; manifest: FuturesArchiveManifest[];
}
/** @description Worker result: preview omits arrays; confirmed execution re-reads and returns the exact checked series. */
export interface FuturesArchivePrepared { plan: FuturesArchivePlan; series?: FuturesArchiveSeries[] }

function fileBars(config: FuturesArchiveConfig, contract: FuturesContract, timeframe: Timeframe, now: number): FuturesBar[] {
  const daily = timeframe === '1Day';
  const file = join(config.dataDir, daily ? 'daily' : 'minute', `${contract.symbol}.txt`);
  let all: FuturesBar[];
  try { all = readStrictFuturesArchive(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (daily ? all.some(bar => !bar.t.endsWith('T00:00:00.000Z')) : all.every(bar => bar.t.endsWith('T00:00:00.000Z'))) throw new Error('Archive granularity does not match its directory');
  const cutoff = futuresUtcToWall(now, config.sourceTimeZone);
  const lastRawEnd = Date.parse(all.at(-1)!.t) + (daily ? 86_400_000 : 60_000);
  const from = Math.max(Date.parse(config.start), contract.activeStart.getTime());
  const to = Math.min(Date.parse(config.end) + 86_400_000, contract.activeEnd.getTime());
  const result: FuturesBar[] = [];
  for (const bar of resampleBars(all.filter(row => Date.parse(row.t) <= cutoff), timeframe)) {
    const wallEnd = Date.parse(bar.t) + barMinutes(timeframe) * 60_000;
    if (wallEnd > lastRawEnd) continue;
    const opened = futuresWallTimeUtc(bar.t, config.sourceTimeZone);
    const closed = futuresWallTimeUtc(new Date(wallEnd).toISOString(), config.sourceTimeZone);
    if (closed <= opened) throw new Error('Invalid archive bucket interval');
    if (opened >= from && opened < to && closed <= now && bar.v >= config.minVolume) result.push({ ...bar, t: new Date(opened).toISOString() });
  }
  return result;
}

class ArchiveSource implements FuturesDataSource {
  readonly name = 'kibot-file';
  readonly series: FuturesArchiveSeries[] = [];
  private total = 0;
  constructor(private readonly config: FuturesArchiveConfig, private readonly now: number) {}
  configured(): boolean { return statSync(this.config.dataDir, { throwIfNoEntry: false })?.isDirectory() === true; }
  async fetchBars(contract: FuturesContract, timeframe: Timeframe): Promise<FuturesBar[]> {
    if (timeframe !== '1Hour' && timeframe !== '1Day') throw new Error('Archive imports support 1Hour and 1Day');
    const bars = fileBars(this.config, contract, timeframe, this.now);
    this.total += bars.length;
    if (this.total > 1_000_000) throw new Error('Archive import exceeds one million bars; split the requested date range');
    this.series.push({ symbol: contract.symbol, timeframe, bars });
    return bars;
  }
}

/** @description Reuse the actual ingest/completeness engine without writing shared bars until an approved fingerprint matches.
 * @param raw - Confirmed source envelope. @param includeBars - Return arrays only to the internal commit path.
 * @returns Stable preview and optional UTC bar arrays. No provider, synthetic data or paper order is invoked.
 */
export async function prepareFuturesArchive(raw: unknown, includeBars = false): Promise<FuturesArchivePrepared> {
  const config = normalizeFuturesArchiveConfig(raw), source = new ArchiveSource(config, Date.now());
  const manifest: FuturesArchiveManifest[] = [];
  for (const root of config.roots) for (const timeframe of config.timeframes) {
    const report = await ingestFutures({ root, timeframe, start: new Date(config.start), end: new Date(Date.parse(config.end) + 86_400_000 - 1), source, maxPasses: 1 });
    if (!report.totalBars) throw new Error(`${root}/${timeframe} has no completed front-month archive bars in the requested window`);
    for (const item of report.contracts) {
      const bars = source.series.find(series => series.symbol === item.symbol && series.timeframe === timeframe)!.bars;
      manifest.push({ symbol: item.symbol, timeframe, received: bars.length, expected: item.completeness.expected,
        missing: item.completeness.missing, complete: item.completeness.complete, gapCount: item.completeness.gaps.length,
        largestGaps: item.completeness.gaps.slice(0, 5), first: bars[0]?.t ?? null, last: bars.at(-1)?.t ?? null,
        fingerprint: fingerprintFuturesEvidence(bars) });
    }
  }
  const totalBars = manifest.reduce((sum, item) => sum + item.received, 0);
  const plan: FuturesArchivePlan = { version: 1, fingerprint: fingerprintFuturesEvidence({ version: 1, config, manifest }),
    totalBars, incomplete: manifest.filter(item => !item.complete).length, manifest };
  return { plan, ...(includeBars ? { series: source.series } : {}) };
}
