/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-169 L3: the step-up over REAL OIDC, across the protocol seam the claim is about. A local identity provider (discovery, authorize, token with PKCE, JWKS, RS256 id tokens carrying nonce, iat and auth_time) and the kernel's own createOidcMiddleware (express-openid-connect, real mode) drive Chromium through login, then through the step-up: the start endpoint sends the browser back to the provider with max_age=0, and the proof is accepted only when the provider's auth_time and iat are no older than the challenge and the account is the same. A provider that ignores max_age and silently reuses its old session proves nothing; reaching the complete endpoint without a fresh round trip proves nothing; re-authenticating as a different account proves nothing. The only doubles are the provider itself (a protocol-faithful local one) and a pool the ceremony never touches.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import type { Pool } from 'pg';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocationStepUpStore } from '@/app/location-step-up';
import { createLocationRoutes } from '@/app/routes/location-routes';
import { refuseLocationServiceRail } from '@/app/routes/location-session';
import { createOidcMiddleware } from '@/shared/middleware/oidc';

const CLIENT_ID = 'oshal-fixture-client';
const CLIENT_SECRET = 'fixture-client-secret';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'fixture-key', use: 'sig', alg: 'RS256' };

/** What the provider does on the next authorize request. */
const idp = {
  base: '',
  mode: 'honour' as 'honour' | 'ignore-max-age' | 'switch-account',
  sessionAuthTime: 0,
  seen: [] as Array<Record<string, string>>,
  codes: new Map<string, { sub: string; nonce: string; authTime: number; challenge: string }>(),
};

const b64u = (value: string) => Buffer.from(value).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fixture-key' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

/** The provider's authorize decision: honour max_age=0 with a fresh sign-in, or not. */
function authorize(query: Record<string, string>): { sub: string; authTime: number } {
  const now = Math.floor(Date.now() / 1000);
  if (idp.mode === 'switch-account') return { sub: 'person-b', authTime: now };
  if (idp.sessionAuthTime && (idp.mode === 'ignore-max-age' || query.max_age === undefined)) {
    return { sub: 'person-a', authTime: idp.sessionAuthTime };
  }
  idp.sessionAuthTime = now;
  return { sub: 'person-a', authTime: now };
}

function identityProvider(): express.Express {
  const app = express();
  app.get('/.well-known/openid-configuration', (_req, res) => res.json({
    issuer: idp.base, authorization_endpoint: `${idp.base}/authorize`, token_endpoint: `${idp.base}/token`, jwks_uri: `${idp.base}/jwks`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
  }));
  app.get('/jwks', (_req, res) => res.json({ keys: [JWK] }));
  app.get('/authorize', (req, res) => {
    const query = req.query as Record<string, string>;
    idp.seen.push(query);
    const who = authorize(query);
    const code = crypto.randomBytes(16).toString('hex');
    idp.codes.set(code, { sub: who.sub, nonce: query.nonce, authTime: who.authTime, challenge: query.code_challenge });
    res.redirect(302, `${query.redirect_uri}?code=${code}&state=${encodeURIComponent(query.state)}`);
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const grant = idp.codes.get(req.body.code);
    const basic = Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64');
    const verifier = crypto.createHash('sha256').update(String(req.body.code_verifier)).digest('base64url');
    if (!grant || req.get('authorization') !== `Basic ${basic}` || verifier !== grant.challenge) { res.status(400).json({ error: 'invalid_grant' }); return; }
    idp.codes.delete(req.body.code);
    const now = Math.floor(Date.now() / 1000);
    res.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 300, id_token: signIdToken({
      iss: idp.base, sub: grant.sub, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: grant.nonce, auth_time: grant.authTime }) });
  });
  return app;
}

async function listen(handler: http.RequestListener | null): Promise<{ server: http.Server; base: string; set: (h: http.RequestListener) => void }> {
  let current = handler;
  const server = http.createServer((req, res) => current?.(req, res));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, set: (h) => { current = h; } };
}

const store = new LocationStepUpStore({ skewMs: 1_500 });
const untouchedPool = { connect: async () => { throw new Error('the step-up ceremony never touches the database'); } } as unknown as Pool;
let idpServer: http.Server; let appServer: http.Server; let appBase = '';
let browser: Browser; let context: BrowserContext; let page: Page;

async function openChallenge(precisionClass: string): Promise<{ challengeId: string; method: string; startUrl: string }> {
  return page.evaluate(async (pc: string) => (await fetch('/api/location/step-up', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'opt-in', params: { deviceId: null, precisionClass: pc } }) })).json(), precisionClass);
}
const challengeState = (id: string) => page.evaluate(async (c: string) => (await (await fetch(`/api/location/step-up/${c}`)).json()).state, id);

beforeAll(async () => {
  const provider = await listen(identityProvider());
  idpServer = provider.server; idp.base = provider.base;
  const app = await listen(null);
  appServer = app.server; appBase = app.base;
  vi.stubEnv('MOCK_OIDC', 'false'); vi.stubEnv('OIDC_ISSUER_URL', idp.base); vi.stubEnv('OIDC_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('OIDC_CLIENT_SECRET', CLIENT_SECRET); vi.stubEnv('SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
  vi.stubEnv('APP_URL', appBase); vi.stubEnv('LOG_LEVEL', 'silent');
  const { authMiddleware, requiresAuth, loginHandler } = createOidcMiddleware();
  const site = express();
  site.use(authMiddleware);
  site.get('/login', loginHandler);
  site.get('/', (_req, res) => { res.type('html').send('<!doctype html><title>home</title><p>signed in</p>'); });
  site.use('/cockpit', requiresAuth, express.static(path.resolve('src/pages/cockpit')));
  site.use('/api/location', refuseLocationServiceRail, requiresAuth, createLocationRoutes({ pool: untouchedPool, stepUpStore: store }));
  app.set(site);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(`${appBase}/login`);
  await page.waitForURL(`${appBase}/`);
}, 120_000);

afterAll(async () => {
  await context?.close(); await browser?.close();
  await new Promise<void>((done) => appServer.close(() => done()));
  await new Promise<void>((done) => idpServer.close(() => done()));
  vi.unstubAllEnvs();
}, 30_000);

describe('location step-up over real OIDC', () => {
  it('a fresh sign-in forced with max_age=0 proves the challenge', async () => {
    idp.mode = 'honour';
    const challenge = await openChallenge('block');
    expect(challenge.method).toBe('oidc-max-age');
    await page.goto(`${appBase}${challenge.startUrl}`);
    await page.waitForURL(/stepUpDone=1/);
    expect(page.url()).toContain('stepUpDone=1&ok=1');
    expect(idp.seen.at(-1)).toMatchObject({ max_age: '0', client_id: CLIENT_ID });
    expect(await challengeState(challenge.challengeId)).toBe('proven');
  }, 30_000);

  it('a provider that ignores max_age and reuses its old session proves nothing', async () => {
    idp.mode = 'ignore-max-age';
    idp.sessionAuthTime = Math.floor(Date.now() / 1000) - 3_600;
    const challenge = await openChallenge('city');
    await page.goto(`${appBase}${challenge.startUrl}`);
    await page.waitForURL(/stepUpDone=1/);
    expect(page.url()).toContain('ok=0&reason=stale-authentication');
    expect(await challengeState(challenge.challengeId)).toBe('pending');
  }, 30_000);

  it('reaching the complete endpoint without a fresh round trip proves nothing', async () => {
    const challenge = await openChallenge('exact');
    await page.goto(`${appBase}/api/location/step-up/${challenge.challengeId}/complete`);
    await page.waitForURL(/stepUpDone=1/);
    expect(page.url()).toContain('ok=0&reason=stale-authentication');
    expect(await challengeState(challenge.challengeId)).toBe('pending');
  }, 30_000);

  it('re-authenticating as a different account proves nothing for the first account', async () => {
    const challenge = await openChallenge('place-only');
    idp.mode = 'switch-account';
    await page.goto(`${appBase}${challenge.startUrl}`);
    await page.waitForURL(/stepUpDone=1/);
    expect(page.url()).toContain('ok=0&reason=different-account');
    expect(store.view(challenge.challengeId, { sub: 'person-a', principalIssuer: idp.base })?.state).toBe('pending');
  }, 30_000);
});
