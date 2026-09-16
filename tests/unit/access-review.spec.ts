/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the joined access review over the REAL boundaries it claims to join: the governance role resolver reading the real swarm_roles snapshot and the real environment allowlists, and the real ADR-149 authorization service over a real policy store with a really applied grant. The load-bearing case is the one the surface exists for - a break-glass-only operator and a swarm-role admin resolve the SAME role, so without provenance they render identically.
 */
/** Real HTTP join over the three authorization axes. No database, no container, no mock authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { ISSUER } from '../fixtures/authorization';
import { createAccessReviewFixture } from '../fixtures/access-review';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

let fixture: Awaited<ReturnType<typeof createAccessReviewFixture>>;

beforeEach(async () => {
  // The real swarm_roles snapshot, populated the way the swarm-roles feature populates it.
  setPrivilegedIdentities([{ sub: 'granted-admin', email: 'granted@fixture.test', role: 'admin' }]);
  // The real break-glass allowlist, read from the environment by the real policy module.
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'breakglass-admin');
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_RBAC_ENFORCE', 'false');
  fixture = await createAccessReviewFixture();
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

    await fixture.revoke('alice', 'reader');

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
