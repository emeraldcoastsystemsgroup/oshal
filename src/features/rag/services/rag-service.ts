/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial RAG service — ChromaDB integration with chunking
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime chunking configuration support (including tiered overlap chunking profiles) from persisted settings
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added collection-aware multi-collection query support for direct RAG search tooling
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added lexical fallback when Chroma server-side query embedding is unavailable
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Wired optional caller permission context into search/searchAllCollections: over-fetch + applyRagPermission drops chunks the caller can't read and stamps permissionBasis; unowned corpus stays public
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Hybrid retrieval: ingest stores locally-computed MiniLM vectors (this Chroma's REST path never embedded — every query was silently BM25 over a full-collection fetch); search now runs vector + BM25 in parallel and fuses by reciprocal rank. Every vector failure degrades to lexical, never breaks. ADR-091 tracks the pgvector end-state.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Ingest embeds BEFORE any Chroma round-trip and the add POST retries once on a thrown network error: tens-of-seconds WASM embedding left the pooled keep-alive socket half-closed (uvicorn ~5s idle) and the big vector add died with EPIPE — undici never retries POSTs on its own.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | ADR-091: RAG_ENGINE=pgvector routes storage/retrieval to PgvectorRagEngine (rag_chunks in the existing Postgres, both legs indexed, RLS'd) with sticky feature-detected fallback to the chroma path; chunking/embedding/permissions stay here, engine-neutral. New deleteCollection() for engine-agnostic reseeds. The chroma code is kept in place unchanged during the soak — formal port extraction rides the eventual Chroma removal.
 */

import { createChildLogger } from '@/shared/logger';
import { readRagRuntimeSettings } from '@/shared/services';
import { chunkText, ChunkerConfig } from './chunker';
import { applyRagPermission, type RagPermissionBasis, type RagPermissionContext } from './permission-filter';
import { localEmbeddings } from './local-embedding-service';
import { reciprocalRankFusion } from './hybrid-fusion';
import { pgvectorRagEngine } from './pgvector-rag-engine';

/** Multiplier for over-fetching candidates before permission filtering, so topK still fills. */
const PERMISSION_OVERFETCH = 5;
/** Hard ceiling on candidates fetched for a permissioned query. */
const PERMISSION_OVERFETCH_CAP = 50;

const logger = createChildLogger({ module: 'rag-service' });

/**
 * Minimal English-leaning tokeniser for BM25.
 * Lowercases, splits on non-alphanumeric (keeps `_` for system view names
 * like `M_BACKUP_CATALOG`), drops 1-char tokens and a small stopword set.
 * Exported so unit tests can pin the tokenisation rules.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'this', 'that', 'it', 'as', 'at',
  'by', 'from', 'has', 'have', 'had',
]);
/**
 * @description Tokenises text for BM25 lexical scoring: lowercases the input,
 * splits on runs of non-alphanumeric/underscore characters, then drops
 * single-character tokens and common stopwords. Underscores are preserved so
 * System view identifiers stay intact as single tokens.
 * @param text - Raw text to tokenise.
 * @returns Array of normalised tokens with stopwords and 1-char tokens removed.
 */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * @description Result of a RAG search query.
 */
export interface RagSearchResult {
  id: string;
  text: string;
  metadata: Record<string, string>;
  score: number;
  collection: string;
  /** When a permission context was applied, the basis on which the caller may read this hit. */
  permissionBasis?: RagPermissionBasis;
}

/**
 * @description Result of a RAG ingestion operation.
 */
export interface RagIngestResult {
  collection: string;
  documentCount: number;
  chunkCount: number;
}

/**
 * @description RAG service that integrates with ChromaDB for document
 * ingestion and semantic search. Uses sentence-aware chunking from
 * the any-bot KnowledgeBootstrap strategy.
 */
export class RagService {
  private readonly chromaUrl: string;
  private readonly chunkerConfig: ChunkerConfig;

  /**
   * @description Creates a new RagService instance.
   * @param chromaUrl - ChromaDB REST API base URL (e.g. http://localhost:8000).
   * @param chunkerConfig - Optional chunking configuration.
   */
  constructor(chromaUrl?: string, chunkerConfig?: ChunkerConfig) {
    const runtimeConfig = readRagRuntimeSettings();
    this.chromaUrl = chromaUrl || process.env.CHROMADB_URL || 'http://localhost:8000';
    this.chunkerConfig = {
      ...(runtimeConfig.chunking || {}),
      ...(chunkerConfig || {}),
    };
    logger.info(
      {
        chromaUrl: this.chromaUrl,
        chunkStrategy: this.chunkerConfig.strategy || 'sentence',
        chunkSize: this.chunkerConfig.chunkSize ?? 500,
        chunkOverlap: this.chunkerConfig.chunkOverlap ?? 50,
        tierCount: Array.isArray(this.chunkerConfig.tierSizes) ? this.chunkerConfig.tierSizes.length : 0,
      },
      'RagService initialized',
    );
  }

  /**
   * @description ADR-091 engine gate: true when RAG_ENGINE=pgvector AND the
   * rag_chunks table + vector extension actually exist (feature-detected once,
   * sticky). False keeps every caller on the chroma path — a stock-postgres
   * deployment with the flag set degrades loudly-but-safely.
   * @returns Whether pgvector serves this instance's storage/retrieval.
   */
  private async usePgvector(): Promise<boolean> {
    if ((process.env.RAG_ENGINE || 'chroma').trim().toLowerCase() !== 'pgvector') return false;
    return pgvectorRagEngine.isAvailable();
  }

  /**
   * @description Every Chroma call goes through this: fetch with ONE retry on a
   * thrown network error. Local WASM embedding stalls the event path for tens of
   * seconds, so whatever pooled keep-alive socket the previous Chroma call left
   * behind is half-closed by uvicorn (~5s idle) when the next call writes — undici
   * surfaces `fetch failed` (EPIPE / other side closed) and never retries on its
   * own, not even GETs. The retry rides a fresh connection. HTTP error statuses
   * are returned as-is, never retried.
   * @param url - Target URL.
   * @param init - Standard fetch init.
   * @returns The (possibly retried) response.
   */
  private async chromaFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      logger.warn({ err, url }, 'Chroma fetch failed at transport level — retrying once on a fresh connection');
      await new Promise((r) => setTimeout(r, 250));
      return fetch(url, init);
    }
  }

  /**
   * @description Ensures a ChromaDB collection exists, creating it if needed.
   * @param collection - Collection name.
   */
  async ensureCollection(collection: string): Promise<void> {
    // pgvector engine: collections are just a name column on rag_chunks — no DDL to run.
    if (await this.usePgvector()) return;
    logger.info({ collection }, 'Ensuring ChromaDB collection exists');
    try {
      const res = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: collection, get_or_create: true }),
      });
      if (!res.ok) {
        const body = await res.text();
        logger.error({ collection, status: res.status, body }, 'Failed to ensure collection');
        throw new Error(`ChromaDB collection error: ${res.status}`);
      }
      logger.info({ collection }, 'Collection ensured');
    } catch (err) {
      logger.error({ err, collection }, 'ChromaDB connection failed');
      throw err;
    }
  }

  /**
   * @description Ingests text documents into a ChromaDB collection.
   * Chunks each document using sentence-aware splitting before storage.
   *
   * @param texts - Array of raw text strings to ingest.
   * @param collection - Target ChromaDB collection name.
   * @param metadata - Optional metadata to attach to each chunk.
   * @returns Ingestion result with counts.
   */
  async ingest(
    texts: string[],
    collection: string,
    metadata?: Record<string, string>,
  ): Promise<RagIngestResult> {
    logger.info({ collection, documentCount: texts.length }, 'Starting RAG ingestion');

    await this.ensureCollection(collection);

    const allChunks: string[] = [];
    const allIds: string[] = [];
    const allMetadatas: Record<string, string>[] = [];

    for (let i = 0; i < texts.length; i++) {
      const chunks = chunkText(texts[i], this.chunkerConfig);
      for (let j = 0; j < chunks.length; j++) {
        allChunks.push(chunks[j]);
        allIds.push(`doc-${i}-chunk-${j}-${Date.now()}`);
        allMetadatas.push({ ...metadata, docIndex: String(i), chunkIndex: String(j) });
      }
    }

    if (allChunks.length === 0) {
      logger.warn({ collection }, 'No chunks generated from input texts');
      return { collection, documentCount: texts.length, chunkCount: 0 };
    }

    try {
      // Vector-enable the chunks BEFORE any Chroma round-trip: WASM embedding of a
      // big batch takes tens of seconds, and a Chroma keep-alive socket left idle
      // that long is half-closed by uvicorn (~5s) — the subsequent add write EPIPEs.
      // Null (model unavailable/disabled) degrades to the historical documents-only add.
      const embeddings = await localEmbeddings.embed(allChunks);

      // ADR-091: pgvector engine stores straight into rag_chunks — no Chroma round-trips.
      if (await this.usePgvector()) {
        await pgvectorRagEngine.addChunks(collection, allIds, allChunks, allMetadatas, embeddings);
        logger.info({ collection, chunkCount: allChunks.length, vectorised: Boolean(embeddings), engine: 'pgvector' }, 'RAG ingestion complete');
        return { collection, documentCount: texts.length, chunkCount: allChunks.length };
      }

      // Get collection ID
      const colRes = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections/${collection}`);
      if (!colRes.ok) {
        throw new Error(`Collection not found: ${collection}`);
      }
      const colData = await colRes.json() as any;
      const colId = colData.id;

      const addBody = (withVectors: boolean): string => JSON.stringify({
        ids: allIds,
        documents: allChunks,
        metadatas: allMetadatas,
        ...(withVectors && embeddings ? { embeddings } : {}),
      });

      // Add documents. POSTs on a stale pooled connection surface as thrown network
      // errors (undici never retries a POST) — chromaFetch rides a fresh socket once.
      const postAdd = (withVectors: boolean): Promise<Response> =>
        this.chromaFetch(`${this.chromaUrl}/api/v1/collections/${colId}/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: addBody(withVectors),
        });
      let addRes = await postAdd(Boolean(embeddings));

      if (!addRes.ok && embeddings) {
        // Legacy collection whose existing chunks were stored without vectors (or a
        // dimension mismatch) — retry documents-only so ingestion never regresses.
        const body = await addRes.text();
        logger.warn({ collection, status: addRes.status, body: body.slice(0, 200) }, 'Vector add rejected — retrying without embeddings');
        addRes = await postAdd(false);
      }

      if (!addRes.ok) {
        const body = await addRes.text();
        logger.error({ status: addRes.status, body }, 'ChromaDB add failed');
        throw new Error(`ChromaDB add error: ${addRes.status}`);
      }

      logger.info({ collection, chunkCount: allChunks.length, vectorised: Boolean(embeddings) }, 'RAG ingestion complete');
    } catch (err) {
      logger.error({ err, collection }, 'RAG ingestion failed');
      throw err;
    }

    return { collection, documentCount: texts.length, chunkCount: allChunks.length };
  }

  /**
   * @description Searches a ChromaDB collection for documents matching the query.
   *
   * @param query - Search query text.
   * @param collection - ChromaDB collection to search.
   * @param topK - Number of results to return (default 5).
   * @returns Array of search results with scores.
   */
  async search(
    query: string,
    collection: string,
    topK = 5,
    context?: RagPermissionContext,
  ): Promise<RagSearchResult[]> {
    // When a permission context is present we over-fetch candidates, because filtering will drop
    // any chunk the caller can't read and we still want up to topK readable hits.
    const fetchK = context ? Math.min(PERMISSION_OVERFETCH_CAP, Math.max(topK, topK * PERMISSION_OVERFETCH)) : topK;
    logger.info({ query, collection, topK, permissioned: Boolean(context) }, 'RAG search');

    // ADR-091: pgvector engine — both legs indexed in Postgres; chunk-level fusion
    // shares hybrid-fusion.ts with the chroma path, so ranking semantics match.
    if (await this.usePgvector()) {
      try {
        const queryEmbedding = await localEmbeddings.embed([query]);
        const { results, scorer } = await pgvectorRagEngine.search(collection, query, queryEmbedding?.[0] ?? null, fetchK);
        const finalized = this.finalizeResults(results, topK, context);
        logger.info({ collection, resultCount: finalized.length, candidates: results.length, scorer, engine: 'pgvector', permissioned: Boolean(context) }, 'RAG search complete');
        return finalized;
      } catch (err) {
        logger.error({ err, collection, query }, 'pgvector RAG search error');
        return [];
      }
    }

    try {
      const colRes = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections/${collection}`);
      if (!colRes.ok) {
        logger.warn({ collection }, 'Collection not found for search');
        return [];
      }
      const colData = await colRes.json() as any;
      const colId = colData.id;

      // Hybrid retrieval: run vector search (local query embedding) and BM25 in
      // parallel, then fuse by rank. Either side may come back empty — model
      // unavailable, un-vectorised legacy collection, fetch failure — and the
      // other side alone is still a valid result set. Both empty = no results.
      const [vector, lexical] = await Promise.all([
        this.vectorSearch(colId, collection, query, fetchK),
        this.lexicalSearch(colId, collection, query, fetchK).catch((err) => {
          logger.error({ err, collection }, 'Lexical search failed during hybrid retrieval');
          return [] as RagSearchResult[];
        }),
      ]);

      if (!vector.length && !lexical.length) {
        logger.info({ collection, query }, 'RAG search: no candidates from either retriever');
        return [];
      }

      const fused = vector.length && lexical.length
        ? reciprocalRankFusion(vector, lexical)
        : (vector.length ? vector : lexical);
      const scorer = vector.length && lexical.length ? 'hybrid-rrf' : (vector.length ? 'vector' : 'bm25');

      const finalized = this.finalizeResults(fused, topK, context);
      logger.info({ collection, resultCount: finalized.length, candidates: fused.length, scorer, permissioned: Boolean(context) }, 'RAG search complete');
      return finalized;
    } catch (err) {
      logger.error({ err, collection, query }, 'RAG search error');
      return [];
    }
  }

  /**
   * @description Vector search over a collection using a locally-computed query
   * embedding (this Chroma's REST /query rejects query_texts — 0.4.24 has no
   * server-side embedder on this path). Returns [] whenever vectors can't be
   * used (embedder disabled/unavailable, collection stored without embeddings,
   * HTTP failure) so the hybrid caller falls back to lexical alone.
   *
   * @param colId - Resolved Chroma collection id.
   * @param collection - Collection name (attached to results).
   * @param query - Search query text.
   * @param fetchK - Candidate count to fetch.
   * @returns Ranked vector hits, best first — or [] when unavailable.
   */
  private async vectorSearch(
    colId: string,
    collection: string,
    query: string,
    fetchK: number,
  ): Promise<RagSearchResult[]> {
    try {
      const queryEmbedding = await localEmbeddings.embed([query]);
      if (!queryEmbedding) return [];
      const qRes = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections/${colId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query_embeddings: queryEmbedding,
          n_results: fetchK,
        }),
      });
      if (!qRes.ok) {
        const body = await qRes.text();
        // Expected on legacy collections whose chunks were stored without vectors.
        logger.warn({ collection, status: qRes.status, body: body.slice(0, 160) }, 'Vector query unavailable for collection — lexical only');
        return [];
      }
      const data = await qRes.json() as any;
      const ids = data.ids?.[0] ?? [];
      const docs = data.documents?.[0] ?? [];
      const metas = data.metadatas?.[0] ?? [];
      const dists = data.distances?.[0] ?? [];
      return ids.map((id: string, i: number) => ({
        id,
        text: docs[i] ?? '',
        metadata: metas[i] ?? {},
        score: 1 - (dists[i] ?? 1),
        collection,
      }));
    } catch (err) {
      logger.error({ err, collection }, 'Vector search error — lexical only');
      return [];
    }
  }

  /**
   * @description Trims candidate hits to topK, applying caller permission filtering when a context
   * is supplied. With no context the behavior is unchanged (a plain topK slice).
   *
   * @param results - Candidate hits in rank order.
   * @param topK - Maximum hits to return.
   * @param context - Optional caller identity/scope; when present, unreadable hits are dropped.
   * @returns The readable hits in rank order, capped at topK.
   */
  private finalizeResults(
    results: RagSearchResult[],
    topK: number,
    context?: RagPermissionContext,
  ): RagSearchResult[] {
    if (!context) {
      return results.slice(0, topK);
    }
    return applyRagPermission(results, context, topK);
  }

  /**
   * @description Searches every available ChromaDB collection and returns a merged ranked result set.
   *
   * @param query - Search query text.
   * @param topK - Number of results to return across all collections.
   * @returns Ranked search results with collection names attached.
   */
  async searchAllCollections(
    query: string,
    topK = 5,
    context?: RagPermissionContext,
  ): Promise<RagSearchResult[]> {
    logger.info({ query, topK, permissioned: Boolean(context) }, 'RAG search across all collections');

    try {
      const collections = await this.listCollections();
      if (collections.length === 0) {
        logger.warn({ query }, 'No ChromaDB collections available for multi-collection search');
        return [];
      }

      const perCollectionTopK = Math.max(topK, 1);
      // Each per-collection search applies the caller's permission filter itself, so the merged
      // set is already readable; we only re-rank and trim to the global topK here.
      const nestedResults = await Promise.all(
        collections.map((collection) => this.search(query, collection, perCollectionTopK, context)),
      );

      const merged = nestedResults
        .flat()
        .sort((left, right) => right.score - left.score)
        .slice(0, topK);

      logger.info({ query, topK, collectionCount: collections.length, resultCount: merged.length }, 'Multi-collection RAG search complete');
      return merged;
    } catch (err) {
      logger.error({ err, query }, 'Multi-collection RAG search error');
      return [];
    }
  }

  /**
   * @description Lists collection names currently present in ChromaDB.
   * @returns Array of collection names.
   */
  async listCollections(): Promise<string[]> {
    if (await this.usePgvector()) {
      try {
        return await pgvectorRagEngine.listCollections();
      } catch (err) {
        logger.error({ err }, 'pgvector listCollections failed');
        return [];
      }
    }
    try {
      const res = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections`);
      if (!res.ok) {
        const body = await res.text();
        logger.error({ status: res.status, body }, 'Failed to list ChromaDB collections');
        return [];
      }

      const data = await res.json() as Array<{ name?: string }>;
      return data
        .map((item) => item?.name?.trim() || '')
        .filter((name): name is string => name.length > 0);
    } catch (err) {
      logger.error({ err }, 'Failed to list ChromaDB collections');
      return [];
    }
  }

  /**
   * @description Fallback search path for Chroma servers that require explicit query embeddings.
   *
   * @param collectionId - Chroma collection id.
   * @param collection - Collection name.
   * @param query - Raw query text.
   * @param topK - Result limit.
   * @returns Ranked lexical matches.
   */
  private async lexicalSearch(
    collectionId: string,
    collection: string,
    query: string,
    topK: number,
  ): Promise<RagSearchResult[]> {
    const getRes = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections/${collectionId}/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        include: ['documents', 'metadatas'],
      }),
    });

    if (!getRes.ok) {
      const body = await getRes.text();
      logger.error({ collection, status: getRes.status, body }, 'ChromaDB lexical fallback fetch failed');
      return [];
    }

    const data = await getRes.json() as {
      ids?: string[];
      documents?: string[];
      metadatas?: Array<Record<string, string>>;
    };

    const ids = Array.isArray(data.ids) ? data.ids : [];
    const documents = Array.isArray(data.documents) ? data.documents : [];
    const metadatas = Array.isArray(data.metadatas) ? data.metadatas : [];

    // BM25 ranking — tokenise query + every doc, compute IDF over the whole
    // collection, then BM25 score per doc. Title and metadata fields get
    // duplicated into the haystack with a small boost so a doc whose
    // metadata.doc_id contains the query terms outranks one where the
    // term only appears once in the body.
    const queryTokens = tokenise(query);
    if (queryTokens.length === 0) return [];

    const docTexts: string[] = ids.map((_, i) => {
      const body = typeof documents[i] === 'string' ? documents[i] : '';
      const meta = this.readMetadataRecord(metadatas[i]);
      // Boost: prepend metadata twice so doc_id / title hits weigh ~3x body hits.
      const metaBag = Object.values(meta).join(' ');
      return `${metaBag} ${metaBag} ${body}`;
    });

    const docTokens = docTexts.map(tokenise);
    const N = docTokens.length;
    const avgDocLen = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, N);
    const docFreq = new Map<string, number>();
    for (const tokens of docTokens) {
      for (const t of new Set(tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }

    const k1 = 1.5;
    const b = 0.75;
    const chunkScores = ids
      .map((id, index) => {
        const tokens = docTokens[index];
        if (!tokens || tokens.length === 0) return null;
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        let score = 0;
        for (const qt of queryTokens) {
          const f = tf.get(qt) ?? 0;
          if (f === 0) continue;
          const df = docFreq.get(qt) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const norm = 1 - b + (b * tokens.length) / Math.max(1, avgDocLen);
          score += idf * ((f * (k1 + 1)) / (f + k1 * norm));
        }
        if (score <= 0) return null;
        const text = typeof documents[index] === 'string' ? documents[index] : '';
        const metadata = this.readMetadataRecord(metadatas[index]);
        return { id, text, metadata, score, collection } satisfies RagSearchResult;
      })
      .filter((x): x is RagSearchResult => x !== null);

    // Aggregate by doc_id — a single doc split into multiple chunks should
    // rank as one entity. Use the best-scoring chunk's text/metadata, and
    // sum-with-decay over the rest so a doc whose Nth chunk also matches
    // outranks a doc with only one weak chunk.
    const byDoc = new Map<string, RagSearchResult>();
    for (const cs of chunkScores) {
      const key = cs.metadata.doc_id || cs.id;
      const existing = byDoc.get(key);
      if (!existing) {
        byDoc.set(key, cs);
      } else if (cs.score > existing.score) {
        // Promote the better-scoring chunk's content; keep cumulative score.
        byDoc.set(key, { ...cs, score: cs.score + existing.score * 0.3 });
      } else {
        existing.score += cs.score * 0.3;
      }
    }
    const ranked = Array.from(byDoc.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);

    logger.info({ collection, query, topK, resultCount: ranked.length, scorer: 'bm25' }, 'Lexical fallback RAG search complete');
    return ranked;
  }

  /**
   * @description Computes a simple lexical score from query terms against document and metadata content.
   *
   * @param query - Raw query.
   * @param text - Candidate document text.
   * @param metadata - Candidate metadata.
   * @returns Positive score for likely matches, zero otherwise.
   */
  private computeLexicalScore(query: string, text: string, metadata: Record<string, string>): number {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return 0;
    }

    const haystack = `${text} ${Object.values(metadata).join(' ')}`.toLowerCase();
    if (haystack.length === 0) {
      return 0;
    }

    let score = 0;
    if (haystack.includes(normalizedQuery)) {
      score += 10;
    }

    const tokens = normalizedQuery.split(/\s+/).filter((token) => token.length > 1);
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += 1;
      }
    }

    return score;
  }

  /**
   * @description Normalizes metadata payloads returned by Chroma into string records.
   *
   * @param value - Raw metadata payload.
   * @returns String metadata record.
   */
  private readMetadataRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const metadata: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw === undefined || raw === null) {
        continue;
      }
      metadata[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
    }
    return metadata;
  }

  /**
   * @description Remove a whole collection (the engine-agnostic reseed path —
   * chunk ids are timestamped, so re-ingesting without a drop duplicates chunks).
   * @param collection - Collection name.
   */
  async deleteCollection(collection: string): Promise<void> {
    if (await this.usePgvector()) {
      const removed = await pgvectorRagEngine.deleteCollection(collection);
      logger.info({ collection, removed, engine: 'pgvector' }, 'RAG collection deleted');
      return;
    }
    const res = await this.chromaFetch(`${this.chromaUrl}/api/v1/collections/${collection}`, { method: 'DELETE' });
    // 404 = already absent — that is the desired end state, not an error.
    if (!res.ok && res.status !== 404) {
      const body = await res.text();
      logger.error({ collection, status: res.status, body: body.slice(0, 200) }, 'ChromaDB collection delete failed');
      throw new Error(`ChromaDB delete error: ${res.status}`);
    }
    logger.info({ collection, engine: 'chroma' }, 'RAG collection deleted');
  }

  /**
   * @description Health check — verifies the active RAG engine is reachable.
   * @returns True if the engine (rag_chunks table / ChromaDB heartbeat) responds.
   */
  async healthCheck(): Promise<boolean> {
    if (await this.usePgvector()) {
      return pgvectorRagEngine.healthCheck();
    }
    try {
      const res = await this.chromaFetch(`${this.chromaUrl}/api/v1/heartbeat`);
      const ok = res.ok;
      logger.info({ chromaUrl: this.chromaUrl, ok }, 'ChromaDB health check');
      return ok;
    } catch (err) {
      logger.error({ err }, 'ChromaDB health check failed');
      return false;
    }
  }
}
