/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Give oshal_bot the three READ grants its own ADR-149 posture guard needs. src/app/bot-node-application-authorization.ts calls readApplicationExecutionOwnership with the BOT's pool and fails closed on any exception, so a bot that cannot read those tables answers 503 authorization_bot_posture_unavailable for every execution. On this stack it could not: the tables are owned by oshal_app, migration 127 ships no GRANT at all, and the default privileges name only oshal_app - so the bot hit `permission denied for table oshal_authorization_applications` (SQLSTATE 42501) and Jarvis returned 500 on every question. SELECT only: the guard reads, never writes. No top-level BEGIN/COMMIT on purpose - the runner owns the transaction (tests/unit/migration-transactionality.spec.ts).
 */

-- =============================================================================
-- Migration 140: the bot posture guard must be able to read what it guards on
--
-- WHAT BROKE (2026-09-14, operator-reported: "i still cant say hi to jarvis"):
--   POST /api/jarvis/ask reached the bot, the bot ran its fail-closed posture
--   check, the check raised 42501, the bare catch converted it to
--   `authorization_bot_posture_unavailable`, and the api surfaced
--   "Bot node returned 500". The page then spoke its generic apology.
--
-- WHY THE GRANT WAS MISSING (not a deliberate revoke):
--   Migration 099 revokes exactly two controller-only tables from oshal_bot -
--   oshal_workload_identities and oshal_user_delegations - and nothing else.
--   oshal_authorization_applications is NOT in that revoke. It simply never
--   received a grant: migration 127 creates it with no GRANT statement, the
--   table is owned by oshal_app, and pg_default_acl carries no entry for
--   oshal_bot, so nothing oshal_app creates is readable by the bot role.
--
-- SCOPE - deliberately three tables, not a blanket re-grant:
--   These are exactly the relations readApplicationExecutionOwnership queries.
--   oshal_bot is NOSUPERUSER + NOBYPASSRLS, so every row-level policy on these
--   tables still applies to it; this restores the read the guard was written to
--   perform and nothing else. SELECT only - the guard never writes.
--
--   The WIDER gap is real and deliberately NOT fixed here: oshal_bot can SELECT
--   only 3 of 409 public tables, so migration 099's intended blanket grants are
--   not in effect for anything oshal_app created afterwards. Re-granting that
--   wholesale changes a least-privilege security posture and is the operator's
--   call, recorded in docs/BACKLOG.md rather than widened in passing.
--
-- PRIVILEGE-TOLERANT, following migration 099: when this file is re-run by the
-- api's own in-process pass as oshal_app (which may not own every table), a
-- failed grant degrades to a NOTICE instead of breaking the bootstrap chain.
--
-- ROLLBACK (break-glass):
--   REVOKE SELECT ON TABLE public.oshal_authorization_applications,
--     public.swarm_applications, public.agents FROM oshal_bot;
--   Jarvis and every other bot execution return 503 again.
-- =============================================================================

DO $$
DECLARE
  target TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_bot') THEN
    RAISE NOTICE 'oshal_bot does not exist - migration 099 has not run; nothing to grant';
    RETURN;
  END IF;

  FOREACH target IN ARRAY ARRAY[
    'public.oshal_authorization_applications',
    'public.swarm_applications',
    'public.agents'
  ] LOOP
    IF to_regclass(target) IS NULL THEN
      RAISE NOTICE 'skipping % - relation absent on this database', target;
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE format('GRANT SELECT ON TABLE %s TO oshal_bot', target);
      RAISE NOTICE 'granted SELECT on % to oshal_bot', target;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'GRANT on % skipped - current role is not the owner and lacks the privilege', target;
    END;
  END LOOP;

  -- The SELECT alone is not enough. swarm_applications' RLS policy
  -- (swarm_applications_personal_or_tenant) calls oshal_is_tenant_member(text), and a role that
  -- cannot EXECUTE the function gets `permission denied for function oshal_is_tenant_member`
  -- (42501) rather than a filtered result - so the read still fails and the guard still 503s.
  -- Granting EXECUTE does NOT widen what the bot can see: the policy still evaluates and still
  -- filters, and oshal_authorization_applications keeps its operator-only
  -- authorization_control_plane policy. It only lets the policy run instead of erroring.
  -- (oshal_owns_ticket was already granted to oshal_bot; oshal_is_tenant_member was missed.)
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = 'oshal_is_tenant_member') THEN
    BEGIN
      EXECUTE 'GRANT EXECUTE ON FUNCTION public.oshal_is_tenant_member(text) TO oshal_bot';
      RAISE NOTICE 'granted EXECUTE on oshal_is_tenant_member(text) to oshal_bot';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'GRANT EXECUTE on oshal_is_tenant_member skipped - insufficient privilege';
    END;
  END IF;
END
$$;
