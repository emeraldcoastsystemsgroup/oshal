/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-124 (ADR-035/076 residual, RLS Phase 2): derived-owner RLS for the five child tables that hang off an already-walled parent and were left readable by every non-superuser connection. tickets has carried owner_sub + FORCE RLS since 060, but its four children did not — ticket_status_history alone held 83305 rows of who-changed-what across 417 distinct owners, fully readable by any oshal_bot connection. Ownership is DERIVED through the NOT NULL ticket_id FK by a new SECURITY DEFINER helper oshal_owns_ticket, the exact pattern 094 established with oshal_owns_task for chat_messages; task_checkpoints reuses oshal_owns_task itself. No schema change and no backfill: every row already points at a parent whose owner is authoritative. Guards: tests/rls-core-table-coverage-live.spec.ts, tests/rls-two-role-isolation-live.spec.ts.
 */

-- ===========================================================================
-- 113-derived-owner-rls-ticket-family.sql
-- ADR-035 / ADR-076 Phase 2 — derived-owner RLS for already-parented children.
--
-- WHAT THIS DOES
--   Five tables hold per-user data but have no owner column of their own. Each
--   has a NOT NULL foreign key to a table that IS walled, so ownership is a
--   lookup, not a schema change:
--
--     table                       key            parent      parent owner
--     -------------------------   ------------   ---------   ------------
--     ticket_status_history       ticket_id      tickets     owner_sub
--     ticket_agent_assignments    ticket_id      tickets     owner_sub
--     ticket_task_links           ticket_id      tickets     owner_sub
--     ticket_workspace_links      ticket_id      tickets     owner_sub
--     task_checkpoints            task_id        chat_tasks  owner_sub
--
--   This is 094's pattern, not a new one. 094 added oshal_owns_task(text) and
--   pointed chat_messages / agent_memories at it; this file adds the ticket-side
--   twin oshal_owns_ticket(uuid) and points the four ticket children at it, then
--   reuses oshal_owns_task unchanged for task_checkpoints.
--
-- WHY SECURITY DEFINER
--   An inline `EXISTS (SELECT 1 FROM tickets ...)` inside a child policy would be
--   re-filtered by tickets' OWN policy while that policy is being evaluated —
--   the recursion 060's oshal_is_tenant_member and 094's oshal_owns_task both
--   avoid the same way. The helper is STABLE, does a primary-key lookup, and
--   reads the caller only from the per-connection GUC the app stamps.
--
-- BACKFILL — THE HONEST ANSWER
--   None is needed or possible: these tables carry no owner column to fill.
--   The derived answer is only ever as good as the parent's, and the parent's
--   NULLs are inherited deliberately:
--     * 71 of 3355 tickets have owner_sub NULL, and 9841 ticket_status_history
--       rows hang off them. Those 9841 become operator/system-visible only.
--       That is NOT a new denial — those 71 tickets are ALREADY invisible to
--       non-operators under tickets' own policy, so the child now agrees with
--       the parent instead of leaking around it.
--     * 1869 of the chat_tasks rows have owner_sub NULL; their checkpoints
--       follow the same rule, matching chat_messages under 094.
--     * Zero orphans exist in either direction (checked live: 0 status-history
--       rows without a ticket, 0 checkpoints without a task), so no row is
--       stranded by a dangling key.
--
-- WHAT THIS DELIBERATELY DOES NOT WALL (enumerated with done-whens in ADR-124)
--   * ticket_governance — its ticket_id is TEXT and only 69 of 215 rows still
--     match a live ticket; the other 146 are orphaned queue-manager state whose
--     parent was deleted. A derived policy would hide two thirds of the table
--     from the ops read surface, and that surface
--     (any-bot/.../routes-ops-observability.js) is being changed in another lane
--     tonight. Wall it after the orphans are reaped, not before.
--   * work_items / swarm_runs / swarm_escalations / subtask_lifecycle_* — checked
--     for a derivable parent and there is none: work_items.external_id matches
--     ZERO tickets (0 of 298) and its swarm_run_id resolves only to swarm_runs,
--     which itself has no owner. These are swarm machinery, not user rows.
--
-- SAFETY
--   * Idempotent + re-runnable (CREATE OR REPLACE FUNCTION, DROP POLICY IF EXISTS
--     then CREATE, ALTER TABLE ... ENABLE/FORCE are no-ops when already set).
--   * Fresh-database tolerant: absent tables are skipped with a NOTICE.
--   * Inert for superuser / BYPASSRLS roles; enforces for oshal_app and oshal_bot.
--     Trusted background work (queue manager, schedulers, bot runtimes) runs under
--     runWithSystemIdentity => oshal.is_operator='on' and is never starved.
--   * Referential-integrity actions bypass row security in Postgres, so the
--     existing ON DELETE CASCADE from tickets keeps working unchanged.
--   * Grants are untouched. No role is created, altered, or granted to here.
--
-- TRANSACTIONALITY
--   No top-level BEGIN;/COMMIT; and nothing non-transactional — the
--   DatabaseBootstrapService runner wraps this file plus its ledger row in ONE
--   transaction.
--
-- ROLLBACK (break-glass, per table):
--   DROP POLICY IF EXISTS <t>_ticket_owner_or_operator ON <t>;
--   ALTER TABLE <t> NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Ticket-ownership helper — the uuid twin of 094's oshal_owns_task(text).
-- SECURITY DEFINER so consulting tickets is not re-filtered by tickets' own RLS
-- from inside a child policy (and cannot recurse). Anonymous connections are
-- stamped '' and no ticket has owner_sub = '', so it fails closed for them; a
-- ticket with owner_sub NULL never equals any stamped sub, so it too fails
-- closed and stays operator/system-only. search_path pinned per SECURITY
-- DEFINER practice (mirrors oshal_is_tenant_member in 060).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oshal_owns_ticket(p_ticket uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM tickets t
    WHERE t.ticket_id = p_ticket
      AND t.owner_sub = current_setting('oshal.current_sub', true)
  );
$$;

REVOKE ALL ON FUNCTION oshal_owns_ticket(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_owns_ticket(uuid) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- The four ticket children: owner derived through ticket_id -> tickets.owner_sub.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl    TEXT;
  policy TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'ticket_status_history',
    'ticket_agent_assignments',
    'ticket_task_links',
    'ticket_workspace_links'
  ] LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE '113: % absent — skipped', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);

    policy := tbl || '_ticket_owner_or_operator';
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy, tbl);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL'
      || ' USING (current_setting(''oshal.is_operator'', true) = ''on'''
      || '        OR oshal_owns_ticket(ticket_id))'
      || ' WITH CHECK (current_setting(''oshal.is_operator'', true) = ''on'''
      || '        OR oshal_owns_ticket(ticket_id))',
      policy, tbl);
    RAISE NOTICE '113: forced derived-owner RLS on % (via tickets.owner_sub)', tbl;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- task_checkpoints — owner derived through task_id -> chat_tasks.owner_sub,
-- reusing 094's oshal_owns_task verbatim so checkpoints and the messages of the
-- same task can never disagree about who owns them.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.task_checkpoints') IS NULL THEN
    RAISE NOTICE '113: task_checkpoints absent — skipped';
    RETURN;
  END IF;

  ALTER TABLE public.task_checkpoints ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.task_checkpoints FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS task_checkpoints_task_owner_or_operator ON public.task_checkpoints;
  CREATE POLICY task_checkpoints_task_owner_or_operator ON public.task_checkpoints
    AS PERMISSIVE FOR ALL
    USING (
      current_setting('oshal.is_operator', true) = 'on'
      OR oshal_owns_task(task_id)
    )
    WITH CHECK (
      current_setting('oshal.is_operator', true) = 'on'
      OR oshal_owns_task(task_id)
    );
  RAISE NOTICE '113: forced derived-owner RLS on task_checkpoints (via chat_tasks.owner_sub)';
END $$;
