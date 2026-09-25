/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Read bounded raw dated-contract archives with explicit clocks and closed-bucket evidence.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Share the strict bounded archive reader with confirmed reference-data imports without changing prediction limits.
 */
import { openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { barMinutes, parseKibotCsv, resampleBars, type FuturesBar, type Timeframe } from '@/features/trading';
import { futuresWallTimeUtc, futuresUtcToWall } from './trading-futures-prediction-clock';

/** @description Frozen dated-contract file and timestamp identity, independent of later console edits. */
export interface FuturesPredictionSource {
  dataDir: string;
  contract: string;
  sourceTimeZone: string;
  timeframe: Timeframe;
  ltfTimeframe: Timeframe;
  minVolume: number;
}
/** @description Raw archive fields plus their separately decoded true UTC bucket close. */
export interface FuturesClosedBar { bar: FuturesBar; closedAt: string }

/** @description Parse a bounded dated-contract archive without dropping malformed rows or duplicate timestamps.
 * @param file - Operator-selected archive file. @returns Strictly validated raw wall-stamped bars.
 */
export function readStrictFuturesArchive(file: string): FuturesBar[] {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new Error('Futures source must be a file no larger than 128 MiB');
    const raw = readFileSync(fd, 'utf8');
    const bars = parseKibotCsv(raw);
    const rows = raw.split(/\r?\n/).filter(line => /^\d/.test(line.trim()));
    if (!bars.length || rows.length !== bars.length) throw new Error('Futures archive is empty or has malformed data rows');
    for (const row of rows) {
      const volume = row.trim().replace(/[;,]+$/, '').split(/[;,]/).at(-1)?.trim();
      if (!volume || !Number.isFinite(Number(volume)) || Number(volume) < 0) throw new Error('Invalid Futures source volume');
    }
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!Number.isFinite(b.v) || b.v < 0 || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c) || b.h < b.l
        || (i > 0 && b.t === bars[i - 1].t)) throw new Error('Invalid OHLCV or duplicate Futures timestamp');
    }
    return bars;
  } finally { closeSync(fd); }
}

/** @description Read one explicit contract; never splice, adjust, roll or substitute a source.
 * @param source - Frozen archive identity. @param timeframe - Chart or higher timeframe.
 * @param asOf - True UTC cutoff. @param fromWall - Optional lower encoded wall bound for grading.
 * @param limit - Maximum recent buckets considered when issuing.
 * @returns Raw closed buckets with separately decoded true UTC close times.
 */
export function readFuturesClosedBars(source: FuturesPredictionSource, timeframe: Timeframe, asOf: number, fromWall?: string, limit = 4096): FuturesClosedBar[] {
  // Daily exports have a distinct meaning; do not silently fall back to another file after issuance.
  const daily = timeframe === '1Day';
  const file = join(source.dataDir, daily ? 'daily' : 'minute', `${source.contract}.txt`);
  const all = readStrictFuturesArchive(file);
  if (daily ? all.some(bar => !bar.t.endsWith('T00:00:00.000Z')) : all.every(bar => bar.t.endsWith('T00:00:00.000Z'))) {
    throw new Error('Futures archive granularity does not match its configured directory');
  }
  const interval = barMinutes(timeframe) * 60_000;
  const wallCutoff = futuresUtcToWall(asOf, source.sourceTimeZone);
  const buckets = resampleBars(all.filter(bar => Date.parse(bar.t) <= wallCutoff), timeframe);
  const selected = fromWall ? buckets.filter(bar => bar.t >= fromWall) : buckets.slice(-limit - 2);
  if (selected.length > 8192) throw new Error('Futures outcome window exceeds 8192 bars');
  // A trailing aggregate is not complete merely because the wall clock advanced after an exporter stopped.
  const lastRawWallEnd = Date.parse(all.at(-1)!.t) + (daily ? 86_400_000 : 60_000);
  const result: FuturesClosedBar[] = [];
  for (const bar of selected) {
    const wallEnd = Date.parse(bar.t) + interval;
    if (wallEnd > lastRawWallEnd) continue;
    const opened = futuresWallTimeUtc(bar.t, source.sourceTimeZone);
    const closed = futuresWallTimeUtc(new Date(wallEnd).toISOString(), source.sourceTimeZone);
    if (closed <= opened) throw new Error('Invalid Futures bar interval');
    if (closed <= asOf && bar.v >= source.minVolume) result.push({ bar, closedAt: new Date(closed).toISOString() });
  }
  return fromWall ? result : result.slice(-limit);
}
