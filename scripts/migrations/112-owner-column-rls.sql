/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-124 (ADR-035/076 residual, RLS Phase 2): forces owner-or-operator RLS on nine CORE tables that already carried an owner column and were simply never walled. A live inventory of the running database found 114 of 282 public tables with RLS switched OFF entirely — the BACKLOG residual list (personal_graph_*, chat_messages, agent_memories, knowledge_memory_documents) was closed by migration 094 and had been stale for a month, while these nine never appeared on any list. Eight of the nine have a NOT NULL owner column with zero NULL rows, so no backfill exists to get wrong; oshal_cost_events.owner_sub is nullable and is walled with the SAME policy its already-forced sibling chat_tasks has carried in production since 060. Deliberately EXCLUDED (enumerated with done-whens in ADR-124): oshal_trading_daily_equity / oshal_trading_strategy_journal (host CLIs read them over the oshal_app DSN with no GUC stamp) and pumpkin_presets / pumpkin_settings / kalshi_orders (store-package readers on device/service auth). Guards: tests/rls-core-table-coverage-live.spec.ts, tests/rls-two-role-isolation-live.spec.ts.
 */

-- ===========================================================================
-- 112-owner-column-rls.sql
-- ADR-035 / ADR-076 Phase 2 — wall the CORE tables that already have an owner.
--
-- WHAT THIS DOES
--   Applies the canonical `<table>_owner_or_operator` policy — byte-identical to
--   src/shared/services/database/owner-rls-policy.ts buildOwnerRlsPolicyStatements
--   and to docs/governance/rls-policies-enforce.sql — to nine tables that hold
--   per-user rows behind an owner column but were never ENABLEd for RLS:
--
--     table                          owner col   rows  NULL owners
--     ----------------------------   ---------   ----  -----------
--     channel_link_codes             user_sub       2            0
--     channel_links                  user_sub       0            0
--     connector_action_audit         user_sub       0            0
--     linkedin_profile_plans         user_sub       0            0
--     social_content_drafts          user_sub       0            0
--     user_notification_prefs        user_sub       0            0
--     voice_user_prefs               user_sub       0            0
--     oshal_trading_rotation_state   user_sub       2            0
--     oshal_cost_events              owner_sub   2332           87
--
--   (counts observed on the live 2026-08-02 stack; they are context for the
--   backfill decision below, not an assertion the migration makes.)
--
-- BACKFILL — THE HONEST ANSWER
--   Eight of the nine declare their owner column NOT NULL, and a live count
--   confirmed zero NULL and zero empty-string owners. There is nothing to
--   backfill and nothing to guess: every existing row already names its owner.
--
--   oshal_cost_events is the exception and is handled DELIBERATELY, not
--   silently. Its owner_sub is nullable and 87 of 2332 rows carry NULL. Those
--   NULLs are NOT derivable: every one of them belongs to a chat_tasks row whose
--   own owner_sub is also NULL (checked — the resolvable count is exactly 0), so
--   there is no join that recovers an owner and no defensible system owner to
--   attribute 87 rows of real spend to. They are therefore LEFT NULL, which
--   under the policy below makes them visible to operator/system context only.
--   That is the same disposition chat_tasks has given its own 1869 NULL-owner
--   rows since migration 060 — this table is that table's per-event projection,
--   so matching it keeps the two ledgers consistent instead of inventing a third
--   rule. Attributing them to a synthetic owner would have been a guess written
--   into a cost ledger; denying them by default is the fail-closed answer.
--
-- WHY THESE NINE AND NOT THE OTHER FIVE OWNER-COLUMN TABLES
--   Walling a table breaks any reader that cannot present an identity. Two
--   groups genuinely cannot yet, so forcing them here would be an outage, not a
--   hardening. Both are enumerated with done-when criteria in ADR-124:
--     * oshal_trading_daily_equity, oshal_trading_strategy_journal — read by
--       host CLIs (site-oshal-report.js, oshal-deck-data.js, oshal-report-journal.js,
--       oshal-strategy-journal.js) that open a raw pg Pool on DATABASE_URL. The
--       operator DSN is oshal_app: NOSUPERUSER, NOBYPASSRLS. None of the 43
--       raw-pool scripts stamps oshal.current_sub / oshal.is_operator, so all of
--       them would read zero rows and the daily report would go silently empty.
--     * pumpkin_presets, pumpkin_settings, kalshi_orders — core-migrated tables
--       (084 / 074) whose only remaining readers are STORE packages reached over
--       device or service auth, where no caller sub is established today.
--
-- SAFETY
--   * Idempotent + re-runnable: create-if-absent (never drop/recreate), so a
--     re-run never opens a window with RLS forced and no policy.
--   * Fresh-database tolerant: a table that does not exist yet is skipped with a
--     NOTICE rather than aborting the migration chain (the 060 lesson — one abort
--     there left EVERY later table policy-less).
--   * Inert for superuser / BYPASSRLS roles; enforces for oshal_app (api) and
--     oshal_bot (bot nodes, migration 099). Trusted background work runs under
--     runWithSystemIdentity => oshal.is_operator='on' and is never starved.
--   * connector_action_audit keeps its append-only triggers
--     (trg_connector_action_audit_no_mutate / _no_truncate); an RLS policy is an
--     additional filter and cannot relax them.
--   * Grants are untouched. This migration does not create, alter, or grant to
--     any role — oshal_bot's least-privilege shape from 099 is left exactly as is.
--
-- TRANSACTIONALITY
--   No top-level BEGIN;/COMMIT; and nothing non-transactional: the
--   DatabaseBootstrapService runner wraps this file plus its ledger row in ONE
--   transaction, so a mid-file failure cannot strand a table forced-but-policyless.
--
-- ROLLBACK (break-glass, per table):
--   ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;
-- ===========================================================================

DO $$
DECLARE
  spec   RECORD;
  policy TEXT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('channel_link_codes',           'user_sub'),
      ('channel_links',                'user_sub'),
      ('connector_action_audit',       'user_sub'),
      ('linkedin_profile_plans',       'user_sub'),
      ('social_content_drafts',        'user_sub'),
      ('user_notification_prefs',      'user_sub'),
      ('voice_user_prefs',             'user_sub'),
      ('oshal_trading_rotation_state', 'user_sub'),
      ('oshal_cost_events',            'owner_sub')
    ) AS t(tbl, owner_col)
  LOOP
    -- Fresh-DB tolerance: skip a table this deployment has not created yet.
    IF to_regclass('public.' || spec.tbl) IS NULL THEN
      RAISE NOTICE '112: % absent — skipped (lazy DDL will apply the same policy via buildOwnerRlsPolicyStatements)', spec.tbl;
      CONTINUE;
    END IF;

    -- Refuse to wall a table whose owner column is not actually there: a silent
    -- rename would otherwise produce a policy that denies every row forever.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = spec.tbl AND column_name = spec.owner_col
    ) THEN
      RAISE EXCEPTION '112: %.% is missing — refusing to force RLS on a table with no owner column', spec.tbl, spec.owner_col;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', spec.tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', spec.tbl);

    policy := spec.tbl || '_owner_or_operator';
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polname = policy AND polrelid = ('public.' || spec.tbl)::regclass
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL'
        || ' USING (%I = current_setting(''oshal.current_sub'', true)'
        || '        OR current_setting(''oshal.is_operator'', true) = ''on'')'
        || ' WITH CHECK (%I = current_setting(''oshal.current_sub'', true)'
        || '        OR current_setting(''oshal.is_operator'', true) = ''on'')',
        policy, spec.tbl, spec.owner_col, spec.owner_col);
      RAISE NOTICE '112: forced RLS on % (owner %)', spec.tbl, spec.owner_col;
    END IF;
  END LOOP;
END $$;
