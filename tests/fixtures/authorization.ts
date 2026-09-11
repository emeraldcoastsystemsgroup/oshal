/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Provide isolated real policy and HTTP fixtures for access administration.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Allow the actual compiled page adapter to exercise installed asset paths under the same authority checks.
 */
/** Isolated real management service and disposable loopback HTTP server. No operator database. */
import express, { type Request, type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange } from '@/shared/application-authorization';
import { createAuthorizationPageRoutes, createAuthorizationRoutes } from '@/app/routes/authorization-routes';
import { AuthorizationToolRuntime } from '@/app/composition/authorization-tool';

export const ISSUER = 'https://identity.fixture.test';
export const CATALOG: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'records.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'own' }] },
    'sensitive-reader': { tier: 'viewer', sensitive: true, grants: [{ permission: 'records.read', scope: 'own' }] } },
  bindings: { http: [{ id: 'read-records', method: 'GET', path: '/records', allOf: ['records.read'] }] },
};

export async function createAuthorizationFixture(pageFactory = createAuthorizationPageRoutes) {
  let identityFailure: Error | null = null;
  let directoryGroups = [{ issuer: ISSUER, tenantId: 'tenant-one', id: 'engineering', label: 'Engineering' }];
  const actors: Record<string, AuthorizationActor> = {
    admin: { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true },
    reader: { sub: 'manager', issuer: ISSUER, isActive: true, isSwarmAdmin: false,
      managementScopes: [{ app: 'catalog-app', permissions: ['read'] }] },
    alice: { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
    bob: { sub: 'bob', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  };
  const store = new MemoryAuthorizationStore();
  const service = new ApplicationAuthorizationService(store, {
    resolveActor: async (sub, issuer) => Object.values(actors).find(actor => actor.sub === sub && actor.issuer === issuer) ?? null,
    inventory: async actor => ({
      users: actor.isSwarmAdmin ? [{ sub: 'alice', issuer: ISSUER, label: '<img src=x onerror="window.inventoryXss=true"> Alice' }, { sub: 'bob', issuer: ISSUER, label: 'Bob' }] : [],
      groups: actor.isSwarmAdmin ? directoryGroups : [],
    }),
  });
  await service.registerApp({ app: 'catalog-app', source: 'fixture-store', version: '1.0.0', catalog: CATALOG, mode: 'enforce',
    adapters: { records: { authorize: async () => true } } });
  await service.registerApp({ app: 'fallback-app', source: 'fixture-store', version: '1.0.0', catalog: null, mode: 'enforce' });
  const name = (req: Request) => /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const auth: RequestHandler = (req, res, next) => {
    if (!actors[name(req) || '']) { res.status(401).json({ error: 'authentication_required' }); return; }
    next();
  };
  const options = { requiresAuth: auth, resolveActor: async (req: Request) => {
    if (identityFailure) throw identityFailure;
    return structuredClone(actors[name(req)!]);
  }, authorizationTool: new AuthorizationToolRuntime(service) };
  const app = express();
  app.use('/api/authorization', createAuthorizationRoutes(service, options));
  app.use('/access', pageFactory(service, options));
  app.use('/shared', express.static(resolve('src/shared')));
  app.use('/cockpit/css/themes', express.static(resolve('src/pages/cockpit/css/themes')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call(endpoint: string, body?: unknown, user: string | null = 'admin', headers: Record<string, string> = {}) {
    const response = await fetch(base + '/api/authorization' + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(user ? { cookie: `session=${user}` } : {}), ...(body === undefined ? {} : {
        'content-type': 'application/json', origin: base, 'x-oshal-access-request': '1',
      }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  async function change(input: Partial<AuthorizationChange> = {}) {
    return { action: 'grant', app: 'catalog-app', targetSub: 'alice', targetIssuer: ISSUER, role: 'reader', reason: 'Fixture access review',
      expectedRevision: (await store.read()).revision, ...input } as AuthorizationChange;
  }
  async function apply(input: Partial<AuthorizationChange> = {}) {
    const preview = await service.previewChange(actors.admin, await change(input));
    return service.applyChange(actors.admin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
  }
  return { actors, store, service, server, base, call, change, apply,
    failIdentity(error: Error) { identityFailure = error; },
    clearDirectoryGroups() { directoryGroups = []; },
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); },
  };
}
