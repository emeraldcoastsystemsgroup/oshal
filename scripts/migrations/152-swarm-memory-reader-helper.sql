/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Durable swarm-memory recall for a bot node, as a derived SECURITY DEFINER helper instead of a table grant. oshal_bot has no privilege on oshal_swarm_memory at all, so every recall on a bot node threw permission denied inside the query's own catch and the bot ran with zero memory. A plain GRANT was the wrong repair: the table's only policy keys on a transaction-local broker marker with no owner predicate, so any caller that can set the marker sees every owner's rows. This helper puts the row rule in the database - shared memories, plus the reader's own - and returns the exact seventeen columns the recall path maps, so the bot gets the rows and never the table. No top-level BEGIN/COMMIT: the runner owns the transaction (tests/unit/migration-transactionality.spec.ts).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The helper answers for EVERY id that exists, carrying a `readable` marker, because returning only the permitted rows made a withheld row indistinguishable from a memory with no ledger row at all - and the recall path lets a missing row through. A withheld row therefore fell out of the answer, hit the missing-row arm and was returned on the strength of its indexed metadata: fail-open on an authorization check. The marker makes the three states distinct at the source. A withheld row carries its identifier and nothing else, so the bot still receives no content it may not see.
 */

-- =============================================================================
-- Migration 152: durable swarm-memory recall, derived for the bot contract
--
-- THE QUESTION
--   "Of these work items, which durable memories may this reader see, and which
--   are being withheld from it?" The recall path asks it once per execution
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
-- WHY IT REPORTS WITHHELD ROWS INSTEAD OF OMITTING THEM
--   The caller's missing-row behaviour is to let the memory through: a vector
--   hit with no ledger row is returned as `untrusted` rather than dropped. So
--   a helper that answered with the permitted rows ALONE made "withheld" look
--   exactly like "no such row", and a memory this reader is forbidden to see
--   came back anyway, judged only by the metadata stored in the vector index -
--   which is a copy, not the authority, and drifts the moment a memory's
--   visibility or owner changes. Three states have to be three answers:
--
--     row exists and this reader may see it   -> the row, readable = TRUE
--     row exists and is withheld              -> the id only, readable = FALSE
--     no row exists at all                    -> no row in the answer
--
--   The withheld answer carries the work item id and NULL in every other
--   column. The id is one the caller supplied in p_work_item_ids and already
--   holds from its own retrieval, so acknowledging the row tells it nothing it
--   did not know, while withholding every attribute keeps the content, the
--   owner and the provenance outside the bot's reach.
--
--   Two alternatives were rejected. A second helper acting as an existence
--   probe assembles the answer from two statements and therefore two snapshots
--   under READ COMMITTED, so a row inserted or deleted between them yields a
--   combination the database was never in and puts the ambiguous case back;
--   it also needs a second EXECUTE grant and a second copy of the owner
--   predicate that can drift from this one. Raising instead of returning is
--   worse: a recall asks about a whole batch, mixed permitted-and-withheld
--   batches are the ordinary case, and the exception would land in
--   queryRelevant's own catch, which returns an empty list and logs a warning -
--   indistinguishable from the permission denied this migration exists to fix.
--
--   The column list is the seventeen the recall path maps (SwarmMemoryRow) plus
--   the marker, so the helper's output is auditable and does not follow the
--   table's rowtype. A NULL or empty reader subject yields shared memories only
--   and withholds the rest: fail closed, never an error that a catch would
--   swallow into "no memory".
--
-- GRANTS
--   REVOKE ALL FROM PUBLIC, then EXECUTE to PUBLIC - exactly what 113 and 142
--   do - so a deployment that never runs the role provisioner keeps working.
--   The provisioner's final phase narrows EXECUTE to oshal_app and oshal_bot
--   and verifies owner, search_path and ACL on every boot. The argument types
--   are unchanged, so no grant moves.
-- =============================================================================

-- The marker is a new OUT column, and a return type cannot be changed in place.
-- Dropping first keeps this file re-runnable; the grants below are re-applied
-- immediately and the provisioner re-converges them on every api boot.
DROP FUNCTION IF EXISTS oshal_swarm_memory_readable(text[], text);

CREATE FUNCTION oshal_swarm_memory_readable(p_work_item_ids text[], p_reader_sub text)
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
    indexed_at timestamptz,
    readable boolean
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  WITH present AS (
    SELECT m.*,
           (
             m.visibility = 'shared'
             OR (p_reader_sub IS NOT NULL AND p_reader_sub <> ''
                 AND m.owner_sub IS NOT NULL AND m.owner_sub = p_reader_sub)
           ) AS is_readable
      FROM oshal_swarm_memory m
     WHERE m.work_item_id = ANY(COALESCE(p_work_item_ids, ARRAY[]::text[]))
  )
  SELECT p.work_item_id, p.title, p.document, p.content_sha256, p.owner_sub, p.tenant_id,
         p.workspace_id, p.visibility, p.trust_level, p.source, p.created_by_workload,
         p.approved_by_sub, p.approval_content_sha256, p.validation_method,
         p.validation_evidence_sha256, p.metadata, p.indexed_at, TRUE
    FROM present p
   WHERE p.is_readable
  UNION ALL
  -- Withheld: the identifier the caller already supplied, and nothing else.
  SELECT p.work_item_id, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
         NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
         NULL::text, NULL::text, NULL::text, NULL::jsonb, NULL::timestamptz, FALSE
    FROM present p
   WHERE NOT p.is_readable;
$$;

REVOKE ALL ON FUNCTION oshal_swarm_memory_readable(text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_swarm_memory_readable(text[], text) TO PUBLIC;
