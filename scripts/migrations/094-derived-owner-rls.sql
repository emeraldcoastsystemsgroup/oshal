/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-076 Phase 2 — derived-owner RLS for the five table families migration 060 deferred: chat_messages + agent_memories get join-based policies through their NOT NULL task_id FK via a new SECURITY DEFINER helper oshal_owns_task (byte-matches the app-layer JOIN in chat-search-source.ts); knowledge_memory_documents gets a policy mirroring the NULL=shared read filter in memory-layer-service.ts with a stricter WITH CHECK so a non-operator can never mint a shared NULL-owner doc; personal_graph_nodes/edges (empty, store dormant behind PERSONAL_GRAPH_ROUTES) gain a user_sub owner column, a (user_sub,id) PK so deterministic node ids no longer collide across users, user_sub-prefixed indexes, and the standard tier-1 policy hardened with user_sub <> '' so anonymous ''-stamped connections can never match a fail-closed ''-owner row. lm_* stays deferred to the little-monsters store package (Rule 0c; lm identity is not an OIDC sub). Transaction-safe by design: NO top-level BEGIN/COMMIT (the DatabaseBootstrapService runner wraps this file + its history row in ONE transaction) and no CONCURRENTLY.
 */

-- ===========================================================================
-- 094-derived-owner-rls.sql
-- ADR-076 Phase 2 — the DEFERRED block of 060-platform-rls-tenancy.sql.
--
-- WHAT THIS DOES
--   * chat_messages / agent_memories : no owner column, but task_id is a
--     NOT NULL FK -> chat_tasks, which already carries owner_sub + forced RLS.
--     Ownership is DERIVED through that FK with a SECURITY DEFINER helper —
--     no schema change, no backfill. Semantics reproduce the existing
--     app-layer scoping (chat-search-source.ts: JOIN chat_tasks t ON
--     t.task_id = m.task_id AND t.owner_sub = $1) exactly.
--   * knowledge_memory_documents    : owner_sub column already exists
--     (NULL = shared-to-all by design). The policy mirrors the read filter in
--     memory-layer-service.ts (owner_sub IS NULL OR owner_sub = caller), but
--     WITH CHECK deliberately DROPS the IS NULL arm: only a trusted
--     system/operator context may create or retarget shared NULL-owner docs.
--   * personal_graph_nodes / edges  : gain the missing user_sub owner column
--     and a (user_sub, id) PK (node/edge ids are deterministic and WOULD
--     collide across users under the old bare-id PK). Both tables are empty
--     today (store is dormant: server.ts mounts InMemoryGraphStore behind
--     PERSONAL_GRAPH_ROUTES), so the PK swap is free — but the swap still
--     re-checks emptiness at run time and fail-closes any surprise row to the
--     '' owner (operator-only under the policy below).
--   * lm_*                          : intentionally NOT here. Their DDL and
--     writers were carved to the oshal-applications store repo (Rule 0c), and
--     lm identity (lm_students / lm_tenants) is not an OIDC sub, so their RLS
--     ships from the little-monsters package once its identity mapping exists.
--
-- SAFETY
--   Idempotent + re-runnable (DROP POLICY IF EXISTS, ADD COLUMN IF NOT EXISTS,
--   conditional PK swap). Policies are inert for superuser/BYPASSRLS roles and
--   enforce only for the least-privilege oshal_app role (ADR-076). A trusted
--   SYSTEM context (oshal.is_operator = 'on', stamped only inside
--   runWithSystemIdentity) bypasses every policy here.
--
-- TRANSACTIONALITY
--   This file carries NO top-level BEGIN;/COMMIT; and nothing non-transactional
--   (no CONCURRENTLY / VACUUM): the migration runner wraps the whole file in a
--   single transaction, so a mid-file failure can never strand a table with
--   RLS forced but no policy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Task-ownership helper. SECURITY DEFINER so consulting chat_tasks is not
-- re-filtered by chat_tasks' own RLS from within a child-table policy (and so
-- the lookup cannot recurse). Reads the caller from the per-connection GUC the
-- app stamps (guc-pool.ts). Anonymous connections are stamped '' and no
-- chat_task has owner_sub = '', so the helper fails closed for them.
-- search_path pinned per SECURITY DEFINER best practice (mirrors
-- oshal_is_tenant_member in 060).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION oshal_owns_task(p_task text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM chat_tasks t
    WHERE t.task_id = p_task
      AND t.owner_sub = current_setting('oshal.current_sub', true)
  );
$$;

REVOKE ALL ON FUNCTION oshal_owns_task(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oshal_owns_task(text) TO PUBLIC;

-- ===========================================================================
-- chat_messages — owner derived through task_id -> chat_tasks.owner_sub.
-- (task_id is NOT NULL; messages of owner_sub-NULL system tasks are visible
-- to operator/system only — identical to chat_tasks' own policy today.)
-- ===========================================================================
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_messages_task_owner_or_operator ON chat_messages;
CREATE POLICY chat_messages_task_owner_or_operator ON chat_messages
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR oshal_owns_task(task_id)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR oshal_owns_task(task_id)
  );

-- ===========================================================================
-- agent_memories — owner derived through task_id -> chat_tasks.owner_sub.
-- Reads in memory-layer-service.ts are agent-scoped (WHERE agent_id = $1);
-- under a user-identity connection this policy additionally narrows recall to
-- the caller's own tasks. Bot/system prompt-assembly paths run under
-- runWithSystemIdentity (is_operator = 'on') and are unaffected.
-- ===========================================================================
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_memories_task_owner_or_operator ON agent_memories;
CREATE POLICY agent_memories_task_owner_or_operator ON agent_memories
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR oshal_owns_task(task_id)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR oshal_owns_task(task_id)
  );

-- ===========================================================================
-- knowledge_memory_documents — owner_sub exists; NULL = shared (by design).
-- USING mirrors memory-layer-service.ts listKnowledgeDocumentsPersistent:
-- a non-operator sees shared docs plus their own. WITH CHECK is STRICTER: it
-- deliberately omits the owner_sub IS NULL arm so only a trusted
-- system/operator context can mint (or retarget a row into) a shared
-- NULL-owner document — a non-operator forging owner_sub = NULL fails closed.
-- No backfill: every existing row is NULL = shared by design.
--
-- The column itself is created lazily in-app (conversation-schema.ts), which
-- may not have run yet on a FRESH database when this migration applies — so
-- mirror the same idempotent ADD COLUMN here before referencing it.
-- ===========================================================================
ALTER TABLE knowledge_memory_documents ADD COLUMN IF NOT EXISTS owner_sub TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_memory_owner ON knowledge_memory_documents (owner_sub);
ALTER TABLE knowledge_memory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_memory_documents_shared_or_owner ON knowledge_memory_documents;
CREATE POLICY knowledge_memory_documents_shared_or_owner ON knowledge_memory_documents
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub IS NULL
    OR owner_sub = current_setting('oshal.current_sub', true)
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  );

-- ===========================================================================
-- personal_graph_nodes / personal_graph_edges — add the missing owner column
-- and re-point the PK to (user_sub, id): node/edge ids are DETERMINISTIC
-- (person:<email>, attended:<a>->-<b>), so a bare-id PK would collide the
-- moment two users ingest the same person/event. Both tables are verified
-- empty (the Postgres store has never been wired: server.ts uses
-- InMemoryGraphStore), but the block still handles a surprise row by
-- fail-closing it to the '' owner, which no real caller can match (the
-- policy below requires a NON-EMPTY user_sub precisely because anonymous
-- connections are GUC-stamped with current_sub = '').
-- ===========================================================================
DO $pg$
DECLARE
  tbl text;
  n bigint;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['personal_graph_nodes', 'personal_graph_edges'] LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE NOTICE 'derived-owner-rls: skipping absent table % (created by 057; policies apply on re-run)', tbl;
      CONTINUE;
    END IF;

    -- Owner column (fills pre-existing rows with the fail-closed '' owner).
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS user_sub TEXT NOT NULL DEFAULT %L', tbl, '');
    -- Defensive normalization in case the column pre-existed nullable.
    EXECUTE format('UPDATE %I SET user_sub = %L WHERE user_sub IS NULL', tbl, '');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN user_sub SET DEFAULT %L', tbl, '');
    EXECUTE format('ALTER TABLE %I ALTER COLUMN user_sub SET NOT NULL', tbl);

    EXECUTE format('SELECT count(*) FROM %I', tbl) INTO n;
    IF n > 0 THEN
      RAISE NOTICE 'derived-owner-rls: % had % pre-existing row(s); any without an owner were fail-closed to the '''' owner (operator-only)', tbl, n;
    END IF;

    -- Re-point a legacy single-column (bare id) PK to (user_sub, id).
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = ('public.' || tbl)::regclass
        AND contype = 'p'
        AND cardinality(conkey) = 1
    ) THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, tbl || '_pkey');
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY (user_sub, id)', tbl, tbl || '_pkey');
    END IF;
  END LOOP;
END
$pg$;

-- Re-shape the secondary indexes so every lookup path leads with the owner.
DROP INDEX IF EXISTS personal_graph_nodes_type_idx;
CREATE INDEX IF NOT EXISTS personal_graph_nodes_user_type_idx
  ON personal_graph_nodes (user_sub, type);
DROP INDEX IF EXISTS personal_graph_edges_from_idx;
CREATE INDEX IF NOT EXISTS personal_graph_edges_user_from_idx
  ON personal_graph_edges (user_sub, from_id);
DROP INDEX IF EXISTS personal_graph_edges_to_idx;
CREATE INDEX IF NOT EXISTS personal_graph_edges_user_to_idx
  ON personal_graph_edges (user_sub, to_id);
DROP INDEX IF EXISTS personal_graph_edges_type_idx;
CREATE INDEX IF NOT EXISTS personal_graph_edges_user_type_idx
  ON personal_graph_edges (user_sub, type);

-- Standard tier-1 owner policy, hardened with user_sub <> '': guc-pool stamps
-- anonymous/identity-less connections with current_sub = '', so without the
-- non-empty guard a fail-closed ''-owner row would be visible to (and
-- writable by) exactly the callers RLS exists to stop.
ALTER TABLE personal_graph_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_graph_nodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_graph_nodes_owner_or_operator ON personal_graph_nodes;
CREATE POLICY personal_graph_nodes_owner_or_operator ON personal_graph_nodes
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR (user_sub <> '' AND user_sub = current_setting('oshal.current_sub', true))
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR (user_sub <> '' AND user_sub = current_setting('oshal.current_sub', true))
  );

ALTER TABLE personal_graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_graph_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS personal_graph_edges_owner_or_operator ON personal_graph_edges;
CREATE POLICY personal_graph_edges_owner_or_operator ON personal_graph_edges
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR (user_sub <> '' AND user_sub = current_setting('oshal.current_sub', true))
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR (user_sub <> '' AND user_sub = current_setting('oshal.current_sub', true))
  );
