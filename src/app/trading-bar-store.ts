/**
 * Market bar store (ADR-116) — Postgres persistence for OHLCV bars, the store the equities stack never
 * had. Schema self-heals on first use (ensureBarSchema), mirroring scripts/migrations/096-market-bars.sql
 * — the same pattern as ensureLabSchema / ensureTradingSchema.
 *
 * Bars are shared REFERENCE data (no user_sub) keyed by (symbol, timeframe, bar_ts): market facts every
 * user sees identically. The futures ingest writes here after validating completeness; a future intraday
 * backtester and the paper-broker mark-price resolver read from here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ensureBarSchema, chunked upsertBars (ON CONFLICT refresh), readBars (ordered window), barCoverage (count + first/last), latestClose. Instrument-agnostic OHLCV; RLS-enabled-but-open per migration 096.
 *
 * @module trading-bar-store
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { FuturesBar, Timeframe } from '@/features/trading';

const logger = createChildLogger({ module: 'trading-bar-store' });

/** Coverage summary for one (symbol, timeframe) series. */
export interface BarCoverage {
  symbol: string;
  timeframe: Timeframe;
  /** Distinct bars stored. */
  count: number;
  /** Earliest bar timestamp (ISO) or null when empty. */
  firstIso: string | null;
  /** Latest bar timestamp (ISO) or null when empty. */
  lastIso: string | null;
}

/** Max rows per multi-row INSERT (9 params/row keeps this well under Postgres' 65535 param cap). */
const CHUNK = 500;
let ensured = false;

/**
 * @description Create the market_bars table + open RLS policy if the migration has not run (fresh
 * installs / hot-swap). Idempotent; runs once per process.
 * @param pool - The shared Postgres pool.
 * @returns Nothing.
 */
export async function ensureBarSchema(pool: Pool): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_bars (
      symbol TEXT NOT NULL, timeframe TEXT NOT NULL, bar_ts TIMESTAMPTZ NOT NULL,
      o DOUBLE PRECISION NOT NULL, h DOUBLE PRECISION NOT NULL, l DOUBLE PRECISION NOT NULL,
      c DOUBLE PRECISION NOT NULL, v DOUBLE PRECISION NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '', ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, timeframe, bar_ts)
    );
    CREATE INDEX IF NOT EXISTS idx_market_bars_symbol_tf ON market_bars (symbol, timeframe, bar_ts);
    ALTER TABLE market_bars ENABLE ROW LEVEL SECURITY;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='market_bars_public' AND polrelid='market_bars'::regclass) THEN
        EXECUTE 'CREATE POLICY market_bars_public ON market_bars AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)';
      END IF;
    END $$;
  `);
  ensured = true;
  logger.info('market_bars schema ensured');
}

/**
 * @description Upsert bars for a series, refreshing OHLCV on conflict. Chunked to stay under the param cap.
 * @param pool - Postgres pool.
 * @param symbol - Contract/instrument symbol.
 * @param timeframe - Bar size.
 * @param source - Provenance tag (e.g. 'mock' / 'kibot').
 * @param bars - The bars to persist.
 * @returns The number of bars written.
 */
export async function upsertBars(pool: Pool, symbol: string, timeframe: Timeframe, source: string, bars: FuturesBar[]): Promise<number> {
  await ensureBarSchema(pool);
  let written = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const chunk = bars.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((b, j) => {
      const p = j * 9;
      values.push(`($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9})`);
      params.push(symbol, timeframe, b.t, b.o, b.h, b.l, b.c, b.v, source);
    });
    await pool.query(
      `INSERT INTO market_bars (symbol,timeframe,bar_ts,o,h,l,c,v,source) VALUES ${values.join(',')}
       ON CONFLICT (symbol,timeframe,bar_ts) DO UPDATE SET
         o=EXCLUDED.o, h=EXCLUDED.h, l=EXCLUDED.l, c=EXCLUDED.c, v=EXCLUDED.v,
         source=EXCLUDED.source, ingested_at=now()`,
      params,
    );
    written += chunk.length;
  }
  logger.debug({ symbol, timeframe, written }, 'bars upserted');
  return written;
}

/**
 * @description Read bars for a series within an inclusive time window, ascending.
 * @param pool - Postgres pool.
 * @param symbol - Instrument symbol.
 * @param timeframe - Bar size.
 * @param fromIso - Window start, ISO-8601.
 * @param toIso - Window end, ISO-8601.
 * @returns The stored bars in ascending time order.
 */
export async function readBars(pool: Pool, symbol: string, timeframe: Timeframe, fromIso: string, toIso: string): Promise<FuturesBar[]> {
  await ensureBarSchema(pool);
  const r = await pool.query(
    `SELECT bar_ts, o, h, l, c, v FROM market_bars
      WHERE symbol=$1 AND timeframe=$2 AND bar_ts >= $3 AND bar_ts <= $4 ORDER BY bar_ts ASC`,
    [symbol, timeframe, fromIso, toIso],
  );
  return r.rows.map((row) => ({
    t: new Date(row.bar_ts).toISOString(),
    o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), v: Number(row.v),
  }));
}

/**
 * @description Coverage summary (count + first/last) for a series.
 * @param pool - Postgres pool.
 * @param symbol - Instrument symbol.
 * @param timeframe - Bar size.
 * @returns The coverage row.
 */
export async function barCoverage(pool: Pool, symbol: string, timeframe: Timeframe): Promise<BarCoverage> {
  await ensureBarSchema(pool);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(bar_ts) AS first_ts, MAX(bar_ts) AS last_ts
       FROM market_bars WHERE symbol=$1 AND timeframe=$2`,
    [symbol, timeframe],
  );
  const row = r.rows[0] ?? {};
  return {
    symbol, timeframe, count: Number(row.n) || 0,
    firstIso: row.first_ts ? new Date(row.first_ts).toISOString() : null,
    lastIso: row.last_ts ? new Date(row.last_ts).toISOString() : null,
  };
}

/**
 * @description The most recent stored close for a symbol/timeframe — the paper broker's mark source.
 * @param pool - Postgres pool.
 * @param symbol - Instrument symbol.
 * @param timeframe - Bar size.
 * @returns The last close, or null if the series is empty.
 */
export async function latestClose(pool: Pool, symbol: string, timeframe: Timeframe): Promise<number | null> {
  await ensureBarSchema(pool);
  const r = await pool.query(
    `SELECT c FROM market_bars WHERE symbol=$1 AND timeframe=$2 ORDER BY bar_ts DESC LIMIT 1`,
    [symbol, timeframe],
  );
  return r.rows[0] ? Number(r.rows[0].c) : null;
}
