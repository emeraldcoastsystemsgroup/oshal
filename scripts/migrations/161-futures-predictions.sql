-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve owner-scoped forward calls and terminal outcomes independently of historical studies.
CREATE TABLE IF NOT EXISTS oshal_trading_futures_predictions (
  prediction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_sub TEXT NOT NULL,
  schedule_id TEXT NOT NULL, run_id UUID NOT NULL, root TEXT NOT NULL, contract TEXT NOT NULL,
  fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','abstained','withheld','unavailable','graded')),
  snapshot JSONB, reason TEXT, outcome JSONB,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='withheld') = (snapshot IS NULL)),
  UNIQUE(owner_sub, schedule_id, contract, fingerprint)
);

CREATE INDEX IF NOT EXISTS oshal_futures_predictions_owner ON oshal_trading_futures_predictions(owner_sub, issued_at DESC);

CREATE OR REPLACE FUNCTION oshal_freeze_futures_prediction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.prediction_id,NEW.owner_sub,NEW.schedule_id,NEW.run_id,NEW.root,NEW.contract,NEW.fingerprint,NEW.snapshot,NEW.issued_at)
    IS DISTINCT FROM ROW(OLD.prediction_id,OLD.owner_sub,OLD.schedule_id,OLD.run_id,OLD.root,OLD.contract,OLD.fingerprint,OLD.snapshot,OLD.issued_at)
    OR (OLD.status IN ('graded','abstained','withheld') AND ROW(NEW.status,NEW.reason,NEW.outcome) IS DISTINCT FROM ROW(OLD.status,OLD.reason,OLD.outcome))
  THEN RAISE EXCEPTION 'Futures prediction evidence and terminal outcomes are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER oshal_futures_prediction_immutable BEFORE UPDATE ON oshal_trading_futures_predictions FOR EACH ROW EXECUTE FUNCTION oshal_freeze_futures_prediction();

ALTER TABLE oshal_trading_futures_research_runs ADD COLUMN IF NOT EXISTS prediction_cycle JSONB;

ALTER TABLE oshal_trading_futures_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_trading_futures_predictions FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='oshal_trading_futures_predictions_owner_or_operator'
    AND polrelid='oshal_trading_futures_predictions'::regclass) THEN
    CREATE POLICY oshal_trading_futures_predictions_owner_or_operator ON oshal_trading_futures_predictions FOR ALL
      USING (owner_sub=current_setting('oshal.current_sub',true) OR current_setting('oshal.is_operator',true)='on')
      WITH CHECK (owner_sub=current_setting('oshal.current_sub',true) OR current_setting('oshal.is_operator',true)='on');
  END IF;
  IF to_regrole('oshal_app') IS NOT NULL THEN
    GRANT SELECT,INSERT,UPDATE ON oshal_trading_futures_predictions TO oshal_app;
  END IF;
END $$;
