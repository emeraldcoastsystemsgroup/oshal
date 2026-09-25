/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Atomically insert approved UTC archive bars while refusing conflicting provenance or prices; never replace shared facts.
 */
import type { Pool, PoolClient } from 'pg';
import { isOperatorIdentity } from '@/shared/middleware/authz';
import type { FuturesBar } from '@/features/trading';
import type { FuturesArchiveConfig } from './trading-futures-archive-config';
import type { FuturesArchivePrepared, FuturesArchiveSeries } from './trading-futures-archive-source';

/** @description A safe operator-facing refusal with no filesystem or database internals.
 * @param message - Public refusal reason. @returns Tagged error safe for an owned receipt.
 */
export function archiveRefusal(message: string): Error { return Object.assign(new Error(message), { publicMessage: message }); }

async function insertChunk(client: PoolClient, series: FuturesArchiveSeries, source: string, bars: FuturesBar[]): Promise<number> {
  const tuples: string[] = [], values: unknown[] = [];
  for (const [i, bar] of bars.entries()) {
    const n = i * 9;
    tuples.push(`($${n + 1},$${n + 2},$${n + 3}::timestamptz,$${n + 4}::float8,$${n + 5}::float8,$${n + 6}::float8,$${n + 7}::float8,$${n + 8}::float8,$${n + 9})`);
    values.push(series.symbol, series.timeframe, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v, source);
  }
  const inserted = await client.query(`INSERT INTO market_bars(symbol,timeframe,bar_ts,o,h,l,c,v,source) VALUES ${tuples.join(',')}
    ON CONFLICT(symbol,timeframe,bar_ts) DO NOTHING RETURNING 1`, values);
  const checked = await client.query(`WITH wanted(symbol,timeframe,bar_ts,o,h,l,c,v,source) AS (VALUES ${tuples.join(',')})
    SELECT m.symbol FROM market_bars m JOIN wanted w USING(symbol,timeframe,bar_ts)
    WHERE ROW(m.o,m.h,m.l,m.c,m.v,m.source) IS NOT DISTINCT FROM ROW(w.o,w.h,w.l,w.c,w.v,w.source) FOR UPDATE OF m`, values);
  if (checked.rows.length !== bars.length) throw archiveRefusal('Stored bars conflict with this preview. Nothing was imported; no existing reference data was replaced.');
  return inserted.rows.length;
}

async function storeSeries(client: PoolClient, data: FuturesArchivePrepared, config: FuturesArchiveConfig): Promise<number> {
  const source = `kibot-file:utc-v1:${config.sourceTimeZone}`;
  let inserted = 0;
  for (const series of data.series!) {
    if (!series.bars.length) continue;
    const foreign = await client.query('SELECT 1 FROM market_bars WHERE symbol=$1 AND timeframe=$2 AND source<>$3 LIMIT 1', [series.symbol, series.timeframe, source]);
    if (foreign.rows.length) throw archiveRefusal(`${series.symbol}/${series.timeframe} has a different stored source or clock. Nothing was imported; inspect provenance before proceeding.`);
    for (let offset = 0; offset < series.bars.length; offset += 500) inserted += await insertChunk(client, series, source, series.bars.slice(offset, offset + 500));
  }
  return inserted;
}

/** @description Commit all bars and their owned receipt together, or roll everything back on source drift, conflict or revoked authority.
 * @param pool - Application pool. @param owner - Admitted operator. @param importId - Owned preview ID.
 * @param data - Re-read internal worker result. @returns Completion; the durable receipt contains exact inserted/unchanged counts.
 */
export async function persistFuturesArchive(pool: Pool, owner: string, importId: string, data: FuturesArchivePrepared): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='60s'");
    await client.query("SET LOCAL lock_timeout='3s'");
    const row = (await client.query('SELECT * FROM oshal_trading_futures_archive_imports WHERE import_id=$1 AND owner_sub=$2 FOR UPDATE', [importId, owner])).rows[0];
    if (!row || row.status !== 'importing') throw archiveRefusal('Archive import is no longer active. No data was imported.');
    if (!isOperatorIdentity(owner)) throw archiveRefusal('Operator access was revoked. No data was imported.');
    if (!data.series || data.plan.fingerprint !== row.plan?.fingerprint) throw archiveRefusal('Archive contents changed since preview. Nothing was imported; create and confirm a new preview.');
    const inserted = await storeSeries(client, data, row.config);
    if (!isOperatorIdentity(owner)) throw archiveRefusal('Operator access was revoked. No data was imported.');
    await client.query(`UPDATE oshal_trading_futures_archive_imports SET status='completed',inserted=$3,unchanged=$4,updated_at=clock_timestamp() WHERE import_id=$1 AND owner_sub=$2`,
      [importId, owner, inserted, data.plan.totalBars - inserted]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
