/**
 * Write-capable connector action tier (connector-writes): schema validation, approval gating,
 * execution, and the connector_action_audit row shape — all against mocked fetch + pg.
 *
 * Proves the fail-closed ordering the tier promises: params are validated before any HTTP work,
 * riskLevel medium/high (or approvalRequired) refuses without confirm:true AND sends nothing to
 * the provider, and every attempt lands exactly one audit row whatever the outcome.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit coverage for action-params, action-executor, the extended connector.schema.json contract in spec.ts, and the live github/todoist action declarations.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review-fix coverage: broker-only resolveConnectorActionCreds (no CONNECTOR_* env fallback), lazy creds resolution (never before validation/confirm gate, resolver failures audited 401 not unaudited 500), and the fail-closed pre-write 'attempt' audit row (audit trail down => 503 refusal, no provider traffic).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guarded the spec-resource create-issue duplicate as an explicit confirmation-gated write
 *
 * @module tests/unit/connectors/connector-action-tier
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  actionProfilesForSpec,
  connectorActionRequiresApproval,
  hashConnectorActionParams,
  loadConnectorSpec,
  resolveConnectorActionCreds,
  runConnectorAction,
  splitConnectorActionInputs,
  validateActionParams,
  validateSpec,
  type ConnectorSpec,
  type SpecAction,
} from '@/app/connectors/runtime';

const root = resolve(__dirname, '../../..');

/** Mock fetch capturing calls; each response is {status, body}. */
function mockFetch(seq: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i += 1;
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => text,
      headers: { get: () => null },
    } as any;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

/** Mock pg pool capturing every query; call [0] is the lazy DDL ensure, [1] the audit INSERT. */
function mockPool() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
  return { query };
}

/** Every audit INSERT in call order (executed writes land TWO: 'attempt' then the terminal row). */
function auditInserts(pool: ReturnType<typeof mockPool>): Array<{ sql: string; params: unknown[] }> {
  return pool.query.mock.calls
    .filter(([sql]) => String(sql).startsWith('INSERT INTO connector_action_audit'))
    .map(([sql, params]) => ({ sql: String(sql), params: params as unknown[] }));
}

/** The TERMINAL audit row (last insert) — the attempt's final outcome. */
function auditInsert(pool: ReturnType<typeof mockPool>): { sql: string; params: unknown[] } {
  const inserts = auditInserts(pool);
  expect(inserts.length, 'expected at least one audit INSERT').toBeGreaterThan(0);
  return inserts[inserts.length - 1];
}

const baseSpec: ConnectorSpec = {
  provider: 'demo',
  baseUrl: 'https://api.demo.test',
  auth: { type: 'oauth2' },
  resources: [{ name: 'ping', method: 'GET', path: '/ping' }],
  actions: [
    {
      name: 'create-widget',
      method: 'POST',
      urlTemplate: '/widgets',
      riskLevel: 'medium',
      description: 'create a widget',
      paramsSchema: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          count: { type: 'integer', minimum: 1, maximum: 10 },
          kind: { type: 'string', enum: ['round', 'square'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    {
      name: 'log-note',
      method: 'POST',
      urlTemplate: '/notes',
      riskLevel: 'low',
      approvalRequired: false,
      description: 'append a note',
      paramsSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    },
    {
      name: 'delete-widget',
      method: 'DELETE',
      urlTemplate: '/widgets/{id}',
      riskLevel: 'high',
      description: 'delete a widget',
      paramsSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, force: { type: 'boolean' } } },
    },
  ],
};

const creds = { token: async () => 'TOK' };
/** Lazy broker-only resolver (the shape the route passes) succeeding with the caller's token. */
const resolveCreds = async () => creds;

describe('spec-level actions validation', () => {
  it('accepts a spec with a well-formed actions block (and one with none)', () => {
    expect(() => validateSpec(baseSpec)).not.toThrow();
    expect(() => validateSpec({ ...baseSpec, actions: undefined })).not.toThrow();
  });

  it('rejects malformed action declarations loudly at load time', () => {
    const bad = (patch: Partial<SpecAction>) => ({
      ...baseSpec,
      actions: [{ ...(baseSpec.actions![0] as SpecAction), ...patch }],
    });
    expect(() => validateSpec(bad({ method: 'GET' as never }))).toThrow(/method must be POST\|PUT\|PATCH\|DELETE/);
    expect(() => validateSpec(bad({ riskLevel: 'extreme' as never }))).toThrow(/riskLevel/);
    expect(() => validateSpec(bad({ paramsSchema: undefined as never }))).toThrow(/paramsSchema required/);
    expect(() => validateSpec(bad({ name: 'Bad Name' }))).toThrow(/lowercase slug/);
    expect(() => validateSpec({ ...baseSpec, actions: [baseSpec.actions![0], baseSpec.actions![0]] })).toThrow(/duplicate action/);
  });

  it('loads the real github and todoist write actions from the catalog', () => {
    const github = loadConnectorSpec(resolve(root, 'swarm-apps/connectors/github.yaml'));
    const todoist = loadConnectorSpec(resolve(root, 'swarm-apps/connectors/todoist.yaml'));
    expect(github.actions?.map((a) => a.name)).toEqual(['create-issue', 'create-issue-comment']);
    expect(github.actions?.[0]).toMatchObject({ method: 'POST', urlTemplate: '/repos/{owner}/{repo}/issues', riskLevel: 'medium', approvalRequired: true });
    expect(todoist.actions?.map((a) => a.name)).toEqual(['create-task', 'close-task']);
    expect(connectorActionRequiresApproval(todoist.actions![0])).toBe(false); // low + approvalRequired:false
    expect(connectorActionRequiresApproval(todoist.actions![1])).toBe(true);  // medium
  });

  it('classifies the GitHub resource-tier create-issue tool as a confirmed write', () => {
    const github = loadConnectorSpec(resolve(root, 'swarm-apps/connectors/github.yaml'));
    const createIssue = actionProfilesForSpec(github).find((profile) => profile.resource === 'create-issue');
    expect(createIssue).toMatchObject({
      actionType: 'write',
      requiresConfirmation: true,
      supportsDryRun: true,
      idempotent: false,
    });
  });
});

describe('validateActionParams (draft-07 subset)', () => {
  const schema = baseSpec.actions![0].paramsSchema;

  it('passes valid params and reports nothing', () => {
    expect(validateActionParams(schema, { name: 'w1', count: 3, kind: 'round', tags: ['a'] })).toEqual([]);
  });

  it('reports missing required, wrong types, bounds, enum, and unexpected properties', () => {
    expect(validateActionParams(schema, {})).toEqual(['params.name: required']);
    expect(validateActionParams(schema, { name: 7 })).toEqual(['params.name: expected string, got number']);
    expect(validateActionParams(schema, { name: 'w', count: 99 })).toEqual(['params.count: above maximum 10']);
    expect(validateActionParams(schema, { name: 'w', count: 1.5 })).toEqual(['params.count: expected integer, got number']);
    expect(validateActionParams(schema, { name: 'w', kind: 'oval' })).toEqual(['params.kind: must be one of ["round","square"]']);
    expect(validateActionParams(schema, { name: 'w', bogus: 1 })).toEqual(['params.bogus: unexpected property']);
    expect(validateActionParams(schema, { name: 'w', tags: ['ok', 5] })).toEqual(['params.tags[1]: expected string, got number']);
  });

  it('enforces pattern and length constraints', () => {
    const s = { type: 'object', properties: { slug: { type: 'string', pattern: '^[a-z-]+$', maxLength: 5 } } };
    expect(validateActionParams(s, { slug: 'ok-ok' })).toEqual([]);
    expect(validateActionParams(s, { slug: 'NOPE' })).toEqual(['params.slug: does not match pattern ^[a-z-]+$']);
    expect(validateActionParams(s, { slug: 'toolong' })).toContain('params.slug: longer than maxLength 5');
  });
});

describe('approval gating decision', () => {
  const action = (riskLevel: SpecAction['riskLevel'], approvalRequired?: boolean): SpecAction => ({
    name: 'a', method: 'POST', urlTemplate: '/a', riskLevel, approvalRequired, description: 'd', paramsSchema: { type: 'object' },
  });

  it('requires approval for medium/high regardless of approvalRequired, and honors it at low', () => {
    expect(connectorActionRequiresApproval(action('low'))).toBe(false);
    expect(connectorActionRequiresApproval(action('low', true))).toBe(true);
    expect(connectorActionRequiresApproval(action('medium'))).toBe(true);
    expect(connectorActionRequiresApproval(action('medium', false))).toBe(true); // cannot relax
    expect(connectorActionRequiresApproval(action('high', false))).toBe(true);   // cannot relax
  });
});

describe('runConnectorAction pipeline', () => {
  it('refuses an unconfirmed medium-risk action with 428, no provider traffic, and NO broker read', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 201, body: { id: 1 } }]);
    const lazyResolve = vi.fn(resolveCreds);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds: lazyResolve, userSub: 'user-1', actionName: 'create-widget',
      params: { name: 'w1' }, requestBody: { params: { name: 'w1' } }, fetchImpl: fn,
    });
    expect(result.status).toBe(428);
    expect(result.body.error).toBe('confirmation_required');
    expect((result.body as Record<string, unknown>).guard).toBe('connector-write');
    expect(calls.length).toBe(0); // fail-closed: no provider traffic
    expect(lazyResolve).not.toHaveBeenCalled(); // creds resolve only AFTER the confirm gate
    const inserts = auditInserts(pool);
    expect(inserts.length).toBe(1); // refusals land exactly one row (no pre-write attempt row)
    expect(inserts[0].params[5]).toBe('confirmation_required');
  });

  it('executes a confirmed action with the caller token and audits attempt (pre-write) + success', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 201, body: { id: 42, name: 'w1' } }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'create-widget',
      params: { name: 'w1', count: 2 }, requestBody: { confirm: true }, fetchImpl: fn,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, data: { id: 42, name: 'w1' } });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.demo.test/widgets');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer TOK');
    expect(JSON.parse(calls[0].init.body)).toEqual({ name: 'w1', count: 2 });
    const inserts = auditInserts(pool);
    expect(inserts.map((row) => row.params[5])).toEqual(['attempt', 'success']); // attempt row BEFORE the write
    expect(inserts[1].params).toEqual(['user-1', 'demo', 'create-widget', hashConnectorActionParams({ name: 'w1', count: 2 }), 'medium', 'success', 201, null]);
  });

  it('runs a low-risk approvalRequired:false action without a confirm signal', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: true } }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'log-note',
      params: { text: 'hi' }, requestBody: {}, fetchImpl: fn,
    });
    expect(result.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(auditInsert(pool).params[5]).toBe('success');
  });

  it('rejects invalid params with 400 before any credential/HTTP work and audits invalid_params', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 201 }]);
    const lazyResolve = vi.fn(resolveCreds);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds: lazyResolve, userSub: 'user-1', actionName: 'create-widget',
      params: { count: 99 }, requestBody: { confirm: true }, fetchImpl: fn,
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('invalid_params');
    expect(result.body.error).toContain('params.name: required');
    expect(result.body.error).toContain('params.count: above maximum 10');
    expect(calls.length).toBe(0);
    expect(lazyResolve).not.toHaveBeenCalled(); // a garbage request never triggers a token refresh
    expect(auditInsert(pool).params[5]).toBe('invalid_params');
  });

  it('404s an undeclared action and audits unknown_action with a NULL risk level', async () => {
    const pool = mockPool();
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'nuke-everything',
      params: {}, requestBody: { confirm: true },
    });
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('unknown_action');
    const { params } = auditInsert(pool);
    expect(params[4]).toBeNull();
    expect(params[5]).toBe('unknown_action');
  });

  it('binds urlTemplate placeholders and turns leftover DELETE params into query string', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 204 }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'delete-widget',
      params: { id: 'a/b 1', force: true }, requestBody: { confirm: true }, fetchImpl: fn,
    });
    expect(result.status).toBe(200); // 204 emptyOk => {} data
    expect(calls[0].url).toBe('https://api.demo.test/widgets/a%2Fb%201?force=true');
    expect(calls[0].init.method).toBe('DELETE');
    expect(auditInsert(pool).params[6]).toBe(204);
  });

  it('maps a provider failure to the provider status, audits attempt + error, and does not retry the write', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 500, body: { message: 'boom' } }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'log-note',
      params: { text: 'hi' }, requestBody: {}, fetchImpl: fn,
    });
    expect(result.status).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(calls.length).toBe(1); // retry: maxRetries 0 — a write is never auto-retried
    const inserts = auditInserts(pool);
    expect(inserts.map((row) => row.params[5])).toEqual(['attempt', 'error']);
    expect(inserts[1].params[6]).toBe(500);
  });

  it('returns a clean audited 401 not_connected when the caller has no stored connection (never the operator key)', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 201 }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds: async () => null, userSub: 'user-1', actionName: 'log-note',
      params: { text: 'hi' }, requestBody: {}, fetchImpl: fn,
    });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('not_connected');
    expect(result.body.error).toContain('not connected');
    expect(calls.length).toBe(0); // auth resolved before any provider request
    expect(auditInsert(pool).params[5]).toBe('not_connected');
  });

  it('audits a credential-resolution throw (revoked refresh token) as a 401 error — never an unaudited 500', async () => {
    const pool = mockPool();
    const { fn, calls } = mockFetch([{ status: 201 }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds: async () => { throw new Error('refresh 400'); },
      userSub: 'user-1', actionName: 'log-note', params: { text: 'hi' }, requestBody: {}, fetchImpl: fn,
    });
    expect(result.status).toBe(401);
    expect(result.body.code).toBe('auth');
    expect(result.body.error).toContain('credential resolution failed');
    expect(calls.length).toBe(0); // no provider traffic on a broken credential
    expect(auditInsert(pool).params[5]).toBe('error');
  });

  it('REFUSES the write with 503 when the audit trail is unavailable (fail-closed: no provider traffic)', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('db down'); }) };
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: 1 } }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'log-note',
      params: { text: 'hi' }, requestBody: {}, fetchImpl: fn,
    });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('audit_unavailable');
    expect(calls.length).toBe(0); // a mutation with zero persistent record must never execute
  });

  it('flags auditRecorded:false when only the POST-write terminal insert fails (write already happened)', async () => {
    let inserts = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).startsWith('INSERT INTO connector_action_audit')) {
          inserts += 1;
          if (inserts === 2) throw new Error('db down after the write'); // attempt row lands, terminal row fails
        }
        return { rows: [] };
      }),
    };
    const { fn, calls } = mockFetch([{ status: 200, body: { ok: 1 } }]);
    const result = await runConnectorAction({
      pool, spec: baseSpec, resolveCreds, userSub: 'user-1', actionName: 'log-note',
      params: { text: 'hi' }, requestBody: {}, fetchImpl: fn,
    });
    expect(result.status).toBe(200);
    expect(calls.length).toBe(1);
    expect((result.body as Record<string, unknown>).auditRecorded).toBe(false);
  });
});

describe('resolveConnectorActionCreds (broker-only, review fix)', () => {
  it('returns null — NOT the operator env key — when the caller has no brokered connection', async () => {
    process.env.CONNECTOR_DEMO_TOKEN = 'OPERATOR-SHARED-PAT';
    try {
      const resolved = await resolveConnectorActionCreds(baseSpec, {}, 'user-1', async () => null);
      expect(resolved).toBeNull(); // the read tier's env fallback must never credential a write
    } finally {
      delete process.env.CONNECTOR_DEMO_TOKEN;
    }
  });

  it('wraps the caller token per auth type and passes credProvider to the broker', async () => {
    const getToken = vi.fn(async () => 'CALLER-TOK');
    const oauth = await resolveConnectorActionCreds({ ...baseSpec, credProvider: 'demo-cloud' }, {}, 'user-1', getToken);
    expect(await oauth!.token!()).toBe('CALLER-TOK');
    expect(getToken).toHaveBeenCalledWith({}, 'user-1', 'demo-cloud');
    const apiKey = await resolveConnectorActionCreds(
      { ...baseSpec, auth: { type: 'apiKeyHeader', header: 'X-Key' } }, {}, 'user-1', getToken,
    );
    expect(apiKey).toEqual({ apiKeyValue: 'CALLER-TOK' });
    const basic = await resolveConnectorActionCreds(
      { ...baseSpec, auth: { type: 'basic' } }, {}, 'user-1', async () => 'me:secret',
    );
    expect(basic).toEqual({ username: 'me', password: 'secret' });
  });

  it('treats auth-type none as credential-free ({}), and a colon-less basic token as not connected', async () => {
    const none = await resolveConnectorActionCreds({ ...baseSpec, auth: { type: 'none' } }, {}, 'user-1', async () => null);
    expect(none).toEqual({});
    const basic = await resolveConnectorActionCreds({ ...baseSpec, auth: { type: 'basic' } }, {}, 'user-1', async () => 'no-colon');
    expect(basic).toBeNull();
  });
});

describe('audit hashing + input split', () => {
  it('hashes params canonically (order-independent, 64-hex) so the trail never stores raw payloads', () => {
    const a = hashConnectorActionParams({ title: 'x', owner: 'o', nested: { b: 2, a: 1 } });
    const b = hashConnectorActionParams({ nested: { a: 1, b: 2 }, owner: 'o', title: 'x' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConnectorActionParams({ title: 'y' })).not.toBe(a);
  });

  it('splits path placeholders from body params', () => {
    const action = baseSpec.actions![2];
    const { path, rest } = splitConnectorActionInputs(action, { id: '9', force: true });
    expect(path).toBe('/widgets/9');
    expect(rest).toEqual({ force: true });
  });
});

describe('route wiring (source contract)', () => {
  it('mounts the action route behind requiresAuth with the connector-write guard rail', () => {
    const route = readFileSync(resolve(root, 'src/app/routes/connector-action-routes.ts'), 'utf8');
    expect(route).toContain("app.post('/api/connectors/:id/actions/:action', requiresAuth as never");
    expect(route).toContain('resolveConnectorActionCreds'); // broker-only caller creds, never operator env keys
    expect(route).not.toMatch(/import[^;]*resolveConnectorSpecCreds/); // the read tier's env-fallback resolver must stay off the write path
    const executor = readFileSync(resolve(root, 'src/app/connectors/runtime/action-executor.ts'), 'utf8');
    expect(executor).toContain("confirmationRequiredPayload('connector-write'");
    expect(executor).toContain('status: 428');
  });
});
