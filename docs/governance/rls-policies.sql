-- ===========================================================================
-- PostgreSQL Row-Level Security (RLS) policies for OSHAL owner_sub-bearing tables.
--
-- ARTIFACT ONLY. This file is NOT applied automatically by the app or by any
-- migration. Applying it WITHOUT the application setting the per-connection GUC
-- (see RLS-RUNBOOK.md) will hide every row from the app and effectively lock out
-- reads. Apply it deliberately, staged, after the app is setting oshal.current_sub.
--
-- Model (matches src/shared/middleware/authz.ts):
--   * A caller may see/mutate rows they own (owner column == current sub).
--   * An operator (admin) bypasses ownership entirely.
--   * Identity comes from a session GUC the app sets per transaction:
--       SET LOCAL oshal.current_sub  = '<oidc-sub>';
--       SET LOCAL oshal.is_operator  = 'on' | 'off';
--   current_setting(..., true) returns NULL (not an error) when the GUC is unset,
--   which the policies treat as "no identity" -> deny (fail closed) for restrictive
--   policies. During rollout you start PERMISSIVE so an unset GUC does not lock out.
--
-- Tables covered: tickets, workspaces, access_audit_log, chat_tasks.
-- Adjust the owner column names if your schema differs (verify before applying).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper expressions (inlined per policy; Postgres has no shared policy macro):
--   owner match : owner_col = current_setting('oshal.current_sub', true)
--   operator    : current_setting('oshal.is_operator', true) = 'on'
-- ---------------------------------------------------------------------------

-- ============================ tickets ======================================
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
-- Stage 1 (rollout): PERMISSIVE policy. An unset GUC yields NULL and the OR keeps
-- access open, so nothing breaks while you confirm the app sets the GUC.
CREATE POLICY tickets_rls_permissive ON tickets
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.current_sub', true) IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    current_setting('oshal.current_sub', true) IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

-- Stage 2 (enforce): swap to a forced owner-or-operator policy. Drop the
-- permissive one FIRST, then create these. Unset GUC -> NULL -> denied.
-- (Left commented; uncomment for the enforce stage.)
-- DROP POLICY tickets_rls_permissive ON tickets;
-- ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
-- CREATE POLICY tickets_owner_or_operator ON tickets
--   AS PERMISSIVE FOR ALL
--   USING (owner_sub = current_setting('oshal.current_sub', true)
--          OR current_setting('oshal.is_operator', true) = 'on')
--   WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
--               OR current_setting('oshal.is_operator', true) = 'on');

-- ============================ workspaces ===================================
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_rls_permissive ON workspaces
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.current_sub', true) IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    current_setting('oshal.current_sub', true) IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
-- Enforce stage (commented):
-- DROP POLICY workspaces_rls_permissive ON workspaces;
-- ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
-- CREATE POLICY workspaces_owner_or_operator ON workspaces
--   AS PERMISSIVE FOR ALL
--   USING (owner_sub = current_setting('oshal.current_sub', true)
--          OR current_setting('oshal.is_operator', true) = 'on')
--   WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
--               OR current_setting('oshal.is_operator', true) = 'on');

-- ============================ access_audit_log =============================
-- Audit rows are owned by the actor (actor_sub). Audit is typically operator/admin
-- readable for export; owners may see their own trail. Inserts come from the app's
-- emitter, so keep INSERT open during rollout (permissive WITH CHECK true).
ALTER TABLE access_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_audit_rls_permissive ON access_audit_log
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.current_sub', true) IS NULL
    OR actor_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (true);
-- Enforce stage (commented): operators read all, owners read their own, inserts allowed.
-- DROP POLICY access_audit_rls_permissive ON access_audit_log;
-- ALTER TABLE access_audit_log FORCE ROW LEVEL SECURITY;
-- CREATE POLICY access_audit_select_owner ON access_audit_log
--   AS PERMISSIVE FOR SELECT
--   USING (actor_sub = current_setting('oshal.current_sub', true)
--          OR current_setting('oshal.is_operator', true) = 'on');
-- CREATE POLICY access_audit_insert ON access_audit_log
--   AS PERMISSIVE FOR INSERT WITH CHECK (true);

-- ============================ chat_tasks ===================================
-- chat_tasks carries cost data keyed by owner_sub. Older rows may be unowned
-- (owner_sub IS NULL); the permissive stage keeps those visible. Verify the column
-- exists in your deployment before applying (some installs key cost by agent only).
ALTER TABLE chat_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_tasks_rls_permissive ON chat_tasks
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.current_sub', true) IS NULL
    OR owner_sub IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    current_setting('oshal.current_sub', true) IS NULL
    OR owner_sub IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
-- Enforce stage (commented):
-- DROP POLICY chat_tasks_rls_permissive ON chat_tasks;
-- ALTER TABLE chat_tasks FORCE ROW LEVEL SECURITY;
-- CREATE POLICY chat_tasks_owner_or_operator ON chat_tasks
--   AS PERMISSIVE FOR ALL
--   USING (owner_sub = current_setting('oshal.current_sub', true)
--          OR current_setting('oshal.is_operator', true) = 'on')
--   WITH CHECK (owner_sub = current_setting('oshal.current_sub', true)
--               OR current_setting('oshal.is_operator', true) = 'on');

-- ===========================================================================
-- ROLLBACK (disable RLS entirely; see RLS-RUNBOOK.md for the staged version):
--   ALTER TABLE tickets          DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE workspaces       DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE access_audit_log DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE chat_tasks       DISABLE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS tickets_rls_permissive          ON tickets;
--   DROP POLICY IF EXISTS workspaces_rls_permissive       ON workspaces;
--   DROP POLICY IF EXISTS access_audit_rls_permissive     ON access_audit_log;
--   DROP POLICY IF EXISTS chat_tasks_rls_permissive       ON chat_tasks;
-- ===========================================================================
