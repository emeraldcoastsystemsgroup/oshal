-- ===========================================================================
-- PostgreSQL Row-Level Security (RLS) ENFORCE stage for owner-scoped OSHAL tables.
--
-- Apply only after:
--   1. the app is stamping oshal.current_sub / oshal.is_operator on pooled queries,
--   2. legacy owner_sub rows have been backfilled or accepted as operator-only,
--   3. docs/governance/rls-policies.sql permissive stage has soaked cleanly.
--
-- 2026-07-18 (kind cold-start proveout): drop access_audit_select_owner_or_operator
-- before recreating it — on a virgin DB a migration pre-creates that policy and the
-- bare CREATE POLICY collided, which never showed on the organically-grown compose DB.
-- Every section drops the exact name it creates (all inside one transaction).
-- ===========================================================================

-- ============================ tickets ======================================
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tickets_rls_permissive ON tickets;
DROP POLICY IF EXISTS tickets_owner ON tickets;
DROP POLICY IF EXISTS tickets_operator_bypass ON tickets;
DROP POLICY IF EXISTS tickets_owner_or_operator ON tickets;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tickets_owner_or_operator ON tickets
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

-- ============================ workspaces ===================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_rls_permissive ON workspaces;
DROP POLICY IF EXISTS workspaces_owner ON workspaces;
DROP POLICY IF EXISTS workspaces_operator_bypass ON workspaces;
DROP POLICY IF EXISTS workspaces_owner_or_operator ON workspaces;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_owner_or_operator ON workspaces
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

-- ============================ access_audit_log =============================
ALTER TABLE access_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_audit_rls_permissive ON access_audit_log;
DROP POLICY IF EXISTS access_audit_select_owner ON access_audit_log;
DROP POLICY IF EXISTS access_audit_select_owner_or_operator ON access_audit_log;
DROP POLICY IF EXISTS access_audit_insert ON access_audit_log;
ALTER TABLE access_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY access_audit_select_owner_or_operator ON access_audit_log
  AS PERMISSIVE FOR SELECT
  USING (
    actor_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
CREATE POLICY access_audit_insert ON access_audit_log
  AS PERMISSIVE FOR INSERT
  WITH CHECK (true);

-- ============================ chat_tasks ===================================
ALTER TABLE chat_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_tasks_rls_permissive ON chat_tasks;
DROP POLICY IF EXISTS chat_tasks_owner ON chat_tasks;
DROP POLICY IF EXISTS chat_tasks_operator_bypass ON chat_tasks;
DROP POLICY IF EXISTS chat_tasks_owner_or_operator ON chat_tasks;
ALTER TABLE chat_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_tasks_owner_or_operator ON chat_tasks
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
