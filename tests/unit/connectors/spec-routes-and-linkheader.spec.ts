/**
 * Phase 5 conformance: Link-header pagination, bare-array extract, and the spec->routes bridge (ADR-065).
 *
 * Proves GitHub-class APIs (Link header + bare-array list bodies) paginate correctly, and that a spec
 * becomes a live, error-mapped HTTP surface via invokeSpecResource — all against a mock fetch.
 *
 * @module tests/unit/connectors/spec-routes-and-linkheader
 */
import { describe, it, expect, vi } from 'vitest';
import { buildClientFromSpec, invokeSpecResource, parseNextLink, type ConnectorSpec } from '@/app/connectors/runtime';

/** Mock fetch with per-response status/body/headers (headers needed for Link pagination). */
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

describe('parseNextLink', () => {
  it('extracts rel="next" from an RFC-5988 Link header and ignores prev/last', () => {
    const h = '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"';
    expect(parseNextLink(h)).toBe('https://api.github.com/user/repos?page=2');
    expect(parseNextLink('<https://x/?page=1>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe('link-header pagination (GitHub-style)', () => {
  const spec: ConnectorSpec = {
    provider: 'github', baseUrl: 'https://api.github.com', auth: { type: 'oauth2' },
    headers: { Accept: 'application/vnd.github+json' },
    pagination: { strategy: 'link-header', itemsField: 'items' },
    resources: [
      { name: 'list-repos', method: 'GET', path: '/user/repos', paginate: true },          // bare array body
      { name: 'search-issues', method: 'GET', path: '/search/issues', paginate: true },     // {items:[...]} body
    ],
  };

  it('follows the Link header across pages for a bare-array body', async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: [{ id: 1 }, { id: 2 }], headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } },
      { status: 200, body: [{ id: 3 }], headers: {} }, // no Link => last page
    ]);
    const c = buildClientFromSpec(spec, { token: async () => 'GH', fetchImpl: fn });
    const all = await c.call<Array<{ id: number }>>('list-repos');
    expect(all.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(calls[0].init.headers.Accept).toBe('application/vnd.github+json');
    expect(calls[1].url).toContain('page=2'); // second request followed the Link header
  });

  it('follows the Link header across pages for an {items} body', async () => {
    const { fn } = mockFetch([
      { status: 200, body: { items: [{ id: 1 }] }, headers: { link: '<https://api.github.com/search/issues?page=2>; rel="next"' } },
      { status: 200, body: { items: [{ id: 2 }] }, headers: {} },
    ]);
    const c = buildClientFromSpec(spec, { token: async () => 'GH', fetchImpl: fn });
    const all = await c.call<Array<{ id: number }>>('search-issues', { query: 'bug' });
    expect(all.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe('spec->routes bridge (invokeSpecResource)', () => {
  const spec: ConnectorSpec = {
    provider: 'demo', baseUrl: 'https://api.demo.dev', auth: { type: 'oauth2' },
    resources: [
      { name: 'get-thing', method: 'GET', path: '/things/{id}' },
      { name: 'create-thing', method: 'POST', path: '/things', body: { name: '{name}' }, retry: { maxRetries: 0 } },
    ],
  };

  it('returns 200 + data for a successful resource call', async () => {
    const { fn } = mockFetch([{ status: 200, body: { id: 'x', name: 'Thing' } }]);
    const r = await invokeSpecResource(spec, { token: async () => 'T', fetchImpl: fn }, 'get-thing', { id: 'x' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, data: { id: 'x', name: 'Thing' } });
  });

  it('maps an unknown resource to 404', async () => {
    const r = await invokeSpecResource(spec, { token: async () => 'T' }, 'nope', {});
    expect(r.status).toBe(404);
    expect(r.body.ok).toBe(false);
  });

  it('maps a provider 4xx to a ConnectorError-coded response', async () => {
    const { fn } = mockFetch([{ status: 400, body: 'bad' }]);
    const r = await invokeSpecResource(spec, { token: async () => 'T', fetchImpl: fn }, 'get-thing', { id: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_request');
  });

  it('maps a missing token (not connected) to 401', async () => {
    const { fn } = mockFetch([{ status: 200, body: {} }]);
    const r = await invokeSpecResource(spec, { token: async () => null, fetchImpl: fn }, 'get-thing', { id: 'x' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('auth');
  });

  it('dry-runs a write connector resource without hitting the provider', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { id: 'created' } }]);
    const r = await invokeSpecResource(spec, { token: async () => 'T', fetchImpl: fn }, 'create-thing', { name: 'Preview', dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect((r.body.data as any).dryRun).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('requires explicit confirmation before executing a mutating connector resource', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { id: 'created' } }]);
    const blocked = await invokeSpecResource(spec, { token: async () => 'T', fetchImpl: fn }, 'create-thing', { name: 'Nope' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('confirmation_required');
    expect(calls).toHaveLength(0);

    const confirmed = await invokeSpecResource(spec, { token: async () => 'T', fetchImpl: fn }, 'create-thing', { name: 'Ok', confirm: true });
    expect(confirmed.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
