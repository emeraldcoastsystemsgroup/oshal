/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify grants, restrictions and reviewed changes through the real administration screen.
 */
/** Chromium drives the real Access Administration page and shared policy HTTP service on loopback. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createAuthorizationFixture } from '../fixtures/authorization';

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); }, 30000);
beforeEach(async () => {
  fixture = await createAuthorizationFixture();
  context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: 'admin', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage();
  await page.goto(fixture.base + '/access/');
  await page.locator('#administration').waitFor({ state: 'visible' });
  await expect.poll(() => page.locator('#status').textContent()).toContain('Access catalog loaded');
}, 30000);
afterEach(async () => { await context?.close(); await fixture?.close(); }, 30000);

async function preview(action = 'grant') {
  await page.locator('#operation').selectOption(action);
  await page.locator('#reason').fill('Reviewed in isolated browser test');
  await page.locator('#preview-button').click();
  await page.locator('#review').waitFor({ state: 'visible' });
}
async function apply() {
  await page.locator('#apply').click();
  await expect.poll(() => page.locator('#status').textContent()).toContain('Change applied');
}

describe('Access Administration browser workflow', () => {
  it('renders declared roles, scoped fields and source metadata safely, with explicit fallback administrator only', async () => {
    expect(await page.locator('#roles').textContent()).toContain('records.read (own)');
    expect(await page.locator('#app-revision').textContent()).toContain('fixture-store');
    expect(await page.locator('#target').textContent()).toContain('<img');
    expect(await page.evaluate(() => (window as any).inventoryXss)).toBeUndefined();
    expect(await page.locator('#administration img').count()).toBe(0);
    await page.locator('#application').selectOption('fallback-app');
    expect(await page.locator('#role option').allTextContents()).toEqual(['App administrator']);
    expect(await page.locator('#app-description').textContent()).toContain('explicit app administrator');
    await preview();
    expect(await page.locator('#preview-details').textContent()).toContain('@app-admin');
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    await apply();
    expect((await fixture.store.read()).assignments[0].role).toBe('@app-admin');
  });

  it('grants, explains, denies, clears a deny and revokes through preview/apply with visible audit receipts', async () => {
    await preview();
    expect(await page.locator('#preview-expiry').textContent()).toContain('Policy revision 0');
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    await apply();
    expect(await page.locator('#effective').textContent()).toContain('Roles: reader');
    expect(await page.locator('#receipt').textContent()).toContain('audit');
    await page.locator('#explain').click();
    await expect.poll(() => page.locator('#effective').textContent()).toContain('Allowed: Yes');
    await preview('deny'); await apply();
    expect(await page.locator('#effective').textContent()).toContain('Explicit deny: Yes');
    await preview('clear-deny'); await apply();
    expect(await page.locator('#effective').textContent()).toContain('Explicit deny: No');
    await preview('revoke'); await apply();
    expect(await page.locator('#effective').textContent()).toContain('Roles: None');
    expect(fixture.store.auditEvents).toHaveLength(4);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    await page.reload();
    await expect.poll(() => page.locator('#effective').textContent()).toContain('Roles: None');
  });

  it('invalidates previews when form/target changes, and reloads authoritative state on a revision conflict', async () => {
    await preview();
    await page.locator('#reason').fill('Changed reason');
    expect(await page.locator('#review').isHidden()).toBe(true);
    await preview();
    await page.locator('#target').selectOption('1');
    expect(await page.locator('#review').isHidden()).toBe(true);
    await page.locator('#target').selectOption('0');
    await preview();
    await fixture.apply({ targetSub: 'bob' });
    await page.locator('#apply').click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Access changed while you were reviewing');
    expect(await page.locator('#review').isHidden()).toBe(true);
    expect(await page.locator('#app-revision').textContent()).toContain('Policy revision: 1');
    expect((await fixture.store.read()).assignments.map(row => row.targetSub)).toEqual(['bob']);
  });

  it('maps and removes a directory group with its source and tenant fixed by the selected inventory', async () => {
    await page.locator('#target-kind').selectOption('group');
    expect(await page.locator('#target').textContent()).toContain('Engineering');
    expect(await page.locator('#explain').isDisabled()).toBe(true);
    await preview('group-map');
    const review = await page.locator('#preview-details').textContent();
    expect(review).toContain('tenant-one'); expect(review).toContain('engineering');
    await apply();
    expect((await fixture.store.read()).assignments[0].group?.id).toBe('engineering');
    expect(await page.locator('#history').textContent()).toContain('reader');
    await preview('group-unmap'); await apply();
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });

  it('removes controls when the caller loses management scope during a session', async () => {
    fixture.actors.admin.isSwarmAdmin = false;
    await page.locator('#refresh').click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('administration scope');
    expect(await page.locator('#administration').isHidden()).toBe(true);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });

  it('shows pending independent approval without pretending the preview is an approval', async () => {
    await page.locator('#target-kind').selectOption('group');
    await page.locator('#role').selectOption('sensitive-reader');
    await preview('group-map');
    expect(await page.locator('#preview-expiry').textContent()).toContain('separate, verified approval');
    expect(await page.locator('#apply').isDisabled()).toBe(true);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    expect(fixture.store.auditEvents).toHaveLength(0);
  });

  it('denies one declared permission and clears exactly that restriction', async () => {
    await preview(); await apply();
    await page.locator('#operation').selectOption('deny');
    await page.locator('#deny-permission').selectOption('records.read');
    await preview('deny'); await apply();
    expect(await page.locator('#history').textContent()).toContain('Deny: records.read');
    await page.locator('#explain').click();
    await expect.poll(() => page.locator('#effective').textContent()).toContain('Allowed: No');
    await preview('clear-deny'); await apply();
    expect(await page.locator('#history').textContent()).not.toContain('Deny:');
    await page.locator('#explain').click();
    await expect.poll(() => page.locator('#effective').textContent()).toContain('Allowed: Yes');
  });

  it('creates the first mapping from an exact manual group identity when directory inventory is empty', async () => {
    fixture.clearDirectoryGroups();
    await page.locator('#refresh').click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Access catalog loaded');
    await page.locator('#target-kind').selectOption('group');
    expect(await page.locator('#target option').count()).toBe(0);
    await page.locator('#manual-target summary').click();
    await page.locator('#manual-issuer').fill('https://directory.fixture.test');
    await page.locator('#manual-id').fill('group-object-id');
    await page.locator('#manual-tenant').fill('directory-tenant-id');
    await page.locator('#use-manual-target').click();
    expect(await page.locator('#target').textContent()).toContain('manual entry');
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    await page.locator('#tenant').fill('business-tenant-id');
    await preview('group-map');
    expect(await page.locator('#preview-details').textContent()).toContain('https://directory.fixture.test');
    await apply();
    const assignment = (await fixture.store.read()).assignments[0];
    expect(assignment.group).toEqual({ issuer: 'https://directory.fixture.test', tenantId: 'directory-tenant-id', id: 'group-object-id' });
    expect(assignment.tenantId).toBe('business-tenant-id');
    await page.reload();
    await page.locator('#administration').waitFor({ state: 'visible' });
    await page.locator('#target-kind').selectOption('group');
    expect(await page.locator('#target').textContent()).toContain('group-object-id');
  });

  it('keeps a manually entered external subject distinct from the acting administrator', async () => {
    await page.locator('#manual-target summary').click();
    await page.locator('#manual-issuer').fill('https://second.identity.fixture.test');
    await page.locator('#manual-id').fill('external-principal');
    await page.locator('#use-manual-target').click();
    expect(await page.locator('#target').textContent()).toContain('external-principal (manual entry)');
    await preview(); expect((await fixture.store.read()).assignments).toHaveLength(0);
    await apply();
    const assignment = (await fixture.store.read()).assignments[0];
    expect(assignment.targetSub).toBe('external-principal');
    expect(assignment.targetIssuer).toBe('https://second.identity.fixture.test');
    expect(fixture.store.auditEvents[0].actor.sub).toBe('admin');
    // Selection is not proof of an active authenticated external identity.
    expect(await page.locator('#effective').textContent()).toContain('Tier: deny');
  });
});
