/**
 * Capture closed Schwab dated-contract OHLCV into an owner-only store. The true UTC
 * provider timestamp stays true UTC here; research reads translate it to the engine's
 * exchange-wall convention. No quote snapshot can become a bar.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Fetch bounded recent dated-contract 30-minute bars, validate complete buckets and immutable replays, and persist under forced owner RLS.
 */
import type { Pool } from 'pg';
import { activeContractAt } from '@/features/trading';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap, SCHEMA_LOCK_KEYS } from '@/shared/services/database';
import { futuresUtcToWall } from './trading-futures-prediction-clock';
import { getValidAccessToken } from './routes/connectors-routes';
import type { AppContext } from './composition-root';
import type { ScheduleDispatchResult, ScheduleRecord } from '@/features/scheduling';

const TABLE = 'oshal_trading_futures_schwab_bars';
const BASE = 'https://api.schwabapi.com/marketdata/v1';
const BAR_MS = 30 * 60_000;
const LOOKBACK_MS = 5 * 86_400_000;
export const SCHWAB_FUTURES_CAPTURE_CRON = '7 * * * *';
export const SCHWAB_FUTURES_CAPTURE_TASK_PREFIX = 'trading-futures-schwab-capture';
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface SchwabCapturedBar { t: string; o: number; h: number; l: number; c: number; v: number }
export interface SchwabCaptureSeries { root: string; symbol: string; received: number; inserted: number; first: string; last: string }
export interface SchwabCaptureReceipt { source: 'schwab'; ownerScoped: true; timeframe: '30Min'; completedAt: string; series: SchwabCaptureSeries[] }
export interface SchwabCaptureCoverage { symbol: string; bars: number; first: string; last: string }

/** @description Runtime schema mirrors migration 167 for fresh install; provider bars never enter shared market_bars. */
export async function ensureSchwabFuturesBars(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Schwab Futures owner bars', lockKey: SCHEMA_LOCK_KEYS.trading,
    statements: [`CREATE TABLE IF NOT EXISTS ${TABLE} (
      owner_sub TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL CHECK (timeframe = '30Min'),
      bar_ts TIMESTAMPTZ NOT NULL, o DOUBLE PRECISION NOT NULL, h DOUBLE PRECISION NOT NULL,
      l DOUBLE PRECISION NOT NULL, c DOUBLE PRECISION NOT NULL, v DOUBLE PRECISION NOT NULL,
      source TEXT NOT NULL DEFAULT 'schwab', captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(owner_sub,symbol,timeframe,bar_ts))`,
    `CREATE INDEX IF NOT EXISTS oshal_futures_schwab_owner_latest ON ${TABLE}(owner_sub,symbol,bar_ts DESC)`,
    ...buildOwnerRlsPolicyStatements(TABLE, 'owner_sub')],
    requirements: [{ table: TABLE, columns: ['owner_sub','symbol','timeframe','bar_ts','o','h','l','c','v','source','captured_at'] }],
  });
}

/** @description Reject a provider response that cannot be replayed as real, closed OHLCV bars. */
export function parseSchwabFuturesCandles(raw: unknown, now = Date.now()): SchwabCapturedBar[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { candles?: unknown }).candles)) throw new Error('Schwab Futures history has no candles array');
  const candles = (raw as { candles: unknown[] }).candles;
  if (candles.length > 1000) throw new Error('Schwab Futures history exceeds the bounded page');
  const bars: SchwabCapturedBar[] = [];
  for (const item of candles) {
    if (!item || typeof item !== 'object') throw new Error('Invalid Schwab Futures candle');
    const row = item as Record<string, unknown>;
    const stamp = Number(row.datetime), [o,h,l,c,v] = [row.open,row.high,row.low,row.close,row.volume].map(Number);
    if (!Number.isInteger(stamp) || stamp < Date.UTC(2020,0,1) || stamp > now || stamp % BAR_MS !== 0 ||
      ![o,h,l,c,v].every(Number.isFinite) || Math.min(o,h,l,c) <= 0 || v < 0 || h < Math.max(o,c) || l > Math.min(o,c)) {
      throw new Error('Invalid Schwab Futures OHLCV or timestamp');
    }
    // The still-forming bucket is never stored, even when the provider emits an interim candle.
    if (stamp + BAR_MS > now - 120_000) continue;
    const t = new Date(stamp).toISOString();
    if (bars.length && bars.at(-1)!.t >= t) throw new Error('Schwab Futures candles are duplicate or out of order');
    bars.push({ t,o,h,l,c,v });
  }
  return bars;
}

async function fetchSeries(token: string, symbol: string, now: number, fetcher: Fetcher): Promise<SchwabCapturedBar[]> {
  const qs = new URLSearchParams({ symbol: `/${symbol}`, periodType: 'day', frequencyType: 'minute', frequency: '30',
    startDate: String(now - LOOKBACK_MS), endDate: String(now), needExtendedHoursData: 'true' });
  const response = await fetcher(`${(process.env.SCHWAB_MARKETDATA_BASE_URL || BASE).replace(/\/+$/, '')}/pricehistory?${qs}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Schwab Futures history HTTP ${response.status}`);
  const bars = parseSchwabFuturesCandles(await response.json(), now);
  if (!bars.length) throw new Error(`${symbol}: no closed Schwab Futures bars`);
  return bars;
}

/** @description Capture current and just-rolled dated contracts using the caller's brokered token; no order path. */
export async function captureSchwabFuturesBars(pool: Pool, ownerSub: string, token: string, roots: string[] = ['ES','CL'],
  fetcher: Fetcher = fetch, now = Date.now()): Promise<SchwabCaptureReceipt> {
  if (!ownerSub || !token) throw new TypeError('Schwab Futures capture needs a connected owner');
  if (!Array.isArray(roots) || !roots.length || roots.length > 2 || roots.some(root => root !== 'ES' && root !== 'CL')) throw new RangeError('Schwab Futures capture supports ES and CL only');
  const wanted = new Map<string,string>();
  for (const root of roots) for (const at of [new Date(now - LOOKBACK_MS), new Date(now)]) {
    const contract = activeContractAt(root, at);
    if (!contract) throw new Error(`${root}: dated contract unavailable`);
    wanted.set(contract.symbol, root);
  }
  // Fetch and validate EVERY series before touching the database; no partial source set on a bad response.
  const series: Array<{ root: string; symbol: string; bars: SchwabCapturedBar[] }> = [];
  for (const [symbol, root] of wanted) series.push({ root, symbol, bars: await fetchSeries(token, symbol, now, fetcher) });
  await ensureSchwabFuturesBars(pool);
  const client = await pool.connect();
  const receipts: SchwabCaptureSeries[] = [];
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [`schwab-futures:${ownerSub}`]);
    if (lock.rows[0]?.acquired !== true) throw new Error('Schwab Futures capture is already running');
    for (const item of series) {
      let inserted = 0;
      for (const bar of item.bars) {
        const existing = (await client.query(`SELECT o,h,l,c,v FROM ${TABLE} WHERE owner_sub=$1 AND symbol=$2 AND timeframe='30Min' AND bar_ts=$3`,
          [ownerSub,item.symbol,bar.t])).rows[0];
        if (existing) {
          if (['o','h','l','c','v'].some(key => Number(existing[key]) !== bar[key as keyof SchwabCapturedBar])) throw new Error(`${item.symbol}: provider revised an already captured closed bar`);
          continue;
        }
        const result = await client.query(`INSERT INTO ${TABLE}(owner_sub,symbol,timeframe,bar_ts,o,h,l,c,v) VALUES($1,$2,'30Min',$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [ownerSub,item.symbol,bar.t,bar.o,bar.h,bar.l,bar.c,bar.v]);
        inserted += result.rowCount ?? 0;
      }
      receipts.push({ root: item.root, symbol: item.symbol, received: item.bars.length, inserted,
        first: item.bars[0].t, last: item.bars.at(-1)!.t });
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { source: 'schwab', ownerScoped: true, timeframe: '30Min', completedAt: new Date().toISOString(), series: receipts };
}

/** @description Owner-only count and time coverage; no licensed bars leave the database. */
export async function listSchwabFuturesCoverage(pool: Pool, ownerSub: string): Promise<SchwabCaptureCoverage[]> {
  await ensureSchwabFuturesBars(pool);
  const rows = (await pool.query(`SELECT symbol,COUNT(*)::int AS bars,MIN(bar_ts) AS first,MAX(bar_ts) AS last
    FROM ${TABLE} WHERE owner_sub=$1 GROUP BY symbol ORDER BY symbol`, [ownerSub])).rows;
  return rows.map(row => ({ symbol: String(row.symbol), bars: Number(row.bars),
    first: new Date(row.first).toISOString(), last: new Date(row.last).toISOString() }));
}

/** @description Read captured true-UTC bars as the engine's New York exchange-wall stamps for analysis only. */
export async function readSchwabFuturesWallBars(pool: Pool, ownerSub: string, symbol: string, from: string, to: string): Promise<SchwabCapturedBar[]> {
  if (!/^(ES|CL)[FGHJKMNQUVXZ]\d{2}$/.test(symbol)) throw new RangeError('Dated ES/CL symbol required');
  await ensureSchwabFuturesBars(pool);
  const rows = (await pool.query(`SELECT bar_ts,o,h,l,c,v FROM ${TABLE} WHERE owner_sub=$1 AND symbol=$2 AND timeframe='30Min' AND bar_ts >= $3 AND bar_ts < $4 ORDER BY bar_ts`,
    [ownerSub,symbol,from,to])).rows;
  const bars = rows.map(row => ({ t: new Date(futuresUtcToWall(new Date(row.bar_ts).getTime(), 'America/New_York')).toISOString(),
    o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), v: Number(row.v) }));
  if (new Set(bars.map(bar => bar.t)).size !== bars.length) throw new Error('Schwab Futures wall clock folds across DST; a unique UTC-aware series is required');
  return bars;
}

/** @description A separate owner schedule for collection, never an order or study promotion. */
export function schwabFuturesCaptureTaskType(sub: string): string { return `${SCHWAB_FUTURES_CAPTURE_TASK_PREFIX}:${sub}`; }
export function isSchwabFuturesCaptureSchedule(taskType: string): boolean { return taskType.startsWith(`${SCHWAB_FUTURES_CAPTURE_TASK_PREFIX}:`); }

/** @description Scheduler entry: resolve the exact owner's brokered connector and capture only closed bars. */
export async function dispatchSchwabFuturesCapture(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const ownerSub = schedule.ownerSub;
  if (!ownerSub || schedule.taskType !== schwabFuturesCaptureTaskType(ownerSub)) return { success: false, scheduleId: schedule.id, error: 'Futures capture owner mismatch' };
  try {
    const token = await getValidAccessToken(ctx.pool, ownerSub, 'schwab');
    if (!token) return { success: false, scheduleId: schedule.id, error: 'Schwab connection unavailable' };
    const roots = (schedule.taskData as Record<string, unknown>).roots;
    const receipt = await captureSchwabFuturesBars(ctx.pool, ownerSub, token, roots as string[]);
    return { success: true, scheduleId: schedule.id, taskId: receipt.completedAt };
  } catch { return { success: false, scheduleId: schedule.id, error: 'Schwab Futures capture failed; inspect owner coverage and provider connectivity' }; }
}
