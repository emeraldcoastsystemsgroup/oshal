-- =============================================================================
-- 070-rag-chunks-pgvector.sql
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com
-- ADR-091: RAG chunks move into Postgres. One table, both retrieval legs indexed:
-- dense vectors (pgvector HNSW, cosine) + lexical FTS (GENERATED tsvector, GIN).
-- `collection` stays a plain name so every existing RagService caller maps 1:1.
-- RLS mirrors the platform arms: unowned rows are the shared corpus (everything
-- today); owner/operator arms activate when rows are ever stamped.
--
-- DEFENSIVE: on a deployment whose postgres image lacks the vector extension
-- (stock postgres instead of pgvector/pgvector), this migration SKIPS with a
-- NOTICE instead of failing boot — the api's pgvector engine feature-detects the
-- missing table and RAG stays on the chroma engine untouched.
-- =============================================================================

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE NOTICE 'pgvector extension unavailable on this postgres image — skipping rag_chunks (RAG stays on the chroma engine)';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE IF NOT EXISTS rag_chunks (
    chunk_id    TEXT PRIMARY KEY,
    collection  TEXT NOT NULL,
    document    TEXT NOT NULL,
    embedding   vector(384),
    fts         tsvector GENERATED ALWAYS AS (to_tsvector('english', document)) STORED,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    owner_sub   TEXT,
    tenant_id   UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS rag_chunks_collection_idx ON rag_chunks (collection);
  CREATE INDEX IF NOT EXISTS rag_chunks_fts_idx ON rag_chunks USING gin (fts);
  -- NULL embeddings (embedder unavailable at ingest) are simply absent from HNSW.
  CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx ON rag_chunks USING hnsw (embedding vector_cosine_ops);

  ALTER TABLE rag_chunks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rag_chunks FORCE ROW LEVEL SECURITY;

  -- Unowned rows = shared corpus (public read); owned rows follow the GUC identity.
  -- current_setting(..., true) returns NULL when the GUC is unset (identity-less
  -- internal pools), so only the unowned arm passes there — fail-closed for owned rows.
  DROP POLICY IF EXISTS rag_chunks_read ON rag_chunks;
  CREATE POLICY rag_chunks_read ON rag_chunks FOR SELECT USING (
    owner_sub IS NULL
    OR current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  );

  DROP POLICY IF EXISTS rag_chunks_write ON rag_chunks;
  CREATE POLICY rag_chunks_write ON rag_chunks FOR ALL USING (
    owner_sub IS NULL
    OR current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  ) WITH CHECK (
    owner_sub IS NULL
    OR current_setting('oshal.is_operator', true) = 'on'
    OR owner_sub = current_setting('oshal.current_sub', true)
  );

  -- The app role may not exist yet on a truly fresh bootstrap (provisioned after
  -- migrations) — grant when present; provision-app-role covers the fresh path.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rag_chunks TO oshal_app;
  END IF;
END
$mig$;
