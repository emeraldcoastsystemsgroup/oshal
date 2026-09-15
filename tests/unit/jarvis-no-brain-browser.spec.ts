/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | End-to-end guard for BACKLOG "Jarvis must fail honestly when the operator has no hosted brain": the unchanged jarvis.html in real Chromium asks the REAL Jarvis router (runJarvisBot → executeBotOrInline → stampRemoteBrain over the shipped registry) while resolveUserLlmConnection resolves to nothing, and must WRITE and SPEAK "Jarvis has no AI engine connected … Bring Your Own LLM" — the spoken line observed at /api/voice/synthesize, the boundary the page actually asks — while the briefing shelf, which needs no live model, still lists its row. An ordinary failure through the same router still shows its own message and speaks the apology.
 */
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const doubles = vi.hoisted(() => ({ turnFailure: null as Error | null }));

// Same doubles as tests/unit/jarvis-no-hosted-brain-honesty.spec.ts: only the hosted-rung ladder,
// persistence and the identity rail are not real. The page, the router, the execution chokepoint
// and the registry decide everything this file asserts.
vi.mock('@/app/routes/free-tier-rotation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/app/routes/free-tier-rotation')>();
  return { ...actual, resolveUserLlmConnection: vi.fn(async () => undefined) };
});
vi.mock('@/app/routes/connector-token-broker', () => ({ resolveBotCreds: vi.fn().mockResolvedValue({}) }));
vi.mock('@/features/user-model', () => ({
  withHavenContext: vi.fn(async (_pool: unknown, _sub: string, prompt: string) => {
    if (doubles.turnFailure) throw doubles.turnFailure;
    return prompt;
  }),
  learnFromExchange: vi.fn().mockResolvedValue(undefined),
}));
// No store may open a pool: every in-memory store stays in memory, and no inherited DATABASE_URL is
// ever dialled. The rest of the barrel stays real (the stores' persistence activation reads it).
vi.mock('@/shared/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/services/database')>()),
  createOptionalPostgresPool: () => null,
  ensureConversationStoreSchema: async () => {},
  runRuntimeSchemaBootstrap: vi.fn().mockResolvedValue(undefined),
}));

import { dashboardState, startJarvisDashboardFixture, type DashboardTask } from '../fixtures/jarvis-dashboard';
import { launchIsolatedBrowser } from '../fixtures/isolated-browser';
import { createNoBrainJarvisRouter, NO_BRAIN_SUB } from '../fixtures/jarvis-no-brain';
import { purgeJarvisAskJobsForOwner } from '../../src/app/routes/jarvis-routes';
import { BotNodeClient } from '../../src/features/agent-management';
import { warmBotEndpointRegistry } from '../../src/features/agent-management/services/bot-node-client';

vi.setConfig({ testTimeout: 60_000 });

// Tripwire on the node transport (see the route-level guard): the no-brain turn is refused before the
// dedicated-node hop, and any dispatch that does happen is recorded and failed here, never sent.
const nodeDispatch = vi.spyOn(BotNodeClient.prototype, 'execute')
  .mockRejectedValue(new Error('tripwire: a Jarvis turn reached the bot-node transport'));

const NO_ENGINE = 'Jarvis has no AI engine connected — add one under Settings → Connections → Bring Your Own LLM.';
const APOLOGY = "Sorry, that didn't work.";

/** A briefing already delivered on an earlier visit: listed on the shelf, never re-announced, so the
 *  only speech in these cases is the failed ask itself. */
const BRIEFING: DashboardTask = {
  id: 'no-brain-briefing', title: 'Briefing: Your morning briefing', status: 'done', delivered: true,
  result: 'Three things worth your attention this morning.', createdAt: new Date().toISOString(),
  briefing: { sourceId: 'no-brain-fixture:morning' },
};

let browser: Browser;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let fixture: Awaited<ReturnType<typeof startJarvisDashboardFixture>>;

beforeAll(async () => {
  // Warmed so Jarvis resolves to its dedicated node (the production shape), not the spec runner's
  // inline fallback.
  await warmBotEndpointRegistry();
  fixture = await startJarvisDashboardFixture({ jarvisRouter: createNoBrainJarvisRouter() });
  owned = await launchIsolatedBrowser({ args: ['--autoplay-policy=no-user-gesture-required'] });
  browser = owned.browser;
}, 90_000);

beforeEach(() => {
  doubles.turnFailure = null;
  nodeDispatch.mockClear();
  Object.assign(fixture.state, dashboardState(), { tasks: [{ ...BRIEFING }] });
  purgeJarvisAskJobsForOwner(NO_BRAIN_SUB);
});

afterAll(async () => {
  try { await owned?.close(); } finally { await fixture?.stop(); }
}, 40_000);

/**
 * @description Open the unchanged page with every other origin blocked. Records what it asked the
 * speech service to say, how many times it read the shelf, and any page error. The browser's own
 * speech engine is stubbed so a fallback can never talk through the host's speakers.
 * @returns The page, the observation logs and an explicit close.
 */
async function openJarvis(): Promise<{ page: Page; spoken: string[]; shelfReads: () => number; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route('**/*', (route) => (
    new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort()
  ));
  await context.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak() {}, cancel() {}, getVoices: () => [], addEventListener() {} },
    });
  });
  const page = await context.newPage();
  const spoken: string[] = [];
  const errors: string[] = [];
  let reads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/jarvis/tasks') reads += 1;
    if (request.method() === 'POST' && url.pathname === '/api/voice/synthesize') {
      spoken.push(String((JSON.parse(request.postData() || '{}') as { text?: string }).text || ''));
    }
  });
  await page.goto(`${fixture.base}/api/jarvis/?layout=compact`, { timeout: 45_000 });
  await page.waitForFunction(() => typeof (window as unknown as { handleInput?: unknown }).handleInput === 'function', undefined, { timeout: 20_000 });
  await page.locator('#shelf .shelf-sum').waitFor({ timeout: 20_000 });
  page.setDefaultTimeout(8000);
  return { page, spoken, shelfReads: () => reads, errors, close: () => context.close() };
}

/** Type one turn into the visible composer and send it. */
async function send(page: Page, text: string): Promise<void> {
  await page.locator('#typein').fill(text);
  await page.locator('#typer button').click();
}

it('writes AND speaks the missing engine, and the briefing shelf still lists its row', async () => {
  const { page, spoken, shelfReads, errors, close } = await openJarvis();
  try {
    await page.locator('[data-source="Briefing"] summary').click();
    expect(await page.locator(`[data-job-open="${BRIEFING.id}"]`).count()).toBe(1);
    const readsBefore = shelfReads();

    await send(page, 'Tighten my resume summary.');

    await expect.poll(() => page.locator('#convo .err').textContent(), { timeout: 20_000 }).toBe(NO_ENGINE);
    // The half the operator experienced: the spoken line was an apology with no content.
    await expect.poll(() => spoken.join(' | '), { timeout: 20_000 }).toContain('Jarvis has no AI engine connected');
    const line = spoken.find((text) => text.includes('no AI engine connected')) ?? '';
    expect(line).toContain('Bring Your Own LLM');
    expect(line).not.toContain('→');
    expect(spoken).not.toContain(APOLOGY);

    // The shelf needs no live model: it is re-read after the failed turn and still carries the row.
    await expect.poll(shelfReads, { timeout: 20_000 }).toBeGreaterThan(readsBefore);
    expect(await page.locator(`[data-job-open="${BRIEFING.id}"]`).count()).toBe(1);
    expect(nodeDispatch).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally { await close(); }
});

it('still shows its own message and speaks the apology for an ordinary failure', async () => {
  doubles.turnFailure = new Error('The request could not be prepared.');
  const { page, spoken, errors, close } = await openJarvis();
  try {
    await send(page, 'Tighten my resume summary.');

    await expect.poll(() => page.locator('#convo .err').textContent(), { timeout: 20_000 }).toBe('The request could not be prepared.');
    await expect.poll(() => spoken, { timeout: 20_000 }).toContain(APOLOGY);
    expect(spoken.join(' | ')).not.toContain('no AI engine connected');
    expect(errors).toEqual([]);
  } finally { await close(); }
});
