-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Keep broker-licensed dated Futures bars private to the connected owner, separate from the public reference market_bars table.
CREATE TABLE IF NOT EXISTS oshal_trading_futures_schwab_bars (
  owner_sub TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe = '30Min'),
  bar_ts TIMESTAMPTZ NOT NULL,
  o DOUBLE PRECISION NOT NULL,
  h DOUBLE PRECISION NOT NULL,
  l DOUBLE PRECISION NOT NULL,
  c DOUBLE PRECISION NOT NULL,
  v DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL DEFAULT 'schwab',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_sub, symbol, timeframe, bar_ts)
);
CREATE INDEX IF NOT EXISTS oshal_futures_schwab_owner_latest
  ON oshal_trading_futures_schwab_bars(owner_sub, symbol, bar_ts DESC);
ALTER TABLE oshal_trading_futures_schwab_bars ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_trading_futures_schwab_bars FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='oshal_trading_futures_schwab_bars_owner_or_operator'
                 AND polrelid='oshal_trading_futures_schwab_bars'::regclass) THEN
    CREATE POLICY oshal_trading_futures_schwab_bars_owner_or_operator ON oshal_trading_futures_schwab_bars
      AS PERMISSIVE FOR ALL
      USING (owner_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on')
      WITH CHECK (owner_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on');
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='oshal_app') THEN
    GRANT SELECT, INSERT ON oshal_trading_futures_schwab_bars TO oshal_app;
  END IF;
END $$;
