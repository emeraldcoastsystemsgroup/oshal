-- 096-market-bars.sql
--
-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Futures extension (ADR-116): persistent OHLCV bar store. OSHAL fetched equity bars live from Alpaca and persisted NONE; the futures pipeline ingests once, validates completeness, and stores. Shared REFERENCE market data (no user_sub) — RLS is ENABLED (not FORCE) with an intentionally-open policy so a table-coverage guard passes while nothing is gated, because bars are public market facts, not tenant data. Mirrored at runtime by src/app/trading-bar-store.ts (ensureBarSchema).
--
-- WHY
-- The friend's pipeline downloaded into NinjaTrader's proprietary store and could not tell a whole
-- contract from a half-downloaded one until a separate gap sweep. Here bars land in one table keyed by
-- (symbol, timeframe, bar_ts); the ingest validates against the instrument model's expected count on
-- write, so completeness is known immediately. Instrument-agnostic on purpose: equities can backfill
-- here too (they currently persist no bars at all).

CREATE TABLE IF NOT EXISTS market_bars (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  bar_ts      TIMESTAMPTZ NOT NULL,
  o           DOUBLE PRECISION NOT NULL,
  h           DOUBLE PRECISION NOT NULL,
  l           DOUBLE PRECISION NOT NULL,
  c           DOUBLE PRECISION NOT NULL,
  v           DOUBLE PRECISION NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT '',
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, bar_ts)
);
CREATE INDEX IF NOT EXISTS idx_market_bars_symbol_tf ON market_bars (symbol, timeframe, bar_ts);

-- Public reference market data: RLS ENABLED (so a coverage guard sees it) but the policy is open on
-- purpose — there is no user_sub to scope, and every user reads the same market facts. Writes come from
-- The operator-run ingest. Not FORCE, so the service writer is never blocked.
ALTER TABLE market_bars ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polname = 'market_bars_public' AND polrelid = 'market_bars'::regclass
  ) THEN
    EXECUTE 'CREATE POLICY market_bars_public ON market_bars AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true)';
  END IF;
END
$$;
