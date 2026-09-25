/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Mirror the owner-RLS archive import ledger and require immutable preview protection in validate-only deployments.
 */
import type { Pool } from 'pg';
import { buildOwnerRlsPolicyStatements, runRuntimeSchemaBootstrap, SCHEMA_LOCK_KEYS } from '@/shared/services/database';
import { ensureBarSchema } from './trading-bar-store';

/** @description Mirror migration 162 after the shared reference-bar schema; application roles only validate in hosted mode.
 * @param pool - Application pool. @returns Verified table and immutable-receipt trigger readiness.
 */
export async function ensureFuturesArchiveSchema(pool: Pool): Promise<void> {
  await ensureBarSchema(pool);
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Futures archive imports', lockKey: SCHEMA_LOCK_KEYS.trading,
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_trading_futures_archive_imports (
        import_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_sub TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('previewing','ready','importing','completed','failed')),
        config JSONB NOT NULL, plan JSONB, inserted INTEGER, unchanged INTEGER, error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
      `CREATE UNIQUE INDEX IF NOT EXISTS oshal_futures_one_archive_worker ON oshal_trading_futures_archive_imports ((1)) WHERE status IN ('previewing','importing')`,
      `CREATE INDEX IF NOT EXISTS oshal_futures_archive_owner_created ON oshal_trading_futures_archive_imports(owner_sub,created_at DESC)`,
      `CREATE OR REPLACE FUNCTION oshal_freeze_futures_archive_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ROW(NEW.import_id,NEW.owner_sub,NEW.config,NEW.created_at) IS DISTINCT FROM ROW(OLD.import_id,OLD.owner_sub,OLD.config,OLD.created_at)
          OR (OLD.plan IS NOT NULL AND NEW.plan IS DISTINCT FROM OLD.plan)
          OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)
        THEN RAISE EXCEPTION 'Futures import identity, approved preview and completed receipt are immutable'; END IF; RETURN NEW; END $$`,
      `CREATE OR REPLACE TRIGGER oshal_futures_archive_immutable BEFORE UPDATE ON oshal_trading_futures_archive_imports FOR EACH ROW EXECUTE FUNCTION oshal_freeze_futures_archive_import()`,
      ...buildOwnerRlsPolicyStatements('oshal_trading_futures_archive_imports', 'owner_sub'),
    ], requirements: [{ table: 'oshal_trading_futures_archive_imports', columns: ['import_id','owner_sub','status','config','plan','inserted','unchanged','error','created_at','updated_at'] }] });
  const trigger = await pool.query("SELECT 1 FROM pg_trigger WHERE tgname='oshal_futures_archive_immutable' AND tgrelid='oshal_trading_futures_archive_imports'::regclass AND tgenabled='O'");
  if (!trigger.rows.length) throw new Error('Futures archive imports require migration 162 immutability protection');
}
