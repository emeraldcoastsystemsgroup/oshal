/**
 * Connector runtime conformance suite (ADR-065).
 *
 * This is the contract EVERY connector inherits by building on ConnectorClient: consistent auth
 * injection, refresh-on-401, retry/backoff honoring Retry-After, a rate-limit governor, structured
 * ConnectorError classification, and pagination. It runs entirely against a mock fetch + injected
 * clock/sleep — no network, no live credentials — so it's CI-safe and is the gate a connector must
 * pass before it counts as "hardened" in the catalog.
 *
 * @module tests/unit/connectors/connector-runtime
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectorClient, ConnectorError } from '@/app/connectors/runtime';

/** Build a mock fetch that returns a queued sequence of responses (status + body + headers). */
function mockFetch(seq: Array<{ status: number; body?: any; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i += 1;
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => text,
      headers: { get: (k: string) => (r.headers || {})[k.toLowerCase()] ?? (r.headers || {})[k] ?? null },
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** Deterministic, instant test harness: monotonically increasing clock, no-op sleep that records waits. */
function harness(seq: Parameters<typeof mockFetch>[0], extra?: Partial<ConstructorParameters<typeof ConnectorClient>[0]>) {
  const { fn, calls } = mockFetch(seq);
  const waits: number[] = [];
  let t = 0;
  const tokenCalls: Array<{ force?: boolean }> = [];
  const client = new ConnectorClient({
    provider: 'test',
    baseUrl: 'https://api.test.dev/v1',
    auth: { type: 'bearer', token: async (o) => { tokenCalls.push(o || {}); return o?.force ? 'TOKEN_2' : 'TOKEN_1'; } },
    retry: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 1000, honorRetryAfter: true },
    fetchImpl: fn,
    now: () => (t += 10),
    sleep: async (ms) => { waits.push(ms); },
    ...extra,
  });
  return { client, calls, waits, tokenCalls };
}

describe('ConnectorClient conformance', () => {
  it('GET happy path parses JSON and injects the bearer token', async () => {
    const { client, calls } = harness([{ status: 200, body: { ok: true, n: 7 } }]);
    const res = await client.request<{ ok: boolean; n: number }>('/thing');
    expect(res).toEqual({ ok: true, n: 7 });
    expect(calls[0].url).toBe('https://api.test.dev/v1/thing');
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOKEN_1');
  });

  it('forces a token refresh on 401 and retries once with the new token', async () => {
    const { client, calls, tokenCalls } = harness([{ status: 401, body: 'expired' }, { status: 200, body: { ok: true } }]);
    const res = await client.request('/secure');
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOKEN_1');
    expect(calls[1].init.headers.Authorization).toBe('Bearer TOKEN_2'); // forced refresh
    expect(tokenCalls.some((c) => c.force)).toBe(true);
  });

  it('retries on 429 honoring Retry-After', async () => {
    const { client, waits, calls } = harness([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true } }]);
    const res = await client.request('/throttled');
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(2000); // honored the 2s Retry-After
  });

  it('retries 5xx up to the budget then throws a retriable server ConnectorError', async () => {
    const { client, calls } = harness([{ status: 500 }, { status: 500 }, { status: 500 }]); // maxRetries=2 => 3 attempts
    await expect(client.request('/flaky')).rejects.toMatchObject({ name: 'ConnectorError', code: 'server', retriable: true });
    expect(calls).toHaveLength(3);
  });

  it('does NOT retry a 4xx client error and classifies it', async () => {
    const { client, calls } = harness([{ status: 400, body: 'bad input' }]);
    const err = await client.request('/bad').catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe('bad_request');
    expect(err.retriable).toBe(false);
    expect(calls).toHaveLength(1); // no retry
  });

  it('retries on a network throw', async () => {
    const waits: number[] = [];
    let t = 0;
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNRESET');
      return { status: 200, ok: true, text: async () => JSON.stringify({ ok: true }), headers: { get: () => null } } as any;
    });
    const client = new ConnectorClient({ provider: 'test', baseUrl: 'https://x.dev', auth: { type: 'none' }, retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, honorRetryAfter: true }, fetchImpl: fn as any, now: () => (t += 1), sleep: async (ms) => { waits.push(ms); } });
    expect(await client.request('/x')).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('rate-limit governor waits when the burst bucket is empty', async () => {
    const seq = Array.from({ length: 3 }, () => ({ status: 200, body: { ok: true } }));
    const { client, waits } = harness(seq, { rateLimit: { burst: 1, perSecond: 1 } });
    await client.request('/a'); await client.request('/b'); await client.request('/c');
    expect(waits.length).toBeGreaterThanOrEqual(1); // second/third call had to wait on the bucket
  });

  it('apiKeyQuery auth appends the key to the URL', async () => {
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const client = new ConnectorClient({ provider: 'tmdb', baseUrl: 'https://api.tmdb.dev/3', auth: { type: 'apiKeyQuery', param: 'api_key', value: 'SECRET' }, fetchImpl: fn, now: () => 1, sleep: async () => {} });
    await client.request('/movie/popular', { query: { page: 1 } });
    expect(calls[0].url).toContain('page=1');
    expect(calls[0].url).toContain('api_key=SECRET');
  });

  it('emptyOk maps a 204 to {}', async () => {
    const { client } = harness([{ status: 204 }]);
    expect(await client.request('/now-playing', { emptyOk: [204] })).toEqual({});
  });

  it('paginate follows a cursor across pages and flattens items', async () => {
    const { client } = harness([
      { status: 200, body: { items: [{ id: 1 }, { id: 2 }], next: 'https://api.test.dev/v1/list?offset=2', offset: 0 } },
      { status: 200, body: { items: [{ id: 3 }], next: null, offset: 2 } },
    ]);
    const all = await client.paginate<{ id: number }>('/list', { type: 'cursor', param: 'offset', nextFrom: (p) => (p?.next ? String((p.offset || 0) + (p.items?.length || 0)) : null) });
    expect(all.map((x) => x.id)).toEqual([1, 2, 3]);
  });
});
