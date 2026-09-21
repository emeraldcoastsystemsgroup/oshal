-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | connector_action_audit gains `tier` (read|write) and `credential_source`, so the READ tier can record an attempt in the same append-only trail the write tier uses. Until now a spec-route read left no row naming the caller, and the read resolver may legitimately fall back to a shared operator env key — so a successful read did not prove the OWNING user's credential was used. `tier` keeps a read from being displayed as a write on the caller's trail; `credential_source` names which credential actually went out.

-- The table is created by migration 083, and lazily by action-executor.ts on a box that has
-- never applied it. Skip rather than abort when it is absent: the runtime DDL mirror creates it
-- with both columns already present, so a fresh install needs nothing from this file.
DO $$
BEGIN
  IF to_regclass('public.connector_action_audit') IS NULL THEN
    RAISE NOTICE '151: connector_action_audit absent - skipped (the runtime DDL mirror creates it with both columns)';
    RETURN;
  END IF;

  -- 'write' as the default is the honest reading of every row that already exists: before this
  -- migration the executor was the only writer, and it only ever recorded write actions.
  ALTER TABLE public.connector_action_audit
    ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'write';

  -- Read-tier only, and NULL elsewhere: the write tier refuses rather than borrowing a key, so a
  -- write row would only restate its tier. NULL means "not recorded", never "no credential".
  ALTER TABLE public.connector_action_audit
    ADD COLUMN IF NOT EXISTS credential_source TEXT;
END $$;

-- The caller's trail is read newest-first filtered by user_sub (+ optional tier); the existing
-- idx_connector_action_audit_user (user_sub, ts DESC) already serves it, so no new index here.
