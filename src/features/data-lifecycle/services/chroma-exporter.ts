/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ChromaDB data-lifecycle exporter (closes the chromadb_collections KNOWN_EXPORT_GAPS entry): per-user data in Chroma is identified by the `owner_sub` chunk METADATA the writers stamp (rag-routes private ingest/upload, haven-context 'user-model' long-tail — there is no per-user collection-name scheme), so export scans EVERY collection with a where={owner_sub} filter and delete removes exactly those docs. Engine-aware: a failed heartbeat (Chroma absent, or a pgvector-only deployment where rag_chunks already rides the discovered Postgres exporters via its owner_sub column) is a clean logged no-op, never an export failure; a failure AFTER a good heartbeat throws so the manifest flags it honestly. The REST client mirrors RagService (same endpoints, same one-retry-on-thrown-network-error chromaFetch semantics — the method is private there, so the pattern is reproduced, not imported).
 */

/**
 * @description ChromaDB exporter for the data-lifecycle registry. User scoping is the
 * `owner_sub` metadata equality filter sent to Chroma itself (`where: {owner_sub: <sub>}`),
 * so the user's docs are selected server-side and another user's docs are never even
 * fetched. Shared-corpus chunks carry no `owner_sub` and are untouched by both passes.
 *
 * @module features/data-lifecycle/services/chroma-exporter
 */

import { createChildLogger } from '@/shared/logger';
import type { DataExporter } from './exporter-registry';

const logger = createChildLogger({ module: 'data-lifecycle:chroma-exporter' });

/** The chunk-metadata key every per-user Chroma writer stamps (rag ACL convention). */
const OWNER_METADATA_KEY = 'owner_sub';

/** Injection points so unit tests run against a faked Chroma without any network. */
export interface ChromaExporterOptions {
  /** Chroma base URL; defaults to CHROMADB_URL (same resolution as RagService). */
  chromaUrl?: string;
  /** Injectable fetch implementation for tests. */
  fetchImpl?: typeof fetch;
}

/** One exported Chroma document: which collection it lives in + its content and metadata. */
export interface ChromaExportRow {
  collection: string;
  id: string;
  document: string;
  metadata: Record<string, unknown>;
}

/** Minimal Chroma REST client for the two lifecycle operations (get-by-owner, delete-by-owner). */
class ChromaLifecycleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /**
   * @description Same retry contract as RagService.chromaFetch: one retry on a THROWN
   * network error (stale keep-alive sockets EPIPE and undici never retries on its own);
   * HTTP error statuses are returned as-is, never retried.
   * @param path - API path under the base URL.
   * @param init - Standard fetch init.
   * @returns The (possibly retried) response.
   */
  private async chromaFetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      logger.warn({ err, url }, 'Chroma fetch failed at transport level — retrying once on a fresh connection');
      await new Promise((r) => setTimeout(r, 250));
      return this.fetchImpl(url, init);
    }
  }

  /** POST helper with a JSON body. */
  private postJson(path: string, body: unknown): Promise<Response> {
    return this.chromaFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * @description Engine-presence probe. False (unreachable or non-OK heartbeat) means the
   * deployment has no usable Chroma — the exporter no-ops instead of failing the bundle.
   * @returns Whether the Chroma engine answered its heartbeat.
   */
  async isReachable(): Promise<boolean> {
    try {
      return (await this.chromaFetch('/api/v1/heartbeat')).ok;
    } catch (err) {
      logger.info({ err, baseUrl: this.baseUrl }, 'Chroma heartbeat unreachable — engine treated as absent');
      return false;
    }
  }

  /**
   * @description List every collection as {id, name}. Called only after a good heartbeat, so
   * failures here are REAL failures and throw (the manifest flags them honestly).
   * @returns All collections.
   */
  async listCollections(): Promise<Array<{ id: string; name: string }>> {
    const res = await this.chromaFetch('/api/v1/collections');
    if (!res.ok) throw new Error(`Chroma list collections failed: ${res.status}`);
    const data = (await res.json()) as Array<{ id?: string; name?: string }>;
    const out: Array<{ id: string; name: string }> = [];
    for (const c of Array.isArray(data) ? data : []) {
      const name = typeof c?.name === 'string' ? c.name.trim() : '';
      if (!name) continue;
      const id = typeof c?.id === 'string' && c.id ? c.id : await this.resolveCollectionId(name);
      if (id) out.push({ id, name });
    }
    return out;
  }

  /** Resolve a collection id by name (the RagService pattern); null when it vanished mid-scan. */
  private async resolveCollectionId(name: string): Promise<string | null> {
    const res = await this.chromaFetch(`/api/v1/collections/${encodeURIComponent(name)}`);
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Chroma collection lookup failed for ${name}: ${res.status}`);
    const data = (await res.json()) as { id?: string };
    return typeof data?.id === 'string' && data.id ? data.id : null;
  }

  /**
   * @description Fetch the docs the user owns in one collection — the where filter is the
   * scoping: Chroma only returns chunks whose owner_sub metadata equals the sub.
   * @param colId - Resolved collection id.
   * @param colName - Collection name (attached to the export rows).
   * @param userSub - The owner's OIDC subject.
   * @returns The user's docs in that collection.
   */
  async userDocs(colId: string, colName: string, userSub: string): Promise<ChromaExportRow[]> {
    const res = await this.postJson(`/api/v1/collections/${colId}/get`, {
      where: { [OWNER_METADATA_KEY]: userSub },
      include: ['documents', 'metadatas'],
    });
    if (!res.ok) throw new Error(`Chroma get failed for collection ${colName}: ${res.status}`);
    const data = (await res.json()) as {
      ids?: string[];
      documents?: Array<string | null>;
      metadatas?: Array<Record<string, unknown> | null>;
    };
    const ids = Array.isArray(data.ids) ? data.ids : [];
    return ids.map((id, i) => ({
      collection: colName,
      id,
      document: typeof data.documents?.[i] === 'string' ? (data.documents[i] as string) : '',
      metadata: data.metadatas?.[i] ?? {},
    }));
  }

  /**
   * @description Delete the user's docs in one collection via the same owner_sub where
   * filter. Chroma returns the deleted ids.
   * @param colId - Resolved collection id.
   * @param colName - Collection name (for the error message).
   * @param userSub - The owner's OIDC subject.
   * @returns How many docs were deleted.
   */
  async deleteUserDocs(colId: string, colName: string, userSub: string): Promise<number> {
    const res = await this.postJson(`/api/v1/collections/${colId}/delete`, {
      where: { [OWNER_METADATA_KEY]: userSub },
    });
    if (!res.ok) throw new Error(`Chroma delete failed for collection ${colName}: ${res.status}`);
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? data.length : 0;
  }
}

/** Refuse a blank sub — a missing filter value must never widen scope to unowned docs. */
function requireSub(userSub: string): string {
  if (!userSub || !userSub.trim()) throw new Error('chroma exporter requires a non-empty user sub');
  return userSub;
}

/**
 * @description Build the ChromaDB DataExporter. Export scans every collection for chunks whose
 * `owner_sub` metadata equals the caller's sub (private RAG ingests/uploads, the 'user-model'
 * long-tail memory — any collection, since ownership is metadata, not collection naming);
 * delete removes exactly those chunks. When the Chroma engine is absent/unused (heartbeat
 * fails — e.g. a pgvector-only deployment, whose rag_chunks Postgres rows are already covered
 * by the discovered exporters), both passes are clean, logged no-ops.
 * @param opts - Optional URL + fetch injection (tests run against a faked Chroma).
 * @returns The Chroma DataExporter.
 */
export function buildChromaExporter(opts: ChromaExporterOptions = {}): DataExporter {
  const client = (): ChromaLifecycleClient =>
    new ChromaLifecycleClient(
      opts.chromaUrl || process.env.CHROMADB_URL || 'http://localhost:8000',
      opts.fetchImpl ?? fetch,
    );
  return {
    store: 'chromadb_collections',
    describe:
      'Your documents in the ChromaDB vector store, across ALL collections: every chunk stamped with your owner_sub ACL metadata (private RAG ingests/uploads, user-model long-tail memory). Shared-corpus chunks carry no owner and are untouched. Empty when the Chroma engine is absent/unused — on RAG_ENGINE=pgvector deployments your rag_chunks rows are covered by the auto-discovered Postgres exporters instead.',
    deletable: true,
    async exportRows(userSub: string): Promise<unknown[]> {
      const sub = requireSub(userSub);
      const c = client();
      if (!(await c.isReachable())) {
        logger.info({ userSub: sub }, 'chroma export: engine absent/unreachable — empty section (no-op)');
        return [];
      }
      const rows: ChromaExportRow[] = [];
      for (const col of await c.listCollections()) {
        rows.push(...(await c.userDocs(col.id, col.name, sub)));
      }
      return rows;
    },
    async deleteRows(userSub: string): Promise<number> {
      const sub = requireSub(userSub);
      const c = client();
      if (!(await c.isReachable())) {
        logger.info({ userSub: sub }, 'chroma delete: engine absent/unreachable — no-op');
        return 0;
      }
      let deleted = 0;
      for (const col of await c.listCollections()) {
        const removed = await c.deleteUserDocs(col.id, col.name, sub);
        if (removed > 0) logger.info({ userSub: sub, collection: col.name, removed }, 'chroma delete: user docs removed');
        deleted += removed;
      }
      return deleted;
    },
  };
}
