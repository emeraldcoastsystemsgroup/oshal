-- 064-swarm-app-operator-scope.sql
--
-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Widen the swarm_applications.scope CHECK to admit 'operator' (admin-only apps).
--
-- 'operator' scope: an app visible ONLY to operators — the first is security-center,
-- whose findings map the platform's own weak points (secret locations/previews, ungated
-- routes) and must never appear in a basic user's catalog or ribbon. Visibility layers:
--   * DB backstop: the 063 public-read policy only exposes scope='public' rows, and the
--     060 personal-or-tenant policy needs owner/tenant/operator — so a scope='operator'
--     row (owner_sub NULL) is already invisible to non-operators. NO new policy needed.
--   * Service layer: isVisibleToCaller() returns false for 'operator'; operators bypass.
--   * Route layer (the real gate): /api/security mounts requiresAuth + requiresOperator.
-- This migration only widens the column CHECK (054 pinned person/tenant/public).
--
-- Idempotent: safe to run more than once.

DO $mig$
DECLARE
  c RECORD;
BEGIN
  IF to_regclass('public.swarm_applications') IS NULL THEN
    RAISE NOTICE '064: swarm_applications absent (lazy in-app DDL); constraint applies on re-run';
    RETURN;
  END IF;

  -- Drop whatever CHECK currently pins the scope values (054 created it inline on the
  -- ADD COLUMN, so the name is the auto-generated one; match by definition to be safe).
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.swarm_applications'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%scope%'
  LOOP
    EXECUTE format('ALTER TABLE swarm_applications DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE swarm_applications
    ADD CONSTRAINT swarm_applications_scope_check
    CHECK (scope IN ('person', 'tenant', 'public', 'operator'));
END
$mig$;
