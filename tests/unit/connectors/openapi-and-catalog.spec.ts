/**
 * Phase 3 conformance: OpenAPI import, doc generation, and the catalog audit gate (ADR-065).
 *
 * Proves the breadth + quality machine end to end against the REAL swarm-apps/connectors/*.yaml and a
 * fixture OpenAPI doc — no network, no live creds. An imported OpenAPI spec must build into a working
 * client; the catalog audit must pass the shipped specs; docs must derive from the spec.
 *
 * @module tests/unit/connectors/openapi-and-catalog
 */
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { specFromOpenApi, specToMarkdown, auditSpec, auditConnectorCatalog, buildClientFromSpec, loadConnectorSpec, type ConnectorSpec } from '@/app/connectors/runtime';

const connectorPath = (slug: string) => path.join(process.cwd(), 'swarm-apps/connectors', `${slug}.yaml`);

function mockFetch(body: any) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = vi.fn(async (url: string, init: any) => { calls.push({ url, init }); return { status: 200, ok: true, text: async () => JSON.stringify(body), headers: { get: () => null } } as any; });
  return { fn: fn as unknown as typeof fetch, calls };
}

const OPENAPI_FIXTURE = {
  info: { title: 'Acme API', version: '2026.1', description: 'Acme widgets and orders.' },
  servers: [{ url: 'https://api.acme.dev/v2' }],
  components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
  tags: [{ name: 'Widgets' }],
  paths: {
    '/widgets': { get: { operationId: 'listWidgets', tags: ['Catalog'], parameters: [{ name: 'limit', in: 'query' }, { name: 'q', in: 'query' }] } },
    '/widgets/{id}': { get: { operationId: 'getWidget', tags: ['Catalog'], parameters: [{ name: 'id', in: 'path', required: true }] } },
    '/widgets/{id}/orders': { post: { operationId: 'createOrder', tags: ['Orders'], requestBody: { content: {} } } },
  },
};

describe('specFromOpenApi', () => {
  it('maps servers/security/paths into a buildable ConnectorSpec', () => {
    const { spec, warnings } = specFromOpenApi('acme', OPENAPI_FIXTURE);
    expect(spec.baseUrl).toBe('https://api.acme.dev/v2');
    expect(spec.auth).toMatchObject({ type: 'apiKeyHeader', header: 'X-Api-Key' });
    const names = spec.resources.map((r) => r.name);
    expect(names).toEqual(['listWidgets', 'getWidget', 'createOrder']);
    expect(spec.resources.map((r) => r.tool)).toEqual(['acme-list-widgets', 'acme-get-widget', 'acme-create-order']);
    expect(spec.resources.find((r) => r.name === 'listWidgets')?.query).toEqual({ limit: '{limit}', q: '{q}' });
    // non-GET defaults to no auto-retry + opaque body warning
    expect(spec.resources.find((r) => r.name === 'createOrder')?.retry).toEqual({ maxRetries: 0 });
    expect(spec.resources.find((r) => r.name === 'createOrder')?.safety).toMatchObject({ action: 'write', requiresConfirmation: true });
    expect(spec.metadata).toMatchObject({ tags: ['catalog', 'orders', 'widgets'] });
    expect(warnings.some((w) => /opaque/.test(w))).toBe(true);
  });

  it('an imported spec actually drives a real request', async () => {
    const { spec } = specFromOpenApi('acme', OPENAPI_FIXTURE);
    const { fn, calls } = mockFetch({ ok: true });
    const c = buildClientFromSpec(spec, { apiKeyValue: 'K', fetchImpl: fn });
    await c.call('getWidget', { id: 'w42' });
    expect(calls[0].url).toBe('https://api.acme.dev/v2/widgets/w42');
    expect(calls[0].init.headers['X-Api-Key']).toBe('K');
  });

  it('warns (not crashes) on a doc with no servers and no security', () => {
    const { spec, warnings } = specFromOpenApi('bare', { paths: { '/x': { get: {} } } });
    expect(spec.baseUrl).toBe('');
    expect(spec.auth.type).toBe('none');
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(spec.resources[0].name).toBe('get-x'); // name synthesized from method+path
  });
});

describe('specToMarkdown', () => {
  it('renders auth, resources, inputs, and tools from the spec', () => {
    const spec: ConnectorSpec = {
      provider: 'demo', displayName: 'Demo', baseUrl: 'https://x.dev', auth: { type: 'oauth2', scopes: ['read'] },
      rateLimit: { burst: 5, perSecond: 5 },
      resources: [{ name: 'search', tool: 'demo-search', method: 'GET', path: '/search', query: { q: '{query}' } }],
    };
    const md = specToMarkdown(spec);
    expect(md).toContain('# Demo connector');
    expect(md).toContain('OAuth2 (bearer)');
    expect(md).toContain('`demo-search`');
    expect(md).toContain('`query`');     // bound input surfaced
  });
});

describe('catalog audit gate', () => {
  it('passes a well-formed spec and flags real problems', () => {
    const bad: ConnectorSpec = {
      provider: 'bad', baseUrl: 'https://x.dev', auth: { type: 'none' },
      resources: [
        { name: 'a', tool: 'dup', method: 'GET', path: '/a' },
        { name: 'b', tool: 'dup', method: 'GET', path: '/b' },          // duplicate tool => error
        { name: 'c', method: 'GET', path: '/c', paginate: true },        // paginate without pagination block => error
      ],
    };
    const audit = auditSpec(bad);
    expect(audit.pass).toBe(false);
    expect(audit.issues.some((i) => i.level === 'error' && /duplicate tool/.test(i.message))).toBe(true);
    expect(audit.issues.some((i) => i.level === 'error' && /paginate/.test(i.message))).toBe(true);
  });

  it('the shipped connector catalog passes the gate', () => {
    const audits = auditConnectorCatalog();
    expect(audits.length).toBeGreaterThanOrEqual(2); // spotify + tmdb
    for (const a of audits) {
      if (!a.pass) console.error(a.provider, a.issues);
      expect(a.pass).toBe(true);
    }
    expect(audits.map((a) => a.provider).sort()).toEqual(expect.arrayContaining(['spotify', 'tmdb']));
  });

  it('includes the ADR-069 operations + SecOps connectors', () => {
    const providers = auditConnectorCatalog().map((a) => a.provider);
    expect(providers).toEqual(expect.arrayContaining([
      'dynatrace', 'servicenow', 'datadog', 'newrelic', 'sentinel', 'virustotal', 'elastic-security',
      'tenable', 'defender-cloud',
    ]));
  });
});

describe('per-tenant ${env:...} interpolation (ADR-069)', () => {
  const ENV_KEYS = ['DYNATRACE_BASE_URL', 'AZURE_SUBSCRIPTION_ID', 'SENTINEL_RESOURCE_GROUP', 'SENTINEL_WORKSPACE'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('resolves a per-tenant baseUrl from env when set', () => {
    process.env.DYNATRACE_BASE_URL = 'https://abc12345.live.dynatrace.com/api/v2';
    expect(loadConnectorSpec(connectorPath('dynatrace')).baseUrl).toBe('https://abc12345.live.dynatrace.com/api/v2');
  });

  it('falls back to the inline default when the env var is unset (keeps the audit gate green)', () => {
    const spec = loadConnectorSpec(connectorPath('dynatrace'));
    expect(spec.baseUrl).toMatch(/^https:\/\/.*live\.dynatrace\.com\/api\/v2$/);
    expect(auditSpec(spec).pass).toBe(true);
  });

  it('interpolates env tokens inside a resource path (Sentinel workspace coordinates)', () => {
    process.env.AZURE_SUBSCRIPTION_ID = 'sub-123';
    process.env.SENTINEL_RESOURCE_GROUP = 'rg-sec';
    process.env.SENTINEL_WORKSPACE = 'ws-soc';
    const incident = loadConnectorSpec(connectorPath('sentinel')).resources.find((r) => r.name === 'incident');
    expect(incident?.path).toContain('/subscriptions/sub-123/resourceGroups/rg-sec/');
    expect(incident?.path).toContain('/workspaces/ws-soc/');
  });

  it('leaves single-brace {placeholder} runtime tokens untouched', () => {
    const incident = loadConnectorSpec(connectorPath('sentinel')).resources.find((r) => r.name === 'incident');
    expect(incident?.path).toContain('{incidentId}'); // bound at call time, not at load
  });
});
