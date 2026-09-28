/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the full-swarm build in headless Chromium through the real static route registration over the isolated synthetic swarm: tickets in every canonical state land on the Commons board and in the Jarvis briefing where the shared status groups put them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const errors: string[] = [];
const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    // window.speechSynthesis is a read-only accessor: a plain assignment leaves the real engine in place.
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {}, cancel() {}, getVoices() { return []; } }, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function SpeechSynthesisUtterance() {}, configurable: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

/** @description Open one experience path and wait for its live root. */
async function open(path: string, ready: string) { await page.goto(fixture.origin + path); await page.waitForSelector(ready); }
/** @description A synthetic ticket in one canonical state, owned by the synthetic caller and attributed to the ledger queue. */
function ticket(id: string, title: string, status: string, offsetMs = -HOUR) {
  return { ticketId: id, title, status, ticketType: 'ledger-review', updatedAt: iso(offsetMs), description: `Synthetic ${status} ticket.` };
}

describe('canonical ticket states in the full-swarm layouts', () => {
  it('the Commons board and the Jarvis briefing place approval gates, customer actions, build phases and approved tickets', async () => {
    fixture.state.tickets.push(ticket('33333333-3333-4333-8333-333333333331', 'Synthetic approval gate', 'approval_required', -10 * 60000),
      ticket('33333333-3333-4333-8333-333333333332', 'Synthetic build phase', 'in_process_build', -20 * 60000),
      ticket('33333333-3333-4333-8333-333333333333', 'Synthetic approved queue item', 'approved', -30 * 60000),
      ticket('33333333-3333-4333-8333-333333333334', 'Synthetic customer action', 'customer_action', -40 * 60000));
    await open('/commons', '.full-commons');
    await page.getByRole('tab', { name: 'Work board' }).click();
    const column = (name: string) => page.locator('.board-column', { has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) }).innerText();
    expect(await column('Review')).toMatch(/Synthetic approval gate[\s\S]*Synthetic customer action/);
    expect(await column('Working')).toMatch(/Synthetic build phase[\s\S]*Synthetic approved queue item/);
    expect(await column('Working')).not.toContain('Synthetic approval gate');
    await open('/jarvis', '.full-jarvis');
    await page.waitForSelector('.briefing-item');
    const brief = await page.locator('.briefing-card').innerText();
    expect(brief).toContain('Synthetic approval gate'); expect(brief).toContain('Synthetic customer action');
    expect(await page.locator('.jarvis-greeting').innerText()).toMatch(/3 items need you: Synthetic approval gate; Synthetic customer action; Synthetic failed task/);
    expect(errors).toEqual([]);
  });
});
