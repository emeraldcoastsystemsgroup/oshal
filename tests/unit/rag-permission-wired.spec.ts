/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Repair after ADR-091 (e64f7352) made search() HYBRID: it now runs a local-embedding vector leg + a BM25 lexical leg, so this spec's Chroma mock no longer matched the calls the service makes and all four wired cases went red. Stub the embedder (its @xenova/transformers dynamic import cannot resolve under vitest's CJS transform — "A dynamic import callback was not specified") and answer the lexical leg's /get. Intent is unchanged: prove the permission filter is WIRED into search.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RagService, applyRagPermission, type RagPermissionContext } from '@/features/rag';

/**
 * Proves permission-aware retrieval is actually WIRED into RagService.search — not just an unused
 * pure function. A mocked Chroma returns a mixed-ACL candidate set; the caller must only get back
 * the shared (public) chunk and their own owned chunk, never another user's owned chunk.
 */

// ADR-091 made retrieval hybrid (vector ⊕ BM25). Two consequences for this spec:
//
//  1. The vector leg calls localEmbeddings.embed(), which dynamically imports the ESM-only
//     @xenova/transformers via a Function() wrapper. Under vitest's CJS transform that throws
//     ("A dynamic import callback was not specified"), embed() fail-opens to null, and the vector
//     leg returns nothing. Stub the singleton so the leg runs — the model itself is not under test.
//  2. The candidate ORDER these tests assert is the vector leg's distance order. Letting BM25 rank
//     instead would reorder them (only two of the three documents contain "note"), so the lexical
//     leg is mocked EMPTY and the vector leg supplies the candidates, exactly as before ADR-091.
vi.mock('@/features/rag/services/local-embedding-service', () => ({
  localEmbeddings: { embed: vi.fn(async () => [[0.1, 0.2, 0.3]]), enabled: () => true },
}));

const CANDIDATES = {
  ids: [['shared-1', 'owned-by-a', 'owned-by-b']],
  documents: [['public runbook', 'alice private note', 'bob private note']],
  metadatas: [[
    {}, // no ACL -> public
    { owner_sub: 'alice' },
    { owner_sub: 'bob' },
  ]],
  distances: [[0.1, 0.2, 0.3]],
};

function mockChroma() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (/\/collections\/[^/]+$/.test(url)) {
      return { ok: true, json: async () => ({ id: 'col-id' }) } as Response;
    }
    if (/\/query$/.test(url)) {
      return { ok: true, json: async () => CANDIDATES } as Response;
    }
    // The BM25 leg's full-collection fetch. Empty = "no lexical candidates", a case the hybrid
    // path explicitly tolerates, so fusion falls through to the vector candidates above.
    if (/\/get$/.test(url)) {
      return { ok: true, json: async () => ({ ids: [], documents: [], metadatas: [] }) } as Response;
    }
    return { ok: false, status: 404, text: async () => 'not found' } as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const aliceContext: RagPermissionContext = { userSub: 'alice', allowPublic: true };

describe('permission-aware RAG retrieval (wired)', () => {
  it('search() drops other users\' owned chunks but keeps public + own', async () => {
    mockChroma();
    const results = await new RagService('http://chroma.test').search('note', 'kb', 5, aliceContext);
    const ids = results.map((r) => r.id);

    expect(ids).toContain('shared-1');
    expect(ids).toContain('owned-by-a');
    expect(ids).not.toContain('owned-by-b');
  });

  it('stamps the permission basis on each returned hit', async () => {
    mockChroma();
    const results = await new RagService('http://chroma.test').search('note', 'kb', 5, aliceContext);
    const byId = Object.fromEntries(results.map((r) => [r.id, r.permissionBasis]));

    expect(byId['shared-1']).toBe('public');
    expect(byId['owned-by-a']).toBe('owner');
  });

  it('without a context, search() applies NO permission filter (backward compatible)', async () => {
    mockChroma();
    const results = await new RagService('http://chroma.test').search('note', 'kb', 5);
    expect(results.map((r) => r.id)).toEqual(['shared-1', 'owned-by-a', 'owned-by-b']);
    expect(results[0].permissionBasis).toBeUndefined();
  });

  it('an operator context bypasses ACLs and sees every chunk', async () => {
    mockChroma();
    const results = await new RagService('http://chroma.test').search('note', 'kb', 5, {
      userSub: 'root',
      isOperator: true,
      allowPublic: true,
    });
    expect(results.map((r) => r.id)).toContain('owned-by-b');
  });

  it('applyRagPermission caps at topK after filtering', () => {
    const hits = [
      { id: '1', metadata: {} },
      { id: '2', metadata: {} },
      { id: '3', metadata: { owner_sub: 'someone-else' } },
      { id: '4', metadata: {} },
    ];
    const kept = applyRagPermission(hits, aliceContext, 2);
    expect(kept.map((h) => h.id)).toEqual(['1', '2']);
  });
});
