/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify authorization HTTP and tool parity and actual Test Lab registration.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep explicit live browser acceptance separate from isolated runner parity and honest about pending execution.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Prove compiled Access HTML delivery and file-error redaction with the real policy and HTTP adapters.
 */
/** Real HTTP authorization adapter proofs using the actual policy service and isolated repository. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizationFixture, ISSUER } from '../fixtures/authorization';
import { AUTHORIZATION_SCENARIOS } from '@/app/routes/test-lab-authorization-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileAuthorizationPage } from '../fixtures/compiled-authorization-page';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

let fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
beforeEach(async () => { fixture = await createAuthorizationFixture(); });
afterEach(async () => { await fixture?.close(); vi.unstubAllEnvs(); });

describe('Access Administration HTTP authority', () => {
  it('serves authorized HTML from the installed source layout when the route runs under dist', async () => {
    const compiled = compileAuthorizationPage();
    try {
      expect(existsSync(resolve(compiled.root, 'dist/pages/access/index.html'))).toBe(false);
      await fixture.close(); fixture = await createAuthorizationFixture(compiled.factory);
      const page = await fetch(fixture.base + '/access/', { headers: { cookie: 'session=admin' } });
      expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toContain('no-store');
      expect(await page.text()).toContain('id="administration"');
      expect((await fetch(fixture.base + '/access/')).status).toBe(401);
      expect((await fetch(fixture.base + '/access/', { headers: { cookie: 'session=alice' } })).status).toBe(403);
    } finally { compiled.close(); }
  });

  it('returns a bounded unavailable response when the installed page is missing', async () => {
    const currentDirectory = vi.spyOn(process, 'cwd').mockReturnValue(resolve('temp/missing-access-installation'));
    try {
      const page = await fetch(fixture.base + '/access/', { headers: { cookie: 'session=admin' } });
      expect(page.status).toBe(500);
      expect(await page.json()).toEqual({ error: 'authorization_unavailable' });
    } finally { currentDirectory.mockRestore(); }
  });

  it('requires authentication and management scope while keeping own access available', async () => {
    expect((await fixture.call('/catalog', undefined, null)).status).toBe(401);
    expect((await fixture.call('/catalog', undefined, 'alice')).status).toBe(403);
    const own = await fixture.call('/me?app=catalog-app', undefined, 'alice');
    expect(own.status).toBe(200); expect(own.body.targetSub).toBe('alice');
    expect(own.body).not.toHaveProperty('users');
    expect((await fixture.call('/me?app=catalog-app&targetSub=bob', undefined, 'alice')).status).toBe(400);
    const page = await fetch(fixture.base + '/access/', { headers: { cookie: 'session=alice' } });
    expect(page.status).toBe(403); expect(await page.text()).not.toContain('id="administration"');
  });

  it('filters the management catalog and refuses caller identity and unknown fields', async () => {
    const catalog = await fixture.call('/catalog', undefined, 'reader');
    expect(catalog.status).toBe(200);
    expect(catalog.body.apps.map((app: { app: string }) => app.app)).toEqual(['catalog-app']);
    expect(catalog.body.users ?? []).toEqual([]);
    expect((await fixture.call('/effective', { app: 'fallback-app', targetSub: 'alice', targetIssuer: ISSUER }, 'reader')).status).toBe(403);
    for (const extra of [{ actor: fixture.actors.admin }, { isSwarmAdmin: true }, { confirmed: true }, { url: 'https://other.test' }]) {
      expect((await fixture.call('/preview', { ...await fixture.change(), ...extra }, 'alice')).status).toBe(400);
    }
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });

  it('requires same-origin JSON and the interactive header before previewing', async () => {
    for (const headers of [{ origin: 'https://attacker.test' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }, { 'x-oshal-access-request': '' }]) {
      expect((await fixture.call('/preview', await fixture.change(), 'admin', headers)).status).toBe(403);
    }
    expect((await fixture.call('/preview', await fixture.change(), 'admin', { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await fixture.store.read()).previews).toHaveLength(0);
  });

  it('rejects malformed and oversized JSON without reflecting parser stacks or creating state', async () => {
    for (const [body, expected] of [['{"action":', 400], ['"' + 'a'.repeat(33 * 1024) + '"', 413]] as const) {
      const response = await fetch(fixture.base + '/api/authorization/preview', { method: 'POST', body,
        headers: { cookie: 'session=admin', origin: fixture.base, 'content-type': 'application/json', 'x-oshal-access-request': '1' } });
      expect(response.status).toBe(expected);
      expect(await response.json()).toEqual({ error: expected === 400 ? 'invalid_authorization_request' : 'authorization_request_too_large' });
    }
    expect((await fixture.store.read()).previews).toHaveLength(0);
  });

  it('previews without granting, applies once, audits and explains the actual effect', async () => {
    const preview = await fixture.call('/preview', await fixture.change());
    expect(preview.status).toBe(200); expect(preview.body.requiresApproval).toBe(false);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    const input = { previewId: preview.body.previewId, idempotencyKey: 'http-fixture-change-1' };
    const receipt = await fixture.call('/apply', input);
    expect(receipt.status).toBe(200); expect(receipt.body.applied).toBe(true);
    expect((await fixture.call('/apply', input)).body).toEqual(receipt.body);
    expect(fixture.store.auditEvents).toHaveLength(1);
    expect(fixture.store.auditEvents[0].actor).toEqual({ sub: 'admin', issuer: ISSUER });
    const effective = await fixture.call('/me?app=catalog-app', undefined, 'alice');
    expect(effective.body.roles).toEqual(['reader']);
    const explain = await fixture.call('/explain', { app: 'catalog-app', targetSub: 'alice', targetIssuer: ISSUER, permission: 'records.read' });
    expect(explain.status).toBe(200); expect(explain.body.allowed).toBe(true);
    expect(explain.body).not.toHaveProperty('records');
  });

  it('rejects stale revisions and a caller whose administration rights were revoked after preview', async () => {
    const old = await fixture.call('/preview', await fixture.change());
    await fixture.apply({ targetSub: 'bob' });
    expect((await fixture.call('/apply', { previewId: old.body.previewId, idempotencyKey: 'stale-fixture-change' })).status).toBe(409);
    const current = await fixture.call('/preview', await fixture.change());
    fixture.actors.admin.isSwarmAdmin = false;
    expect((await fixture.call('/apply', { previewId: current.body.previewId, idempotencyKey: 'revoked-fixture-change' })).status).toBe(403);
    expect((await fixture.store.read()).assignments.map(row => row.targetSub)).toEqual(['bob']);
  });

  it('keeps unknown catalogs to explicit app-admin and deny; stale app declarations invalidate a preview', async () => {
    expect((await fixture.call('/preview', await fixture.change({ app: 'fallback-app', role: 'reader' }))).status).toBe(400);
    const fallback = await fixture.call('/preview', await fixture.change({ app: 'fallback-app', role: '@app-admin' }));
    expect(fallback.status).toBe(200); expect(fallback.body.change.role).toBe('@app-admin');
    const preview = await fixture.call('/preview', await fixture.change());
    await fixture.service.registerApp({ app: 'catalog-app', source: 'replacement-store', version: '2.0.0', catalog: null, mode: 'enforce' });
    expect((await fixture.call('/apply', { previewId: preview.body.previewId, idempotencyKey: 'replaced-fixture-app' })).status).toBe(409);
  });

  it('registers meaningful regression suites and its live probe never mutates access', async () => {
    vi.stubEnv('PORT', new URL(fixture.base).port);
    const scenario = AUTHORIZATION_SCENARIOS.find(item => item.id === 'authorization-management')!;
    expect(scenario.regressionTests?.map(item => item.path)).toContain('tests/unit/authorization-admin-browser.spec.ts');
    expect(SCENARIOS.find(item => item.id === scenario.id)).toBe(scenario);
    const command = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts['test:authorization'];
    const registered = scenario.regressionTests!.map(item => item.path);
    expect(new Set(command.match(/tests\/unit\/[^ ]+\.spec\.ts/g))).toEqual(new Set(registered));
    expect(registered.every(file => existsSync(resolve(file)))).toBe(true);
    const state = await fixture.store.read();
    expect((await scenario.steps[0].run('session=admin', [])).state).toBe('pass');
    expect((await scenario.steps[0].run('session=alice', [])).state).toBe('degraded');
    expect(await fixture.store.read()).toEqual(state);
    const live = AUTHORIZATION_SCENARIOS.find(item => item.id === 'authorization-localhost-live')!;
    expect(SCENARIOS.find(item => item.id === live.id)).toBe(live);
    expect(live.regressionTests).toEqual([{ level: 'browser', path: 'tests/live/authorization-management.live.spec.ts' }]);
    expect(existsSync(resolve(live.regressionTests![0].path))).toBe(true);
    expect(command).not.toContain(live.regressionTests![0].path);
    const pending = await live.steps[0].run('', {});
    expect(pending.state).toBe('degraded'); expect(pending.detail).toContain('No browser tests ran');
  });

  it('uses the real typed tool for interactive requests with identical identity, CSRF and preview/apply authority', async () => {
    const ownCatalog = await fixture.call('/tool', { operation: 'catalog' }, 'alice');
    expect(ownCatalog.status).toBe(200);
    expect(ownCatalog.body.users).toEqual([]); expect(ownCatalog.body.groups).toEqual([]); expect(ownCatalog.body.assignments).toEqual([]);
    expect((await fixture.call('/tool', { operation: 'catalog' }, 'admin', { origin: 'https://unrelated.test' })).status).toBe(403);
    expect((await fixture.call('/tool', { operation: 'catalog', actor: fixture.actors.admin })).status).toBe(400);
    const catalog = await fixture.call('/tool', { operation: 'catalog' });
    expect(catalog.body).toEqual((await fixture.call('/catalog')).body);
    const preview = await fixture.call('/tool', { operation: 'preview_change', change: await fixture.change() });
    expect(preview.status).toBe(200);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    const receipt = await fixture.call('/apply', { previewId: preview.body.previewId, idempotencyKey: 'cross-surface-preview' });
    expect(receipt.status).toBe(200);
    const effective = await fixture.call('/tool', { operation: 'effective', target: { app: 'catalog-app' } }, 'alice');
    expect(effective.body.roles).toEqual(['reader']);
    expect(fixture.store.auditEvents[0].actor.sub).toBe('admin');
  });

  it('maps an authentication-composition identity rejection to401 without exposing its internal message', async () => {
    fixture.failIdentity(Object.assign(new Error('Fixture identity namespace detail'), { status: 401 }));
    for (const response of [await fixture.call('/catalog'), await fixture.call('/preview', await fixture.change()), await fixture.call('/tool', { operation: 'catalog' })]) {
      expect(response.status).toBe(401); expect(response.body).toEqual({ error: 'authorization_identity_required' });
    }
    const page = await fetch(fixture.base + '/access/', { headers: { cookie: 'session=admin' } });
    expect(page.status).toBe(401); expect(await page.json()).toEqual({ error: 'authorization_identity_required' });
  });
});
