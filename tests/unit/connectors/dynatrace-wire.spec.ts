/**
 * Dynatrace connector wire conformance (ADR-069 Phase 1 — the reference observability connector).
 *
 * Proves the REAL swarm-apps/connectors/dynatrace.yaml drives correct Environment API v2 requests
 * through the shared runtime — no network, no live creds:
 *   - GET-only catalog (read product; problems / entities / metrics / metric-query / events),
 *   - the Authorization header carries the pasted "Api-Token <token>" value verbatim,
 *   - per-tenant base host from DYNATRACE_BASE_URL,
 *   - nextPageKey cursor pagination where follow-up pages send ONLY the cursor (Dynatrace rejects
 *     nextPageKey combined with the original query params — the cursorOnly contract).
 *
 * @module tests/unit/connectors/dynatrace-wire
 */
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { auditSpec, buildClientFromSpec, loadConnectorSpec } from '@/app/connectors/runtime';

const SPEC_PATH = path.join(process.cwd(), 'swarm-apps/connectors', 'dynatrace.yaml');
const TENANT_BASE = 'https://abc12345.live.dynatrace.com/api/v2';
// Stand-in credential for wire assertions only — NOT a real token (real ones are dt0c01.<24>.<64>).
const PASTED_KEY = 'Api-Token dt0c01.SAMPLE.FAKE';

/** Serialize exactly like the runtime's buildUrl (URLSearchParams form-encoding, not encodeURIComponent). */
function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function mockFetch(seq: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
      headers: { get: () => null },
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe('dynatrace connector over the runtime', () => {
  let savedBase: string | undefined;
  beforeEach(() => { savedBase = process.env.DYNATRACE_BASE_URL; process.env.DYNATRACE_BASE_URL = TENANT_BASE; });
  afterEach(() => {
    if (savedBase === undefined) delete process.env.DYNATRACE_BASE_URL;
    else process.env.DYNATRACE_BASE_URL = savedBase;
  });

  it('is a GET-only read catalog covering the ADR-069 surface and passes the audit gate', () => {
    const spec = loadConnectorSpec(SPEC_PATH);
    expect(spec.resources.every((r) => r.method === 'GET')).toBe(true);
    expect(spec.resources.map((r) => r.name)).toEqual(
      expect.arrayContaining(['problems', 'problem', 'entities', 'metrics', 'metric-query', 'events']),
    );
    expect(auditSpec(spec).pass).toBe(true);
  });

  it('problems: binds selectors, sends the pasted Api-Token value verbatim, and paginates cursor-only', async () => {
    const spec = loadConnectorSpec(SPEC_PATH);
    const { fn, calls } = mockFetch([
      { status: 200, body: { nextPageKey: 'NEXT1', problems: [{ problemId: 'P-1' }] } },
      { status: 200, body: { nextPageKey: null, problems: [{ problemId: 'P-2' }] } },
    ]);
    const c = buildClientFromSpec(spec, { apiKeyValue: PASTED_KEY, fetchImpl: fn });

    const rows = await c.call('problems', { from: 'now-2h', to: 'now', problemSelector: 'status("OPEN")' });

    expect(rows.map((p: any) => p.problemId)).toEqual(['P-1', 'P-2']);
    // First page: tenant host + the bound selectors.
    expect(calls[0].url).toContain(`${TENANT_BASE}/problems?`);
    expect(calls[0].url).toContain('from=now-2h');
    expect(calls[0].url).toContain(qs({ problemSelector: 'status("OPEN")' }));
    // The credential is the full pasted header value — scheme prefix included, nothing added by us.
    expect(calls[0].init.headers.Authorization).toBe(PASTED_KEY);
    // Follow-up page: ONLY nextPageKey — Dynatrace 400s when the cursor rides with other params.
    expect(calls[1].url).toContain('nextPageKey=NEXT1');
    expect(calls[1].url).not.toContain('from=');
    expect(calls[1].url).not.toContain('problemSelector=');
  });

  it('metric-query: binds metricSelector/resolution/timeframe onto /metrics/query', async () => {
    const spec = loadConnectorSpec(SPEC_PATH);
    const { fn, calls } = mockFetch([{ status: 200, body: { result: [] } }]);
    const c = buildClientFromSpec(spec, { apiKeyValue: PASTED_KEY, fetchImpl: fn });

    await c.call('metric-query', {
      metricSelector: 'builtin:host.cpu.usage', from: 'now-1h', to: 'now', resolution: '5m',
    });

    expect(calls[0].url).toContain(`${TENANT_BASE}/metrics/query?`);
    expect(calls[0].url).toContain(qs({ metricSelector: 'builtin:host.cpu.usage' }));
    expect(calls[0].url).toContain('resolution=5m');
  });

  it('single problem + entities + events: path/selector binding stays on the v2 read surface', async () => {
    const spec = loadConnectorSpec(SPEC_PATH);
    const { fn, calls } = mockFetch([{ status: 200, body: {} }]);
    const c = buildClientFromSpec(spec, { apiKeyValue: PASTED_KEY, fetchImpl: fn });

    await c.call('problem', { problemId: 'P-42' });
    await c.call('entities', { entitySelector: 'type("HOST")', from: 'now-24h' });
    await c.call('events', { from: 'now-6h', to: 'now', eventSelector: 'eventType("CUSTOM_ALERT")' });

    expect(calls[0].url).toBe(`${TENANT_BASE}/problems/P-42`);
    expect(calls[1].url).toContain(`${TENANT_BASE}/entities?`);
    expect(calls[1].url).toContain(qs({ entitySelector: 'type("HOST")' }));
    expect(calls[2].url).toContain(`${TENANT_BASE}/events?`);
    expect(calls[2].url).toContain(qs({ eventSelector: 'eventType("CUSTOM_ALERT")' }));
    for (const call of calls) expect(call.init.headers.Authorization).toBe(PASTED_KEY);
  });
});
