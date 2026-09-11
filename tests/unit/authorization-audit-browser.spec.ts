/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Drive scoped applied-change history in the real Access page backed by PostgreSQL.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { AuthorizationAuditFixture } from '../fixtures/authorization-audit';

const fixture = new AuthorizationAuditFixture(); let browser: Browser, context: BrowserContext, page: Page;
beforeAll(async () => { vi.stubEnv('OSHAL_SCHEMA_BOOTSTRAP', ''); await fixture.start(); browser = await chromium.launch({ headless: true }); }, 90_000);
beforeEach(async () => {
  await fixture.reset(); context = await browser.newContext();
  await context.addCookies([{ name: 'session', value: 'root', url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  page = await context.newPage();
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); await fixture.close(); vi.unstubAllEnvs(); }, 30_000);
async function open() {
  await page.goto(fixture.base + '/access');
  await expect.poll(() => page.locator('#audit-status').textContent()).toContain('applied changes loaded');
}

describe('Access applied-change history browser', () => {
  it('loads older pages with exact identities and permits explicit global history only to swarm administrators', async () => {
    for (let i = 0; i < 11; i++) await fixture.apply({ targetSub: i === 0 ? '<img src=x onerror=alert(1)>' : 'user' });
    await fixture.apply({ app: 'app-two' }); await open();
    await page.locator('#audit-limit').selectOption('10');
    await expect.poll(() => page.locator('#audit-entries tbody tr').count()).toBe(10);
    await page.locator('#audit-more').click();
    await expect.poll(() => page.locator('#audit-entries tbody tr').count()).toBe(11);
    expect(await page.locator('#audit-entries').textContent()).toContain('<img');
    expect(await page.locator('#audit-entries img').count()).toBe(0);
    expect(await page.locator('#audit-entries').textContent()).not.toContain('SECRET_REASON');
    await page.locator('#audit-scope').selectOption('global');
    await expect.poll(() => page.locator('#audit-entries').textContent()).toContain('app-two');
    expect(await page.locator('#audit-tenant').isDisabled()).toBe(true);
  });

  it('filters tenant history and clears stale rows on lost scope without offering global access', async () => {
    await fixture.apply({ tenantId: 'tenant-a' }); await fixture.apply({ tenantId: 'tenant-b' });
    await context.addCookies([{ name: 'session', value: 'tenant', url: fixture.base }]);
    await page.goto(fixture.base + '/access');
    await expect.poll(() => page.locator('#audit-status').textContent()).toContain('unavailable');
    expect(await page.locator('#audit-global').isHidden()).toBe(true);
    await page.locator('#audit-tenant').fill('tenant-a'); await page.locator('#audit-refresh').click();
    await expect.poll(() => page.locator('#audit-entries tbody tr').count()).toBe(1);
    expect(await page.locator('#audit-entries').textContent()).not.toContain('tenant-b');
    fixture.actors.tenant.managementScopes = [];
    await page.locator('#audit-refresh').click();
    await expect.poll(() => page.locator('#audit-status').textContent()).toContain('unavailable');
    expect(await page.locator('#audit-entries tbody tr').count()).toBe(0);
    expect(await page.locator('#audit-more').isDisabled()).toBe(true);
  });
});

it('discards an older application response when the selected application changes', async () => {
  await fixture.apply(); await fixture.apply({ app: 'app-two' }); await open();
  let release!: () => void, received!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const pending = new Promise<void>(done => { received = done; });
  await page.route('**/api/authorization/audit?*', async route => {
    if (new URL(route.request().url()).searchParams.get('app') !== 'app-one') { await route.continue(); return; }
    const response = await route.fetch(); received(); await held; await route.fulfill({ response });
  });
  await page.locator('#audit-refresh').click(); await pending;
  await page.locator('#application').selectOption('app-two');
  await expect.poll(() => page.locator('#audit-entries').textContent()).toContain('app-two');
  release(); await page.waitForResponse(response => response.url().includes('/audit?app=app-one'));
  expect(await page.locator('#audit-entries').textContent()).not.toContain('app-one');
});
