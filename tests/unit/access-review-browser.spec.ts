/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the real access-review page in headless Chromium against the real route and policy service. The HTTP answer being different is not the claim the entry makes - the claim is that a break-glass-only operator is not RENDERED the same as a granted admin, and only the page can be red on that.
 */
/** Chromium drives the real /access-review page and the real joined route on loopback. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { clearPrivilegedIdentities, setPrivilegedIdentities } from '@/shared/middleware/privileged-identities';
import { createAccessReviewFixture } from '../fixtures/access-review';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof createAccessReviewFixture>>;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

beforeEach(async () => {
  setPrivilegedIdentities([{ sub: 'granted-admin', email: 'granted@fixture.test', role: 'admin' }]);
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'breakglass-admin');
  vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  fixture = await createAccessReviewFixture();
  context = await browser.newContext();
  // Nothing off this origin may load: the page must be legible without a third-party asset.
  await context.route('**/*', (route) => new URL(route.request().url()).origin === fixture.base
    ? route.continue() : route.abort());
}, 60000);

afterEach(async () => {
  await context?.close();
  await fixture?.close();
  clearPrivilegedIdentities();
  vi.unstubAllEnvs();
}, 30000);

/** @description Open the page as one signed-in session and wait for the joined answer to land. */
async function open(session: string, query = ''): Promise<Page> {
  await context.addCookies([{ name: 'session', value: session, url: fixture.base }]);
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${fixture.base}/access-review/${query}`);
  await expect.poll(() => page.locator('#swarmRole').textContent()).not.toBe('—');
  return page;
}

describe('access review page — provenance is visible, not just present in the payload', () => {
  it('does not render a break-glass-only operator the same way as a granted admin', async () => {
    const granted = await open('granted');
    const grantedRole = await granted.locator('#swarmRole').textContent();
    const grantedSources = await granted.locator('#swarmSources').textContent();
    const grantedNote = await granted.locator('#swarmNote').textContent();
    const grantedNoteClass = await granted.locator('#swarmNote').getAttribute('class');
    await granted.close();

    const breakglass = await open('breakglass');
    const breakglassRole = await breakglass.locator('#swarmRole').textContent();
    const breakglassSources = await breakglass.locator('#swarmSources').textContent();
    const breakglassNote = await breakglass.locator('#swarmNote').textContent();

    // The same role on both screens — which is exactly why the label has to differ.
    expect(grantedRole).toBe('admin');
    expect(breakglassRole).toBe('admin');
    expect(grantedSources).toContain('swarm-role');
    expect(breakglassSources).toContain('break-glass');
    expect(breakglassSources).not.toBe(grantedSources);
    expect(breakglassNote).not.toBe(grantedNote);
    expect(breakglassNote).toContain('environment file');
    expect(await breakglass.locator('#swarmNote').getAttribute('class')).toContain('warn');
    expect(grantedNoteClass).not.toContain('warn');
  }, 60000);

  it('shows the three axes together, including the application the caller cannot reach', async () => {
    await fixture.grant('alice', 'reader');
    const alice = await open('alice');

    expect(await alice.locator('#swarmRole').textContent()).toBe('viewer');
    expect(await alice.locator('#permissions').textContent()).toContain('ticket.read');

    const rows = alice.locator('#appRows tr');
    await expect.poll(() => rows.count()).toBe(2);
    const catalogRow = await rows.nth(0).textContent();
    expect(catalogRow).toContain('catalog-app');
    expect(catalogRow).toContain('app-assignment');
    expect(catalogRow).toContain('reader');
    expect(catalogRow).toContain('records.read');
    const fallbackRow = await rows.nth(1).textContent();
    expect(fallbackRow).toContain('fallback-app');
    expect(fallbackRow).toContain('denied');

    // The whole point of a read-only view: nothing on the screen changes anything.
    expect(await alice.locator('#chooser').isVisible()).toBe(false);
    expect((await fixture.store.read()).assignments).toHaveLength(1);
  }, 60000);

  it('lets an admin look up another subject from the page itself', async () => {
    await fixture.grant('alice', 'reader');
    const admin = await open('granted');
    expect(await admin.locator('#chooser').isVisible()).toBe(true);

    await admin.locator('#subjectInput').fill('alice');
    await admin.locator('#lookupBtn').click();
    await expect.poll(() => admin.locator('#subjectIdentity').textContent()).toContain('alice');
    expect(await admin.locator('#subjectIdentity').textContent()).not.toContain('(you)');
    await expect.poll(() => admin.locator('#appRows').textContent()).toContain('app-assignment');
    // Somebody else has no session here, so the page must say which evidence it did NOT have.
    expect(await admin.locator('#swarmNote').textContent()).toContain('Only the subject identifier was evaluated');
  }, 60000);

  it('says the role snapshot has not loaded rather than calling an admin a viewer', async () => {
    clearPrivilegedIdentities();
    const granted = await open('granted');
    expect(await granted.locator('#swarmRole').textContent()).toBe('viewer');
    const note = await granted.locator('#swarmNote').textContent();
    expect(note).toContain('has not loaded');
    expect(await granted.locator('#swarmNote').getAttribute('class')).toContain('warn');
  }, 60000);
});
