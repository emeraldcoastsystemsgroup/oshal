-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Trading prediction ledger
--   (ADR-052/053/054). Persists the per-algorithm directional predictions the monitor/scan emits,
--   moving them off the local JSON file into Postgres. One row per (symbol, algo, run): the call +
--   its price, then resolved against the actual price after the horizon so each algorithm's live
--   hit-rate is queryable. Deterministic engine = scoreSymbol/ensemble in src/features/trading.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oshal_trading_predictions (
    prediction_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_sub       TEXT,                       -- owner (null = system/scheduled scan)
    mode           TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper','live')),
    symbol         TEXT NOT NULL,
    algo           TEXT NOT NULL,              -- momentum | gravity | donchian | meanrev | ensemble
    pred_dir       TEXT NOT NULL CHECK (pred_dir IN ('up','down')),
    confidence     NUMERIC(5,4),
    price          NUMERIC(18,4) NOT NULL,     -- price at prediction time
    basis          TEXT,                       -- human-readable why
    horizon_hrs    INTEGER NOT NULL DEFAULT 24,
    resolved       BOOLEAN NOT NULL DEFAULT false,
    actual_dir     TEXT,                       -- set on resolution
    actual_price   NUMERIC(18,4),
    hit            BOOLEAN,                     -- pred_dir == actual_dir
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trd_pred_symbol_algo ON oshal_trading_predictions (symbol, algo, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trd_pred_open ON oshal_trading_predictions (resolved, created_at) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_trd_pred_algo ON oshal_trading_predictions (algo, resolved);
