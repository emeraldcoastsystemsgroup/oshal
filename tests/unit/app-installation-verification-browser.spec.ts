/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Open actual installation report links in Chromium across delayed catalogs and replacement registrations without executing suites.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { INSTALL_COOKIE, INSTALL_SECRET, installationRequest, startInstallationVerificationFixture } from '../fixtures/app-installation-verification';
import type { InstallationVerificationReport } from '@/features/swarm-apps/services/app-installation-report';

let fixture: Awaited<ReturnType<typeof startInstallationVerificationFixture>>;
let browser: Browser;
beforeAll(async () => {
  vi.stubEnv('SWARM_SERVICE_SECRET', INSTALL_SECRET); vi.stubEnv('OSHAL_OPERATOR_SUBS', 'installation-operator');
  fixture = await startInstallationVerificationFixture(); fixture.add();
  browser = await chromium.launch({ headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); await fixture?.close(); vi.unstubAllEnvs(); }, 30000);

async function session(): Promise<BrowserContext> {
  const context = await browser.newContext();
  const [name, value] = INSTALL_COOKIE.split('=');
  await context.addCookies([{ name, value, url: fixture.base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  return context;
}

async function installationReport(): Promise<InstallationVerificationReport> {
  const response = await installationRequest(fixture.base, ['install-fixture']);
  expect(response.status).toBe(200); return response.json();
}

it('focuses the linked real Lab card after a delayed catalog response without running it', async () => {
  const report = await installationReport(); const test = report.apps[0].cases.find(entry => entry.runner === 'smoke')!;
  let release!: () => void; fixture.state.catalogHold = () => new Promise<void>(done => { release = done; });
  const context = await session(); const page = await context.newPage();
  try {
    await page.goto(fixture.base + test.labUrl, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => Boolean(release)).toBe(true);
    expect(await page.locator(`[id="card-${test.id}"]`).count()).toBe(0);
    release(); fixture.state.catalogHold = undefined;
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('card-' + test.id);
    const card = page.locator(`[id="card-${test.id}"]`);
    expect(await card.textContent()).toContain('Installed 1.0.0');
    expect(await card.locator('.badge').textContent()).toBe('idle');
    expect(fixture.state.reads.get('GET /api/install-fixture/ready')).toBe(1);
    expect(fixture.state.suiteRuns).toBe(0);
  } finally { release?.(); fixture.state.catalogHold = undefined; await context.close(); }
}, 30000);

it('retains stable links across a reload and leaves unavailable suites unexecuted', async () => {
  const report = await installationReport(); const test = report.apps[0].cases.find(entry => entry.runner !== 'smoke')!;
  fixture.replace('install-fixture', '2.0.0');
  const context = await session(); const page = await context.newPage();
  try {
    await page.goto(fixture.base + test.labUrl);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('card-' + test.id);
    const card = page.locator(`[id="card-${test.id}"]`);
    expect(await card.textContent()).toContain('Installed 2.0.0');
    expect(await card.getByRole('button', { name: 'Run', exact: true }).isDisabled()).toBe(true);
    const requests = fixture.state.reads.get('GET /api/install-fixture/ready');
    await page.evaluate(() => { location.hash = '#card-app%3Aforeign-package%3Atest%3Aprivate'; });
    expect(await page.locator('[id="card-app:foreign-package:test:private"]').count()).toBe(0);
    expect(fixture.state.reads.get('GET /api/install-fixture/ready')).toBe(requests);
    expect(fixture.state.suiteRuns).toBe(0);
  } finally { await context.close(); }
}, 30000);
