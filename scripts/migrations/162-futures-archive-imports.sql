-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Preserve owner-approved archive previews and atomic shared-reference import receipts independently of research and orders.
CREATE TABLE IF NOT EXISTS oshal_trading_futures_archive_imports (
  import_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_sub TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('previewing','ready','importing','completed','failed')),
  config JSONB NOT NULL, plan JSONB, inserted INTEGER, unchanged INTEGER, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS oshal_futures_one_archive_worker
  ON oshal_trading_futures_archive_imports ((1)) WHERE status IN ('previewing','importing');
CREATE INDEX IF NOT EXISTS oshal_futures_archive_owner_created ON oshal_trading_futures_archive_imports(owner_sub,created_at DESC);
CREATE OR REPLACE FUNCTION oshal_freeze_futures_archive_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.import_id,NEW.owner_sub,NEW.config,NEW.created_at) IS DISTINCT FROM ROW(OLD.import_id,OLD.owner_sub,OLD.config,OLD.created_at)
    OR (OLD.plan IS NOT NULL AND NEW.plan IS DISTINCT FROM OLD.plan)
    OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)
  THEN RAISE EXCEPTION 'Futures import identity, approved preview and completed receipt are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER oshal_futures_archive_immutable BEFORE UPDATE ON oshal_trading_futures_archive_imports
  FOR EACH ROW EXECUTE FUNCTION oshal_freeze_futures_archive_import();
ALTER TABLE oshal_trading_futures_archive_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_trading_futures_archive_imports FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='oshal_trading_futures_archive_imports_owner_or_operator'
    AND polrelid='oshal_trading_futures_archive_imports'::regclass) THEN
    CREATE POLICY oshal_trading_futures_archive_imports_owner_or_operator ON oshal_trading_futures_archive_imports FOR ALL
      USING(owner_sub=current_setting('oshal.current_sub',true) OR current_setting('oshal.is_operator',true)='on')
      WITH CHECK(owner_sub=current_setting('oshal.current_sub',true) OR current_setting('oshal.is_operator',true)='on');
  END IF;
  IF to_regrole('oshal_app') IS NOT NULL THEN
    GRANT SELECT,INSERT,UPDATE ON oshal_trading_futures_archive_imports TO oshal_app;
    -- market_bars remains the existing shared reference store; only operator-confirmed routes invoke imports.
    GRANT SELECT,INSERT,UPDATE ON market_bars TO oshal_app;
  END IF;
END $$;
