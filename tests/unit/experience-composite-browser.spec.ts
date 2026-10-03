/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify explicit composite choices, review, apply and revocation through the real policy-backed Access screen.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise scoped tenant discovery and source-safe revocation while refusing another tenant.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { CATALOG, createAuthorizationFixture, ISSUER } from '../fixtures/authorization';
let browser: Browser, context: BrowserContext, page: Page, fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await createAuthorizationFixture();
  await fixture.service.registerApp({ app: 'synthetic-experience', source: 'fixture-experience', version: '1', catalog: CATALOG, mode: 'enforce', compositeRoles: {
    templates: [{ id: 'resident', version: 1, label: 'Resident', members: [{ app: 'synthetic-experience', role: 'reader' }, { app: 'catalog-app', role: 'reader' }, { app: 'fallback-app', role: '@app-admin' }] }], requiredApps: ['catalog-app'], optionalApps: ['fallback-app'] } });
  context = await browser.newContext(); await context.addCookies([{ name: 'session', value: 'admin', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(10000); await page.goto(fixture.base + '/access/');
  await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
});
afterEach(async () => { await context?.close(); await fixture?.close(); });
const review = async () => {
  await page.locator('#experience-role-reason').fill('Synthetic browser acceptance');
  await page.getByRole('button', { name: 'Review experience role', exact: true }).click();
  await expect.poll(() => page.getByRole('dialog').textContent()).toContain('Every member is ready');
};
/** @description Expose one existing identity to a delegate within a disposable tenant scope. */
async function visitAsTenantDelegate() {
  fixture.actors.alice.tenantIds = ['tenant-one'];
  fixture.actors.reader.managementScopes = ['synthetic-experience', 'catalog-app'].map(app => ({ app, tenantId: 'tenant-one', permissions: ['read', 'assign'] }));
  await fixture.apply({ tenantId: 'tenant-one' });
  await context.addCookies([{ name: 'session', value: 'reader', url: fixture.base }]);
  await page.goto(fixture.base + '/access/');
  await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('No installed experience role templates');
  await page.locator('#experience-role-tenant').fill('tenant-one');
  await page.locator('#experience-role-tenant').dispatchEvent('change');
  await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('Choose a named role');
}
describe('experience role Access workflow', () => {
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
    await expect.poll(() => page.locator('#experience-role-status').textContent()).toContain('No installed experience role templates');
    expect(await page.locator('#experience-role-tenant').isEnabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Review experience role', exact: true }).isDisabled()).toBe(true);
    const response = await fixture.call('/composites/preview', { action: 'assign', app: 'synthetic-experience', template: 'resident',
      targetSub: 'alice', targetIssuer: ISSUER, tenantId: 'tenant-two', reason: 'Refuse cross-tenant review', expectedRevision: (await fixture.store.read()).revision }, 'reader');
    expect(response.status).toBe(403); expect((await fixture.store.read()).assignments).toHaveLength(1);
  });
  it('reviews required roles only, applies together, and revokes the source', async () => {
    expect(await page.locator('[data-optional-app]').isChecked()).toBe(false);
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
