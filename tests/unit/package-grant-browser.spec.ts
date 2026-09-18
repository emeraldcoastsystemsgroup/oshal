/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive package planning and reviewed grants through Chromium, the real Access page and authorization HTTP service.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep existing role editing usable while an older deployed core lacks package planning.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createAuthorizationFixture } from '../fixtures/authorization';

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof createAuthorizationFixture>>;
const dependencies = { required: { apps: ['fallback-app'], tools: ['fixture-tool'], connectors: [] }, optional: { apps: ['optional-fixture'] } };
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30000);
afterAll(async () => { await browser?.close(); }, 30000);
beforeEach(async () => {
  fixture = await createAuthorizationFixture(undefined, async app => app === 'catalog-app' ? dependencies
    : app === 'fallback-app' ? { required: { apps: [], tools: [], connectors: [] }, optional: { apps: [] } } : null);
  context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: 'admin', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(10000);
  await page.goto(fixture.base + '/access/');
  await expect.poll(() => page.locator('#package-access-app option').count()).toBe(2);
}, 30000);
afterEach(async () => { await context?.close(); await fixture?.close(); }, 30000);

async function openPlan() {
  await page.locator('#package-access-app').selectOption('catalog-app');
  await page.locator('#package-access-plan').click();
  await page.locator('#package-access-dialog').waitFor({ state: 'visible' });
}

describe('assign a package to a person', () => {
  it('keeps ordinary editing available when mounted pages are newer than the server API', async () => {
    await page.route('**/api/authorization/package-plan', route => route.fulfill({ status: 404, contentType: 'text/html', body: 'Not found' }));
    await page.locator('#package-access-plan').click();
    await expect.poll(() => page.locator('#package-access-status').textContent()).toContain('Use Edit roles');
    expect(await page.locator('#package-access-dialog').isVisible()).toBe(false);
    await page.locator('tr[data-app="catalog-app"] [data-action="edit-roles"]').click();
    expect(await page.locator('[data-editor-app="catalog-app"]').isVisible()).toBe(true);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });
  it('carries the reviewed business tenant into every required application draft', async () => {
    fixture.actors.alice.tenantIds = ['tenant-one'];
    await page.locator('#package-access-tenant').fill('tenant-one'); await openPlan();
    await page.locator('#package-access-continue').click();
    expect(await page.locator('[data-bulk-tenant]').evaluateAll(elements => elements.map(element => (element as HTMLInputElement).value)))
      .toEqual(['tenant-one', 'tenant-one']);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });
  it('refuses a plan from a newer policy revision until access is refreshed', async () => {
    await fixture.apply({ targetSub: 'bob' });
    await page.locator('#package-access-plan').click();
    await expect.poll(() => page.locator('#package-access-status').textContent()).toContain('Refresh applications');
    expect(await page.locator('#package-access-dialog').isVisible()).toBe(false);
    expect((await fixture.store.read()).assignments.map(row => row.targetSub)).toEqual(['bob']);
  });
  it('keeps one selected row per application after closing a package review', async () => {
    await openPlan(); await page.locator('#package-access-continue').click();
    await page.locator('#bulk-close').click();
    expect(await page.locator('[data-bulk-select]:checked').count()).toBe(2);
    await page.locator('#bulk-select-visible').click();
    expect(await page.locator('#bulk-count').textContent()).toBe('2 applications selected');
    await page.locator('#bulk-edit-selected').click();
    expect(await page.locator('[data-bulk-app]').count()).toBe(2);
  });
  it('keeps planning read-only and requires exact role choices before audited dependency grants', async () => {
    await openPlan();
    expect(await page.locator('#package-access-entries').textContent()).toContain('fallback-app');
    expect(await page.locator('#package-access-offers').textContent()).toContain('optional-fixture');
    expect(await page.locator('#package-access-needs').textContent()).toContain('fixture-tool');
    await page.screenshot({ path: 'temp/access-package-review-20260917.png' });
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    await page.locator('#package-access-continue').click();
    expect(await page.locator('[data-bulk-app]').count()).toBe(2);
    expect(await page.locator('[data-bulk-app="catalog-app"] [data-bulk-role]').inputValue()).toBe('');
    expect(await page.locator('[data-bulk-app="fallback-app"] [data-bulk-role]').inputValue()).toBe('');
    await page.locator('[data-bulk-app="catalog-app"] [data-bulk-role]').selectOption('reader');
    await page.locator('[data-bulk-app="fallback-app"] [data-bulk-role]').selectOption('@app-admin');
    await page.locator('#bulk-reason').fill('Reviewed package dependencies for fixture learner');
    await page.locator('#bulk-review').click(); await page.locator('#bulk-reviewed').waitFor({ state: 'visible' });
    expect((await fixture.store.read()).assignments).toHaveLength(0);
    await page.locator('#bulk-apply').click();
    await expect.poll(() => page.locator('#bulk-status').textContent()).toContain('2 changes applied');
    const assignments = (await fixture.store.read()).assignments;
    expect(assignments.map(row => [row.app, row.targetSub, row.role])).toEqual([
      ['catalog-app', 'alice', 'reader'], ['fallback-app', 'alice', '@app-admin'],
    ]);
    expect(fixture.store.auditEvents).toHaveLength(2);
  }, 30000);

  it('reports an explicit deny and refuses to start a partial package grant', async () => {
    await fixture.apply({ app: 'fallback-app', action: 'deny', role: undefined });
    await page.reload(); await expect.poll(() => page.locator('#package-access-app option').count()).toBe(2);
    await openPlan();
    expect(await page.locator('#package-access-entries').textContent()).toContain('Explicitly denied');
    expect(await page.locator('#package-access-continue').isDisabled()).toBe(true);
    expect((await fixture.store.read()).assignments).toHaveLength(1);
  });

  it('preserves existing access and sends only missing required apps to review', async () => {
    await fixture.apply(); await page.reload();
    await expect.poll(() => page.locator('#package-access-app option').count()).toBe(2);
    await openPlan(); expect(await page.locator('#package-access-entries').textContent()).toContain('Already has access');
    await page.locator('#package-access-continue').click();
    expect(await page.locator('[data-bulk-app]').getAttribute('data-bulk-app')).toBe('fallback-app');
    expect((await fixture.store.read()).assignments).toHaveLength(1);
  });

  it('ignores an old plan after the selected identity changes', async () => {
    let release!: () => void, entered!: () => void;
    const gated = new Promise<void>(done => { release = done; });
    const started = new Promise<void>(done => { entered = done; });
    await page.route('**/api/authorization/package-plan', async route => {
      const response = await route.fetch(); entered(); await gated; await route.fulfill({ response });
    });
    await page.locator('#package-access-plan').click(); await started;
    await page.locator('#target').selectOption('1'); release();
    await expect.poll(() => page.locator('#package-access-app option').count()).toBe(2);
    expect(await page.locator('#package-access-dialog').isVisible()).toBe(false);
    expect((await fixture.store.read()).assignments).toHaveLength(0);
  });
});
