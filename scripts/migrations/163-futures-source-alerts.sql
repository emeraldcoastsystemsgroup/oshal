-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Persist opt-in source notification claims and outcomes within the forced owner-RLS research ledger.
ALTER TABLE oshal_trading_futures_research_runs ADD COLUMN IF NOT EXISTS source_alert JSONB;
