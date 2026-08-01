/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: pg_trgm GIN indexes on the text columns the adapters actually ILIKE (tickets.title/description, chat_tasks.title, chat_messages.text, oshal_connections.provider/account_email). A leading-wildcard ILIKE '%q%' can use NO btree index, so every keystroke was a sequential scan of the whole table; a trigram GIN index is the only index type Postgres can use for that predicate. Transaction-safe by design: no top-level BEGIN/COMMIT (the DatabaseBootstrapService runner wraps this file plus its history row in ONE transaction) and no CONCURRENTLY, which cannot run inside a transaction — acceptable because these are additive index builds on tables that are small at install time and the runner already serializes boot.
 */

-- ===========================================================================
-- 103-global-search-trgm.sql
-- Trigram indexes for /api/search (features/global-search).
--
-- WHY THIS EXISTS
--   Every adapter matches with `col ILIKE '%' || $q || '%' ESCAPE '\'`. A
--   leading wildcard makes a btree index unusable, so the planner had exactly
--   one option on each of these columns: Seq Scan. pg_trgm's GIN operator class
--   (gin_trgm_ops) indexes 3-grams and DOES serve LIKE/ILIKE with wildcards on
--   both sides — it is the only way to index this predicate shape.
--
-- WHICH COLUMNS, AND WHY EXACTLY THESE
--   The set is derived from the adapters, not guessed:
--     tickets.title, tickets.description        -> tickets-search-source.ts
--     chat_tasks.title                          -> chat-search-source.ts (title arm)
--     chat_messages.text                        -> chat-search-source.ts (message arm)
--     oshal_connections.provider, .account_email-> connectors-search-source.ts
--   The apps and bots adapters are NOT here: both match in memory over a
--   registry/catalog of tens of rows with no store round-trip, so an index
--   would be dead weight. The RAG adapter ranks inside ChromaDB/pgvector and
--   never issues an ILIKE. The personal-data vault is owner-key encrypted at
--   rest, so SQL-side text matching is impossible there by construction.
--
-- OWNER-COLUMN COMPANIONS
--   Each adapter's WHERE begins with an equality on the owner column, and the
--   planner is free to satisfy that first and never touch the trigram index.
--   The owner-column btrees below make that cheap path cheap. They are the
--   isolation-critical half: a search must stay owner-scoped whichever plan
--   wins.
--
-- SAFETY
--   Fully idempotent (CREATE EXTENSION IF NOT EXISTS / CREATE INDEX IF NOT
--   EXISTS) and re-runnable. Tables absent on a partial install are skipped by
--   the to_regclass guards rather than failing the boot — oshal_connections and
--   the chat tables are created by runtime schema bootstrap, not by a numbered
--   migration, so they may legitimately not exist yet the first time this runs.
--   Nothing here is destructive and nothing rewrites a row.
--
-- MEASURING THE EFFECT
--   scripts/measure-global-search-latency.js records before/after timings
--   against a live database (it can drop and rebuild these indexes on a scratch
--   DB). The measured numbers live in
--   docs/architecture/global-search-deep-link-contract.md.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
BEGIN
  -- ── tickets: title + description (tickets-search-source.ts) ──────────────
  IF to_regclass('public.tickets') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_tickets_title_trgm
      ON tickets USING gin (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_tickets_description_trgm
      ON tickets USING gin (description gin_trgm_ops);
    -- Owner-first path: the adapter pins owner_sub before it ever matches text.
    CREATE INDEX IF NOT EXISTS idx_tickets_owner_sub_updated
      ON tickets (owner_sub, updated_at DESC);
  END IF;

  -- ── chat_tasks: title (chat-search-source.ts title arm) ──────────────────
  IF to_regclass('public.chat_tasks') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_chat_tasks_title_trgm
      ON chat_tasks USING gin (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_chat_tasks_owner_sub_updated
      ON chat_tasks (owner_sub, updated_at DESC);
  END IF;

  -- ── chat_messages: text (chat-search-source.ts message arm) ──────────────
  -- chat_messages carries no owner column: message hits are only ever reached
  -- through an INNER JOIN to the caller's own chat_tasks (migration 094 makes
  -- that derivation an RLS policy too). The task_id index is what keeps that
  -- join cheap once the trigram index has narrowed the text side.
  IF to_regclass('public.chat_messages') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_chat_messages_text_trgm
      ON chat_messages USING gin (text gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_task_id_created
      ON chat_messages (task_id, created_at DESC);
  END IF;

  -- ── oshal_connections: provider + account_email (connectors adapter) ─────
  -- Token columns are deliberately NOT indexed and never read by search.
  IF to_regclass('public.oshal_connections') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_oshal_connections_provider_trgm
      ON oshal_connections USING gin (provider gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_oshal_connections_account_email_trgm
      ON oshal_connections USING gin (account_email gin_trgm_ops);
  END IF;
END
$$;

-- Fresh statistics so the planner can actually choose the new indexes on the
-- first search after boot instead of after the next autovacuum cycle. ANALYZE
-- is transaction-safe (unlike VACUUM), so it stays inside the runner's wrapper.
DO $$
BEGIN
  IF to_regclass('public.tickets') IS NOT NULL THEN EXECUTE 'ANALYZE tickets'; END IF;
  IF to_regclass('public.chat_tasks') IS NOT NULL THEN EXECUTE 'ANALYZE chat_tasks'; END IF;
  IF to_regclass('public.chat_messages') IS NOT NULL THEN EXECUTE 'ANALYZE chat_messages'; END IF;
  IF to_regclass('public.oshal_connections') IS NOT NULL THEN EXECUTE 'ANALYZE oshal_connections'; END IF;
END
$$;
