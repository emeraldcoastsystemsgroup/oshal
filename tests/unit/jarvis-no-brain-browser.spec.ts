/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove in real Chromium, against the unchanged Jarvis page, that a NO_HOSTED_BRAIN turn is READ and SPOKEN as "Jarvis has no AI engine connected" — the pure askFailureLines guard covers the decision, this covers the WIRING (deleting the call site left that guard green) — and that the work queue still lists its finished row in the same state.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { dashboardState, startJarvisDashboardFixture } from '../fixtures/jarvis-dashboard';
import { launchIsolatedBrowser } from '../fixtures/isolated-browser';
import { JARVIS_NO_BRAIN_CODE, JARVIS_NO_BRAIN_MESSAGE } from '@/app/routes/jarvis-no-brain-notice';

vi.setConfig({ testTimeout: 30_000 });

let browser: Browser;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let fixture: Awaited<ReturnType<typeof startJarvisDashboardFixture>>;

/** A finished shelf row from an earlier delivery. `delivered` so the page renders it without
 *  announcing it — the only speech in these cases must be the failed ask itself. */
const BRIEFING_ROW = {
  id: 'jarvis-briefing-fixture',
  title: 'Briefing: Your morning briefing',
  status: 'done',
  result: 'Three things worth your attention this morning.',
  createdAt: new Date().toISOString(),
  delivered: true,
};

beforeAll(async () => {
  fixture = await startJarvisDashboardFixture();
  owned = await launchIsolatedBrowser();
  browser = owned.browser;
}, 90_000);

beforeEach(() => { Object.assign(fixture.state, dashboardState()); });

afterAll(async () => {
  try { await owned?.close(); } finally { await fixture?.stop(); }
}, 40_000);

/**
 * @description Open the unchanged page with every other origin blocked, recording what it asked
 * the speech service to say.
 * @returns The page, the spoken-text log, collected page errors and an explicit close.
 */
async function openJarvis(): Promise<{ page: Page; spoken: string[]; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route) => (
    new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort()
  ));
  const page = await context.newPage();
  const spoken: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/voice/synthesize')) return;
    spoken.push(String((JSON.parse(request.postData() || '{}') as { text?: string }).text || ''));
  });
  // The page pulls the real surface plus every real client module, so first paint is not a
  // four-second operation on a loaded box; the per-locator budget below stays tight.
  await page.goto(`${fixture.base}/api/jarvis/?layout=compact`, { timeout: 45_000 });
  await page.waitForFunction(
    () => typeof (window as unknown as { handleInput?: unknown }).handleInput === 'function',
    undefined, { timeout: 20_000 },
  );
  await page.locator('#shelf .shelf-sum').waitFor({ timeout: 20_000 });
  page.setDefaultTimeout(8000);
  return { page, spoken, errors, close: () => context.close() };
}

it('reads AND speaks the missing engine, and still lists the work queue', async () => {
  // Exactly what /ask/result returns once the user-brain ladder resolves to nothing on a bot whose
  // registry harness is an unbrokered CLI (server side pinned in jarvis-no-hosted-brain-honesty).
  fixture.state.result = { status: 'error', error: JARVIS_NO_BRAIN_MESSAGE, code: JARVIS_NO_BRAIN_CODE };
  fixture.state.tasks = [BRIEFING_ROW];
  const { page, spoken, errors, close } = await openJarvis();
  try {
    await page.locator('#typein').fill('Tighten my resume summary.');
    await page.locator('#typer button').click();

    await expect.poll(() => page.locator('#convo').textContent(), { timeout: 10_000 })
      .toContain('Jarvis has no AI engine connected');
    expect(await page.locator('#convo').textContent()).toContain('Bring Your Own LLM');

    // The half the operator actually experienced: the written line was whatever arrived, and the
    // spoken one was an apology with no content.
    await expect.poll(() => spoken.join(' | '), { timeout: 10_000 }).toContain('no AI engine connected');
    expect(spoken.join(' | ')).not.toContain("didn't work");

    // The briefing shelf needs no live model, so it must not be dragged down with the ask path.
    await page.locator('[data-source="Briefing"] summary').click();
    expect(await page.locator(`[data-job-open="${BRIEFING_ROW.id}"]`).count()).toBe(1);
    expect(errors).toEqual([]);
  } finally { await close(); }
});

it('still apologises for an ordinary failure — the honest line is scoped to the one state', async () => {
  fixture.state.result = { status: 'error', error: 'That ticket no longer exists.' };
  const { page, spoken, errors, close } = await openJarvis();
  try {
    await page.locator('#typein').fill('Open ticket 41.');
    await page.locator('#typer button').click();

    await expect.poll(() => page.locator('#convo').textContent(), { timeout: 10_000 })
      .toContain('That ticket no longer exists.');
    await expect.poll(() => spoken.join(' | '), { timeout: 10_000 }).toContain("Sorry, that didn't work.");
    expect(spoken.join(' | ')).not.toContain('no AI engine connected');
    expect(errors).toEqual([]);
  } finally { await close(); }
});
