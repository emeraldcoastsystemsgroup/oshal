/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-145 D3 render guard, in a real browser against the real page. Chromium loads the SHIPPED src/pages/cockpit/tools/app-group-setup.html exactly as the real GET /:name/setup-dashboard route serves it, it fetches the real plan from the real GET /:name/setup, and it asks each synthetic package's summary and readiness probes itself over the same origin — the page's own fetch discipline, unmodified. The cases assert what an operator would see: one app's tiles and items in "What's going on" ABOVE its setup steps in "What still needs you", and a deliberately broken probe rendering "can't be checked" with no tile and no green mark. Isolated browser, loopback-only routing, no page script is stubbed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | A probe that answers and then stalls, plus the D5 fallback RENDER. The first had no bound at all - fetch resolves on headers, so clearing the timer there left a stalled body waiting forever and Promise.all held back every probe that had answered (measured 15 s, undegraded). The second is the user-visible half of D5, asserted server-side and executed by nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { startAppStatusDashboardFixture, type AppStatusDashboardFixture } from '../fixtures/app-status-dashboard';
import { BROWSER_HOOK_TIMEOUT_MS, launchIsolatedBrowser } from '../fixtures/isolated-browser';

vi.setConfig({ hookTimeout: BROWSER_HOOK_TIMEOUT_MS });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: AppStatusDashboardFixture;
let isolated: Awaited<ReturnType<typeof launchIsolatedBrowser>>;

beforeAll(async () => { isolated = await launchIsolatedBrowser(); browser = isolated.browser; });
afterAll(async () => {
  if (!isolated) return;
  const cleanup = await isolated.close();
  mkdirSync('temp', { recursive: true });
  writeFileSync(`temp/app-status-dashboard-browser-cleanup-${cleanup.pid}.json`, JSON.stringify(cleanup, null, 2) + '\n', { flag: 'wx' });
});
beforeEach(async () => {
  fixture = await startAppStatusDashboardFixture();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  // Nothing but this fixture's own origin may be reached: no external asset can colour a verdict.
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  page = await context.newPage();
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

/**
 * @description Open the kernel status dashboard for one name through the real route and wait for
 * the page to finish rendering its own probe results.
 * @param name - The installed app or group name in the URL path.
 * @returns Nothing; the page is settled when it resolves.
 */
async function open(name: string): Promise<void> {
  await page.goto(`${fixture.origin}/api/swarm/apps/${name}/setup-dashboard`);
  await page.waitForFunction(() => {
    const subtitle = document.getElementById('subtitle');
    return !!subtitle && subtitle.textContent !== 'Loading…';
  });
  await page.waitForFunction(() => {
    const highlights = document.getElementById('highlights');
    return !!highlights && !highlights.className.includes('hidden');
  });
}

/** @description Read what the rendered highlights section actually shows. @returns The visible render. */
function rendered() {
  return page.evaluate(() => {
    const text = (el: Element | null) => (el?.textContent ?? '').trim();
    const visible = (el: Element | null) => !!el && !el.className.includes('hidden');
    return {
      title: text(document.getElementById('title')),
      highlightsHeading: text(document.querySelector('#highlights h2')),
      needsHeading: text(document.querySelector('#needs h2')),
      tiles: [...document.querySelectorAll('#tiles .tile')].map(t => ({
        label: text(t.querySelector('.tile-label')), value: text(t.querySelector('strong')), tone: t.className.replace('tile ', ''),
      })),
      items: [...document.querySelectorAll('#items li')].map(li => ({
        text: text(li.querySelector('span')), fix: text(li.querySelector('button')),
      })),
      notice: visible(document.getElementById('summaryNotice')) ? text(document.getElementById('summaryNotice')) : '',
      steps: [...document.querySelectorAll('#steps .step')].map(s => ({
        // The label element also carries the attributing `.app` span (ADR-141), so read its own node.
        label: (s.querySelector('.label')?.firstChild?.textContent ?? '').trim(),
        app: text(s.querySelector('.label .app')),
        state: s.className.replace('step ', ''), detail: text(s.querySelector('.detail')),
      })),
      count: text(document.getElementById('count')),
      // The order an operator actually reads them in: highlights must sit above the steps.
      highlightsAboveSteps: (document.getElementById('highlights') as HTMLElement).getBoundingClientRect().top
        < (document.getElementById('needs') as HTMLElement).getBoundingClientRect().top,
      needsVisible: visible(document.getElementById('needs')),
    };
  });
}

it('renders one app\'s tiles and items beside its setup steps on the shipped page', async () => {
  await open('fixture-ok');
  const view = await rendered();

  expect(view.title).toBe('fixture-ok display');
  expect(view.highlightsHeading).toBe("What's going on");
  expect(view.needsHeading).toBe('What still needs you');
  expect(view.highlightsAboveSteps).toBe(true);
  expect(view.needsVisible).toBe(true);

  // Five tiles were asserted by the app; D2's cap TRUNCATES to four rather than rejecting the lot.
  expect(view.tiles).toEqual([
    { label: 'Record', value: '116W-215L', tone: 'tone-warn' },
    { label: 'P&L', value: '-$18.24', tone: 'tone-neutral' },
    { label: 'Open', value: '3', tone: 'tone-good' },
    { label: 'Queued', value: '9', tone: 'tone-neutral' },
  ]);
  expect(view.items.map(i => i.text)).toEqual([
    'Both strategies are failing their Brier gate',
    '4 documents awaiting your approval',
    'A fix into a surface this app does not own',
  ]);
  // `fix` is same-app by contract: only the button into this app's own surface is offered.
  expect(view.items.map(i => i.fix)).toEqual(['', 'Open', '']);
  expect(view.notice).toBe('');

  // The setup steps render beside the highlights, from the app's OWN readiness declarations.
  expect(view.steps).toEqual([
    { label: 'Connect inbox', app: 'fixture-ok display', state: 'done', detail: 'Inbox connected' },
    { label: 'Import history', app: 'fixture-ok display', state: 'todo', detail: 'No history imported yet' },
  ]);
  expect(view.count).toBe('1 of 2 steps done');
});

it('bounds a probe that answers and then stalls, instead of waiting on it forever', async () => {
  // The bound has to outlive the HEADERS. Measured against this page before the fix: a dead socket
  // degraded at 3.0 s, but headers-then-nothing was still undegraded at 15 s - and because the
  // probes are joined with Promise.all, that one lane held back every probe that had answered.
  const started = Date.now();
  await open('fixture-slow');
  const view = await rendered();
  const elapsed = Date.now() - started;

  expect(view.notice, 'the page must say it could not check, not stay blank').toMatch(/could not|can.t|not reachable|finish/i);
  expect(elapsed, 'the 3 s probe bound did not apply to the body').toBeLessThan(12_000);
  // And never invents a fact from a body it never received.
  expect(view.tiles).toEqual([]);
}, 30_000);

it('renders the D5 fallback items for an app that declares nothing', async () => {
  // The server side of the fallback is asserted elsewhere; this is the branch that turns those rows
  // into what a person actually reads, and nothing executed it.
  await open('fixture-quiet');
  const view = await rendered();
  const texts = view.items.map(item => item.text).join(' | ');
  expect(view.items.length, 'an app with recent task history must not render as empty').toBeGreaterThan(0);
  expect(texts).toMatch(/swept the queue|reconciled the ledger/);
}, 30_000);

it('a deliberately broken probe renders "can\'t be checked", never a green state and never a zero', async () => {
  await open('fixture-broken');
  const view = await rendered();

  expect(view.notice).toBe("fixture-broken display can't be checked right now.");
  expect(view.tiles).toEqual([]);
  expect(view.items).toEqual([]);
  // Nothing on the page asserts a fact the app did not answer with.
  const painted = await page.evaluate(() => document.body.innerHTML);
  expect(painted).not.toContain('tone-good');
  expect(painted).not.toContain('step done');
  expect(view.needsVisible).toBe(false);
});

it('a pointer that resolves to the wrong type also degrades to "can\'t be checked"', async () => {
  await open('fixture-typed');
  const view = await rendered();
  expect(view.notice).toBe("fixture-typed display can't be checked right now.");
  expect(view.tiles).toEqual([]);
});
