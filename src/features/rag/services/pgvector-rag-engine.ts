/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-091 pgvector engine: RAG chunks in the existing Postgres (rag_chunks — vector(384) HNSW + generated tsvector GIN, RLS'd like the rest of the platform). Vector KNN and websearch FTS run as two indexed queries fused by the shared RRF helper — replaces Chroma's full-collection BM25 fetch. Selected via RAG_ENGINE=pgvector; availability is health-checked (table+extension) with sticky fallback to the chroma path, so a stock-postgres deployment keeps working untouched.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG security burn-down: rag_chunks RLS was INERT for engine-written rows - addChunks never populated the owner_sub COLUMN (the ACL rode only in metadata JSONB, which policies cannot see), so every chunk landed unowned = public-read, and the engine's private raw Pool carried no identity GUCs anyway. Now (a) addChunks lifts owner_sub out of each chunk's metadata into the column, making migration 070's policies bite at the database layer exactly where the app-side permission filter already draws the line, and (b) the engine pool is wrapped with wrapPoolWithGuc (via the shared barrel) so the caller's request identity (or the SYSTEM sentinel for background sweeps) rides every query - without which the FORCE-RLS WITH CHECK would refuse the very owned writes (a) introduces. Pre-existing rows keep owner_sub NULL until re-ingest (shared-corpus semantics unchanged). Test seam _setRagPoolForTests. Guard: tests/unit/rag-pgvector-owner-sub.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserve every valid metadata.owner_sub byte-for-byte when lifting it into the RLS column. Subject case and surrounding whitespace are identity data, so normalizing them could rebind a private chunk; existing blank-value validation remains unchanged.
 */

import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { gucEnabled, wrapPoolWithGuc } from '@/shared/services/database';
import { reciprocalRankFusion } from './hybrid-fusion';
import type { RagSearchResult } from './rag-service';

const logger = createChildLogger({ module: 'pgvector-rag-engine' });

/** Insert batch size — keeps each statement's parameter count well under pg's 65535 cap. */
const INSERT_BATCH = 200;

/** One shared pool for RAG chunk I/O — sized small; this is not the app's main pool. */
let sharedPool: Pool | null = null;
function getPool(): Pool {
  if (!sharedPool) {
    const raw = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    // Identity-stamped like every other pool: rag_chunks is FORCE-RLS (migration 070), so
    // owned reads/writes need oshal.current_sub riding the connection. An unwrapped private
    // pool here is exactly how owner-stamped rows would be unwritable (WITH CHECK) and
    // owned rows invisible to their own users.
    sharedPool = gucEnabled() ? wrapPoolWithGuc(raw) : raw;
  }
  return sharedPool;
}

/**
 * @description Test seam: inject a fake pool (pre-wrap — it is GUC-wrapped exactly like the
 * real one) or null to reset to lazy construction. Mirrors the seam pattern of guc-pool's
 * _resetFailOpenAudit; never called by production code.
 * @param pool - Replacement pool, or null to restore the default lazy pool.
 */
export function _setRagPoolForTests(pool: Pool | null): void {
  sharedPool = pool ? (gucEnabled() ? wrapPoolWithGuc(pool) : pool) : null;
}

/**
 * @description Postgres-backed RAG storage/retrieval (ADR-091). Chunks live in
 * `rag_chunks` (migration 070): dense vectors under an HNSW cosine index, lexical
 * matching via a GENERATED tsvector under GIN — both retrieval legs are indexed,
 * unlike the chroma path's full-collection BM25 fetch. `collection` stays a plain
 * name column so every existing caller maps 1:1. Availability is feature-detected
 * (extension + table) and cached; every caller falls back to the chroma engine
 * when this reports unavailable.
 */
export class PgvectorRagEngine {
  /** Sticky availability: null = not yet probed. */
  private available: boolean | null = null;

  /**
   * @description Feature-detect the engine once: the vector extension AND the
   * rag_chunks table must exist (migration 070 skips itself on a stock postgres
   * image, in which case this stays false and callers keep using chroma).
   * @returns True when pgvector storage is usable.
   */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const res = await getPool().query(
        `SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'vector') AS ext,
                (SELECT to_regclass('public.rag_chunks')) AS tbl`,
      );
      this.available = Number(res.rows[0]?.ext) > 0 && res.rows[0]?.tbl !== null;
    } catch (err) {
      logger.error({ err }, 'pgvector availability probe failed — falling back to chroma');
      this.available = false;
    }
    if (!this.available) {
      logger.warn('RAG_ENGINE=pgvector requested but rag_chunks/vector extension unavailable — using chroma');
    }
    return this.available;
  }

  /**
   * @description Store chunks (with or without vectors). Idempotent on chunk_id.
   * @param collection - Logical collection name.
   * @param ids - Chunk ids (aligned with documents/metadatas).
   * @param documents - Chunk texts.
   * @param metadatas - Per-chunk metadata objects. An `owner_sub` key (the ACL the writers
   *   stamp — rag-routes private ingest/upload, the source-acl mapper) is ALSO lifted into
   *   the rag_chunks owner_sub COLUMN so migration 070's RLS policies actually apply to
   *   engine-written rows; without the column every row lands unowned = public-read and the
   *   database-layer backstop is inert. Chunks without the key stay NULL (shared corpus).
   * @param embeddings - One vector per chunk, or null when the embedder was unavailable.
   */
  async addChunks(
    collection: string,
    ids: string[],
    documents: string[],
    metadatas: Record<string, string>[],
    embeddings: number[][] | null,
  ): Promise<void> {
    const pool = getPool();
    for (let start = 0; start < ids.length; start += INSERT_BATCH) {
      const end = Math.min(start + INSERT_BATCH, ids.length);
      const values: string[] = [];
      const params: unknown[] = [];
      for (let i = start; i < end; i++) {
        const base = params.length;
        const meta = metadatas[i] ?? {};
        const ownerSub = typeof meta.owner_sub === 'string' && meta.owner_sub.trim().length > 0
          ? meta.owner_sub
          : null;
        // Postgres TEXT/JSONB reject NUL bytes — pdf-parse output regularly contains
        // them, and one poisoned chunk must not fail a whole ingest batch.
        params.push(ids[i], collection, documents[i].replace(/\u0000/g, ''),
          JSON.stringify(meta).replace(/\\u0000/g, ''),
          embeddings ? `[${embeddings[i].join(',')}]` : null,
          ownerSub);
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::vector, $${base + 6})`);
      }
      await pool.query(
        `INSERT INTO rag_chunks (chunk_id, collection, document, metadata, embedding, owner_sub)
         VALUES ${values.join(', ')}
         ON CONFLICT (chunk_id) DO NOTHING`,
        params,
      );
    }
  }

  /**
   * @description Hybrid retrieval over one collection: vector KNN (when a query
   * embedding is supplied and vectorised rows exist) and websearch-FTS run as two
   * parallel INDEXED queries, fused by the shared RRF helper — deliberately the
   * same fusion codepath the chroma engine uses, so ranking semantics are
   * engine-independent (the ADR's single-SQL-statement fusion stays an
   * optimization for later).
   * @param collection - Collection name.
   * @param query - Raw query text (FTS leg).
   * @param queryEmbedding - Locally-computed query vector, or null for lexical-only.
   * @param fetchK - Candidates per leg.
   * @returns Fused hits (best first) and the scorer label for observability.
   */
  async search(
    collection: string,
    query: string,
    queryEmbedding: number[] | null,
    fetchK: number,
  ): Promise<{ results: RagSearchResult[]; scorer: string }> {
    const pool = getPool();

    const vectorLeg = async (): Promise<RagSearchResult[]> => {
      if (!queryEmbedding) return [];
      const res = await pool.query(
        `SELECT chunk_id, document, metadata, 1 - (embedding <=> $2::vector) AS score
         FROM rag_chunks
         WHERE collection = $1 AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector
         LIMIT $3`,
        [collection, `[${queryEmbedding.join(',')}]`, fetchK],
      );
      return res.rows.map((r) => this.toResult(r, collection));
    };

    const lexicalLeg = async (): Promise<RagSearchResult[]> => {
      // websearch_to_tsquery ANDs every term — right for keyword queries, but a long
      // natural-language question ("why does bread dough get bigger before you bake
      // it") almost never has ALL its words in one 500-char chunk, which would leave
      // fusion vector-only. When AND yields nothing, retry with OR-joined terms —
      // the BM25-equivalent any-term semantics the chroma path always had.
      const strict = await pool.query(
        `SELECT chunk_id, document, metadata, ts_rank_cd(fts, q) AS score
         FROM rag_chunks, websearch_to_tsquery('english', $2) q
         WHERE collection = $1 AND fts @@ q
         ORDER BY score DESC
         LIMIT $3`,
        [collection, query, fetchK],
      );
      if (strict.rows.length) return strict.rows.map((r) => this.toResult(r, collection));
      const orTerms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1).join(' | ');
      if (!orTerms) return [];
      const loose = await pool.query(
        `SELECT chunk_id, document, metadata, ts_rank_cd(fts, q) AS score
         FROM rag_chunks, to_tsquery('english', $2) q
         WHERE collection = $1 AND fts @@ q
         ORDER BY score DESC
         LIMIT $3`,
        [collection, orTerms, fetchK],
      );
      return loose.rows.map((r) => this.toResult(r, collection));
    };

    const [vector, lexical] = await Promise.all([
      vectorLeg().catch((err) => { logger.error({ err, collection }, 'pgvector vector leg failed'); return [] as RagSearchResult[]; }),
      lexicalLeg().catch((err) => { logger.error({ err, collection }, 'pgvector lexical leg failed'); return [] as RagSearchResult[]; }),
    ]);

    if (!vector.length && !lexical.length) return { results: [], scorer: 'none' };
    if (vector.length && lexical.length) return { results: reciprocalRankFusion(vector, lexical), scorer: 'hybrid-rrf' };
    return vector.length ? { results: vector, scorer: 'vector' } : { results: lexical, scorer: 'fts' };
  }

  /** @returns Distinct collection names present in rag_chunks. */
  async listCollections(): Promise<string[]> {
    const res = await getPool().query('SELECT DISTINCT collection FROM rag_chunks ORDER BY collection');
    return res.rows.map((r) => String(r.collection));
  }

  /**
   * @description Drop a collection's chunks (the reseed path — chunk ids are
   * timestamped, so re-ingest without a drop would duplicate).
   * @param collection - Collection name.
   * @returns Number of chunks removed.
   */
  async deleteCollection(collection: string): Promise<number> {
    const res = await getPool().query('DELETE FROM rag_chunks WHERE collection = $1', [collection]);
    return res.rowCount ?? 0;
  }

  /** @returns True when the table answers a trivial query. */
  async healthCheck(): Promise<boolean> {
    try {
      await getPool().query('SELECT 1 FROM rag_chunks LIMIT 1');
      return true;
    } catch (err) {
      logger.error({ err }, 'pgvector health check failed');
      return false;
    }
  }

  /** Map a rag_chunks row to the engine-neutral result shape (metadata values stringified). */
  private toResult(row: { chunk_id: string; document: string; metadata: unknown; score: unknown }, collection: string): RagSearchResult {
    const metadata: Record<string, string> = {};
    if (row.metadata && typeof row.metadata === 'object') {
      for (const [k, v] of Object.entries(row.metadata as Record<string, unknown>)) {
        if (v === undefined || v === null) continue;
        metadata[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    return { id: row.chunk_id, text: row.document, metadata, score: Number(row.score) || 0, collection };
  }
}

/** Process-wide engine instance (owns the small shared pool + the sticky probe). */
export const pgvectorRagEngine = new PgvectorRagEngine();
