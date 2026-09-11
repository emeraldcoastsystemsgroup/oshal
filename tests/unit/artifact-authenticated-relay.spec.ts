/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify real authenticated relay, exact issuer ownership, revocation, redirects and inactive source boundaries.
 */
import express, { type Request } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { createArtifactExchangeRoutes } from '@/app/routes/artifact-exchange-routes';
import type { AppContext } from '@/app/composition/app-context';
import type { SwarmApplicationRecord } from '@/features/swarm-apps';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { mintArtifactHandle } from '@/shared/artifact-exchange';

const ISSUER = 'https://artifact-relay.fixture.test';
const FIXTURE_PAT = `Bearer oshal_pat_${'a'.repeat(48)}`;
const actors: Record<string, AuthorizationActor> = {
  alice: { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  collision: { sub: 'alice', issuer: 'https://other.fixture.test', isActive: true, isSwarmAdmin: false },
  admin: { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true },
};
const catalog: AuthorizationCatalog = { version: 1, resources: { files: { scopes: ['own'] } },
  permissions: { 'files.read': { resource: 'files', effect: 'read', minimumTier: 'viewer' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'files.read', scope: 'own' }] } },
  bindings: { http: ['data', 'redirect'].map(name => ({ id: name, method: 'GET', path: `/${name}`, allOf: ['files.read'] })) } };
let root: string, server: Server, target: Server, base: string, targetBase: string;
let policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore, runtime: ApplicationAuthorizationRuntime;
let record: SwarmApplicationRecord, blocked: Promise<void> | undefined, release: (() => void) | undefined;
let observed: Request['headers'][], leaked: number, sourceAborted: boolean;

function identity(req: Request): AuthorizationActor {
  const name = req.headers.authorization === FIXTURE_PAT ? 'alice' : /(?:^|;\s*)relay-user=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const actor = name ? actors[name] : undefined;
  if (!actor) throw Object.assign(new Error('Verified fixture cookie required'), { status: 401 });
  return actor;
}
async function listen(app: express.Express) {
  const result = app.listen(0, '127.0.0.1'); await new Promise<void>(done => result.once('listening', done));
  return { server: result, base: `http://127.0.0.1:${(result.address() as AddressInfo).port}` };
}
async function change(action: 'grant' | 'revoke', user = 'alice') {
  const principal = actors[user];
  const preview = await policy.previewChange(actors.admin, { app: 'relay-fixture', action, role: 'reader',
    targetSub: principal.sub, targetIssuer: principal.issuer, reason: 'Isolated relay permission proof', expectedRevision: (await store.read()).revision });
  await policy.applyChange(actors.admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
}
async function call(path: string, user = 'alice', body?: unknown) {
  return fetch(base + '/api/artifacts' + path, { method: body ? 'POST' : 'GET',
    headers: { cookie: `relay-user=${user}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function mint(source = '/api/relay-fixture/data') {
  const response = await call('/handles', 'alice', { source, type: 'text/plain' });
  expect(response.status).toBe(201); return (await response.json()).ref as string;
}
function sourceRoutes(app: express.Express) {
  app.use('/api/relay-fixture', (req, res, next) => { void runtime.guard('relay-fixture', req, res, next); });
  app.get('/api/relay-fixture/data', async (req, res) => {
    observed.push(req.headers); res.once('close', () => { if (!res.writableEnded) sourceAborted = true; });
    await blocked; res.type('text').send('owned-sensitive-bytes');
  });
  app.get('/api/relay-fixture/redirect', (_req, res) => { res.redirect(targetBase + '/credential-sink'); });
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'artifact-relay-')); observed = []; leaked = 0; blocked = undefined; release = undefined; sourceAborted = false;
  writeFileSync(join(root, 'authorization.yaml'), JSON.stringify(catalog));
  const manifest = { name: 'relay-fixture', version: '1.0.0', uses: ['application-authorization'],
    authorization: { version: 1 as const, catalog: 'authorization.yaml' }, routes: [{ mountPath: '/api/relay-fixture' }] };
  record = { name: 'relay-fixture', manifestPath: join(root, 'oshal-app.yaml'), manifest } as SwarmApplicationRecord;
  store = new MemoryAuthorizationStore(); policy = new ApplicationAuthorizationService(store);
  runtime = new ApplicationAuthorizationRuntime(policy, async req => identity(req)); await runtime.start(record);
  runtime.forPackage('relay-fixture').registerResource('files', { authorize: async () => true }); runtime.complete(record);
  await change('grant'); await change('grant', 'collision');
  const sink = express(); sink.get('/credential-sink', (_req, res) => { leaked++; res.send('never'); });
  const targetHttp = await listen(sink); target = targetHttp.server; targetBase = targetHttp.base;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { try { const actor = identity(req); (req as any).oidc = { user: { sub: actor.sub, iss: actor.issuer }, isAuthenticated: () => true }; next(); }
    catch { res.status(401).json({ error: 'fixture_login_required' }); } });
  const ctx = { applicationAuthorization: runtime } as AppContext;
  app.use('/api/artifacts', createArtifactExchangeRoutes(ctx)); sourceRoutes(app);
  const http = await listen(app); server = http.server; base = http.base;
});
afterEach(async () => {
  release?.();
  for (const http of [server, target]) if (http) { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); }
  if (root) rmSync(root, { recursive: true, force: true });
});

it('re-fetches a protected source with the original verified cookie and no service impersonation', async () => {
  const ref = await mint(); const response = await call(`/handles/${ref}/content`);
  expect(response.status).toBe(200); expect(await response.text()).toBe('owned-sensitive-bytes');
  expect(observed[0].cookie).toBe('relay-user=alice');
  expect(observed[0]['x-service-secret']).toBeUndefined(); expect(observed[0]['x-oshal-user-sub']).toBeUndefined();
});
it('refuses a second issuer with the same subject and a legacy unbound protected handle', async () => {
  const ref = await mint();
  expect((await call(`/handles/${ref}`, 'collision')).status).toBe(404);
  expect((await call(`/handles/${ref}/content`, 'collision')).status).not.toBe(200);
  const legacy = mintArtifactHandle({ ownerSub: 'alice', sourcePath: '/api/relay-fixture/data', type: 'text/plain' });
  expect((await call(`/handles/${legacy.ref}/content`)).status).not.toBe(200);
  expect(observed).toHaveLength(0);
});
it('preserves normal authentication precedence when original cookie and PAT coexist', async () => {
  const ref = await mint();
  const response = await fetch(base + `/api/artifacts/handles/${ref}/content`, {
    headers: { cookie: 'relay-user=collision', authorization: FIXTURE_PAT },
  });
  expect(response.status).toBe(200); expect(await response.text()).toBe('owned-sensitive-bytes');
  expect(observed[0].authorization).toBe(FIXTURE_PAT); expect(observed[0].cookie).toBe('relay-user=collision');
});
it('revalidates read permission after the source response was delayed', async () => {
  const ref = await mint(); blocked = new Promise<void>(done => { release = done; });
  const response = call(`/handles/${ref}/content`); await expect.poll(() => observed.length).toBe(1);
  await change('revoke'); release!();
  const result = await response; expect(result.status).not.toBe(200); expect(await result.text()).not.toContain('owned-sensitive-bytes');
});
it('retains protected mount ownership when unloaded and invalidates old handles on reload', async () => {
  const ref = await mint(); runtime.unregister('relay-fixture');
  expect(await runtime.authorizeHttpPath(actors.alice, { method: 'GET', path: '/api/relay-fixture/data' })).toMatchObject({ allowed: false, app: 'relay-fixture' });
  expect((await call(`/handles/${ref}/content`)).status).not.toBe(200);
  await runtime.start(record); runtime.forPackage('relay-fixture').registerResource('files', { authorize: async () => true }); runtime.complete(record);
  expect((await call(`/handles/${ref}/content`)).status).not.toBe(200);
  expect((await call(`/handles/${await mint()}/content`)).status).toBe(200);
});
it('never follows a source redirect to another origin with credentials', async () => {
  const ref = await mint('/api/relay-fixture/redirect');
  expect((await call(`/handles/${ref}/content`)).status).not.toBe(200); expect(leaked).toBe(0);
});
it('cancels the source fetch when its receiving browser disconnects', async () => {
  const ref = await mint(); blocked = new Promise<void>(done => { release = done; });
  const abort = new AbortController();
  const response = fetch(base + `/api/artifacts/handles/${ref}/content`, { headers: { cookie: 'relay-user=alice' }, signal: abort.signal }).catch(() => null);
  await expect.poll(() => observed.length).toBe(1); abort.abort(); await response;
  await expect.poll(() => sourceAborted).toBe(true);
});
