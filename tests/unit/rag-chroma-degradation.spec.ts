/**
 * Graceful-degradation guard for RAG over ChromaDB (rag-service.ts + rag-routes.ts).
 *
 * ChromaDB is an external dependency; RAG must degrade, never 500. This VERIFIES the already-shipped
 * behavior (the sweep found no source fix needed here — the degradation was already correct) and
 * PINS it so it can't silently regress:
 *   (a) Chroma UNREACHABLE (every fetch rejects) → search() returns [] (no throw), error-logged;
 *   (b) Chroma reachable but the VECTOR query errors while docs are still servable → the documented
 *       BM25 lexical fallback triggers and returns ranked results (scorer 'bm25');
 *   (c) healthCheck() reports false rather than throwing;
 *   (d) GET /api/rag/search and /api/rag/health return 200 with a graceful body when Chroma is down —
 *       never an unhandled 500.
 *
 * A mocked Chroma + stubbed local embedder are used throughout (never a live engine / model).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard verifying RAG/Chroma graceful degradation: unreachable → [] no-throw, vector-error → BM25 fallback, health → false, and the /search + /health routes never 500 on a Chroma failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';

// The native fetch, captured BEFORE any test stubs the global: the route tests replace globalThis.fetch
// (to fake / fail Chroma) while this file's own HTTP client still needs to reach the express server.
const realFetch = globalThis.fetch;

const logSpies = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('@/shared/logger', () => ({
  createChildLogger: () => logSpies,
  logger: logSpies,
  LOG_REDACT_OPTIONS: { paths: [], censor: '[redacted]' },
}));

// The vector leg's embedder dynamically imports an ESM-only model that cannot resolve under vitest's
// CJS transform; stub the singleton so the leg runs deterministically without loading ~80MB of ONNX.
vi.mock('@/features/rag/services/local-embedding-service', () => ({
  localEmbeddings: { embed: vi.fn(async () => [[0.1, 0.2, 0.3]]), isEnabled: () => true, enabled: () => true },
}));

import { RagService } from '@/features/rag';
import { createRagRoutes } from '@/app/routes/rag-routes';

interface FetchLike { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }

/** Fail EVERY Chroma call at the transport level (connection refused). */
function stubUnreachable(): void {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); }));
}

/** Chroma reachable, collection resolves + docs are servable, but the VECTOR /query errors. */
function stubVectorErrorDocsServable(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string): Promise<FetchLike> => {
    if (/\/query$/.test(url)) {
      return { ok: false, status: 503, text: async () => 'no server-side embedder on this path' };
    }
    if (/\/get$/.test(url)) {
      return {
        ok: true,
        json: async () => ({
          ids: ['d1', 'd2'],
          documents: ['Postgres backup catalog housekeeping runbook', 'unrelated network topology notes'],
          metadatas: [{ doc_id: 'd1' }, { doc_id: 'd2' }],
        }),
      };
    }
    if (/\/collections\/[^/]+$/.test(url)) {
      return { ok: true, json: async () => ({ id: 'col-1' }) };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  }));
}

async function hit(app: express.Express, route: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}${route}`);
    const raw = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null; } catch { body = null; }
    return { status: res.status, body };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function ragApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', createRagRoutes(new RagService('http://chroma.unit.test')));
  return app;
}

describe('RagService — Chroma degradation', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('(a) Chroma unreachable: search() returns [] (no throw) and logs the failure', async () => {
    stubUnreachable();
    const svc = new RagService('http://chroma.unit.test');
    await expect(svc.search('backup catalog', 'infra-runbooks', 5)).resolves.toEqual([]);
    expect(logSpies.error).toHaveBeenCalled();
  });

  it('(a2) Chroma unreachable: searchAllCollections() also returns [] (no throw)', async () => {
    stubUnreachable();
    const svc = new RagService('http://chroma.unit.test');
    await expect(svc.searchAllCollections('backup catalog', 5)).resolves.toEqual([]);
  });

  it('(b) vector query errors but docs servable: the BM25 lexical fallback triggers and ranks results', async () => {
    stubVectorErrorDocsServable();
    const svc = new RagService('http://chroma.unit.test');
    const results = await svc.search('backup catalog', 'infra-runbooks', 5);
    expect(results.length).toBeGreaterThan(0);
    // The doc that actually contains the query terms wins — proving BM25 (not the failed vector leg) ranked.
    expect(results[0].id).toBe('d1');
  });

  it('(c) healthCheck() reports false rather than throwing when Chroma is unreachable', async () => {
    stubUnreachable();
    await expect(new RagService('http://chroma.unit.test').healthCheck()).resolves.toBe(false);
  });
});

describe('rag-routes — /search and /health never 500 on a Chroma failure', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('GET /api/rag/search (single collection) → 200 with empty results, not 500', async () => {
    stubUnreachable();
    const res = await hit(ragApp(), '/api/rag/search?q=backup&collection=infra-runbooks&topK=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ results: [], count: 0, collection: 'infra-runbooks' });
  });

  it('GET /api/rag/search (all collections) → 200 with empty results, not 500', async () => {
    stubUnreachable();
    const res = await hit(ragApp(), '/api/rag/search?q=backup&topK=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ results: [], count: 0, collection: 'all' });
  });

  it('GET /api/rag/health → 200 reporting chromadb unreachable', async () => {
    stubUnreachable();
    const res = await hit(ragApp(), '/api/rag/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chromadb: 'unreachable' });
  });
});
