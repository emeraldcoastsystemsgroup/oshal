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
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Measure bounded owner-private active-contract session gaps and trailing freshness on true UTC buckets.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Add bounded, explicit current-contract catch-up through the same immutable private store.
 */
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { activeContractAt } from '@/features/trading';
import { isSessionBucket } from '@/features/trading/services/futures-session-calendar';
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
export interface SchwabCaptureGap { first: string; last: string; missingBars: number }
export interface SchwabCaptureHealth {
  root: string; symbol: string; state: 'unobserved' | 'covered' | 'missing';
  windowStart: string | null; latestExpected: string | null; latestCaptured: string | null;
  expected: number | null; received: number; missing: number | null; trailingMissing: number | null;
  outsideSession: number; gapCount: number; largestGaps: SchwabCaptureGap[];
}
export interface SchwabBackfillPlan { roots: string[]; fromDate: string; throughDate: string;
  contracts: Array<{ root: string; symbol: string }>; requestCount: number; fingerprint: string }

/** @description Grade the observable forward span, not a historical archive or a trading entitlement.
 * UTC iteration preserves distinct instants through DST; only the session predicate sees NY wall fields.
 */
export function assessSchwabCaptureHealth(root: string, symbol: string, timestamps: string[], now = Date.now()): SchwabCaptureHealth {
  const cutoff = Math.floor((now - 120_000) / BAR_MS) * BAR_MS - BAR_MS;
  const present = new Set(timestamps.map(Date.parse).filter(t => Number.isFinite(t) && t % BAR_MS === 0 && t <= cutoff && t >= now - LOOKBACK_MS));
  const ordered = [...present].sort((a,b) => a-b);
  const base = { root, symbol, latestCaptured: ordered.length ? new Date(ordered.at(-1)!).toISOString() : null };
  if (!ordered.length) return { ...base, state: 'unobserved', windowStart: null, latestExpected: null,
    expected: null, received: 0, missing: null, trailingMissing: null, outsideSession: 0, gapCount: 0, largestGaps: [] };
  const windowStart = ordered[0];
  const expectedSlots: number[] = [];
  for (let t = windowStart; t <= cutoff; t += BAR_MS) {
    if (isSessionBucket(futuresUtcToWall(t, 'America/New_York'), BAR_MS)) expectedSlots.push(t);
  }
  const eligible = new Set(expectedSlots);
  const missingSlots = expectedSlots.filter(t => !present.has(t));
  const received = expectedSlots.length - missingSlots.length;
  const outsideSession = ordered.filter(t => !eligible.has(t)).length;
  const gaps: SchwabCaptureGap[] = [];
  let run: { first: number; last: number; missingBars: number } | null = null;
  for (const t of expectedSlots) {
    if (!present.has(t)) {
      if (run) { run.last = t; run.missingBars++; }
      else run = { first: t, last: t, missingBars: 1 };
    } else if (run) { gaps.push({ first: new Date(run.first).toISOString(), last: new Date(run.last).toISOString(), missingBars: run.missingBars }); run = null; }
  }
  if (run) gaps.push({ first: new Date(run.first).toISOString(), last: new Date(run.last).toISOString(), missingBars: run.missingBars });
  const trailingMissing = expectedSlots.length ? gaps.at(-1)?.last === new Date(expectedSlots.at(-1)!).toISOString()
    ? gaps.at(-1)!.missingBars : 0 : 0;
  return { ...base, state: missingSlots.length || outsideSession ? 'missing' : 'covered',
    windowStart: new Date(windowStart).toISOString(), latestExpected: expectedSlots.length ? new Date(expectedSlots.at(-1)!).toISOString() : null,
    expected: expectedSlots.length, received, missing: missingSlots.length, trailingMissing, outsideSession,
    gapCount: gaps.length, largestGaps: gaps.sort((a,b) => b.missingBars - a.missingBars).slice(0, 5) };
}

/** @description Active ES/CL aggregate diagnostics only; bounded to five days and enforced by owner RLS. */
export async function listSchwabFuturesHealth(pool: Pool, ownerSub: string, now = Date.now()): Promise<SchwabCaptureHealth[]> {
  await ensureSchwabFuturesBars(pool);
  const active = ['ES','CL'].map(root => ({ root, symbol: activeContractAt(root, new Date(now))!.symbol }));
  const rows = (await pool.query(`SELECT symbol,bar_ts FROM ${TABLE} WHERE owner_sub=$1 AND symbol=ANY($2::text[])
    AND timeframe='30Min' AND bar_ts >= $3 ORDER BY symbol,bar_ts`,
    [ownerSub, active.map(item => item.symbol), new Date(now - LOOKBACK_MS).toISOString()])).rows;
  return active.map(item => assessSchwabCaptureHealth(item.root, item.symbol,
    rows.filter(row => row.symbol === item.symbol).map(row => new Date(row.bar_ts).toISOString()), now));
}

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

async function fetchSeries(token: string, symbol: string, from: number, to: number, now: number, fetcher: Fetcher, allowEmpty = false): Promise<SchwabCapturedBar[]> {
  const qs = new URLSearchParams({ symbol: `/${symbol}`, periodType: 'day', frequencyType: 'minute', frequency: '30',
    startDate: String(from), endDate: String(to), needExtendedHoursData: 'true' });
  const response = await fetcher(`${(process.env.SCHWAB_MARKETDATA_BASE_URL || BASE).replace(/\/+$/, '')}/pricehistory?${qs}`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Schwab Futures history HTTP ${response.status}`);
  const bars = parseSchwabFuturesCandles(await response.json(), now).filter(bar => Date.parse(bar.t) >= from && Date.parse(bar.t) < to);
  if (!bars.length && !allowEmpty) throw new Error(`${symbol}: no closed Schwab Futures bars`);
  return bars;
}

function assertRoots(roots: string[]): void {
  if (!Array.isArray(roots) || !roots.length || roots.length > 2 || roots.some(root => root !== 'ES' && root !== 'CL') || new Set(roots).size !== roots.length) {
    throw new RangeError('Schwab Futures capture supports ES and CL only');
  }
}

async function persistSchwabSeries(pool: Pool, ownerSub: string, series: Array<{ root: string; symbol: string; bars: SchwabCapturedBar[] }>): Promise<SchwabCaptureReceipt> {
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

/** @description Capture current and just-rolled dated contracts using the caller's brokered token; no order path. */
export async function captureSchwabFuturesBars(pool: Pool, ownerSub: string, token: string, roots: string[] = ['ES','CL'],
  fetcher: Fetcher = fetch, now = Date.now()): Promise<SchwabCaptureReceipt> {
  if (!ownerSub || !token) throw new TypeError('Schwab Futures capture needs a connected owner');
  assertRoots(roots);
  const wanted = new Map<string,string>();
  for (const root of roots) for (const at of [new Date(now - LOOKBACK_MS), new Date(now)]) {
    const contract = activeContractAt(root, at);
    if (!contract) throw new Error(`${root}: dated contract unavailable`);
    wanted.set(contract.symbol, root);
  }
  // Fetch and validate EVERY series before touching the database; no partial source set on a bad response.
  const series: Array<{ root: string; symbol: string; bars: SchwabCapturedBar[] }> = [];
  for (const [symbol, root] of wanted) series.push({ root, symbol, bars: await fetchSeries(token, symbol, now - LOOKBACK_MS, now, now, fetcher) });
  return persistSchwabSeries(pool, ownerSub, series);
}

/** @description Preview a finite exact-date current-contract read without a provider call. */
export function planSchwabCurrentBackfill(roots: string[], fromDate: string, throughDate: string, now = Date.now()): SchwabBackfillPlan {
  assertRoots(roots);
  const date = (value: string): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Choose ISO UTC dates');
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== value) throw new RangeError('Choose real UTC dates');
    return ms;
  };
  const from = date(fromDate), through = date(throughDate), end = Math.min(through + 86_400_000, now);
  if (through < from || through - from >= 14 * 86_400_000 || from < now - 180 * 86_400_000 || from >= now || through > now) {
    throw new RangeError('Schwab catch-up must be within the past 180 days and span at most 14 UTC dates');
  }
  const contracts = roots.map(root => ({ root, symbol: activeContractAt(root, new Date(now))?.symbol }));
  if (contracts.some(item => !item.symbol)) throw new Error('Active dated contract unavailable');
  const requestCount = roots.length * Math.ceil((end - from) / LOOKBACK_MS);
  const fingerprint = createHash('sha256').update(JSON.stringify({ roots, fromDate, throughDate, contracts })).digest('hex');
  return { roots, fromDate, throughDate, contracts: contracts as Array<{ root: string; symbol: string }>, requestCount, fingerprint };
}

/** @description Catch up currently active dated contracts over at most 14 selected UTC days. Never invent a front-month/rolled archive. */
export async function backfillSchwabCurrentFuturesBars(pool: Pool, ownerSub: string, token: string, roots: string[], fromDate: string, throughDate: string,
  confirmation: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<SchwabCaptureReceipt> {
  if (!ownerSub || !token) throw new TypeError('Schwab Futures backfill needs a connected owner');
  const plan = planSchwabCurrentBackfill(roots, fromDate, throughDate, now);
  if (!confirmation || confirmation !== plan.fingerprint) throw new RangeError('Preview and confirm the exact Futures catch-up range first');
  const from = Date.parse(`${fromDate}T00:00:00.000Z`), end = Math.min(Date.parse(`${throughDate}T00:00:00.000Z`) + 86_400_000, now);
  const series: Array<{ root: string; symbol: string; bars: SchwabCapturedBar[] }> = [];
  for (const { root, symbol } of plan.contracts) {
    const gathered = new Map<string,SchwabCapturedBar>();
    for (let start = from; start < end; start += LOOKBACK_MS) {
      const chunk = await fetchSeries(token, symbol, start, Math.min(start + LOOKBACK_MS, end), now, fetcher, true);
      for (const bar of chunk) {
        const prior = gathered.get(bar.t);
        if (prior && JSON.stringify(prior) !== JSON.stringify(bar)) throw new Error(`${symbol}: conflicting catch-up pages`);
        gathered.set(bar.t, bar);
      }
    }
    const bars = [...gathered.values()].sort((a,b) => a.t.localeCompare(b.t));
    if (!bars.length) throw new Error(`${symbol}: no closed candles in the selected range`);
    series.push({ root, symbol, bars });
  }
  return persistSchwabSeries(pool, ownerSub, series);
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
