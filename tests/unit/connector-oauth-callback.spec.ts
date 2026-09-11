/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real HTTP connector consent, public relay, and authenticated completion using isolated provider/SQL fixtures. Covers domain changes, browser/owner binding, PKCE, replay, expiry, and registered Lab refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import { request, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/app/routes/connector-plaid-link', () => ({ registerPlaidLinkRoutes: () => {}, isPlaidConfigured: () => false }));
vi.mock('@/app/routes/ringcentral-screen-pop', () => ({ registerRingcentralScreenPop: () => {} }));

import { connectorCallbackAuth, createConnectorsRoutes } from '@/app/routes/connectors-routes';
import { CONNECTOR_CEREMONY_TTL } from '@/app/routes/connector-oauth-state';
import { signState, verifyState } from '@/app/routes/connector-oauth-ceremony';
import { decryptToken } from '@/app/routes/connector-token-crypto';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { CONNECTOR_OAUTH_SCENARIOS } from '@/app/routes/test-lab-connector-scenarios';

const OWNER = 'auth0|connector-owner';
const THEME = 'theme.example.test';
const CENTRAL = 'central.other.test';
const originalFetch = globalThis.fetch;
let server: Server;
let providerServer: Server;
let base: string;
let providerBase: string;
let tokenRequests: URLSearchParams[];
let writes: Array<{ values: unknown[]; identity: ReturnType<typeof getRequestIdentity> }>;
let membership: boolean;
let connections: Record<string, unknown>[];
let pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }> };

/** @description Bind a disposable HTTP server without fixed ports. */
async function listen(app: ReturnType<typeof express>): Promise<{ server: Server; base: string }> {
  let bound: Server;
  await new Promise<void>(resolve => { bound = app.listen(0, '127.0.0.1', resolve); });
  const address = bound!.address();
  if (!address || typeof address === 'string') throw new Error('no test listener');
  return { server: bound!, base: `http://127.0.0.1:${address.port}` };
}

/** @description Raw HTTP preserves virtual host names while all traffic stays on loopback. */
async function call(path: string, { host = THEME, cookie = '', method = 'GET' } = {}) {
  return new Promise<{ status: number; location: string; cookies: string[]; body: string }>((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: { host, ...(cookie ? { cookie } : {}) } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location || '', cookies: res.headers['set-cookie'] || [], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** @description Start from the themed authenticated host and retain its host-only browser cookie. */
async function begin(provider = 'google', query = '') {
  const response = await call(`/api/connect/${provider}/start${query}`, { cookie: 'session=owner' });
  expect(response.status).toBe(302);
  const authorize = new URL(response.location);
  const state = authorize.searchParams.get('state')!;
  const cookie = response.cookies[0].split(';')[0];
  return { provider, authorize, state, cookie, response };
}

/** @description Follow the fixed callback without either originating cookie. */
async function relay(flow: Awaited<ReturnType<typeof begin>>, query = 'code=provider-code') {
  const response = await call(`/api/connect/${flow.provider}/callback?state=${encodeURIComponent(flow.state)}&${query}`, { host: CENTRAL });
  expect(response.status).toBe(302);
  return { response, path: new URL(response.location).pathname + new URL(response.location).search };
}

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'isolated-connector-callback-fixture');
  vi.stubEnv('APP_URL', `https://${CENTRAL}`);
  vi.stubEnv('OIDC_BASE_URLS', `https://${THEME}`);
  vi.stubEnv('GOOGLE_CONNECT_CLIENT_ID', 'fixture-client');
  vi.stubEnv('GOOGLE_CONNECT_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('RINGCENTRAL_CLIENT_ID', 'fixture-client');
  vi.stubEnv('RINGCENTRAL_CLIENT_SECRET', 'fixture-secret');
  vi.stubEnv('GOOGLE_REDIRECT_URI', '');
  vi.stubEnv('RINGCENTRAL_REDIRECT_URI', '');
  vi.stubEnv('OSHAL_ENVELOPE_CRYPTO', 'false');
  tokenRequests = [];
  writes = [];
  connections = [];
  membership = true;
  const fakeProvider = express();
  fakeProvider.use(express.urlencoded({ extended: false }));
  fakeProvider.post('/token', (req, res) => {
    tokenRequests.push(new URLSearchParams(req.body));
    res.json({ access_token: 'example-access-token', refresh_token: 'example-refresh-token', expires_in: 3600 });
  });
  fakeProvider.get('/account', (_req, res) => res.json({ sub: 'provider-account', email: 'work@example.test', id: 'provider-account', contact: { email: 'work@example.test' } }));
  ({ server: providerServer, base: providerBase } = await listen(fakeProvider));
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.startsWith('http://127.0.0.1:')) return originalFetch(input, init);
    if (url === 'https://oauth2.googleapis.com/token' || url === 'https://platform.ringcentral.com/restapi/oauth/token') return originalFetch(`${providerBase}/token`, init);
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo' || url === 'https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~') return originalFetch(`${providerBase}/account`, init);
    throw new Error(`Fixture refuses external provider URL: ${url}`);
  });
  pool = { query: async (sql, values = []) => {
    if (/INSERT INTO oshal_connections/i.test(sql)) writes.push({ values, identity: getRequestIdentity() });
    const rows = /FROM oshal_tenant_memberships/i.test(sql) ? (membership ? [{ tenant_id: 'household' }] : [])
      : /FROM oshal_connections/i.test(sql) ? connections : [];
    return { rows, rowCount: rows.length };
  } };
  const app = express();
  app.use((req, _res, next) => {
    const match = /(?:^|;\s*)session=(owner|other)(?:;|$)/.exec(req.headers.cookie || '');
    const sub = match ? match[1] === 'owner' ? OWNER : 'auth0|other' : null;
    (req as unknown as { oidc: unknown }).oidc = { isAuthenticated: () => !!sub, user: { sub, email: `${match?.[1]}@example.test` } };
    runWithRequestIdentity({ sub, isOperator: false }, next);
  });
  const requiresAuth: RequestHandler = (req, res, next) => {
    if ((req as unknown as { oidc: { isAuthenticated: () => boolean } }).oidc.isAuthenticated()) next();
    else res.status(401).json({ error: 'not authenticated' });
  };
  app.use('/api/connect', connectorCallbackAuth(requiresAuth), createConnectorsRoutes({ pool } as never));
  ({ server, base } = await listen(app));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all([server, providerServer].filter(Boolean).map(bound => new Promise<void>(resolve => { bound.closeAllConnections(); bound.close(() => resolve()); })));
});

describe('connector OAuth across cookie-domain families', () => {
  it('relays a sessionless fixed callback then exchanges and persists only in the original browser', async () => {
    const flow = await begin('google', '?label=Work&returnTo=https://evil.example');
    expect(flow.authorize.searchParams.get('redirect_uri')).toBe(`https://${CENTRAL}/api/connect/google/callback`);
    expect(flow.response.cookies[0]).toContain('HttpOnly');
    expect(flow.response.cookies[0]).toContain('Secure');
    expect(flow.response.cookies[0]).toContain('SameSite=Lax');
    expect(flow.response.cookies[0]).not.toContain('Domain=');
    const returned = await relay(flow);
    expect(returned.response.location).toMatch(new RegExp(`^https://${THEME}/api/connect/google/complete\\?ticket=`));
    expect(returned.response.location).not.toContain('provider-code');
    expect(tokenRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
    const complete = await call(returned.path, { cookie: `session=owner; ${flow.cookie}` });
    expect(complete.status).toBe(302);
    expect(complete.location).toBe('/utilities?connected=google');
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get('redirect_uri')).toBe(`https://${CENTRAL}/api/connect/google/callback`);
    expect(writes).toHaveLength(1);
    expect(writes[0].values.slice(0, 3)).toEqual([OWNER, 'owner@example.test', 'google']);
    expect(writes[0].values[11]).toBe('Work');
    expect(writes[0].identity).toMatchObject({ sub: OWNER, isOperator: false });
    expect(await decryptToken(pool, OWNER, String(writes[0].values[6]))).toBe('example-access-token');
    expect(complete.cookies[0]).toContain('Expires=Thu, 01 Jan 1970');
    expect(complete.location + complete.body).not.toContain('example-access-token');
  });

  it('requires both original user and original browser secret, including after a malicious copied authorization URL', async () => {
    const flow = await begin();
    const returned = await relay(flow);
    for (const cookie of ['session=owner', 'session=other', `session=other; ${flow.cookie}`, `session=owner; ${flow.cookie.split('=')[0]}=forged`]) {
      expect((await call(returned.path, { cookie })).status).toBe(400);
    }
    expect((await call(returned.path, { cookie: flow.cookie })).status).toBe(401);
    expect((await call(returned.path, { host: CENTRAL, cookie: `session=owner; ${flow.cookie}` })).status).toBe(400);
    expect(tokenRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect((await call(returned.path, { cookie: `session=owner; ${flow.cookie}` })).status).toBe(302);
  });

  it('rejects forged, trailing, foreign-provider and wrong-identity callback state before any provider request', async () => {
    const flow = await begin();
    const forged = `${flow.state.slice(0, -1)}${flow.state.endsWith('x') ? 'y' : 'x'}`;
    for (const state of [forged, `${flow.state}.extra`, signState({ sub: OWNER, provider: 'google' }), '']) {
      expect((await call(`/api/connect/google/callback?state=${encodeURIComponent(state)}&code=unused`, { host: CENTRAL })).status).toBe(400);
    }
    expect((await call(`/api/connect/ringcentral/callback?state=${encodeURIComponent(flow.state)}&code=unused`, { host: CENTRAL })).status).toBe(400);
    expect((await call(`/api/connect/google/callback?state=${encodeURIComponent(flow.state)}&code=unused`, { host: CENTRAL, cookie: 'session=other' })).status).toBe(400);
    expect(tokenRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('consumes callback state and completion tickets only once, including concurrent completion', async () => {
    const flow = await begin();
    const returned = await relay(flow);
    expect((await call(`/api/connect/google/callback?state=${encodeURIComponent(flow.state)}&code=again`, { host: CENTRAL })).status).toBe(400);
    const results = await Promise.all([0, 1].map(() => call(returned.path, { cookie: `session=owner; ${flow.cookie}` })));
    expect(results.map(result => result.status).sort()).toEqual([302, 400]);
    expect(tokenRequests).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it.each(['callback', 'completion'])('expires the %s at the original ten-minute deadline', async phase => {
    const flow = await begin();
    const returned = phase === 'completion' ? await relay(flow) : null;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + CONNECTOR_CEREMONY_TTL);
    const result = returned
      ? await call(returned.path, { cookie: `session=owner; ${flow.cookie}` })
      : await call(`/api/connect/google/callback?state=${encodeURIComponent(flow.state)}&code=late`, { host: CENTRAL });
    expect(result.status).toBe(400);
    expect(tokenRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('rejects a future timestamp and never accepts an orphaned signed state after restart', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1);
    const state = signState({ nonce: 'unknown-after-restart' });
    clock.mockReturnValue(now);
    expect(verifyState(state)).toBeNull();
    clock.mockRestore();
    expect((await call(`/api/connect/google/callback?state=${encodeURIComponent(signState({ nonce: 'unknown-after-restart' }))}&code=unused`, { host: CENTRAL })).status).toBe(400);
  });

  it('keeps PKCE verifiers distinct for concurrent flows without a callback cookie', async () => {
    const first = await begin('ringcentral');
    const second = await begin('ringcentral');
    expect(first.cookie.split('=')[0]).not.toBe(second.cookie.split('=')[0]);
    for (const flow of [second, first]) {
      const returned = await relay(flow);
      const response = await call(returned.path, { cookie: `session=owner; ${flow.cookie}` });
      expect(response.location).toBe('/utilities?connected=ringcentral');
      const verifier = tokenRequests.at(-1)!.get('code_verifier')!;
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(flow.authorize.searchParams.get('code_challenge'));
      expect(flow.state).not.toContain(verifier);
    }
    expect(tokenRequests).toHaveLength(2);
  });

  it('preserves stored reconnect label and rechecks household membership before exchange', async () => {
    connections = [{ connection_id: 'existing', tenant_id: 'household', label: 'Saved name', account_email: 'work@example.test' }];
    const flow = await begin('google', '?reconnect=existing&label=forged');
    const returned = await relay(flow);
    expect((await call(returned.path, { cookie: `session=owner; ${flow.cookie}` })).location).toBe('/utilities?connected=google');
    expect(writes[0].values[9]).toBe('household');
    expect(writes[0].values[11]).toBe('Saved name');
    const revoked = await begin('google', '?tenant=household');
    const revokedReturn = await relay(revoked);
    membership = false;
    expect((await call(revokedReturn.path, { cookie: `session=owner; ${revoked.cookie}` })).status).toBe(403);
    expect(tokenRequests).toHaveLength(1);
  });

  it('returns provider denial to the original browser and consumes it without a token exchange', async () => {
    const flow = await begin();
    const returned = await relay(flow, 'error=access_denied');
    expect((await call(returned.path, { cookie: `session=owner; ${flow.cookie}` })).location).toBe('/utilities?error=access_denied');
    expect((await call(returned.path, { cookie: `session=owner; ${flow.cookie}` })).status).toBe(400);
    expect(tokenRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('refuses unconfigured origins and callback reconfiguration while consent is pending', async () => {
    expect((await call('/api/connect/google/start', { host: 'evil.example', cookie: 'session=owner' })).status).toBe(400);
    const flow = await begin();
    const returned = await relay(flow);
    vi.stubEnv('GOOGLE_REDIRECT_URI', 'https://another.example/callback');
    expect((await call(returned.path, { cookie: `session=owner; ${flow.cookie}` })).location).toBe('/utilities?error=state');
    expect(tokenRequests).toHaveLength(0);
  });

  it('bounds pending ceremonies per user without evicting an existing consent', async () => {
    const first = await begin();
    for (let index = 0; index < 7; index++) await begin();
    expect((await call('/api/connect/google/start', { cookie: 'session=owner' })).status).toBe(503);
    expect((await relay(first)).response.status).toBe(302);
  });

  it('only exempts the exact GET OAuth callback; every data, completion, and mutation route retains auth', async () => {
    for (const [path, method] of [
      ['/google/start', 'GET'], ['/list', 'GET'], ['/google/access-token', 'GET'], ['/google/complete?ticket=x', 'GET'],
      ['/google/token', 'POST'], ['/google', 'DELETE'], ['/google/callback?state=x&code=x', 'POST'],
      ['/unknown/callback?state=x&code=x', 'GET'], ['/constructor/callback?state=x&code=x', 'GET'],
      ['/plaid/callback?state=x&code=x', 'GET'], ['/google/callback/extra', 'GET'],
    ]) expect((await call(`/api/connect${path}`, { method })).status).toBe(401);
    expect((await call('/api/connect/google/callback?state=x&code=x', { host: CENTRAL })).status).toBe(400);
    expect(tokenRequests).toHaveLength(0);
    const serverSource = readFileSync('src/app/server.ts', 'utf8');
    expect(serverSource).toContain("app.use('/api/connect', connectorCallbackAuth(requiresAuth), createConnectorsRoutes(ctx))");
  });

  it('registers real anonymous refusal probes and their existing regression suites with the Lab', async () => {
    const scenario = CONNECTOR_OAUTH_SCENARIOS[0];
    expect(scenario.id).toBe('connector-oauth-boundary');
    for (const suite of scenario.regressionTests || []) expect(readFileSync(suite.path, 'utf8')).toBeTruthy();
    vi.stubEnv('PORT', new URL(base).port);
    for (const step of scenario.steps) expect((await step.run('', {})).state).toBe('pass');
    expect(tokenRequests).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
});
