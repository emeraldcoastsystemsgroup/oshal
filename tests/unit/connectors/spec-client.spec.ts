/**
 * Connector spec generator conformance (ADR-065 Phase 2).
 *
 * Proves the doc->client loop: a declarative ConnectorSpec (incl. the real swarm-apps/connectors/*.yaml
 * files) builds into a working client whose calls bind {placeholders}, inject the declared auth, and
 * paginate per the declared strategy — with no bespoke per-connector HTTP code. All against a mock
 * fetch, no live credentials.
 *
 * @module tests/unit/connectors/spec-client
 */
import { join } from 'path';
import { describe, it, expect, vi } from 'vitest';
import { buildClientFromSpec, loadConnectorSpec, validateSpec, type ConnectorSpec } from '@/app/connectors/runtime';

function mockFetch(seq: Array<{ status: number; body?: any; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i += 1;
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => text, headers: { get: (k: string) => (r.headers || {})[k.toLowerCase()] ?? null } } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('buildClientFromSpec', () => {
  it('binds path, query, and body placeholders and injects a bearer token', async () => {
    const spec: ConnectorSpec = {
      provider: 'demo', baseUrl: 'https://api.demo.dev/v1', auth: { type: 'oauth2' },
      resources: [{ name: 'create', method: 'POST', path: '/users/{userId}/items', query: { tag: '{tag}' }, body: { name: '{name}', tags: '{tags}' } }],
    };
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const c = buildClientFromSpec(spec, { token: async () => 'TKN', fetchImpl: fn });
    await c.call('create', { userId: 'u 1', tag: 'x', name: 'Mix', tags: ['a', 'b'] });
    expect(calls[0].url).toBe('https://api.demo.dev/v1/users/u%201/items?tag=x'); // path encoded, query bound
    expect(calls[0].init.headers.Authorization).toBe('Bearer TKN');
    expect(JSON.parse(calls[0].init.body)).toEqual({ name: 'Mix', tags: ['a', 'b'] }); // whole-value bind keeps the array
  });

  it('sends spec-level + per-resource headers (templated), resource overriding spec', async () => {
    const spec: ConnectorSpec = {
      provider: 'notion', baseUrl: 'https://api.notion.com/v1', auth: { type: 'oauth2' },
      headers: { 'Notion-Version': '2022-06-28', 'X-Trace': 'spec' },
      resources: [{ name: 'get', method: 'GET', path: '/pages/{id}', headers: { 'X-Trace': '{trace}' } }],
    };
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const c = buildClientFromSpec(spec, { token: async () => 'T', fetchImpl: fn });
    await c.call('get', { id: 'p1', trace: 'req42' });
    expect(calls[0].init.headers['Notion-Version']).toBe('2022-06-28'); // global header applied
    expect(calls[0].init.headers['X-Trace']).toBe('req42');             // resource header overrides + templated
  });

  it('apiKeyQuery auth appends the key from build-time creds (not the spec)', async () => {
    const spec: ConnectorSpec = {
      provider: 'tmdb', baseUrl: 'https://api.themoviedb.org/3', auth: { type: 'apiKeyQuery', param: 'api_key' },
      resources: [{ name: 'search', method: 'GET', path: '/search/movie', query: { query: '{query}' } }],
    };
    const { fn, calls } = mockFetch([{ status: 200, body: { results: [] } }]);
    const c = buildClientFromSpec(spec, { apiKeyValue: 'KEY123', fetchImpl: fn });
    await c.call('search', { query: 'dune' });
    expect(calls[0].url).toContain('query=dune');
    expect(calls[0].url).toContain('api_key=KEY123');
  });

  it('paginates offset-style across pages and flattens the declared items field', async () => {
    const spec: ConnectorSpec = {
      provider: 'demo', baseUrl: 'https://api.demo.dev', auth: { type: 'none' },
      pagination: { strategy: 'offset', param: 'page', pageSize: 1, nextField: 'next_page', itemsField: 'results' },
      resources: [{ name: 'list', method: 'GET', path: '/list', paginate: true }],
    };
    const { fn } = mockFetch([
      { status: 200, body: { results: [{ id: 1 }, { id: 2 }], next_page: 2 } },
      { status: 200, body: { results: [{ id: 3 }], next_page: 0 } }, // next_page falsy => last
    ]);
    const c = buildClientFromSpec(spec, { fetchImpl: fn });
    const all = await c.call<Array<{ id: number }>>('list');
    expect(all.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it('exposes declared bot tools', () => {
    const spec: ConnectorSpec = {
      provider: 'demo', baseUrl: 'https://x.dev', auth: { type: 'none' },
      resources: [{ name: 'a', tool: 'demo-a', method: 'GET', path: '/a' }, { name: 'b', method: 'GET', path: '/b' }],
    };
    const c = buildClientFromSpec(spec, {});
    expect(c.tools()).toEqual([{ tool: 'demo-a', resource: 'a' }]);
  });

  it('rejects an invalid spec', () => {
    expect(() => validateSpec({ provider: 'X', baseUrl: 'ftp://x', auth: {}, resources: [] })).toThrow(/invalid connector spec/);
  });

  it('loads the real spotify.yaml and drives a call from it', async () => {
    const spec = loadConnectorSpec(join(process.cwd(), 'swarm-apps/connectors/spotify.yaml'));
    expect(spec.provider).toBe('spotify');
    expect(spec.auth.type).toBe('oauth2');
    const { fn, calls } = mockFetch([{ status: 200, body: { tracks: { items: [] } } }]);
    const c = buildClientFromSpec(spec, { token: async () => 'SPOT', fetchImpl: fn });
    await c.call('search-tracks', { query: 'jazz', limit: 5, market: 'US' });
    expect(calls[0].url).toContain('https://api.spotify.com/v1/search');
    expect(calls[0].url).toContain('q=jazz');
    expect(calls[0].init.headers.Authorization).toBe('Bearer SPOT');
    // the create-playlist resource opts out of retries (duplicate-write safe)
    expect(spec.resources.find((r) => r.name === 'create-playlist')?.retry?.maxRetries).toBe(0);
  });

  it('loads the real tmdb.yaml (apiKeyQuery + offset pagination shape)', async () => {
    const spec = loadConnectorSpec(join(process.cwd(), 'swarm-apps/connectors/tmdb.yaml'));
    expect(spec.provider).toBe('tmdb');
    expect(spec.auth).toMatchObject({ type: 'apiKeyQuery', param: 'api_key' });
    expect(spec.pagination).toMatchObject({ strategy: 'offset', itemsField: 'results' });
  });
});
