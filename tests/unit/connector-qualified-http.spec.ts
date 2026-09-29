/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise qualified grant HTTP routes, browser consent, real envelope crypto and session code with explicit authentication, provider and transactional SQL doubles; no PostgreSQL/RLS or live-provider claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type RequestHandler } from 'express';
import { request, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

const diagnostics = vi.hoisted(() => ({ error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => diagnostics }));
vi.mock('@/app/routes/connector-plaid-link', () => ({ registerPlaidLinkRoutes: () => {}, isPlaidConfigured: () => false }));
vi.mock('@/app/routes/ringcentral-screen-pop', () => ({ registerRingcentralScreenPop: () => {} }));
import { connectorCallbackAuth, createConnectorsRoutes } from '@/app/routes/connectors-routes';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { decryptQualifiedConnectorToken } from '@/app/routes/connector-qualified-token-crypto';
import { ConnectorOAuthCeremonies } from '@/app/routes/connector-oauth-state';
import { CONNECTOR_OAUTH_SCENARIOS } from '@/app/routes/test-lab-connector-scenarios';

const ISSUER = 'https://identity.example.test/', OTHER_ISSUER = 'https://other.example.test/';
const OWNER = 'subject-same', HOST = 'qualified.example.test';
const ACCESS = 'fixture-qualified-access', REFRESH = 'fixture-qualified-refresh';
const realFetch = globalThis.fetch;
type Row = Record<string, unknown>;
let server: Server, base: string, rows: Row[], deks: Map<string, string>, legacyReads: number;
let queries: { sql: string; values: unknown[]; identity: ReturnType<typeof getRequestIdentity> }[];
let providerCalls: string[], providerHook: (() => void) | undefined, providerMode: 'ok' | 'refused' | 'no-location';
let activeRequest: Request;

/** Explicit SQL double: exercises the actual SQL caller/crypto, not database policy or concurrency. */
async function sql(query: string, values: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
  const statement = query.replace(/\s+/g, ' ').trim();
  if (/oshal_qualified_/.test(statement)) queries.push({ sql: statement, values: [...values], identity: { ...getRequestIdentity() } as ReturnType<typeof getRequestIdentity> });
  if (statement.startsWith('SELECT wrapped_dek')) {
    const value = deks.get(JSON.stringify([values[1], values[0]]));
    return result(value ? [{ wrapped_dek: value }] : []);
  }
  if (statement.startsWith('INSERT INTO oshal_qualified_deks')) {
    const key = JSON.stringify([values[1], values[0]]);
    if (!deks.has(key)) deks.set(key, String(values[2]));
    return result([]);
  }
  // Existing router bootstrap also contains legacy default-seeding SQL. Count request work only.
  if (/\boshal_connections\b/.test(statement) && getRequestIdentity()?.sub) {
    legacyReads++;
    throw new Error('qualified HTTP fixture refuses legacy request storage');
  }
  if (statement.startsWith('INSERT INTO oshal_qualified_connections')) return insert(values);
  if (!/oshal_qualified_connections/.test(statement)) return result([]);
  let found = rows.filter(row => row.principal_issuer === values[0] && row.owner_sub === values[1]);
  if (/connection_id = \$3::uuid/.test(statement)) found = found.filter(row => row.connection_id === values[2]);
  if (/provider = \$3/.test(statement)) found = found.filter(row => row.provider === values[2] && row.account_key === values[3]);
  if (/provider = \$4/.test(statement)) found = found.filter(row => row.provider === values[3] && row.account_key === values[4] && row.revision === values[5]);
  if (statement.startsWith('UPDATE ')) {
    for (const row of found) {
      if (statement.includes("SET status = 'revoked'")) { row.status = 'revoked'; row.refresh_token = null; }
      else { row.access_token = values[6]; row.refresh_token = values[7]; row.expiry = values[8]; row.status = 'connected'; }
      row.revision = String(BigInt(String(row.revision)) + 1n);
    }
  }
  if (statement.includes('ORDER BY connection_id')) {
    found = found.filter(row => values[2] === null || String(row.connection_id) > String(values[2]))
      .sort((a, b) => String(a.connection_id).localeCompare(String(b.connection_id))).slice(0, Number(values[3]));
  }
  return result(found.map(row => ({ ...row })));
}
function result(found: Row[]) { return { rows: found, rowCount: found.length }; }
function insert(values: unknown[]) {
  if (rows.some(row => row.principal_issuer === values[0] && row.owner_sub === values[1]
    && row.provider === values[2] && row.account_key === values[3])) return result([]);
  const row = { principal_issuer: values[0], owner_sub: values[1], provider: values[2], account_key: values[3],
    access_token: values[4], refresh_token: values[5], expiry: values[6], connection_id: randomUUID(),
    status: 'connected', revision: '1', created_at: new Date(), updated_at: new Date() };
  rows.push(row);
  return result([{ ...row }]);
}
/** Transaction commands and rollback are doubled; actual session code still owns their lifecycle. */
const pool = {
  query: sql,
  async connect() {
    let savedRows: Row[], savedDeks: Map<string, string>;
    return { release: vi.fn(), query: async (statement: string, values?: unknown[]) => {
      if (statement.startsWith('BEGIN')) { savedRows = structuredClone(rows); savedDeks = new Map(deks); }
      if (statement === 'ROLLBACK') { rows = savedRows; deks = savedDeks; }
      return sql(statement, values);
    } };
  },
};
async function call(path: string, options: { session?: string; method?: string; body?: unknown; origin?: string; cookie?: string; revision?: string } = {}) {
  const session = options.session ?? 'owner', body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<{ status: number; location: string; cookies: string[]; body: string; etag?: string }>((resolve, reject) => {
    const req = request(base + path, { method: options.method ?? 'GET', headers: {
      host: HOST, cookie: [session ? 'session=' + session : '', options.cookie ?? ''].filter(Boolean).join('; '),
      ...(options.origin ? { origin: options.origin } : {}), ...(options.revision ? { 'if-match': options.revision } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
    } }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, location: response.headers.location ?? '',
        cookies: response.headers['set-cookie'] ?? [], body: text, etag: response.headers.etag }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function create(session = 'owner') {
  const response = await call('/api/connect/qualified/smartthings/token',
    { method: 'POST', session, origin: 'https://' + HOST, body: { token: ACCESS } });
  expect(response.status, response.body).toBe(200);
  return JSON.parse(response.body).connection;
}
async function start(query = '') {
  const response = await call('/api/connect/qualified/smartthings/start' + query);
  expect(response.status, response.body).toBe(302);
  return { state: new URL(response.location).searchParams.get('state')!, cookie: response.cookies[0].split(';')[0], response };
}
async function relay(flow: Awaited<ReturnType<typeof start>>) {
  const response = await call('/api/connect/smartthings/callback?state=' + encodeURIComponent(flow.state) + '&code=fixture-code', { session: '' });
  expect(response.status, response.body).toBe(302);
  const url = new URL(response.location);
  return url.pathname + url.search;
}

beforeEach(async () => {
  rows = []; deks = new Map(); queries = []; legacyReads = 0; providerCalls = []; providerHook = undefined; providerMode = 'ok';
  vi.clearAllMocks();
  vi.stubEnv('SESSION_SECRET', 'qualified-http-isolated-secret');
  vi.stubEnv('APP_URL', 'https://' + HOST); vi.stubEnv('OIDC_BASE_URLS', '');
  vi.stubEnv('SMARTTHINGS_CLIENT_ID', 'fixture-client'); vi.stubEnv('SMARTTHINGS_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('SMARTTHINGS_REDIRECT_URI', '');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (!['https://api.smartthings.com/oauth/token', 'https://api.smartthings.com/v1/locations'].includes(url)) throw new Error('unexpected fixture URL');
    providerCalls.push(url); providerHook?.();
    if (providerMode === 'refused') return new globalThis.Response('private provider diagnostic ' + ACCESS, { status: 401 });
    return globalThis.Response.json(url.endsWith('/token')
      ? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }
      : { items: providerMode === 'no-location' ? [] : [{ locationId: 'location-a', name: 'Home' }] });
  });
  const app = express(); app.use(express.json({ limit: '80kb' }));
  app.use((req, _res, next) => {
    activeRequest = req;
    const session = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const sub = session === 'other' ? 'different-subject' : OWNER;
    const issuer = session === 'sibling' ? OTHER_ISSUER : session === 'missing' ? null : ISSUER;
    (req as any).oidc = { isAuthenticated: () => !!session, user: { sub, email: 'display@example.test', iss: ISSUER },
      idTokenClaims: issuer ? { iss: issuer } : {} };
    if (session === 'no-context') { next(); return; }
    runWithRequestIdentity({ sub: session ? sub : null, principalIssuer: session === 'misbound' ? OTHER_ISSUER : issuer,
      isOperator: session === 'operator', ...(session === 'system' ? { system: true } : {}) }, next);
  });
  const auth: RequestHandler = (req, res, next) => (req as any).oidc.isAuthenticated() ? next() : res.status(401).json({ error: 'not authenticated' });
  app.use('/api/connect', connectorCallbackAuth(auth), createConnectorsRoutes({ pool } as any));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener missing');
  base = 'http://127.0.0.1:' + address.port;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('qualified personal connector real HTTP boundary (named provider/auth/SQL doubles)', () => {
  it('validates a fresh PAT, encrypts under issuer+subject, and returns metadata only', async () => {
    const grant = await create();
    expect(grant).toMatchObject({ provider: 'smartthings', accountKey: 'smartthings-location:location-a', revision: '1', status: 'connected', expiresAt: null });
    expect(Object.keys(grant).sort()).toEqual(['accountKey', 'connectionId', 'createdAt', 'expiresAt', 'provider', 'revision', 'status', 'updatedAt'].sort());
    expect(rows[0].access_token).toMatch(/^qct1:/); expect(rows[0].refresh_token).toBeNull();
    expect(await decryptQualifiedConnectorToken(pool, { sub: OWNER, principalIssuer: ISSUER }, String(rows[0].access_token))).toBe(ACCESS);
    expect(legacyReads).toBe(0); expect(providerCalls).toEqual(['https://api.smartthings.com/v1/locations']);
    expect(JSON.stringify(grant)).not.toContain(ACCESS);
  });
  it.each(['', 'missing', 'no-context', 'misbound', 'system'])('refuses identity %j before provider or qualified storage', async session => {
    const response = await call('/api/connect/qualified/smartthings/token',
      { method: 'POST', session, origin: 'https://' + HOST, body: { token: ACCESS } });
    expect(response.status).toBe(session === '' ? 401 : 403);
    expect(providerCalls).toEqual([]); expect(queries).toEqual([]); expect(rows).toEqual([]);
  });
  it('uses an explicit personal non-operator database identity even for an operator', async () => {
    await create('operator');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(query => query.identity?.isOperator === false && query.identity.sub === OWNER && query.identity.principalIssuer === ISSUER)).toBe(true);
  });
  it('separates identical subjects at distinct verified issuers', async () => {
    const first = await create(), second = await create('sibling');
    expect(first.connectionId).not.toBe(second.connectionId); expect(deks.size).toBe(2);
    const own = await call('/api/connect/qualified');
    expect(JSON.parse(own.body).connections.map((row: any) => row.connectionId)).toEqual([first.connectionId]);
    expect((await call('/api/connect/qualified/' + first.connectionId, { session: 'sibling' })).status).toBe(404);
  });
  it.each([undefined, 'https://hostile.example.test', 'null'])('refuses mutation origin %j before provider I/O', async origin => {
    const response = await call('/api/connect/qualified/smartthings/token', { method: 'POST', origin, body: { token: ACCESS } });
    expect(response.status).toBe(403); expect(providerCalls).toEqual([]); expect(rows).toEqual([]);
  });
  it.each([{ token: ACCESS, tenant: 'shared' }, { token: ACCESS, accountKey: 'forged' }, { token: ACCESS, principalIssuer: OTHER_ISSUER }, { token: '' }])('refuses credential target overrides or malformed paste %j', async body => {
    const response = await call('/api/connect/qualified/smartthings/token', { method: 'POST', origin: 'https://' + HOST, body });
    expect(response.status).toBe(400); expect(providerCalls).toEqual([]);
  });
  it.each(['refused', 'no-location'] as const)('does not persist unverifiable provider result %s or echo provider secrets', async mode => {
    providerMode = mode;
    const response = await call('/api/connect/qualified/smartthings/token', { method: 'POST', origin: 'https://' + HOST, body: { token: ACCESS } });
    expect(response.status).toBe(502); expect(rows).toEqual([]); expect(deks.size).toBe(0);
    expect(response.body + JSON.stringify(diagnostics.error.mock.calls)).not.toContain(ACCESS);
  });
  it('rejects identity substitution while the provider is awaited', async () => {
    providerHook = () => { (activeRequest as any).oidc.idTokenClaims.iss = OTHER_ISSUER; };
    const response = await call('/api/connect/qualified/smartthings/token', { method: 'POST', origin: 'https://' + HOST, body: { token: ACCESS } });
    expect(response.status).toBe(403); expect(rows).toEqual([]); expect(queries).toEqual([]);
  });
  it('keeps duplicate creation distinct from explicit revision-bound reconnect', async () => {
    const grant = await create();
    const duplicate = await call('/api/connect/qualified/smartthings/token', { method: 'POST', origin: 'https://' + HOST, body: { token: ACCESS } });
    expect(duplicate.status).toBe(409); expect(rows).toHaveLength(1);
    rows[0].refresh_token = rows[0].access_token; // Prior encrypted material must not survive a refresh-less reconnect.
    const reconnect = await call('/api/connect/qualified/smartthings/' + grant.connectionId + '/token',
      { method: 'POST', origin: 'https://' + HOST, revision: '"1"', body: { token: ACCESS } });
    expect(reconnect.status, reconnect.body).toBe(200);
    expect(JSON.parse(reconnect.body).connection.revision).toBe('2'); expect(rows[0].refresh_token).toBeNull();
  });
  it('requires the selected revision for reconnect and revoke, and returns the new metadata ETag', async () => {
    const grant = await create(), path = '/api/connect/qualified/' + grant.connectionId;
    expect((await call(path)).etag).toBe('"1"');
    expect((await call(path, { method: 'DELETE', origin: 'https://' + HOST })).status).toBe(428);
    expect((await call(path, { method: 'DELETE', origin: 'https://' + HOST, revision: '"2"' })).status).toBe(404);
    const revoked = await call(path, { method: 'DELETE', origin: 'https://' + HOST, revision: '"1"' });
    expect(revoked.status).toBe(200); expect(revoked.etag).toBe('"2"');
    expect(JSON.parse(revoked.body).connection.status).toBe('revoked');
    expect((await call(path, { method: 'DELETE', origin: 'https://' + HOST, revision: '"1"' })).status).toBe(404);
  });
  it('does not turn another principal UUID or a legacy id into qualified consent', async () => {
    const grant = await create();
    expect((await call('/api/connect/qualified/smartthings/start?reconnect=' + grant.connectionId, { session: 'other' })).status).toBe(404);
    expect((await call('/api/connect/qualified/smartthings/start?reconnect=' + randomUUID())).status).toBe(404);
    expect(legacyReads).toBe(0);
  });
  it('reuses the fixed provider callback but persists only the server-bound qualified namespace', async () => {
    const flow = await start(), complete = await relay(flow);
    expect(providerCalls).toEqual([]);
    expect(new URL(flow.response.location).searchParams.get('redirect_uri')).toBe('https://' + HOST + '/api/connect/smartthings/callback');
    const response = await call(complete + '&tenant=forged&qualified=legacy', { cookie: flow.cookie });
    expect(response.status, response.body).toBe(302);
    expect(response.location).toMatch(/^\/utilities\?qualified=connected&connection=/);
    expect(rows).toHaveLength(1); expect(legacyReads).toBe(0);
    expect(rows[0].refresh_token).toMatch(/^qct1:/);
    expect(await decryptQualifiedConnectorToken(pool, { sub: OWNER, principalIssuer: ISSUER }, String(rows[0].refresh_token))).toBe(REFRESH);
    expect((await call(complete, { cookie: flow.cookie })).status).toBe(400);
    expect(providerCalls).toHaveLength(2);
  });
  it('requires the original browser and issuer for qualified completion', async () => {
    const flow = await start(), complete = await relay(flow);
    expect((await call(complete)).status).toBe(400);
    expect((await call(complete, { cookie: flow.cookie, session: 'sibling' })).status).toBe(400);
    expect(providerCalls).toEqual([]);
    expect((await call(complete, { cookie: flow.cookie })).status).toBe(302);
  });
  it('holds the original reconnect revision through provider consent instead of silently overwriting a revocation', async () => {
    const grant = await create(), flow = await start('?reconnect=' + grant.connectionId), complete = await relay(flow);
    rows[0].revision = '2'; rows[0].status = 'revoked'; rows[0].refresh_token = null;
    const response = await call(complete, { cookie: flow.cookie });
    expect(response.status).toBe(404); expect(rows[0].revision).toBe('2'); expect(rows[0].status).toBe('revoked');
  });
  it('snapshots the server-side qualified target rather than retaining a mutable caller object', async () => {
    const ceremonies = new ConnectorOAuthCeremonies();
    const target = { connectionId: randomUUID(), accountKey: 'smartthings-location:location-a', expectedRevision: '1' };
    const issued = ceremonies.issue({ provider: 'smartthings', caller: { sub: OWNER, principalIssuer: ISSUER, email: '' },
      origin: 'https://' + HOST, redirect: 'https://' + HOST + '/api/connect/smartthings/callback',
      qualified: { scope: 'personal', reconnect: target } });
    target.expectedRevision = '99';
    const relay = ceremonies.relay(issued.state, 'smartthings', null, 'code', '')!;
    const req = { headers: { cookie: issued.cookieName + '=' + issued.cookieSecret }, get: () => HOST } as unknown as Request;
    const consent = ceremonies.complete(new URL(relay.location).searchParams.get('ticket')!, 'smartthings', req,
      { sub: OWNER, principalIssuer: ISSUER, email: '' });
    expect(consent?.qualified?.reconnect?.expectedRevision).toBe('1');
  });
  it('registers real anonymous Lab refusal probes without starting provider consent', async () => {
    const scenario = CONNECTOR_OAUTH_SCENARIOS.find(item => item.id === 'qualified-personal-connector')!;
    expect(scenario).toBeDefined();
    for (const reference of scenario.regressionTests ?? []) expect(existsSync(reference.path)).toBe(true);
    vi.stubEnv('PORT', new URL(base).port);
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      if (!String(input).startsWith('http://127.0.0.1:' + new URL(base).port + '/')) throw new Error('Lab fixture refuses external URL');
      return realFetch(input, init);
    });
    for (const step of scenario.steps ?? []) {
      const result = await step.run();
      expect(result).toMatchObject({ status: 401, state: 'pass' });
    }
    expect(providerCalls).toEqual([]); expect(queries).toEqual([]);
  });
});
