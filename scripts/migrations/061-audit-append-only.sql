-- ===========================================================================
-- 061-audit-append-only.sql
-- A2 (market remediation) — make the access_audit_log tamper-resistant.
--
-- WHAT THIS DOES
--   Installs a BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE
--   statement trigger on access_audit_log so the audit trail is append-only:
--   rows can be INSERTed, never modified, deleted, or truncated through normal
--   DML — even by the table owner or the least-privilege app role (oshal_app).
--
-- WHY
--   The June 2026 market re-assessment flagged the audit trail as "not immutable —
--   plain INSERT, runtime role holds DELETE." Revoking DELETE from oshal_app is not
--   enough because the role OWNS the table (ADR-076 ownership model) and owners are
--   not subject to table privilege checks. A trigger fires regardless of role, so it
--   is the right enforcement point given that ownership model.
--
-- HONEST LIMITS (do not overclaim immutability)
--   A superuser can still DROP/DISABLE the trigger or set session_replication_role
--   = replica to bypass it. This makes tampering require superuser + a deliberate,
--   loggable act — it does NOT provide WORM/hash-chained guarantees. True immutability
--   needs append-only external storage or a hash chain; tracked as a follow-up. The
--   SECURITY DEFINER-style helper here stays owned by the migration runner (superuser
--   `oshal`) so oshal_app cannot redefine it.
--
-- SAFE TO AUTO-APPLY
--   Idempotent (CREATE OR REPLACE + DROP TRIGGER IF EXISTS). Inserts are unaffected,
--   so it never blocks the emit path.
--
-- 2026-07-04 (A1.2 fresh-boot fix): CREATE the table here instead of skipping when
--   absent. The old to_regclass guard silently no-op'd on a FRESH database (the table
--   was only created lazily by the audit emitter / apply-rls.mjs), which recorded this
--   migration as applied WITHOUT installing the append-only triggers — leaving a fresh
--   deploy's audit trail mutable forever. DDL mirrors scripts/governance/apply-rls.mjs
--   ensurePrerequisites; both sides are idempotent.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS access_audit_log (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_sub TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  decision TEXT NOT NULL DEFAULT 'info',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_audit_actor ON access_audit_log (actor_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_audit_resource ON access_audit_log (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_audit_created ON access_audit_log (created_at DESC);

CREATE OR REPLACE FUNCTION oshal_audit_no_mutate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access_audit_log is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_append_only ON access_audit_log;
CREATE TRIGGER audit_append_only
  BEFORE UPDATE OR DELETE ON access_audit_log
  FOR EACH ROW EXECUTE FUNCTION oshal_audit_no_mutate();

DROP TRIGGER IF EXISTS audit_no_truncate ON access_audit_log;
CREATE TRIGGER audit_no_truncate
  BEFORE TRUNCATE ON access_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION oshal_audit_no_mutate();

-- ---------------------------------------------------------------------------
-- RLS enforce policies (2026-07-04, A1.2 fresh-boot fix): a fresh database now
-- gets the audit table's owner-read / open-insert policies here, in the same
-- migration that creates the table, instead of waiting for an operator to run
-- docs/governance/rls-policies-enforce.sql. Create-if-absent (no drop) so a
-- re-run never opens an RLS-enabled-but-policy-less deny window. Shapes mirror
-- rls-policies-enforce.sql exactly. Inert for superuser/BYPASSRLS runtimes.
-- ---------------------------------------------------------------------------
ALTER TABLE access_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_audit_log FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'access_audit_select_owner_or_operator'
      AND polrelid = 'access_audit_log'::regclass
  ) THEN
    CREATE POLICY access_audit_select_owner_or_operator ON access_audit_log
      AS PERMISSIVE FOR SELECT
      USING (
        actor_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'access_audit_insert'
      AND polrelid = 'access_audit_log'::regclass
  ) THEN
    CREATE POLICY access_audit_insert ON access_audit_log
      AS PERMISSIVE FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;
