/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary regression for the 2026-09-28 live FAIL of the Little Monsters class-material import (404 "artifact handle not found" seconds after the mint). Crossed for real: the shipped artifact-exchange router behind the shipped serviceSecretOr gate, the shipped PAT middleware (createCliTokenAuthMiddleware) stamping the token's owner and issuer, the shipped actor resolver (createApplicationAuthorizationActorResolver) inside a real ApplicationAuthorizationRuntime that binds the verified principal at mint and revalidates it at redeem, and a package route behind the runtime's own guard that calls the shipped redeemArtifactViaRelay over the loopback. The shipped store call shape (no request handed over) reproduces the exact 404 and message, and a direct service-rail lookup shows the refusal is the principal check (the relay's "handle not found or expired" branch), not the registry; handing the request over redeems as the caller with no service secret on the wire; a second issuer with the same subject and a locator over a protected source are proven too.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { createApplicationAuthorizationActorResolver } from '@/app/middleware/application-authorization-identity';
import { createArtifactExchangeRoutes } from '@/app/routes/artifact-exchange-routes';
import { createCliTokenAuthMiddleware } from '@/app/routes/cli-token-routes';
import type { AppContext } from '@/app/composition/app-context';
import type { SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { callerRelayHeaders, redeemArtifactViaRelay } from '@/shared/artifact-exchange';
import { serviceSecretOr } from '@/shared/middleware/authz';
import { FakeCliTokenPool } from '../helpers/fake-cli-token-pool';

const ISSUER = 'https://redeem-principal.fixture.test';
const OTHER_ISSUER = 'https://other.fixture.test';
const SECRET = 'redeem-principal-fixture-secret';
const EXPIRED = 'artifact handle not found — it may have expired; use Send to… again';
const admin: AuthorizationActor = { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const catalog: AuthorizationCatalog = { version: 1, resources: { files: { scopes: ['own'] } },
  permissions: { 'files.read': { resource: 'files', effect: 'read', minimumTier: 'viewer' }, 'files.write': { resource: 'files', effect: 'write', minimumTier: 'editor' } },
  roles: { member: { tier: 'editor', grants: [{ permission: 'files.read', scope: 'own' }, { permission: 'files.write', scope: 'own' }] } },
  bindings: { http: [{ id: 'data', method: 'GET', path: '/data', allOf: ['files.read'] }, { id: 'import', method: 'POST', path: '/import', allOf: ['files.write'] }] } };

type Caller = 'pat' | 'collisionPat' | 'alice' | 'collision';
interface Seen { method: string; path: string; headers: Request['headers'] }
let root: string, server: Server, base: string, savedSecret: string | undefined;
let policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore;
let tokens: FakeCliTokenPool, pats: Record<'pat' | 'collisionPat', string>;
let relaySeen: Seen[], sourceSeen: Seen[];

/** Session cookies stand in for express-openid-connect's appSession: the verified subject on user, the issuer on idTokenClaims. */
const SESSIONS: Record<string, { sub: string; iss: string }> = { alice: { sub: 'alice', iss: ISSUER }, collision: { sub: 'alice', iss: OTHER_ISSUER } };
function sessionDouble(req: Request, _res: Response, next: NextFunction): void {
  const name = /(?:^|;\s*)fixture-session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const session = name ? SESSIONS[name] : undefined;
  if (session) Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: session.sub }, idTokenClaims: { iss: session.iss } } });
  next();
}
/** requiresAuth's contract: an authenticated req.oidc passes, anything else is 401. */
function requiresAuthDouble(req: Request, res: Response, next: NextFunction): void {
  if ((req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.()) { next(); return; }
  res.status(401).json({ error: 'fixture_login_required' });
}
async function grant(sub: string, issuer: string) {
  const preview = await policy.previewChange(admin, { app: 'relay-fixture', action: 'grant', role: 'member',
    targetSub: sub, targetIssuer: issuer, reason: 'Isolated redeem principal proof', expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
}
/** Credentials for one caller: a real PAT, or a session cookie. */
function rail(caller: Caller): Record<string, string> {
  return caller === 'pat' || caller === 'collisionPat' ? { authorization: `Bearer ${pats[caller]}` } : { cookie: `fixture-session=${caller}` };
}
async function mintUpload(caller: Caller, bytes = 'class handout bytes') {
  const form = new FormData();
  form.append('type', 'application/pdf');
  form.append('name', 'handout.pdf');
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'handout.pdf');
  const response = await fetch(`${base}/api/artifacts/handles/upload`, { method: 'POST', headers: rail(caller), body: form });
  expect(response.status).toBe(201);
  return (await response.json()).ref as string;
}
async function mintLocator(caller: Caller, source = '/api/relay-fixture/data') {
  const response = await fetch(`${base}/api/artifacts/handles`, { method: 'POST',
    headers: { ...rail(caller), 'content-type': 'application/json' }, body: JSON.stringify({ source, type: 'text/plain' }) });
  expect(response.status).toBe(201);
  return (await response.json()).ref as string;
}
/** The package route, called the way the store's import-artifact route calls it: `legacy` omits the request. */
async function importAs(caller: Caller, ref: string, shape: 'legacy' | 'request' = 'request') {
  const response = await fetch(`${base}/api/relay-fixture/import`, { method: 'POST',
    headers: { ...rail(caller), 'content-type': 'application/json' }, body: JSON.stringify({ ref, shape }) });
  return { status: response.status, json: await response.json() as { error?: string; name?: string; type?: string; bytes?: string } };
}
const lookups = () => relaySeen.filter((s) => s.method === 'GET' && s.path.startsWith('/handles/'));

beforeEach(async () => {
  savedSecret = process.env.SWARM_SERVICE_SECRET;
  process.env.SWARM_SERVICE_SECRET = SECRET;
  root = mkdtempSync(join(tmpdir(), 'artifact-redeem-principal-'));
  relaySeen = []; sourceSeen = [];
  tokens = new FakeCliTokenPool();
  pats = { pat: tokens.seed({ sub: 'alice', principalIssuer: ISSUER }), collisionPat: tokens.seed({ sub: 'alice', principalIssuer: OTHER_ISSUER }) };
  writeFileSync(join(root, 'authorization.yaml'), JSON.stringify(catalog));
  const manifest = { name: 'relay-fixture', version: '1.0.0', uses: ['application-authorization'],
    authorization: { version: 1 as const, catalog: 'authorization.yaml' }, routes: [{ mountPath: '/api/relay-fixture' }] };
  const record = { name: 'relay-fixture', manifestPath: join(root, 'oshal-app.yaml'), manifest } as SwarmApplicationRecord;
  store = new MemoryAuthorizationStore(); policy = new ApplicationAuthorizationService(store);
  // The shipped resolver; its only store reads (local-auth status, tenant memberships, the role
  // table) are for other issuers, so an empty pool is never queried for these https issuers.
  const resolveActor = createApplicationAuthorizationActorResolver({} as Pool, { env: {}, tenantIds: async () => [] });
  const runtime = new ApplicationAuthorizationRuntime(policy, resolveActor, {}); await runtime.start(record);
  runtime.forPackage('relay-fixture').registerResource('files', { authorize: async () => true }); runtime.complete(record);
  await grant('alice', ISSUER); await grant('alice', OTHER_ISSUER);
  const app = express(); app.use(express.json());
  app.use(createCliTokenAuthMiddleware(tokens.asPool()));
  app.use(sessionDouble);
  app.use('/api/artifacts', (req, _res, next) => { relaySeen.push({ method: req.method, path: req.path, headers: req.headers }); next(); });
  app.use('/api/artifacts', serviceSecretOr(requiresAuthDouble), createArtifactExchangeRoutes({ applicationAuthorization: runtime } as AppContext));
  app.use('/api/relay-fixture', requiresAuthDouble, (req, res, next) => { void runtime.guard('relay-fixture', req, res, next); });
  app.get('/api/relay-fixture/data', (req, res) => { sourceSeen.push({ method: req.method, path: req.path, headers: req.headers }); res.type('text').send('owned-sensitive-bytes'); });
  app.post('/api/relay-fixture/import', async (req, res) => {
    const subject = String((req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub || '');
    const redeemed = await redeemArtifactViaRelay({ port: req.socket.localPort, callerSub: subject, ref: String(req.body?.ref || ''),
      maxBytes: 1_000_000, ...(req.body?.shape === 'legacy' ? {} : { request: req }) });
    if (!redeemed.ok) { res.status(redeemed.status).json({ error: redeemed.error }); return; }
    res.status(201).json({ name: redeemed.name, type: redeemed.type, bytes: redeemed.buffer.toString() });
  });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((done) => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (savedSecret === undefined) delete process.env.SWARM_SERVICE_SECRET; else process.env.SWARM_SERVICE_SECRET = savedSecret;
  server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

describe('package-side redeem against the principal-bound relay', () => {
  it('reproduces the live failure: the service-rail redeem of a handle the same caller minted seconds earlier is refused 404', async () => {
    const ref = await mintUpload('pat');
    expect(await importAs('pat', ref, 'legacy')).toEqual({ status: 404, json: { error: EXPIRED } });
    const [lookup] = lookups();
    expect(lookup.headers['x-service-secret']).toBe(SECRET);
    expect(lookup.headers['x-oshal-user-sub']).toBe('alice');
    expect(lookup.headers.authorization).toBeUndefined();
    // Same process, same registry, same owner: the registry resolves the handle and the relay's
    // principal check refuses the service rail (it carries a subject but no verified issuer).
    const direct = await fetch(`${base}/api/artifacts/handles/${ref}`, { headers: { 'x-service-secret': SECRET, 'x-oshal-user-sub': 'alice' } });
    expect({ status: direct.status, json: await direct.json() }).toEqual({ status: 404, json: { error: 'handle not found or expired' } });
    const unknown = await fetch(`${base}/api/artifacts/handles/art_unknownfixture01`, { headers: { 'x-service-secret': SECRET, 'x-oshal-user-sub': 'alice' } });
    expect(await unknown.json()).toEqual({ error: 'artifact handle not found' });
  });

  it('redeems as the caller on the PAT rail when the importing route hands over its request, with no service secret on the wire', async () => {
    const ref = await mintUpload('pat', 'pat handout');
    expect(await importAs('pat', ref)).toEqual({ status: 201, json: { name: 'handout.pdf', type: 'application/pdf', bytes: 'pat handout' } });
    expect(lookups().map((s) => s.path)).toEqual([`/handles/${ref}`, `/handles/${ref}/content`]);
    for (const { headers } of lookups()) {
      expect(headers['x-service-secret']).toBeUndefined();
      expect(headers['x-oshal-user-sub']).toBeUndefined();
      expect(headers.authorization).toBe(`Bearer ${pats.pat}`);
    }
  });

  it('redeems on the session rail, and relays a locator over the protected package source as the caller', async () => {
    const ref = await mintLocator('alice');
    expect(await importAs('alice', ref)).toEqual({ status: 201, json: { name: 'artifact', type: 'text/plain', bytes: 'owned-sensitive-bytes' } });
    expect(sourceSeen).toHaveLength(1);
    expect(sourceSeen[0].headers.cookie).toBe('fixture-session=alice');
    expect(sourceSeen[0].headers['x-service-secret']).toBeUndefined();
  });

  it('refuses the same subject under a second issuer on either rail, and never reaches the protected source', async () => {
    expect((await importAs('collision', await mintUpload('alice'))).status).toBe(404);
    expect((await importAs('collisionPat', await mintUpload('pat'))).status).toBe(404);
    expect((await importAs('collision', await mintLocator('alice'))).status).toBe(404);
    expect(sourceSeen).toHaveLength(0);
  });

  it('forwards only the caller rails the relay accepts', () => {
    const pat = `Bearer oshal_pat_${'b'.repeat(48)}`;
    expect(callerRelayHeaders({ headers: { cookie: 'appSession=x', host: 'oshal.example.com', authorization: 'Bearer not-a-pat', 'x-service-secret': 's' } }))
      .toEqual({ cookie: 'appSession=x', host: 'oshal.example.com' });
    expect(callerRelayHeaders({ headers: { authorization: pat } })).toEqual({ authorization: pat });
    expect(callerRelayHeaders({ headers: { host: 'oshal.example.com' } })).toBeNull();
    expect(callerRelayHeaders(undefined)).toBeNull();
  });
});
