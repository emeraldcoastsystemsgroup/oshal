/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B guards (step B5-6) for the Chroma branch of RagService.deleteDocumentChunks, the live engine, with Chroma faked at the fetch layer in the shapes Chroma 0.4.24 answers: the delete goes to the collection's /delete with exactly { where: { knowledge_id } } (never an empty where, which would wipe the collection) and reports the deleted ids' count; an absent collection answers 0 whether Chroma says 404 or 0.4's 500 "does not exist"; any other failure throws so the route keeps the record; deleteCollection treats 0.4's 500 "does not exist" as already absent too. Each fails on the tree before the fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/rag/services/local-embedding-service', () => ({
  localEmbeddings: { embed: vi.fn(async () => null), isEnabled: () => false, enabled: () => false },
}));

import { RagService, isChromaAbsentCollection } from '@/features/rag/services/rag-service';

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Chroma faked at the fetch layer: the collection lookup and the delete, in 0.4.24's shapes. */
function fakeChroma(options: { lookup: 'ok' | '404' | '500-absent' | '500-other'; deleted?: unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (/\/api\/v1\/collections\/[^/]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
      if (options.lookup === 'ok') return new Response(JSON.stringify({ id: 'col-uuid-1', name: 'swarm-knowledge' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (options.lookup === '404') return new Response('not found', { status: 404 });
      if (options.lookup === '500-absent') return new Response(JSON.stringify({ error: "ValueError('Collection swarm-knowledge does not exist.')" }), { status: 500 });
      return new Response(JSON.stringify({ error: 'InternalError' }), { status: 500 });
    }
    if (/\/api\/v1\/collections\/col-uuid-1\/delete$/.test(url)) {
      return new Response(JSON.stringify(options.deleted ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/api\/v1\/collections\/[^/]+$/.test(url) && init?.method === 'DELETE') {
      if (options.lookup === '500-absent') return new Response(JSON.stringify({ error: "ValueError('Collection swarm-knowledge does not exist.')" }), { status: 500 });
      if (options.lookup === '500-other') return new Response('boom', { status: 500 });
      return new Response('', { status: options.lookup === '404' ? 404 : 200 });
    }
    return new Response('unexpected', { status: 599 });
  }));
}

beforeEach(() => { calls.length = 0; vi.stubEnv('RAG_ENGINE', 'chroma'); });
afterEach(() => { vi.stubGlobal('fetch', realFetch); vi.unstubAllEnvs(); });

describe('RagService.deleteDocumentChunks on Chroma', () => {
  it('deletes by exactly { where: { knowledge_id } } on the collection id and reports the deleted count', async () => {
    fakeChroma({ lookup: 'ok', deleted: ['a-0', 'a-1', 'a-2'] });
    const service = new RagService('http://chroma.test:8000');
    expect(await service.deleteDocumentChunks('swarm-knowledge', '11111111-1111-4111-8111-111111111111')).toBe(3);
    const del = calls.find((c) => c.url.endsWith('/collections/col-uuid-1/delete'));
    expect(del?.method).toBe('POST');
    expect(del?.body).toEqual({ where: { knowledge_id: '11111111-1111-4111-8111-111111111111' } });
    expect(calls.map((c) => c.url)).toEqual(['http://chroma.test:8000/api/v1/collections/swarm-knowledge', 'http://chroma.test:8000/api/v1/collections/col-uuid-1/delete']);
  });

  it('answers null when Chroma does not report the deleted ids, and 0 when nothing matched', async () => {
    fakeChroma({ lookup: 'ok', deleted: { ok: true } });
    expect(await new RagService('http://chroma.test:8000').deleteDocumentChunks('swarm-knowledge', '11111111-1111-4111-8111-111111111111')).toBeNull();
    fakeChroma({ lookup: 'ok', deleted: [] });
    expect(await new RagService('http://chroma.test:8000').deleteDocumentChunks('swarm-knowledge', '11111111-1111-4111-8111-111111111111')).toBe(0);
  });

  it('treats an absent collection as 0 chunks, whether Chroma says 404 or 0.4\'s 500 "does not exist", and throws on any other failure', async () => {
    fakeChroma({ lookup: '404' });
    expect(await new RagService('http://chroma.test:8000').deleteDocumentChunks('swarm-knowledge', '11111111-1111-4111-8111-111111111111')).toBe(0);
    fakeChroma({ lookup: '500-absent' });
    expect(await new RagService('http://chroma.test:8000').deleteDocumentChunks('swarm-knowledge', '11111111-1111-4111-8111-111111111111')).toBe(0);
    expect(calls.some((c) => c.url.endsWith('/delete'))).toBe(false);
    fakeChroma({ lookup: '500-other' });
    await expect(new RagService('http://chroma.test:8000').deleteDocumentChunks('swarm-knowledge', '11111111-1111-4111-8111-111111111111')).rejects.toThrow(/lookup error: 500/);
  });

  it('deleteCollection treats 0.4\'s 500 "does not exist" as already absent, and still throws on other failures', async () => {
    fakeChroma({ lookup: '500-absent' });
    await expect(new RagService('http://chroma.test:8000').deleteCollection('swarm-knowledge')).resolves.toBeUndefined();
    fakeChroma({ lookup: '500-other' });
    await expect(new RagService('http://chroma.test:8000').deleteCollection('swarm-knowledge')).rejects.toThrow(/delete error: 500/);
    expect(isChromaAbsentCollection(404, '')).toBe(true);
    expect(isChromaAbsentCollection(500, "ValueError('Collection x does not exist.')")).toBe(true);
    expect(isChromaAbsentCollection(500, 'InternalError')).toBe(false);
  });
});
