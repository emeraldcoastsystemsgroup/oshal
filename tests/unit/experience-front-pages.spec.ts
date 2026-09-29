/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Composed front pages in headless Chromium over the isolated synthetic swarm: each preset's declared module order (Business leads with the email digest, office calendar, documents and Federal CRM cards; Home with the shared calendar and money or school by role; the classroom unchanged), a package summary card rendered from the application's own probe (tiles, items, timestamp, the admitted tool as its action), nothing rendered and nothing requested for an application outside the caller's plan or not installed, a refusal shown as its status, the action opening the hosted tool in place with the preset's audience or falling back to the application link, the About dialog naming each card's source, and the per-preset shopping heading.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Home's declared front page gained the room strip first, the opt-in check-ins after the personal module and the Family admin card in the aside (the design study's remaining Home pieces); Business and the classroom orders are unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { installAssemblyHosts, installFrontPageHosts, startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const errors: string[] = [];

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

/** @description Open one preset's front page and wait until its live sources have answered, so a late repaint never races an assertion. */
async function open(preset: string, ready: string) {
  await page.goto(`${fixture.origin}/homebase?preset=${preset}`);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}
/** @description Reload the open page after a state change and wait the same way. */
async function reload(ready: string) { await page.reload(); await page.waitForSelector(ready); await page.waitForLoadState('networkidle'); }
/** @description The rendered order of one column: cards as card:<app>, core modules by their data-module, the tools section as apps, the assistant strip as assistant. */
const columnOrder = (column: 'main' | 'aside') => page.locator(`.${column}-column`).evaluate(col =>
  Array.from(col.children).flatMap(el => el.classList.contains('card-grid') ? Array.from(el.children) : [el]).map(el => {
    const h = el as HTMLElement;
    return h.dataset.card ? `card:${h.dataset.card}` : h.dataset.module || (h.querySelector('.section-heading') ? 'apps' : h.classList.contains('assistant') ? 'assistant' : h.className);
  }));
const card = (name: string) => page.locator(`[data-module="card"][data-card="${name}"]`);
const probeCalls = () => fixture.state.calls.filter(c => c.startsWith('GET /fixture/probe/'));
const asStudent = () => { fixture.state.education.me = { ...fixture.state.education.me, role: 'student' }; };
const CARDS = ['email-summarizer', 'calendar', 'presentations', 'capture-crm', 'payroll', 'calling-assistant'];

describe('composed front pages: Business', () => {
  it('leads with the email digest, office calendar, documents and Federal CRM cards from each application’s own probe; payroll, calls and lists beside', async () => {
    installAssemblyHosts(fixture.state); installFrontPageHosts(fixture.state);
    await open('company', '[data-card="capture-crm"] .card-tile');
    expect(await columnOrder('main')).toEqual(['card:email-summarizer', 'card:calendar', 'card:presentations', 'card:capture-crm', 'projects', 'apps', 'assistant']);
    expect(await columnOrder('aside')).toEqual(['card:payroll', 'card:calling-assistant', 'shopping', 'finance', 'updates']);
    for (const name of CARDS) {
      const text = await card(name).innerText();
      expect(text).toContain('Reported items'); expect(text).toContain(`Update from ${name}`); expect(text).toContain('A synthetic owner-provided detail.'); expect(text).toMatch(/As of /);
      expect(await card(name).locator('.card-tile strong').innerText()).toBe('2');
      expect(probeCalls()).toContain(`GET /fixture/probe/${name}`);
    }
    expect(await card('email-summarizer').locator('.panel-kicker').textContent()).toBe('OFFICE · EMAIL');
    expect(await card('email-summarizer').locator('h2').textContent()).toBe('Today');
    expect(await card('email-summarizer').locator('button[data-action="tool"]').getAttribute('data-tool')).toBe('tool-email-myday');
    expect(await card('capture-crm').locator('button[data-action="tool"]').getAttribute('data-tool')).toBe('tool-federal-home');
    expect(await card('calling-assistant').locator('button[data-action="tool"]').textContent()).toBe('Open Calling');
    expect(await card('payroll').locator('button[data-action="tool"]').getAttribute('data-tool')).toBe('tool-payroll-home');
    // The four leading cards share the two-up grid; the aside stacks.
    expect(await page.locator('.main-column > .card-grid > [data-card]').count()).toBe(4);
    expect(await page.locator('.aside-column .card-grid').count()).toBe(0);
    expect(await page.locator('[data-module="shopping"] h2').textContent()).toBe('Your lists');
    // The Little Monsters calendar module left the Business front page; the Team calendar page keeps it.
    expect(await page.locator('[data-module="calendar"]').count()).toBe(0);
    await page.locator('[data-action="page"][data-page="calendar"]').click();
    await page.waitForSelector('[data-module="calendar"]');
    expect(await page.locator('[data-module="calendar"]').count()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('an application outside the caller’s plan or not installed gets no card and no request; a refusal shows its status and nothing in its place', async () => {
    installAssemblyHosts(fixture.state); installFrontPageHosts(fixture.state);
    const crm = fixture.state.apps.find(a => a.summary.name === 'capture-crm')!;
    crm.plan = null;                                                                          // installed, not admitted to this caller
    fixture.state.apps = fixture.state.apps.filter(a => a.summary.name !== 'calling-assistant');   // not installed at all
    fixture.state.status['probe:payroll'] = 403; fixture.state.status['probe:calendar'] = 503;
    await open('company', '[data-card="payroll"]');
    expect(await columnOrder('main')).toEqual(['card:email-summarizer', 'card:calendar', 'card:presentations', 'projects', 'apps', 'assistant']);
    expect(await columnOrder('aside')).toEqual(['card:payroll', 'shopping', 'finance', 'updates']);
    expect(await card('capture-crm').count()).toBe(0); expect(await card('calling-assistant').count()).toBe(0);
    expect(probeCalls()).not.toContain('GET /fixture/probe/capture-crm'); expect(probeCalls()).not.toContain('GET /fixture/probe/calling-assistant');
    const payroll = await card('payroll').innerText();
    expect(payroll).toContain('Not available to you (HTTP 403). Nothing is shown in its place.');
    expect(payroll).not.toContain('Reported items');
    expect(await card('payroll').locator('.card-tile').count()).toBe(0);
    expect(await card('calendar').innerText()).toContain('Unavailable right now (HTTP 503). Nothing is shown in its place.');
    // A refused card still offers its way in: the admitted tool is a fact of the profile, not of the probe.
    expect(await card('payroll').locator('button[data-action="tool"]').count()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('a card’s action opens the hosted tool in place with the company view; without an admitted tool it links to the application', async () => {
    installAssemblyHosts(fixture.state); installFrontPageHosts(fixture.state);
    // Admitted to Calendar, but its profile lists no surface for this caller: the named tool is not admitted.
    (fixture.state as unknown as { assembly: { ribbons: Record<string, unknown[]> } }).assembly.ribbons.calendar = [];
    await open('company', '[data-card="capture-crm"] .card-tile');
    const fallback = card('calendar').locator('a.text-button');
    expect(await fallback.textContent()).toBe('Open Synthetic calendar ↗');
    expect(await fallback.getAttribute('href')).toBe('/cockpit/?app=calendar');
    expect(await card('calendar').locator('button[data-action="tool"]').count()).toBe(0);
    await card('capture-crm').locator('button[data-action="tool"]').click();
    await page.waitForSelector('#tool-frame');
    expect(await page.locator('#tool-frame').getAttribute('src')).toBe('/fixture/surface/federal-home?audience=company');
    expect(await page.locator('.breadcrumb').textContent()).toContain('Synthetic Home');
    expect(await page.locator('[data-module="card"]').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('the About dialog names each card’s application and the status its own probe answered', async () => {
    installAssemblyHosts(fixture.state); installFrontPageHosts(fixture.state);
    fixture.state.status['probe:payroll'] = 403;
    await open('company', '[data-card="capture-crm"] .card-tile');
    await page.locator('button[data-action="about"]').click();
    const text = await page.locator('#homebase-dialog').innerText();
    expect(text).toContain('Today: Synthetic email-summarizer’s own summary probe (HTTP 200).');
    expect(text).toContain('Capture pipeline: Synthetic capture-crm’s own summary probe (HTTP 200).');
    expect(text).toContain('Payroll: Synthetic payroll’s own summary probe (not available to you).');
    expect(errors).toEqual([]);
  });
});

describe('composed front pages: Home and the classroom', () => {
  it('Home opens with the room strip, then the shared calendar, money for a parent or school for a learner and the check-ins; the list, recent documents and Family admin beside', async () => {
    installAssemblyHosts(fixture.state);
    await open('family', '[data-card="presentations"] .card-tile');
    expect(await columnOrder('main')).toEqual(['room', 'calendar', 'finance', 'locations', 'home-facts', 'apps', 'assistant']);
    expect(await columnOrder('aside')).toEqual(['shopping', 'card:presentations', 'family-admin', 'updates']);
    expect(await card('presentations').locator('h2').textContent()).toBe('Recent documents');
    expect(await card('presentations').locator('.panel-kicker').textContent()).toBe('OFFICE');
    expect(await card('presentations').locator('button[data-action="tool"]').getAttribute('data-tool')).toBe('tool-presentations-studio');
    expect(await page.locator('[data-module="shopping"] h2').textContent()).toBe('One list. Fewer texts.');
    asStudent();
    await reload('[data-module="learning"]');
    expect(await columnOrder('main')).toEqual(['room', 'calendar', 'learning', 'locations', 'home-facts', 'apps', 'assistant']);
    expect(await page.locator('[data-module="finance"]').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('the classroom front page is unchanged: classwork, then the roster for a teacher or the class calendar for a learner, the tools; the calendar or the learning card beside', async () => {
    await open('classroom', '[data-module="teacher-roster"]');
    expect(await columnOrder('main')).toEqual(['requirements', 'teacher-roster', 'apps', 'assistant']);
    expect(await columnOrder('aside')).toEqual(['calendar', 'updates']);
    expect(await page.locator('[data-module="card"]').count()).toBe(0);
    asStudent();
    await reload('[data-module="learning"]');
    expect(await columnOrder('main')).toEqual(['requirements', 'calendar', 'apps', 'assistant']);
    expect(await columnOrder('aside')).toEqual(['learning', 'updates']);
    expect(errors).toEqual([]);
  });
});
