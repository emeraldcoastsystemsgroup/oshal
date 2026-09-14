/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove in real Chromium, against the real Jarvis router and an isolated PostgreSQL, that a persisted thread the server cannot attribute to the current sign-in is refused, the page rolls to a fresh thread and resends the turn once, the answer renders, and the new thread carries the caller's issuer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { createProtectedJarvisFixture } from '../fixtures/protected-jarvis-results';
import { DisposableAlertPostgres } from '../helpers/disposable-alert-postgres';
import { launchIsolatedBrowser } from '../fixtures/isolated-browser';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

const bot = vi.hoisted(() => vi.fn());
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
// Only the model turn is doubled. Routing, session ownership, persistence and the page are real.
vi.mock('@/app/routes/jarvis-orchestrator', async importOriginal => ({ ...await importOriginal<object>(),
  runJarvisBot: bot, buildCatalogBlock: async () => '', loadEffectiveRoutes: async () => [],
  maskPendingComplexSummaries: async () => {}, repairCompletedTaskTableVisuals: async () => {} }));

vi.setConfig({ testTimeout: 40_000 });
const database = new DisposableAlertPostgres();
let fixture: Awaited<ReturnType<typeof createProtectedJarvisFixture>>;
let owned: Awaited<ReturnType<typeof launchIsolatedBrowser>>;
let browser: Browser;
const question = 'How did I do in the stock market last week?';
const answer = 'Last week you finished **up 2.3%** on the fixture ledger.';

beforeAll(async () => {
  await database.start();
  owned = await launchIsolatedBrowser(); browser = owned.browser;
}, 90_000);
afterAll(async () => { try { await owned?.close(); } finally { await database.stop(); } }, 40_000);
beforeEach(async () => {
  vi.stubEnv('OSHAL_NO_AI', 'false');
  fixture = await createProtectedJarvisFixture(database);
  bot.mockResolvedValue({ answer });
});
afterEach(async () => { await fixture?.close(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

/** @description Open the real page as the fixture's signed-in user with the given thread bookmarked, blocking every other origin. */
async function openJarvis(bookmarkedThread: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce',
    extraHTTPHeaders: { 'x-fixture-user': 'alice' } });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.base ? route.continue() : route.abort());
  await context.addInitScript(value => localStorage.setItem('jarvisSessionId', value), bookmarkedThread);
  const page = await context.newPage();
  const asks: { status: number; sessionId: string; body: string }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    const request = response.request();
    if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/jarvis/ask') return;
    const sessionId = String((JSON.parse(request.postData() || '{}') as { sessionId?: string }).sessionId);
    asks.push({ status: response.status(), sessionId, body: await response.text().catch(() => '') });
  });
  await page.goto(fixture.base + '/api/jarvis/?layout=compact');
  await page.waitForFunction(() => typeof (window as unknown as { handleInput?: unknown }).handleInput === 'function');
  return { page, context, asks, errors };
}

it('refuses the bookmarked legacy thread, rolls to a fresh one, answers on it, and stamps the caller issuer', async () => {
  // Every Jarvis thread created before issuer provenance existed looks like this row: owner known, issuer absent.
  await fixture.tasks.create({ taskId: 'legacy-conversation', title: 'How did I do last month?', processingMode: 'agentic',
    agentId: 'jarvis', ownerSub: 'alice', metadata: { origin: 'jarvis-chat' } });
  const { page, context, asks, errors } = await openJarvis('legacy-conversation');
  try {
    await page.locator('#typein').fill(question);
    await page.locator('#typer button').click();
    await expect.poll(() => asks.length, { timeout: 15_000 }).toBe(2);
    expect(asks[0]).toMatchObject({ status: 404, sessionId: 'legacy-conversation' });
    expect(JSON.parse(asks[0].body)).toEqual({ error: 'session_not_found' });
    expect(asks[1].status).toBe(202);
    const fresh = asks[1].sessionId;
    expect(fresh).toMatch(/^jarvis-[0-9a-f-]{36}$/);
    await expect.poll(() => page.locator('#convo .msg.bot .bx').last().textContent(), { timeout: 20_000 }).toContain('up 2.3%');
    expect(await page.evaluate(() => localStorage.getItem('jarvisSessionId'))).toBe(fresh);
    expect(await page.locator('#convo').textContent()).not.toContain('session_not_found');
    // The server created the fresh thread for this caller with issuer provenance; the legacy row never ran a turn.
    const created = await fixture.tasks.get(fresh);
    expect(created?.ownerSub).toBe('alice');
    expect(readOwnerPrincipalIssuer(created?.metadata)).toBe(fixture.actors.alice.issuer);
    expect(bot).toHaveBeenCalledTimes(1);
    expect(bot.mock.calls[0].some(argument => typeof argument === 'string' && argument === fresh)
      || JSON.stringify(bot.mock.calls[0]).includes(fresh)).toBe(true);
    expect(JSON.stringify(bot.mock.calls[0])).not.toContain('legacy-conversation');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

it('leaves a thread the caller does own untouched: one ask, no roll', async () => {
  const { page, context, asks, errors } = await openJarvis('jarvis-owned-thread-000000000000000000000000000');
  try {
    await page.locator('#typein').fill(question);
    await page.locator('#typer button').click();
    await expect.poll(() => page.locator('#convo .msg.bot .bx').last().textContent(), { timeout: 20_000 }).toContain('up 2.3%');
    expect(asks.map(ask => ask.status)).toEqual([202]);
    expect(asks[0].sessionId).toBe('jarvis-owned-thread-000000000000000000000000000');
    expect(await page.evaluate(() => localStorage.getItem('jarvisSessionId'))).toBe('jarvis-owned-thread-000000000000000000000000000');
    expect(readOwnerPrincipalIssuer((await fixture.tasks.get('jarvis-owned-thread-000000000000000000000000000'))?.metadata)).toBe(fixture.actors.alice.issuer);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
