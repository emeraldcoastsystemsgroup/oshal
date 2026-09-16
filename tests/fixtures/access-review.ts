/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolated real fixture for the joined access review: the real route over the real ADR-149 service and a real policy store, plus the real page, so the HTTP answer and the screen that renders it are proven against the same authority.
 */
/** Real access-review route, real policy service, real page. No database, no container. */
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { createAccessReviewRoutes } from '@/app/routes/access-review-routes';
import { CATALOG, ISSUER } from './authorization';

/** One signed-in identity: the OIDC claims the governance resolver reads, and its ADR-149 actor. */
export interface AccessReviewSession { claims: Record<string, unknown>; actor: AuthorizationActor }

export const SESSIONS: Record<string, AccessReviewSession> = {
  // Granted on the Users page: a row in the swarm_roles snapshot (ADR-148).
  granted: {
    claims: { sub: 'granted-admin', email: 'granted@fixture.test' },
    actor: { sub: 'granted-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true },
  },
  // Break-glass ONLY: named in the operator-local environment file, no swarm_roles row.
  breakglass: {
    claims: { sub: 'breakglass-admin', email: 'breakglass@fixture.test' },
    actor: { sub: 'breakglass-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: true },
  },
  // Admin by an IdP role claim only — the case the old two-way guess reported as break-glass.
  claimed: {
    claims: { sub: 'claims-admin', email: 'claims@fixture.test', realm_access: { roles: ['oshal-admin'] } },
    actor: { sub: 'claims-admin', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  },
  alice: {
    claims: { sub: 'alice', email: 'alice@fixture.test' },
    actor: { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  },
  bob: {
    claims: { sub: 'bob', email: 'bob@fixture.test' },
    actor: { sub: 'bob', issuer: ISSUER, isActive: true, isSwarmAdmin: false },
  },
};

/**
 * @description Stand up the real service, the real route, the real page and a loopback server.
 * @returns The service, store, a real grant helper, a JSON reader, the base URL and a closer.
 */
export async function createAccessReviewFixture() {
  const store = new MemoryAuthorizationStore();
  const service = new ApplicationAuthorizationService(store, {
    resolveActor: async (sub, issuer) => Object.values(SESSIONS)
      .map((session) => session.actor)
      .find((actor) => actor.sub === sub && actor.issuer === issuer) ?? null,
  });
  await service.registerApp({ app: 'catalog-app', source: 'fixture-store', version: '1.0.0', catalog: CATALOG,
    mode: 'enforce', adapters: { records: { authorize: async () => true } } });
  await service.registerApp({ app: 'fallback-app', source: 'fixture-store', version: '1.0.0', catalog: null, mode: 'enforce' });

  const name = (req: Request) => /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '')?.[1] ?? '';
  const app = express();
  app.use('/api/access-review', createAccessReviewRoutes({
    // The one seam a test may stand in for: the OIDC session. callerFromRequest reads req.oidc.user
    // exactly as it does in production, so the role resolution under test is the real one.
    requiresAuth: (req, res, next) => {
      const session = SESSIONS[name(req)];
      if (!session) { res.status(401).json({ error: 'authentication_required' }); return; }
      (req as unknown as { oidc: { user: unknown } }).oidc = { user: session.claims };
      next();
    },
    resolveActor: async (req) => {
      const session = SESSIONS[name(req)];
      if (!session) throw new Error('no identity');
      return structuredClone(session.actor);
    },
    authority: service,
  }));
  app.use('/access-review', express.static(resolve('src/pages/access-review')));
  app.use('/shared', express.static(resolve('src/shared')));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** @description Apply a real grant through the service's own preview/apply path. */
  async function grant(targetSub: string, role: string) {
    const preview = await service.previewChange(SESSIONS.granted.actor, {
      action: 'grant', app: 'catalog-app', targetSub, targetIssuer: ISSUER, role,
      reason: 'Access review fixture', expectedRevision: (await store.read()).revision,
    });
    await service.applyChange(SESSIONS.granted.actor, { previewId: preview.previewId, idempotencyKey: randomUUID() });
  }

  /** @description Revoke a role the same way the management surface does. */
  async function revoke(targetSub: string, role: string) {
    const preview = await service.previewChange(SESSIONS.granted.actor, {
      action: 'revoke', app: 'catalog-app', targetSub, targetIssuer: ISSUER, role,
      reason: 'Access review fixture revoke', expectedRevision: (await store.read()).revision,
    });
    await service.applyChange(SESSIONS.granted.actor, { previewId: preview.previewId, idempotencyKey: randomUUID() });
  }

  /** @description Read the joined review over HTTP as one signed-in session. */
  async function review(session: string | null, query = '') {
    const response = await fetch(`${base}/api/access-review${query}`, {
      headers: session ? { cookie: `session=${session}` } : {},
    });
    return { status: response.status, body: await response.json() as Record<string, never> };
  }

  return { service, store, grant, revoke, review, base,
    async close() { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}
