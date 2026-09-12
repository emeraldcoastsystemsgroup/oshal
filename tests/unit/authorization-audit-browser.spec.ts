/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Drive scoped applied-change history in the real Access page backed by PostgreSQL.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Bound sequential browser checks explicitly and release held responses during cleanup.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Open the visible Advanced access disclosure before exercising existing audit controls.
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
}, 30_000);
afterEach(async () => { await context?.unrouteAll({ behavior: 'ignoreErrors' }); await context?.close(); }, 30_000);
afterAll(async () => {
  try { await browser?.close(); } finally { try { await fixture.close(); } finally { vi.unstubAllEnvs(); } }
}, 60_000);
async function openAdvanced() {
  const advanced = page.locator('#advanced-access');
  expect(await advanced.getAttribute('open')).toBeNull();
  expect(await page.locator('#audit-refresh').isVisible()).toBe(false);
  await advanced.locator(':scope > summary').click();
  await expect.poll(() => page.locator('#audit-refresh').isVisible(), { timeout: 10_000 }).toBe(true);
}
async function open() {
  await page.goto(fixture.base + '/access');
  await expect.poll(() => page.locator('#audit-status').textContent(), { timeout: 10_000 }).toContain('applied changes loaded');
  await openAdvanced();
}

describe('Access applied-change history browser', () => {
  it.sequential('loads older pages with exact identities and permits explicit global history only to swarm administrators', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 11; i++) await fixture.apply({ targetSub: i === 0 ? '<img src=x onerror=alert(1)>' : 'user' });
    await fixture.apply({ app: 'app-two' }); await open();
    await page.locator('#audit-limit').selectOption('10');
    await expect.poll(() => page.locator('#audit-entries tbody tr').count(), { timeout: 10_000 }).toBe(10);
    await page.locator('#audit-more').click();
    await expect.poll(() => page.locator('#audit-entries tbody tr').count(), { timeout: 10_000 }).toBe(11);
    expect(await page.locator('#audit-entries').textContent()).toContain('<img');
    expect(await page.locator('#audit-entries img').count()).toBe(0);
    expect(await page.locator('#audit-entries').textContent()).not.toContain('SECRET_REASON');
    await page.locator('#audit-scope').selectOption('global');
    await expect.poll(() => page.locator('#audit-entries').textContent(), { timeout: 10_000 }).toContain('app-two');
    expect(await page.locator('#audit-tenant').isDisabled()).toBe(true);
  });

  it.sequential('filters tenant history and clears stale rows on lost scope without offering global access', { timeout: 60_000 }, async () => {
    await fixture.apply({ tenantId: 'tenant-a' }); await fixture.apply({ tenantId: 'tenant-b' });
    await context.addCookies([{ name: 'session', value: 'tenant', url: fixture.base }]);
    await page.goto(fixture.base + '/access');
    await expect.poll(() => page.locator('#audit-status').textContent(), { timeout: 10_000 }).toContain('unavailable');
    await openAdvanced();
    expect(await page.locator('#audit-global').isHidden()).toBe(true);
    await page.locator('#audit-tenant').fill('tenant-a'); await page.locator('#audit-refresh').click();
    await expect.poll(() => page.locator('#audit-entries tbody tr').count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator('#audit-entries').textContent()).not.toContain('tenant-b');
    fixture.actors.tenant.managementScopes = [];
    await page.locator('#audit-refresh').click();
    await expect.poll(() => page.locator('#audit-status').textContent(), { timeout: 10_000 }).toContain('unavailable');
    expect(await page.locator('#audit-entries tbody tr').count()).toBe(0);
    expect(await page.locator('#audit-more').isDisabled()).toBe(true);
  });
});

it.sequential('discards an older application response when the selected application changes', { timeout: 60_000 }, async () => {
  await fixture.apply(); await fixture.apply({ app: 'app-two' }); await open();
  let release!: () => void, received = false;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/api/authorization/audit?*', async route => {
    if (new URL(route.request().url()).searchParams.get('app') !== 'app-one') { await route.continue(); return; }
    const response = await route.fetch(); received = true; await held; await route.fulfill({ response });
  });
  try {
    await page.locator('#audit-refresh').click(); await expect.poll(() => received, { timeout: 10_000 }).toBe(true);
    await page.locator('#application').selectOption('app-two');
    await expect.poll(() => page.locator('#audit-entries').textContent(), { timeout: 10_000 }).toContain('app-two');
    const resumed = page.waitForResponse(response => response.url().includes('/audit?app=app-one'), { timeout: 10_000 });
    release(); await resumed;
    expect(await page.locator('#audit-entries').textContent()).not.toContain('app-one');
  } finally { release(); }
});
