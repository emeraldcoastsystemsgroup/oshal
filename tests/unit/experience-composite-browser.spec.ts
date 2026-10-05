/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify explicit composite choices, review, apply and revocation through the real policy-backed Access screen.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise scoped tenant discovery and source-safe revocation while refusing another tenant.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Pin exact dependency roles, explicit optional selection, existing-access preservation and blocked atomic reviews on the real Access screen.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Verify collapsed inactive history preserves assignment details, audit state, keyboard access and current-role edit controls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { compositeGrantSource } from '@/features/application-authorization';
import { CATALOG, createAuthorizationFixture, ISSUER } from '../fixtures/authorization';
let browser: Browser, context: BrowserContext, page: Page, fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await createAuthorizationFixture();
  await fixture.service.registerApp({ app: 'optional-app', source: 'fixture-optional', version: '1', catalog: CATALOG, mode: 'enforce' });
  await fixture.service.registerApp({ app: 'synthetic-experience', source: 'fixture-experience', version: '1', catalog: CATALOG, mode: 'enforce', compositeRoles: {
    templates: [
      { id: 'resident', version: 1, label: 'Resident', members: [{ app: 'synthetic-experience', role: 'reader' }, { app: 'catalog-app', role: 'reader' }, { app: 'fallback-app', role: '@app-admin' }, { app: 'optional-app', role: 'reader' }] },
      { id: 'observer', version: 2, label: 'Observer', members: [{ app: 'synthetic-experience', role: 'reader' }, { app: 'catalog-app', role: 'sensitive-reader' }, { app: 'optional-app', role: 'reader' }] },
    ], requiredApps: ['catalog-app'], optionalApps: ['fallback-app', 'optional-app'] } });
  context = await browser.newContext(); await context.addCookies([{ name: 'session', value: 'admin', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(10000); await page.goto(fixture.base + '/access/');
  await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
});
afterEach(async () => { await context?.close(); await fixture?.close(); });
const review = async () => {
  await page.locator('#experience-role-reason').fill('Synthetic browser acceptance');
  await page.getByRole('button', { name: 'Review application role', exact: true }).click();
  await expect.poll(() => page.getByRole('dialog').textContent()).toContain('Every member is ready');
};
/** @description Create genuine assignment and revocation history through the fixture HTTP review/apply boundary. */
async function historyChange(action: 'assign' | 'revoke', assignmentId?: string, optionalApps: string[] = []): Promise<string> {
  const preview = await fixture.call('/composites/preview', { action, app: 'synthetic-experience',
    ...(action === 'assign' ? { template: 'resident', targetSub: 'alice', targetIssuer: ISSUER, optionalApps } : { assignmentId }),
    reason: 'Synthetic assignment history', expectedRevision: (await fixture.store.read()).revision });
  expect(preview.status).toBe(200); expect(preview.body.ready).toBe(true);
  const receipt = await fixture.call('/composites/apply', { previewId: preview.body.previewId, idempotencyKey: crypto.randomUUID() });
  expect(receipt.status).toBe(200); return receipt.body.assignmentId;
}
/** @description Expose one existing identity to a delegate within a disposable tenant scope. */
async function visitAsTenantDelegate() {
  fixture.actors.alice.tenantIds = ['tenant-one'];
  fixture.actors.reader.managementScopes = ['synthetic-experience', 'catalog-app'].map(app => ({ app, tenantId: 'tenant-one', permissions: ['read', 'assign'] }));
  await fixture.apply({ tenantId: 'tenant-one' });
  await context.addCookies([{ name: 'session', value: 'reader', url: fixture.base }]);
  await page.goto(fixture.base + '/access/');
  await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('No installed application role templates');
  await page.locator('#experience-role-tenant').fill('tenant-one');
  await page.locator('#experience-role-tenant').dispatchEvent('change');
  await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
}
describe('experience role Access workflow', () => {
  it('assigns a complete native application bundle to a fresh user with one review and no component checkboxes', async () => {
    await fixture.service.registerApp({ app: 'learning-app', source: 'fixture-learning', version: '2', catalog: CATALOG,
      mode: 'enforce', adapters: { records: { authorize: async () => true } }, compositeRoles: {
        templates: [{ id: 'student', version: 2, label: 'Student', members: [
          { app: 'learning-app', role: 'reader' }, { app: 'fallback-app', role: '@app-admin' },
          { app: 'catalog-app', role: 'reader' },
        ] }], requiredApps: ['fallback-app', 'catalog-app'], optionalApps: [],
      } });
    expect((await fixture.store.read()).assignments).toEqual([]);
    expect(fixture.actors.alice.isSwarmAdmin).toBe(false);
    expect((await fixture.service.authorize(fixture.actors.alice,
      { app: 'fallback-app', kind: 'http', method: 'GET', path: '/app' })).allowed).toBe(false);
    await page.reload();
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
    await page.locator('#experience-role-app').selectOption('learning-app');
    expect(await page.locator('#experience-role-required [data-required-app]').count()).toBe(3);
    expect(await page.locator('[data-optional-app]').count()).toBe(0);
    expect(await page.locator('#experience-role-optional').isVisible()).toBe(false);
    await review();
    expect(await page.getByRole('dialog').textContent()).toContain('grant fallback-app: @app-admin');
    expect(await page.getByRole('dialog').textContent()).toContain('grant catalog-app: reader');
    await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
    await expect.poll(() => fixture.store.read().then(state => state.compositeAssignments?.length)).toBe(1);
    const state = await fixture.store.read(), assignment = state.compositeAssignments![0];
    expect(assignment.members.map(member => member.app).sort()).toEqual(['catalog-app', 'fallback-app', 'learning-app']);
    expect(state.assignments).toHaveLength(3);
    expect(state.assignments.every(row => row.grantSource === compositeGrantSource(assignment.id))).toBe(true);
    for (const app of ['learning-app', 'catalog-app']) expect((await fixture.service.authorize(fixture.actors.alice,
      { app, kind: 'http', method: 'GET', path: '/records' })).allowed).toBe(true);
    expect((await fixture.service.authorize(fixture.actors.alice,
      { app: 'fallback-app', kind: 'http', method: 'POST', path: '/author' })).allowed).toBe(true);
    const access = await fixture.service.effective(fixture.actors.admin,
      { app: 'fallback-app', targetSub: 'alice', targetIssuer: ISSUER });
    expect(access.managementRoles).toEqual([]);
    expect(fixture.actors.alice.isSwarmAdmin).toBe(false);
  });
  it('keeps current controls visible and inactive history collapsed until keyboard expansion', async () => {
    const revoked = await historyChange('assign'); await historyChange('revoke', revoked);
    const secondRevoked = await historyChange('assign'); await historyChange('revoke', secondRevoked);
    const active = await historyChange('assign', undefined, ['optional-app']);
    const expired = await historyChange('assign');
    // Seed a past expiry in the disposable store; the real server still projects the expired status.
    await fixture.store.transaction(async transaction => {
      transaction.state.compositeAssignments!.find(row => row.id === expired)!.expiresAt = '2000-01-01T00:00:00.000Z';
      transaction.state.assignments.filter(row => row.grantSource === compositeGrantSource(expired)).forEach(row => { row.expiresAt = '2000-01-01T00:00:00.000Z'; });
    });
    const before = await fixture.store.read(), auditBefore = structuredClone(fixture.store.auditEvents);
    await page.reload();
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
    const expiredLabel = await page.evaluate(() => new Date('2000-01-01T00:00:00.000Z').toLocaleString());
    const current = page.locator('[data-assignment-id="' + active + '"]');
    const history = page.locator('#experience-role-history'), summary = history.locator('summary');
    expect(await summary.textContent()).toBe('Inactive assignment history (3)');
    expect(await history.evaluate(node => node.hasAttribute('open'))).toBe(false);
    expect(await current.isVisible()).toBe(true);
    expect(await current.getByRole('button', { name: 'Review revocation', exact: true }).isVisible()).toBe(true);
    expect(await current.getByRole('button', { name: 'Edit assigned role', exact: true }).isVisible()).toBe(true);
    for (const id of [revoked, secondRevoked, expired]) expect(await page.locator('[data-assignment-id="' + id + '"]').isVisible()).toBe(false);
    await summary.focus(); await page.keyboard.press('Enter');
    expect(await history.evaluate(node => node.hasAttribute('open'))).toBe(true);
    expect(await summary.evaluate(node => node === document.activeElement)).toBe(true);
    for (const id of [revoked, secondRevoked, expired]) {
      const row = history.locator('[data-assignment-id="' + id + '"]');
      expect(await row.isVisible()).toBe(true);
      expect(await row.textContent()).toContain('synthetic-experience · Resident');
      expect(await row.textContent()).toContain('Version 1 · ' + (id === expired ? 'expired' : 'revoked') + ' · No business tenant');
      expect(await row.textContent()).toContain('Expiry: ' + (id === expired ? expiredLabel : 'None'));
      expect(await row.textContent()).toContain('synthetic-experience: reader; catalog-app: reader');
      expect(await row.locator('button').count()).toBe(0);
    }
    await page.keyboard.press('Space');
    expect(await history.evaluate(node => node.hasAttribute('open'))).toBe(false);
    expect(await summary.evaluate(node => node === document.activeElement)).toBe(true);
    await current.getByRole('button', { name: 'Edit assigned role', exact: true }).click();
    expect(await page.locator('#experience-role-reason').evaluate(node => node === document.activeElement)).toBe(true);
    expect(await page.locator('[data-optional-app="optional-app"]').isChecked()).toBe(true);
    expect(await fixture.store.read()).toEqual(before); expect(fixture.store.auditEvents).toEqual(auditBefore);
  });
  it('retains history when this identity has no active experience assignments', async () => {
    const revoked = await historyChange('assign'); await historyChange('revoke', revoked);
    await page.reload();
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
    const assignments = page.locator('#experience-role-assignments'), history = page.locator('#experience-role-history');
    expect(await assignments.textContent()).toContain('No active application roles for this identity.');
    expect(await assignments.getByRole('button').count()).toBe(0);
    expect(await history.locator('summary').textContent()).toBe('Inactive assignment history (1)');
    expect(await history.evaluate(node => node.hasAttribute('open'))).toBe(false);
    await history.locator('summary').click();
    expect(await history.locator('[data-assignment-id="' + revoked + '"]').isVisible()).toBe(true);
    expect(await page.getByRole('button', { name: 'Review application role', exact: true }).isEnabled()).toBe(true);
  });
  it('shows exact included roles and changes optional choices only through explicit selection', async () => {
    const included = page.locator('#experience-role-required');
    expect(await included.textContent()).toContain('synthetic-experience: reader · Application role');
    expect(await included.textContent()).toContain('catalog-app: reader · Required application');
    expect(await included.locator('[data-required-app]').count()).toBe(2);
    expect(await page.locator('#experience-role-optional').textContent()).toContain('fallback-app: @app-admin · application administrator adapter');
    expect(await page.locator('#experience-role-optional').textContent()).toContain('administrator access to that member application');
    expect(await page.locator('[data-optional-app]:checked').count()).toBe(0);
    await page.getByRole('button', { name: 'Select all optional', exact: true }).click();
    expect(await page.locator('[data-optional-app]:checked').count()).toBe(2);
    expect(await page.locator('#experience-role-optional').textContent()).toContain('2 of 2 optional applications selected');
    await page.getByRole('button', { name: 'Clear optional', exact: true }).click();
    expect(await page.locator('[data-optional-app]:checked').count()).toBe(0);
    await page.getByRole('button', { name: 'Select all optional', exact: true }).click();
    await review();
    expect(await page.getByRole('dialog').textContent()).toContain('grant fallback-app: @app-admin');
    expect(await page.getByRole('dialog').textContent()).toContain('grant optional-app: reader');
    expect((await fixture.store.read()).assignments).toEqual([]);
    await page.getByRole('button', { name: 'Back to choices', exact: true }).click();
    expect(await page.locator('[data-optional-app]:checked').count()).toBe(2);
    await page.locator('#experience-role-template').selectOption('observer');
    expect(await included.textContent()).toContain('catalog-app: sensitive-reader · Required application');
    expect(await page.locator('[data-optional-app]').count()).toBe(1);
    expect(await page.locator('[data-optional-app]:checked').count()).toBe(0);
    expect(await page.locator('#experience-role-optional').textContent()).toContain('optional-app: reader');
    expect((await fixture.store.read()).assignments).toEqual([]);
  });
  it('identifies an already-held role and preserves its independent grant after experience revocation', async () => {
    await fixture.apply();
    const direct = structuredClone((await fixture.store.read()).assignments[0]);
    await page.reload();
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
    await review();
    expect(await page.locator('[data-existing-access="catalog-app"]').textContent()).toBe('Already held; existing access stays in place.');
    expect(await page.getByRole('dialog').textContent()).toContain('Access from other assignments stays in place');
    expect((await fixture.store.read()).assignments).toEqual([direct]);
    await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
    await expect.poll(async () => (await fixture.store.read()).assignments.length).toBe(3);
    await expect.poll(() => page.locator('#experience-role-assignments').textContent()).toContain('Resident');
    await page.locator('#experience-role-reason').fill('Revoke only this experience role');
    await page.getByRole('button', { name: 'Review revocation', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('Only access assigned through this application role will be removed');
    await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).click();
    await expect.poll(async () => (await fixture.store.read()).assignments).toEqual([direct]);
  });
  it('keeps a refused optional application visible in review and disables the entire apply', async () => {
    await fixture.apply({ action: 'deny', app: 'optional-app', role: undefined });
    const existing = structuredClone((await fixture.store.read()).assignments);
    await page.reload();
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
    await page.locator('[data-optional-app="optional-app"]').check();
    await page.locator('#experience-role-reason').fill('Review explicit optional selection with existing refusal');
    await page.getByRole('button', { name: 'Review application role', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('This role cannot be applied');
    expect(await page.getByRole('dialog').textContent()).toContain('optional-app: reader — composite_member_denied');
    expect(await page.getByRole('button', { name: 'Apply reviewed changes', exact: true }).isDisabled()).toBe(true);
    expect((await fixture.store.read()).assignments).toEqual(existing);
  });
  it('lets a tenant delegate discover, assign and revoke within the exact tenant', async () => {
    await visitAsTenantDelegate(); await review();
    await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await expect.poll(async () => (await fixture.store.read()).assignments.length).toBe(3);
    await expect.poll(() => page.locator('#experience-role-assignments').textContent()).toContain('Resident');
    await page.locator('#experience-role-tenant').fill('tenant-one');
    await page.locator('#experience-role-tenant').dispatchEvent('change');
    await expect.poll(() => page.locator('#experience-role-assignments').textContent()).toContain('Resident');
    await page.locator('#experience-role-reason').fill('Remove this reviewed tenant role');
    await page.getByRole('button', { name: 'Review revocation' }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('revoke catalog-app');
    await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await expect.poll(async () => (await fixture.store.read()).assignments.length).toBe(1);
    expect((await fixture.store.read()).assignments[0].grantSource).toBeUndefined();
  });
  it('keeps another tenant unavailable and refuses a forged cross-tenant review', async () => {
    await visitAsTenantDelegate();
    await page.locator('#experience-role-tenant').fill('tenant-two');
    await page.locator('#experience-role-tenant').dispatchEvent('change');
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('No installed application role templates');
    expect(await page.locator('#experience-role-tenant').isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Review application role', exact: true }).isDisabled()).toBe(true);
    const response = await fixture.call('/composites/preview', { action: 'assign', app: 'synthetic-experience', template: 'resident',
      targetSub: 'alice', targetIssuer: ISSUER, tenantId: 'tenant-two', reason: 'Refuse cross-tenant review', expectedRevision: (await fixture.store.read()).revision }, 'reader');
    expect(response.status).toBe(403); expect((await fixture.store.read()).assignments).toHaveLength(1);
  });
  it('reviews required roles only, applies together, and revokes the source', async () => {
    expect(await page.locator('[data-optional-app]:checked').count()).toBe(0);
    await review(); expect(await page.getByRole('dialog').textContent()).not.toContain('@app-admin');
    expect((await fixture.store.read()).assignments).toEqual([]);
    await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await expect.poll(async () => (await fixture.store.read()).assignments.length).toBe(2);
    await expect.poll(() => page.locator('#experience-role-assignments').textContent()).toContain('Resident');
    await page.locator('#experience-role-reason').fill('Synthetic revocation');
    await page.getByRole('button', { name: 'Review revocation' }).click();
    await expect.poll(() => page.getByRole('dialog').textContent()).toContain('revoke catalog-app');
    await page.getByRole('button', { name: 'Apply reviewed changes' }).click();
    await expect.poll(async () => (await fixture.store.read()).assignments.length).toBe(0);
  });
  it('exposes an explicitly selected legacy adapter in the review before any grant', async () => {
    await page.locator('[data-optional-app="fallback-app"]').check(); await review();
    expect(await page.getByRole('dialog').textContent()).toContain('fallback-app: @app-admin');
    expect((await fixture.store.read()).assignments).toEqual([]);
    await page.getByRole('button', { name: 'Back to choices' }).click();
    expect(await page.locator('[data-optional-app="fallback-app"]').isChecked()).toBe(true);
  });
  it('keeps identity display inert and the controls within phone width', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('#experience-access img').count()).toBe(0);
    const box = await page.locator('#experience-access').boundingBox(); expect(box!.width).toBeLessThanOrEqual(390);
    await page.locator('#experience-role-app').focus(); await page.keyboard.press('Tab');
    expect(await page.locator('#experience-role-template').evaluate(node => node === document.activeElement)).toBe(true);
  });
});
