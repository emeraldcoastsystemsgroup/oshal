# ADR-091 - Move the RAG engine to pgvector + tsvector in the existing Postgres

- **Status:** Accepted - **engine SHIPPED + live-proven 2026-07-12**: `RAG_ENGINE=pgvector` on the
  local stack (db image `pgvector/pgvector:pg16`, migration 070, all 12 collections reingested -
  demo textbooks fully vectorised), hybrid-rrf verified end-to-end including the LM tutor. The
  chroma path + container are RETAINED for the soak; their removal is the one outstanding
  done-when item. (Step 1 - local-embedding hybrid on Chroma - shipped earlier the same day.)
- **Date:** 2026-07-12
- **Author:** maintainer@emeraldcoastsystemsgroup.com
- **Related:** [ADR-045 (graph extension - the engine-agnostic connector pattern this copies)](045-two-tier-graph-database-and-connector.md),
  [ADR-085 (app packages - little-monsters' per-class textbook collections are the first consumer)](085-remote-app-packages-and-registries.md)

---

## Context

### What retrieval actually was until 2026-07-12

The stack ran ChromaDB 0.4.24 as a dedicated container. The TypeScript `RagService`
talks to it over REST - a path on which **nothing ever computed embeddings**: documents
were added embedding-less, `POST /query` with `query_texts` 422s on this version, and
every search silently fell back to a hand-rolled BM25 over a **full-collection `/get`**.
Chroma was effectively a JSON document store plus an extra container, and CLAUDE.md's
"server-side embedding" description held only for the Python-client seeding scripts.

Step 1 (shipped the same day) fixed retrieval quality on the existing engine: `RagService`
computes MiniLM embeddings locally (transformers.js, WASM, fully local/free), stores
them on ingest, runs vector + BM25 in parallel, and fuses by reciprocal rank. Fail-open:
any vector failure degrades to lexical.

### Why the engine itself was still wrong

1. **A whole container for what Postgres does natively.** `pgvector` (dense vectors,
   HNSW) + `tsvector` (lexical FTS) cover hybrid retrieval inside the Postgres that
   already holds every other piece of OSHAL state. One fewer service to boot, health-check,
   back up, and reason about (`oshal-up.sh` ordering, the localhost-wedge class of bugs).
2. **Isolation by naming convention.** Chroma collections (`lm-cls-<8>-stu-<8>`,
   `lm-class-<uuid>-textbook`) are isolated only by string names - invisible to the
   RLS/tenancy model that guards the rest of the platform (ADR-060/-042). In Postgres,
   RAG rows sit behind the same GUC-stamped RLS policies as everything else.
3. **Operational drift.** Chroma 0.4.24 is pinned-old (its v2 REST API 404s); upgrading
   means a REST-API rewrite anyway - the migration effort is owed either way.
4. **Consistency.** Book/material rows (e.g. `lm_materials`) live in Postgres while
   their chunks live in Chroma: deletes/uninstalls can orphan one side. One engine makes
   chunk lifecycle transactional with the owning rows.

## Decision

1. **`RagService` selects an engine behind `RAG_ENGINE=chroma|pgvector`** (default
   `chroma`). The public surface (`ingest / search / searchAllCollections /
   ensureCollection / deleteCollection`, permission contexts, chunking, local
   embeddings) does not change; callers never know the engine. As-built note: the
   chroma code stays in place inside `rag-service.ts` and the pgvector path lives in
   `pgvector-rag-engine.ts`; the formal port-interface extraction rides the eventual
   Chroma removal rather than churning the soak baseline.
2. **Schema (migration 070):** one `rag_chunks` table -
   `(chunk_id, collection, document, embedding vector(384), fts tsvector GENERATED,
   metadata jsonb, owner_sub, tenant_id, created_at)` - with an HNSW cosine index on
   `embedding`, a GIN index on `fts`, and a b-tree on `collection`. "Collection" stays a
   name so every existing caller maps 1:1. RLS: unowned rows are the shared corpus;
   owner/operator arms activate when rows are stamped. DEFENSIVE: the migration skips
   with a NOTICE on a postgres image without the vector extension, so stock deployments
   keep booting and stay on chroma (the engine feature-detects and falls back, sticky).
3. **Hybrid retrieval:** vector KNN and FTS run as two INDEXED queries fused by the
   shared `hybrid-fusion.ts` RRF helper - the same fusion codepath as the chroma
   engine, so ranking semantics are engine-independent. The lexical leg tries
   `websearch_to_tsquery` (AND) first and falls back to OR-joined terms so long
   natural-language questions keep BM25-parity any-term matching. (Single-SQL-statement
   fusion remains a later optimization.)
4. **Embeddings stay local** (MiniLM via the step-1 `local-embedding-service`), with
   BYOK API embeddings as an optional upgrade - never the default (self-host ethos).
   NUL bytes are stripped before insert (pdf-parse emits 0x00; Postgres TEXT rejects it).
5. **Migration executed strangler-fig:** `RAG_ENGINE` defaults to `chroma` in code; the
   local stack opts into `pgvector` (compose). `scripts/rag-reingest-pgvector.js` copied
   every Chroma collection (ids, documents, metadatas, existing embeddings) into
   `rag_chunks`, resilient to Chroma 0.4's IndexError on `include:embeddings` for
   vectorless collections. The Chroma container stays until the soak completes.

## Consequences

- One fewer container (after soak); RAG data inherits backup, RLS, and tenancy; chunk
  lifecycle becomes transactional with owning rows (class uninstall can delete its chunks).
- **The db image is now `pgvector/pgvector:pg16` (glibc) where `postgres:16-alpine` was
  musl - collation implementations differ, so the swap required a one-time
  `REINDEX DATABASE` + collation-version stamp (done 2026-07-12). Never flip back to
  an -alpine postgres image without the same reindex treatment.**
- `vector(384)` pins the embedding model dimension - changing models means a reindex
  column migration (acceptable; reingest scripts exist).
- The RAG-as-skill boundary (ADR-090 kernel-skills) is unaffected: apps keep calling
  `/api/rag/*`; only the kernel's engine changes. Reseeds are engine-agnostic via
  `DELETE /api/rag/collections/:name`.

## Done-when

- [x] `RAG_ENGINE=pgvector` serves existing callers (LM tutor grounded=true through
  Postgres; paraphrase + hybrid-rrf verified in logs 2026-07-12).
- [x] Reingest script moved all 12 live collections (demo textbooks fully vectorised;
  legacy corpora lexical-only until re-ingested with vectors).
- [ ] Soak: Playwright RAG specs re-run green on pgvector; a quiet week of live use.
- [ ] Chroma container removed from `docker-compose.oshal-local.yml` and `oshal-up.sh`
  (and CLAUDE.md's RAG section rewritten for the pgvector reality).
