/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise authenticated composite roles through the real Access HTTP adapter and policy store.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin explicit tenant discovery and reject cross-tenant lifecycle previews for delegates.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG, createAuthorizationFixture, ISSUER } from '../fixtures/authorization';
let fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
beforeEach(async () => {
  fixture = await createAuthorizationFixture();
  await fixture.service.registerApp({ app: 'synthetic-experience', source: 'fixture-experience', version: '1', catalog: CATALOG, mode: 'enforce', compositeRoles: {
    templates: [{ id: 'resident', version: 1, label: 'Resident', members: [{ app: 'synthetic-experience', role: 'reader' }, { app: 'catalog-app', role: 'reader' }] }], requiredApps: ['catalog-app'], optionalApps: [] } });
});
afterEach(async () => { await fixture.close(); });
const body = async () => ({ action: 'assign', app: 'synthetic-experience', template: 'resident', targetSub: 'alice', targetIssuer: ISSUER, reason: 'Synthetic HTTP review', expectedRevision: (await fixture.store.read()).revision });
describe('composite HTTP boundaries', () => {
  it('filters tenant-scoped templates without widening review authority', async () => {
    fixture.actors.alice.tenantIds = ['tenant-one'];
    fixture.actors.reader.managementScopes = ['synthetic-experience', 'catalog-app'].map(app => ({ app, tenantId: 'tenant-one', permissions: ['read', 'assign'] }));
    expect((await fixture.call('/composites', undefined, 'reader')).body.experiences).toEqual([]);
    expect((await fixture.call('/composites?tenantId=tenant-one', undefined, 'reader')).body.experiences).toHaveLength(1);
    expect((await fixture.call('/composites?tenantId=tenant-two', undefined, 'reader')).body.experiences).toEqual([]);
    expect((await fixture.call('/composites/preview', { ...await body(), tenantId: 'tenant-two' }, 'reader')).status).toBe(403);
    const review = await fixture.call('/composites/preview', { ...await body(), tenantId: 'tenant-one' }, 'reader');
    expect(review.status).toBe(200); expect(review.body.ready).toBe(true);
    expect((await fixture.store.read()).assignments).toEqual([]);
  });
  it('requires authenticated management scope and closed selections', async () => {
    expect((await fixture.call('/composites', undefined, null)).status).toBe(401);
    expect((await fixture.call('/composites', undefined, 'reader')).body.experiences).toEqual([]);
    expect((await fixture.call('/composites?app=synthetic-experience', undefined, 'reader')).status).toBe(403);
    expect((await fixture.call('/composites?actor=forged')).status).toBe(400);
    expect((await fixture.call('/composites/preview', { ...await body(), source: 'forged' })).status).toBe(400);
    expect((await fixture.call('/composites/preview', await body(), 'reader')).status).toBe(403);
    expect((await fixture.call('/composites/preview', await body(), 'admin', { origin: 'https://elsewhere.invalid' })).status).toBe(403);
  });
  it('applies one reviewed set and exposes source-redacted management records', async () => {
    const preview = await fixture.call('/composites/preview', await body());
    expect(preview.status).toBe(200); expect(preview.body.ready).toBe(true);
    const input = { previewId: preview.body.previewId, idempotencyKey: randomUUID() };
    expect((await fixture.call('/composites/apply', input, 'alice')).status).toBe(404);
    expect((await fixture.call('/composites/apply', input)).body.applied).toBe(true);
    const catalog = (await fixture.call('/catalog')).body;
    expect(catalog.assignments.every((row: Record<string, unknown>) => row.managed === true && row.grantSource === undefined)).toBe(true);
    const list = await fixture.call('/composites');
    expect(list.body.assignments).toHaveLength(1);
    expect(JSON.stringify(list.body.assignments)).not.toContain('fixture-experience');
    expect(JSON.stringify(list.body.assignments)).not.toContain('experience-composite:');
    expect((await fixture.call('/composites', undefined, 'alice')).body.assignments).toEqual([]);
  });
  it('does not allow the ordinary apply endpoint to split the reviewed set', async () => {
    const preview = await fixture.call('/composites/preview', await body());
    expect((await fixture.call('/apply', { previewId: preview.body.members[0].preview.previewId, idempotencyKey: randomUUID() })).status).toBe(403);
    expect((await fixture.store.read()).assignments).toEqual([]);
  });
});
