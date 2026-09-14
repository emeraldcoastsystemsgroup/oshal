/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove live ASK approval, safe transient output, one-shot AUTO, cancellation, expiry and current-result refusal in Chromium.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { attachJarvisBrowserAssets, browserToolProposal, browserToolState, startJarvisPackageBrowserFixture } from '../fixtures/jarvis-package-tools-browser';
import { createJarvisPackageToolsFixture } from '../fixtures/jarvis-package-tools';

let browser: Browser, fixture: Awaited<ReturnType<typeof startJarvisPackageBrowserFixture>>;
const pageErrors = new WeakMap<Page, string[]>();
beforeAll(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', '1');
  fixture = await startJarvisPackageBrowserFixture(); browser = await chromium.launch({ headless: true });
});
beforeEach(() => Object.assign(fixture.state, browserToolState()));
afterAll(async () => { await browser?.close(); await fixture?.stop(); vi.unstubAllEnvs(); }, 30_000);

/** Load the actual Jarvis page and restrict every request to the disposable fixture origin. */
async function openPage(base = fixture.base, headers: Record<string, string> = {}) {
  const context = await browser.newContext({ extraHTTPHeaders: headers });
  await context.addCookies([{ name: 'panel-user', value: 'fixture', url: base }]);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  pageErrors.set(page, []);
  page.on('pageerror', error => pageErrors.get(page)!.push(error.message));
  try {
    const response = await page.goto(base + '/api/jarvis/ui');
    expect(response?.status()).toBe(200);
    await page.waitForFunction(() => typeof (window as any).oshalPresentPackageTool === 'function' && typeof (window as any).handleInput === 'function', undefined, { timeout: 8000 });
  } catch (error) { await context.close(); throw error; }
  return { page, context };
}

/** Drive the normal live ask path instead of replaying a stored conversation response. */
async function liveTurn(page: Page) {
  await page.evaluate(() => { void (window as any).handleInput('Use the fixture application tool.'); });
  try { await page.getByRole('region', { name: 'Application tool' }).waitFor({ timeout: 8000 }); }
  catch (error) { throw new Error(`${String(error)}; browser errors: ${JSON.stringify(pageErrors.get(page))}`); }
}

it('shows exact ASK inputs, rejects synthetic approval, and sends only the proposal ID on a real click', async () => {
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    const panel = page.getByRole('region', { name: 'Application tool' });
    expect(await panel.textContent()).toContain('Application: fixture-app');
    expect(await panel.textContent()).toContain('Tool: fixture_change');
    expect(await panel.locator('pre').first().textContent()).toContain('<img src=x onerror=');
    expect(await panel.locator('img,script').count()).toBe(0);
    await panel.getByRole('button', { name: 'Approve', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    expect(fixture.state.calls).toEqual([]);
    await panel.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => panel.textContent()).toContain('private-fixture-result');
    expect(fixture.state.calls).toEqual([{ action: 'execute', body: { proposalId: fixture.state.proposal.id },
      marker: '1', origin: fixture.base, cookie: 'panel-user=fixture' }]);
    expect(await panel.locator('script,img').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
    expect(await page.locator('#convo').textContent()).not.toContain('private-fixture-result');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('private-fixture-result');
  } finally { await context.close(); }
}, 30_000);

it('AUTO executes once and never replays a cached proposal or injects its result into the next model turn', async () => {
  fixture.state.proposal = browserToolProposal('auto');
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toContain('private-fixture-result');
    await page.evaluate(proposal => (window as any).oshalPresentPackageTool(proposal, document.getElementById('resultContent')), fixture.state.proposal);
    expect(fixture.state.calls.filter(call => call.action === 'execute')).toHaveLength(1);
    await page.evaluate(() => (window as any).openJob('historical-fixture-job'));
    expect(await page.locator('.jpt-panel').count()).toBe(0);
    expect(fixture.state.calls.filter(call => call.action === 'execute')).toHaveLength(1);
    await page.evaluate(() => { void (window as any).handleInput('Continue without including private tool output.'); });
    await expect.poll(() => fixture.state.asks.length).toBe(2);
    expect(JSON.stringify(fixture.state.asks)).not.toContain('private-fixture-result');
    await page.reload();
    expect(await page.locator('.jpt-panel').count()).toBe(0);
  } finally { await context.close(); }
}, 30_000);

it('cancels without execution and ignores replay of the canceled proposal', async () => {
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    await page.locator('.jpt-panel').getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(proposal => (window as any).oshalPresentPackageTool(proposal, document.getElementById('resultContent')), fixture.state.proposal);
    expect(await page.locator('.jpt-panel').count()).toBe(0);
    expect(fixture.state.calls).toEqual([]);
  } finally { await context.close(); }
}, 30_000);

it('redacts private output before focus revalidation and refuses revoked access without another execution', async () => {
  fixture.state.proposal = browserToolProposal('auto');
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toContain('private-fixture-result');
    fixture.state.allowed = false;
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await page.locator('.jpt-panel').textContent()).not.toContain('private-fixture-result');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toBe('Results expired. Ask again to refresh.');
    expect(fixture.state.calls.map(call => call.action)).toEqual(['execute', 'result']);
    expect(await page.locator('.jpt-panel').textContent()).not.toContain('fixture-record');
  } finally { await context.close(); }
}, 30_000);

it('discards a late result after cancellation and never repeats an in-flight write', async () => {
  let release!: () => void;
  fixture.state.hold = new Promise<void>(done => { release = done; });
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    const approve = page.locator('.jpt-panel').getByRole('button', { name: 'Approve', exact: true });
    await approve.click();
    await expect.poll(() => fixture.state.calls.length).toBe(1);
    expect(await approve.isDisabled()).toBe(true);
    await page.locator('.jpt-panel').getByRole('button', { name: 'Dismiss' }).click();
    release();
    await page.evaluate(() => new Promise(done => setTimeout(done, 50)));
    expect(await page.locator('.jpt-panel').count()).toBe(0);
    expect(fixture.state.calls.map(call => call.action)).toEqual(['execute']);
  } finally { release(); await context.close(); }
}, 30_000);

it('expires displayed results and ignores expired or malformed proposals without HTTP', async () => {
  const { page, context } = await openPage();
  try {
    fixture.state.proposal = browserToolProposal('auto', 1500);
    await liveTurn(page);
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toContain('private-fixture-result');
    await expect.poll(() => page.locator('.jpt-panel').count(), { timeout: 4000 }).toBe(0);
    const count = fixture.state.calls.length;
    await page.evaluate(proposal => {
      const present = (window as any).oshalPresentPackageTool;
      present(proposal, document.getElementById('resultContent'));
      present({ ...proposal, id: 'forged', expiresAt: 'never', mode: 'auto' }, document.getElementById('resultContent'));
    }, fixture.state.proposal);
    expect(await page.locator('.jpt-panel').count()).toBe(0);
    expect(fixture.state.calls).toHaveLength(count);
  } finally { await context.close(); }
}, 30_000);

it('never restores cached output even if a result endpoint returns an older successful response', async () => {
  fixture.state.proposal = browserToolProposal('auto');
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toContain('private-fixture-result');
    await page.route('**/api/jarvis/package-tools/result', route => route.fulfill({ status: 200,
      contentType: 'application/json', body: JSON.stringify({ result: 'stale-private-replay', expiresAt: fixture.state.proposal.expiresAt }) }));
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toBe('Results expired. Ask again to refresh.');
    expect(await page.locator('body').textContent()).not.toContain('stale-private-replay');
    expect(fixture.state.calls.filter(call => call.action === 'execute')).toHaveLength(1);
  } finally { await context.close(); }
}, 30_000);

it('does not reveal an in-flight result after the user leaves the surface', async () => {
  let release!: () => void;
  fixture.state.hold = new Promise<void>(done => { release = done; });
  const { page, context } = await openPage();
  try {
    await liveTurn(page);
    await page.locator('.jpt-panel').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => fixture.state.calls.length).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    release();
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toBe('Results expired. Ask again to refresh.');
    expect(await page.locator('body').textContent()).not.toContain('private-fixture-result');
    expect(fixture.state.calls.map(call => call.action)).toEqual(['execute', 'result']);
  } finally { release(); await context.close(); }
}, 30_000);

/** Display a real controller proposal in the primary answer slot without synthetic approval. */
async function presentControllerProposal(page: Page, proposal: unknown) {
  await page.evaluate(value => {
    (window as any).showInlineResult('Review application tool');
    (window as any).oshalPresentPackageTool(value, document.getElementById('resultContent'));
  }, proposal);
  await page.locator('.jpt-panel').waitFor();
}

/** Pair a real controller with the real page and dispose either one when setup fails. */
async function openRealPage() {
  const actual = await createJarvisPackageToolsFixture('ask');
  try {
    attachJarvisBrowserAssets(actual.fixture.app);
    return { actual, ...await openPage(actual.base, { 'x-fixture-user': 'alice' }) };
  } catch (error) { await actual.close(); throw error; }
}

it('a real ASK click executes the current package policy once and its private result cannot be restored', async () => {
  const { actual, page, context } = await openRealPage();
  try {
    const proposal = await actual.propose();
    await presentControllerProposal(page, proposal);
    expect(actual.fixture.results).toBe(0);
    await page.locator('.jpt-panel').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toContain('"count": 3');
    expect(actual.fixture.results).toBe(1);
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toBe('Results expired. Ask again to refresh.');
    expect((await actual.call('/result', { proposalId: proposal.id })).status).toBe(410);
    expect(actual.fixture.results).toBe(1);
  } finally { await context.close(); await actual.close(); }
}, 30_000);

it.each(['revoked', 'different-issuer'] as const)('refuses a real pending ASK after %s without business execution', async change => {
  const { actual, page, context } = await openRealPage();
  try {
    await presentControllerProposal(page, await actual.propose());
    if (change === 'revoked') await actual.fixture.grant({ action: 'revoke' });
    else await context.setExtraHTTPHeaders({ 'x-fixture-user': 'collision' });
    await page.locator('.jpt-panel').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => page.locator('.jpt-panel').textContent()).toBe('Application tool access is unavailable. Ask again.');
    expect(actual.fixture.results).toBe(0);
  } finally { await context.close(); await actual.close(); }
}, 30_000);
