/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the package grant plan's HTTP adapter: it is the whole new callable surface, so it must refuse an anonymous caller, a cross-origin post, a non-JSON body, a half-specified subject and a caller with no management read — and answer nothing but a plan when it does answer.
 */
/** Real routes and real policy service over an isolated in-memory store. No deployment database. */
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, RequestHandler } from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '../../src/features/application-authorization';
import { createAuthorizationRoutes } from '../../src/app/routes/authorization-routes';
import type { AuthorizationActor } from '../../src/shared/application-authorization';

const ISSUER = 'https://identity.fixture.test';
const actors: Record<string, AuthorizationActor> = {
  admin: { sub: 'admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true },
  outsider: { sub: 'outsider', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  child: { sub: 'child', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
};
let service: ApplicationAuthorizationService;
const server = express().listen(0, '127.0.0.1');
const origin = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const session = (req: Request): string | undefined => /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
const requiresAuth: RequestHandler = (req, res, next) => {
  if (!actors[session(req) || '']) { res.status(401).json({ error: 'authentication_required' }); return; }
  next();
};

beforeEach(async () => {
  service = new ApplicationAuthorizationService(new MemoryAuthorizationStore(), {
    resolveActor: async (sub, issuer) => Object.values(actors).find(a => a.sub === sub && a.issuer === issuer) ?? null,
    resolvePackage: async app => app === 'monsters'
      ? { required: { apps: ['office'], tools: [], connectors: ['gmail'] }, optional: { apps: [] } }
      : app === 'office' ? { required: { apps: [], tools: [], connectors: [] }, optional: { apps: [] } } : null,
  });
  for (const app of ['monsters', 'office']) {
    await service.registerApp({ app, source: `source-${app}`, version: '1.0.0', catalog: null, mode: 'enforce' });
  }
  const app = express();
  app.use('/api/authorization', createAuthorizationRoutes(service, {
    requiresAuth, resolveActor: async req => structuredClone(actors[session(req)!]),
  }));
  server.removeAllListeners('request');
  server.on('request', app);
});
afterAll(() => { server.close(); });

async function post(body: unknown, options: { as?: string; origin?: string; marker?: string; type?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': options.type ?? 'application/json' };
  if (options.as) headers.cookie = `session=${options.as}`;
  headers.origin = options.origin ?? origin();
  if (options.marker !== '') headers['x-oshal-access-request'] = options.marker ?? '1';
  const response = await fetch(`${origin()}/api/authorization/package-plan`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
}

describe('package grant plan HTTP adapter', () => {
  it('refuses an anonymous caller before any policy is read', async () => {
    expect(await post({ app: 'monsters' }, {})).toMatchObject({ status: 401 });
  });

  it('refuses a cross-origin post, a post with no access marker and a non-JSON body', async () => {
    expect(await post({ app: 'monsters' }, { as: 'admin', origin: 'https://attacker.example' }))
      .toMatchObject({ status: 403, body: { error: 'same_origin_required' } });
    expect(await post({ app: 'monsters' }, { as: 'admin', marker: '' }))
      .toMatchObject({ status: 403, body: { error: 'same_origin_required' } });
    expect(await post({ app: 'monsters' }, { as: 'admin', type: 'text/plain' })).toMatchObject({ status: 415 });
  });

  it('refuses an unknown field and a half-specified subject rather than falling back to the caller', async () => {
    expect(await post({ app: 'monsters', role: '@app-admin' }, { as: 'admin' }))
      .toMatchObject({ status: 400, body: { error: 'invalid_authorization_request' } });
    expect(await post({ app: 'monsters', targetSub: 'child' }, { as: 'admin' }))
      .toMatchObject({ status: 400, body: { error: 'invalid_authorization_request' } });
    expect(await post({ app: 'Monsters' }, { as: 'admin' })).toMatchObject({ status: 400 });
  });

  it('refuses a caller with no management read on the requested package, about anyone including themselves', async () => {
    expect(await post({ app: 'monsters', targetSub: 'child', targetIssuer: ISSUER }, { as: 'outsider' }))
      .toMatchObject({ status: 403, body: { error: 'authorization_management_denied' } });
    // Naming no target means "about me". The plan is an ADMINISTRATION view, so a caller who cannot
    // administer the package is refused outright rather than handed a list of blocked entries.
    expect(await post({ app: 'monsters' }, { as: 'outsider' }))
      .toMatchObject({ status: 403, body: { error: 'authorization_management_denied' } });
  });

  it('answers a plan and creates nothing', async () => {
    const before = await service.catalog(actors.admin);
    const answer = await post({ app: 'monsters', targetSub: 'child', targetIssuer: ISSUER }, { as: 'admin' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ app: 'monsters', targetSub: 'child', targetIssuer: ISSUER, actionable: 2 });
    expect((answer.body as { entries: Array<{ app: string; action: string }> }).entries)
      .toEqual([{ app: 'monsters', depth: 0, requiredBy: [], action: 'grant-app-admin', status: 'admin-required',
        candidateRoles: ['@app-admin'], currentTier: 'deny' },
      { app: 'office', depth: 1, requiredBy: ['monsters'], action: 'grant-app-admin', status: 'admin-required',
        candidateRoles: ['@app-admin'], currentTier: 'deny' }]);
    expect((answer.body as { declaredNeeds: unknown[] }).declaredNeeds)
      .toEqual([{ kind: 'connector', id: 'gmail', declaredBy: 'monsters' }]);
    const after = await service.catalog(actors.admin);
    expect({ revision: after.revision, assignments: after.assignments.length })
      .toEqual({ revision: before.revision, assignments: before.assignments.length });
  });
});
