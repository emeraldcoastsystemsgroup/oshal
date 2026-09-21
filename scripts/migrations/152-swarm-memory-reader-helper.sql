/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Durable swarm-memory recall for a bot node, as a derived SECURITY DEFINER helper instead of a table grant. oshal_bot has no privilege on oshal_swarm_memory at all, so every recall on a bot node threw permission denied inside the query's own catch and the bot ran with zero memory. A plain GRANT was the wrong repair: the table's only policy keys on a transaction-local broker marker with no owner predicate, so any caller that can set the marker sees every owner's rows. This helper puts the row rule in the database - shared memories, plus the reader's own - and returns the exact seventeen columns the recall path maps, so the bot gets the rows and never the table. No top-level BEGIN/COMMIT: the runner owns the transaction (tests/unit/migration-transactionality.spec.ts).
 */

-- =============================================================================
-- Migration 152: durable swarm-memory recall, derived for the bot contract
--
-- THE QUESTION
--   "Of these work items, which durable memories may this reader see?" The
--   recall path asks it once per execution
--   (src/features/agent-management/services/swarm-memory-service.ts,
--   bindDurableTrust) to bind each retrieved memory to its recorded trust
--   level before the prompt is assembled.
--
-- WHY THE BOT COULD NOT ANSWER IT
--   oshal_swarm_memory is outside the governed bot contract entirely:
--   has_table_privilege('oshal_bot', 'public.oshal_swarm_memory', 'SELECT') is
--   false and there is no column grant either. The read sits inside a catch
--   that returns an empty list, so the refusal surfaced as one warning and a
--   bot with no memory rather than an error anyone chased.
--
-- WHY NOT JUST GRANT SELECT
--   The table is ENABLE + FORCE row-level security with exactly one policy,
--   oshal_swarm_memory_ledger_broker (migration 117), whose USING and WITH
--   CHECK are both `current_setting('oshal.swarm_memory_ledger_broker', true)
--   = 'on'`. No owner column appears in it. The marker is required of every
--   caller - and it is also all that is required, of any caller. Granting
--   SELECT would move the bot from "reads nothing" to "reads every owner's
--   memories", with the per-user decision resting entirely on an application
--   filter. The database would still not be enforcing anything.
--
-- THE FIX, IN THE CONTRACT'S OWN PATTERN
--   The same shape as oshal_owns_ticket (113) and
--   oshal_application_execution_claims (142): a SECURITY DEFINER helper that
--   returns the derived answer and nothing else. The owner rule lives here, in
--   SQL, so a bot cannot read another owner's memory even if the application
--   filter above it were removed. A shared memory is readable by anyone - that
--   is what `visibility = 'shared'` means, and migration 117's CHECK
--   constraint already forces such a row to carry no owner, tenant or
--   workspace and to be trust_level 'approved'.
--
--   The column list is the seventeen the recall path maps (SwarmMemoryRow), so
--   the helper's output is auditable and does not follow the table's rowtype.
--   A NULL or empty reader subject yields shared memories only: fail closed,
--   never an error that a catch would swallow into "no memory".
--
-- GRANTS
--   REVOKE ALL FROM PUBLIC, then EXECUTE to PUBLIC - exactly what 113 and 142
--   do - so a deployment that never runs the role provisioner keeps working.
--   The provisioner's final phase narrows EXECUTE to oshal_app and oshal_bot
--   and verifies owner, search_path and ACL on every boot.
-- =============================================================================

CREATE OR REPLACE FUNCTION oshal_swarm_memory_readable(p_work_item_ids text[], p_reader_sub text)
  RETURNS TABLE (
    work_item_id text,
    title text,
    document text,
    content_sha256 text,
    owner_sub text,
    tenant_id text,
    workspace_id text,
    visibility text,
    trust_level text,
    source text,
    created_by_workload text,
    approved_by_sub text,
    approval_content_sha256 text,
    validation_method text,
    validation_evidence_sha256 text,
    metadata jsonb,
    indexed_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT m.work_item_id, m.title, m.document, m.content_sha256, m.owner_sub, m.tenant_id,
         m.workspace_id, m.visibility, m.trust_level, m.source, m.created_by_workload,
         m.approved_by_sub, m.approval_content_sha256, m.validation_method,
         m.validation_evidence_sha256, m.metadata, m.indexed_at
    FROM oshal_swarm_memory m
   WHERE m.work_item_id = ANY(COALESCE(p_work_item_ids, ARRAY[]::text[]))
     AND (
       m.visibility = 'shared'
       OR (p_reader_sub IS NOT NULL AND p_reader_sub <> ''
           AND m.owner_sub IS NOT NULL AND m.owner_sub = p_reader_sub)
     );
$$;

REVOKE ALL ON FUNCTION oshal_swarm_memory_readable(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_swarm_memory_readable(text[], text) TO PUBLIC;
