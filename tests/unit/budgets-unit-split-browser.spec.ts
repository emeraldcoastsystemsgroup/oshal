/**
 * The Budgets surface labels the units it is given.
 *
 * `GET /api/budgets/spend` answers `spendByUnit` (billed / priceEquivalent / byo / total). The page
 * used to keep only `spendUsd` and paint one dollar figure that adds a metered bill, a subscription
 * price-equivalent and a $0 BYO token count as if they were one unit — the review of PR #641 found
 * the field arriving and being dropped, which is the entry's done-when "cost surfaces label the
 * price-equivalent/BYO units distinctly" unmet on the only user-facing windowed-spend surface.
 *
 * The boundary here is the shipped page in a real browser: `src/pages/cockpit/tools/budgets.html` is
 * served off disk to real Chromium, the two budget endpoints are stubbed at the network, and the
 * assertions read the rendered DOM. Nothing about the page is doubled.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the self-view renders the split under the enforcement figure and names each unit; a response WITHOUT the split renders the figure alone (the API omits it when its own read fails, and absent must read as unlabelled, never as zero); and the enforcement figure stays the plain sum, because a cap is one number.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

const ROOT = resolve(__dirname, '../..');
const CAP = { scopeType: 'user', scopeKey: 'owner-sub', dailyUsd: 10, hard: true, enabled: true };

let isolated: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let browser: Browser;
let server: Server;
let origin = '';

/**
 * @description Serves the shipped Budgets page and the two endpoints it calls.
 * @param spendBody - The exact JSON body `GET /api/budgets/spend` should answer.
 * @returns Nothing; the module-level server is (re)configured for the case.
 */
function serve(spendBody: Record<string, unknown>): void {
  const app = express();
  app.get('/cockpit/tools/budgets.html', (_req, res) => res.sendFile(resolve(ROOT, 'src/pages/cockpit/tools/budgets.html')));
  app.get('/api/budgets', (_req, res) => res.json({ success: true, budgets: [CAP] }));
  app.get('/api/budgets/state', (_req, res) => res.status(403).json({ error: 'self_only' }));
  app.get('/api/budgets/spend', (_req, res) => res.json(spendBody));
  app.get('*splat', (_req, res) => res.status(404).end());
  server = createServer(app);
}

/**
 * @description Loads the page against a stubbed API and returns the rendered spend cell.
 * @param spendBody - The body `GET /api/budgets/spend` answers.
 * @returns The spend cell's full text and the text of its unit sub-line, if any.
 */
async function renderSpendCell(spendBody: Record<string, unknown>): Promise<{ cell: string; split: string | null; title: string | null }> {
  serve(spendBody);
  await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
    await page.goto(`${origin}/cockpit/tools/budgets.html`);
    const cell = page.locator('table tbody tr td').nth(3);
    await cell.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => !/^\s*$/.test(document.querySelectorAll('table tbody tr td')[3]?.textContent ?? ''), null, { timeout: 15_000 });
    const split = page.locator('table tbody tr td .unit-split');
    return {
      cell: (await cell.textContent()) ?? '',
      split: (await split.count()) ? ((await split.first().textContent()) ?? '') : null,
      title: await cell.getAttribute('title'),
    };
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done())));
  }
}

beforeAll(async () => {
  isolated = await launchIsolatedBrowser();
  browser = isolated.browser;
}, BROWSER_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await isolated?.close();
}, BROWSER_HOOK_TIMEOUT_MS);

describe('the Budgets surface labels the units it is given', () => {
  it('renders the split under the enforcement figure and names every unit', async () => {
    const { cell, split, title } = await renderSpendCell({
      success: true, scopeType: 'user', scopeKey: 'owner-sub', windowHours: 24,
      spendUsd: 3.5, spendByUnit: { billed: 1.25, priceEquivalent: 2.25, byo: 0, total: 3.5 },
    });
    // The cap is enforced against one number, so the sum stays on top, unchanged.
    expect(cell).toContain('$3.5000');
    expect(split, 'the page dropped the split the API supplied').not.toBeNull();
    expect(split).toContain('billed $1.2500');
    expect(split).toContain('price-equivalent $2.2500');
    expect(split).toContain('BYO $0.0000');
    expect(title ?? '').toMatch(/price-equivalent is a subscription turn/i);
  }, 60_000);

  it('renders the figure alone when the API omits the split, so absent reads as unlabelled and not as zero', async () => {
    const { cell, split } = await renderSpendCell({
      success: true, scopeType: 'user', scopeKey: 'owner-sub', windowHours: 24, spendUsd: 3.5,
    });
    expect(cell).toContain('$3.5000');
    expect(split, 'a missing split must render nothing, never a zeroed breakdown').toBeNull();
  }, 60_000);
});
