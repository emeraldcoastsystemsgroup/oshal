-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Persist review attempts under the existing forced owner-or-operator RLS study boundary.
ALTER TABLE oshal_trading_futures_research_runs ADD COLUMN IF NOT EXISTS review JSONB;
