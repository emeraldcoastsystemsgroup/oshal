/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the joined access review over the REAL boundaries it claims to join: the governance role resolver reading the real swarm_roles snapshot and the real environment allowlists, and the real ADR-149 authorization service over a real policy store with a really applied grant. The load-bearing case is the one the surface exists for - a break-glass-only operator and a swarm-role admin resolve the SAME role, so without provenance they render identically.
 */
/** Real HTTP join over the three authorization axes. No database, no container, no mock authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { createAccessReviewRoutes } from '@/app/routes/access-review-routes';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { CATALOG, ISSUER } from '../fixtures/authorization';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

/** One signed-in identity: the OIDC claims the governance resolver reads, and its ADR-149 actor. */
interface Session { claims: Record<string, unknown>; actor: AuthorizationActor }

const SESSIONS: Record<string, Session> = {
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

/** @description Stand up the real service, the real route and a disposable loopback server. */
async function createFixture() {
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

  async function review(session: string | null, query = '') {
    const response = await fetch(`${base}/api/access-review${query}`, {
      headers: session ? { cookie: `session=${session}` } : {},
    });
    return { status: response.status, body: await response.json() as Record<string, never> };
  }

  return { service, store, grant, review, base,
    async close() { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } };
}

let fixture: Awaited<ReturnType<typeof createFixture>>;

beforeEach(async () => {
  // The real swarm_roles snapshot, populated the way the swarm-roles feature populates it.
  setPrivilegedIdentities([{ sub: 'granted-admin', email: 'granted@fixture.test', role: 'admin' }]);
  // The real break-glass allowlist, read from the environment by the real policy module.
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'breakglass-admin');
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_RBAC_ENFORCE', 'false');
  fixture = await createFixture();
});

afterEach(async () => {
  await fixture?.close();
  clearPrivilegedIdentities();
  vi.unstubAllEnvs();
});

describe('access review — the provenance of a swarm role', () => {
  it('labels a break-glass-only operator differently from a granted admin holding the same role', async () => {
    const granted = await fixture.review('granted');
    const breakglass = await fixture.review('breakglass');

    expect(granted.status).toBe(200);
    expect(breakglass.status).toBe(200);
    // Identical role. This is the whole problem: without provenance the two render the same.
    expect(granted.body.swarm.role).toBe('admin');
    expect(breakglass.body.swarm.role).toBe('admin');
    expect(granted.body.permissions).toEqual(breakglass.body.permissions);

    expect(granted.body.swarm.source).toBe('swarm-role');
    expect(granted.body.swarm.sources).toEqual(['swarm-role']);
    expect(breakglass.body.swarm.source).toBe('break-glass');
    expect(breakglass.body.swarm.sources).toEqual(['break-glass']);
    expect(breakglass.body.swarm.source).not.toBe(granted.body.swarm.source);
  });

  it('names an IdP role claim as its own source instead of blaming the environment file', async () => {
    const claimed = await fixture.review('claimed');
    expect(claimed.body.swarm.role).toBe('admin');
    expect(claimed.body.swarm.source).toBe('idp-claim');
    expect(claimed.body.swarm.sources).toEqual(['idp-claim']);
  });

  it('lists every axis that independently confers the role, most durable first', async () => {
    setPrivilegedIdentities([{ sub: 'breakglass-admin', email: 'breakglass@fixture.test', role: 'root' }]);
    const both = await fixture.review('breakglass');
    expect(both.body.swarm.sources).toEqual(['swarm-role', 'break-glass']);
    expect(both.body.swarm.source).toBe('swarm-role');
    expect(both.body.swarm.isRoot).toBe(true);
  });

  it('says the role snapshot has not loaded rather than reporting "no role"', async () => {
    clearPrivilegedIdentities();
    const granted = await fixture.review('granted');
    expect(granted.body.swarm.rolesLoaded).toBe(false);
    expect(granted.body.swarm.sources).toEqual([]);
    const loaded = await fixture.review('breakglass');
    expect(loaded.body.swarm.rolesLoaded).toBe(false);
    expect(loaded.body.swarm.sources).toEqual(['break-glass']);
  });

  it('reports a plain authenticated caller as holding no role grant at all', async () => {
    const alice = await fixture.review('alice');
    expect(alice.body.swarm.role).toBe('viewer');
    expect(alice.body.swarm.source).toBe('none');
    expect(alice.body.canChooseSubject).toBe(false);
  });
});

describe('access review — the three axes in one answer', () => {
  it('joins swarm role, governance permissions and a real per-application assignment', async () => {
    await fixture.grant('alice', 'reader');
    const alice = await fixture.review('alice');

    expect(alice.status).toBe(200);
    expect(alice.body.subject).toMatchObject({ sub: 'alice', issuer: ISSUER, self: true });
    expect(alice.body.swarm.role).toBe('viewer');
    expect(alice.body.permissions).toEqual(['ticket.read', 'audit.read']);
    expect(alice.body.appsAvailable).toBe(true);

    const apps = alice.body.apps as unknown as Array<Record<string, unknown>>;
    expect(apps.map((row) => row.app)).toEqual(['catalog-app', 'fallback-app']);
    const catalogApp = apps.find((row) => row.app === 'catalog-app')!;
    expect(catalogApp.source).toBe('app-assignment');
    expect(catalogApp.roles).toEqual(['reader']);
    expect(catalogApp.tier).toBe('viewer');
    expect(catalogApp.grants).toEqual(['records.read']);
    expect(catalogApp.denied).toBe(false);
  });

  it('shows the application a subject CANNOT reach, which is the half ownCatalog cannot answer', async () => {
    const bob = await fixture.review('bob');
    const apps = bob.body.apps as unknown as Array<Record<string, unknown>>;
    expect(apps.map((row) => row.app)).toEqual(['catalog-app', 'fallback-app']);
    for (const row of apps) {
      expect(row.roles).toEqual([]);
      expect(row.source).toBe('none');
      expect(row.tier).toBe('deny');
    }
  });

  it('follows a revocation, because every value is read live from the policy store', async () => {
    await fixture.grant('alice', 'reader');
    const granted = await fixture.review('alice');
    expect((granted.body.apps as unknown as Array<Record<string, unknown>>)[0].source).toBe('app-assignment');

    const preview = await fixture.service.previewChange(SESSIONS.granted.actor, {
      action: 'revoke', app: 'catalog-app', targetSub: 'alice', targetIssuer: ISSUER, role: 'reader',
      reason: 'Access review fixture revoke', expectedRevision: (await fixture.store.read()).revision,
    });
    await fixture.service.applyChange(SESSIONS.granted.actor, { previewId: preview.previewId, idempotencyKey: randomUUID() });

    const after = await fixture.review('alice');
    expect((after.body.apps as unknown as Array<Record<string, unknown>>)[0].source).toBe('none');
    expect((after.body.apps as unknown as Array<Record<string, unknown>>)[0].roles).toEqual([]);
  });
});

describe('access review — who may review whom', () => {
  it('lets an admin review any subject and refuses everybody else', async () => {
    await fixture.grant('alice', 'reader');

    const byAdmin = await fixture.review('granted', '?sub=alice');
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.subject).toMatchObject({ sub: 'alice', self: false, email: null });
    const catalogApp = (byAdmin.body.apps as unknown as Array<Record<string, unknown>>)
      .find((row) => row.app === 'catalog-app')!;
    expect(catalogApp.roles).toEqual(['reader']);
    // Reviewing somebody else sees only their subject identifier: an EMAIL-only break-glass entry
    // is outside that answer, and the payload must say so rather than imply the axis is clear.
    expect(byAdmin.body.swarm.emailEvaluated).toBe(false);

    expect((await fixture.review('alice', '?sub=bob')).status).toBe(403);
    expect((await fixture.review('bob', '?sub=alice')).status).toBe(403);
    expect((await fixture.review(null)).status).toBe(401);
  });

  it('reads a break-glass subject the reviewer cannot otherwise see', async () => {
    const byAdmin = await fixture.review('granted', '?sub=breakglass-admin');
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.swarm.role).toBe('admin');
    expect(byAdmin.body.swarm.sources).toEqual(['break-glass']);
  });

  it('degrades one unreadable application instead of the whole answer', async () => {
    // Admin by IdP claim only: the governance axis lets them choose a subject, while the
    // authorization authority still refuses a read they hold no management scope for.
    const claimed = await fixture.review('claimed', '?sub=alice');
    expect(claimed.status).toBe(200);
    expect(claimed.body.apps).toEqual([]);
    expect(claimed.body.unreadable).toEqual([
      { app: 'catalog-app', reason: 'authorization_management_denied' },
      { app: 'fallback-app', reason: 'authorization_management_denied' },
    ]);
  });

  it('refuses an identifier the authorization authority would itself refuse', async () => {
    expect((await fixture.review('granted', `?sub=${encodeURIComponent('a'.repeat(513))}`)).status).toBe(400);
    expect((await fixture.review('granted', `?sub=${encodeURIComponent('alice' + String.fromCharCode(7))}`)).status).toBe(400);
  });
});

describe('access review — it is a view, not an authority', () => {
  it('exposes no write verb', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${fixture.base}/api/access-review`, {
        method, headers: { cookie: 'session=granted' },
      });
      expect(response.status).toBe(404);
    }
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });

  it('never caches an identity-scoped answer', async () => {
    const response = await fetch(`${fixture.base}/api/access-review`, { headers: { cookie: 'session=granted' } });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
