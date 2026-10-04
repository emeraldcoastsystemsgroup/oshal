/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The design study's pages and choices built into /homebase, in headless Chromium over the real static routes and the synthetic swarm: Routines (Jarvis briefing sources switched through the route with its own header and reverted on a refusal, the caller's schedules in words with pause and resume, a routine asked of Jarvis and the schedules read again, refusals named), search in this home (what the page read plus the caller-scoped swarm search, deep links only where the route gives one, refusal named, a result opening its record), the Room / Tasks / Files tabs, the day-by-day agenda with a read-only event dialog beside the unchanged Add dialog, the assistant bubble and inline composer on the same Jarvis thread with the catch-up dismissed on this device, the "Make it yours" choices (what greets you, what stays close at hand; device-local, no server write) and six viewport widths per preset with no horizontal overflow.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Guards for paths the design study lists that were built earlier without a browser case: + Add posting a personal Little Monsters event (title kept as typed, day and time); the display choices (compact density, the activity panel and the week strip hidden) saved on this device, surviving a reload and restored; the My access and About access dialogs, a sidebar application's dialog with its summary, and All applications. A notice shown before the repaint that follows it (the added event) is still shown after it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | The access dialog names the preset's own space since #1042: Business reads "The same workspace, different access", and a family and a classroom case pin "home" and "classroom" (the regression test #1042 shipped without).
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Use operational panel labels in existing behavior checks; retain actual application data, interactions and caller-context assertions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { homeBuildState, installAssemblyHosts, startExperienceBrowserFixture, type HomeBuildState } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
let home: HomeBuildState;
const errors: string[] = [];
const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
/** @description A context over the fixture only, speech stubbed, at one viewport width. */
async function openContext(width = 1440) {
  context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {}, cancel() {}, getVoices() { return []; } }, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function SpeechSynthesisUtterance() {}, configurable: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
}
beforeEach(async () => { fixture = await startExperienceBrowserFixture(); home = homeBuildState(fixture.state); await openContext(); });
afterEach(async () => { await context?.close(); await fixture?.close(); });

async function open(preset: string, ready: string) { await page.goto(`${fixture.origin}/homebase?preset=${preset}`); await page.waitForSelector(ready); await page.waitForLoadState('networkidle'); }
const moduleText = (name: string) => page.locator(`[data-module="${name}"]`).first().innerText();
const dialogText = () => page.locator('#homebase-dialog').innerText();
const toastHas = (text: string) => page.waitForFunction(t => document.getElementById('toast')?.textContent?.includes(t), text);
const nav = (label: string) => page.locator('.side-nav').getByRole('button', { name: label });
/** @description The main column's module order (the same reading the front-page spec uses). */
const mainOrder = () => page.locator('.main-column').evaluate(col => Array.from(col.children).flatMap(el => el.classList.contains('card-grid') ? Array.from(el.children) : [el])
  .map(el => (el as HTMLElement).dataset.card ? `card:${(el as HTMLElement).dataset.card}` : (el as HTMLElement).dataset.module || (el.querySelector('.section-heading') ? 'apps' : el.classList.contains('assistant') ? 'assistant' : el.className)));

describe('Routines', () => {
  it('lists briefing sources and the caller’s schedules in words; a briefing switch goes through the route and a refusal reverts it', async () => {
    home.schedules.push({ id: 'sch-1', taskType: 'jarvis-reminder', cron: '30 8 * * 6', taskData: { prompt: 'Prepare a synthetic weekend brief' }, status: 'active', nextRunAt: iso(26 * HOUR) },
      { id: 'sch-2', taskType: 'jarvis-reminder', cron: '0 8 * * 1-5', taskData: { prompt: 'Check the synthetic markets' }, status: 'paused', nextRunAt: null, once: true });
    await open('family', '.home-shell');
    await nav('Routines').click();
    await page.waitForSelector('[data-schedule="sch-1"]');
    const text = await moduleText('routines');
    expect(text).toMatch(/Briefings[\s\S]*Synthetic morning brief[\s\S]*A synthetic briefing source\. · daily · by bubble/);
    const nextRun = await page.evaluate(v => new Date(v).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), home.schedules[0].nextRunAt as string);
    expect(text).toContain('Every Saturday at 8:30 AM · next ' + nextRun);
    expect(text).toMatch(/Check the synthetic markets[\s\S]*Weekdays at 8:00 AM · paused · once/);
    fixture.state.status['home:briefing-put'] = 403;
    await page.locator('[data-briefing="synthetic-morning"]').click();
    await toastHas('Could not change Synthetic morning brief (HTTP 403: briefing_access_denied)');
    expect(await page.locator('[data-briefing="synthetic-morning"]').isChecked()).toBe(false);
    delete fixture.state.status['home:briefing-put'];
    await page.locator('[data-briefing="synthetic-morning"]').click();
    await toastHas('Synthetic morning brief is on.');
    expect(home.briefings[0].preference).toEqual({ enabled: true, frequency: 'daily', channel: 'bubble' });
    expect(await page.locator('[data-briefing="synthetic-morning"]').isChecked()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('pauses and resumes a schedule through its owner-checked route and names a refusal', async () => {
    home.schedules.push({ id: 'sch-1', taskType: 'jarvis-reminder', cron: '0 7 * * *', taskData: { prompt: 'Synthetic wake-up' }, status: 'active', nextRunAt: iso(HOUR) });
    await open('family', '.home-shell'); await nav('Routines').click(); await page.waitForSelector('[data-schedule="sch-1"]');
    fixture.state.status['home:schedule-toggle'] = 404;
    await page.locator('[data-schedule="sch-1"] button').click();
    await toastHas('Could not pause that schedule (HTTP 404: Synthetic schedule refusal)');
    delete fixture.state.status['home:schedule-toggle'];
    await page.locator('[data-schedule="sch-1"] button').click();
    await toastHas('Paused');
    await page.waitForFunction(() => document.querySelector('[data-schedule="sch-1"]')?.textContent?.includes('paused'));
    await page.locator('[data-schedule="sch-1"] button', { hasText: 'Resume' }).click();
    await toastHas('Resumed.');
    expect(home.writes.filter(w => w.startsWith('schedule'))).toEqual(['schedule pause sch-1', 'schedule pause sch-1', 'schedule resume sch-1']);
  });

  it('asks Jarvis for a routine in words and reads the schedules again; unreadable sources are named', async () => {
    await open('family', '.home-shell'); await nav('Routines').click(); await page.waitForSelector('#routine-input');
    const before = fixture.state.calls.filter(c => c === 'GET /api/v1/agent/schedules').length;
    await page.fill('#routine-input', 'Every Saturday at 8:30, prepare a weekend brief'); await page.press('#routine-input', 'Enter');
    await toastHas('Jarvis answered; your schedules were read again.');
    expect(fixture.state.asks.map(a => a.message)).toEqual(['Every Saturday at 8:30, prepare a weekend brief']);
    expect(fixture.state.calls.filter(c => c === 'GET /api/v1/agent/schedules').length).toBe(before + 1);
    expect(await page.locator('[data-bubble="reply"]').innerText()).toContain('Synthetic answer');
    fixture.state.status['home:briefings'] = 503; fixture.state.status['home:schedules'] = 500;
    await page.reload(); await page.waitForSelector('.home-shell'); await nav('Routines').click();
    await page.waitForFunction(() => document.querySelector('[data-module="routines"]')?.textContent?.includes('HTTP 500'));
    const text = await moduleText('routines');
    expect(text).toContain('Your briefings could not be read (HTTP 503: briefings_unavailable).');
    expect(text).toContain('Your schedules could not be read (HTTP 500: Synthetic schedules unavailable).');
  });
});

describe('search, tabs and the calendar', () => {
  it('searches what the home read and the caller’s own swarm; deep links only where the route gives one', async () => {
    home.hits.push({ id: 't1', title: 'Synthetic ledger review', snippet: 'A synthetic ticket', kind: 'ticket', url: '/cockpit/?ticket=t1', score: 1, source: 'tickets', ts: null },
      { id: 'c1', title: 'Synthetic ledger chunk', snippet: 'From the corpus', kind: 'doc', url: null, score: 1, source: 'rag', ts: null });
    await open('family', '.home-shell');
    await page.fill('#home-search-input', 'synthetic'); await page.press('#home-search-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('[data-module="search"]')?.textContent?.includes('Synthetic ledger chunk'));
    const text = await moduleText('search');
    expect(text).toMatch(/SEARCH IN HOME[\s\S]*For “synthetic” · only your own data/);
    expect(text).toMatch(/In this home[\s\S]*Synthetic milk[\s\S]*Shopping list/);
    expect(text).toContain('Synthetic ledger review');
    expect(await page.locator('a.search-row', { hasText: 'Synthetic ledger review' }).getAttribute('href')).toBe('/cockpit/?ticket=t1');
    expect(await page.locator('div.search-row', { hasText: 'Synthetic ledger chunk' }).innerText()).toContain('no page to open');
    expect(await page.locator('.breadcrumb').innerText()).toBe('Home / Search');
    fixture.state.status['home:search'] = 500;
    await page.fill('#home-search-input', 'science'); await page.press('#home-search-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('[data-module="search"]')?.textContent?.includes('HTTP 500'));
    expect(await moduleText('search')).toContain('The swarm search could not be read (HTTP 500: search failed).');
    await page.locator('button.search-row', { hasText: 'Science circle' }).click();
    expect(await page.locator('#dialog-title').innerText()).toBe('Science circle');
    expect(errors).toEqual([]);
  });

  it('the Room, Tasks and Files tabs show the open work and classwork, and the files and drafts the caller owns', async () => {
    await open('family', '.room-tabs');
    expect(await page.locator('.room-tab').allInnerTexts()).toEqual(['Room', 'Tasks', 'Files']);
    expect(await page.locator('.room-tab[aria-current="page"]').innerText()).toBe('Room');
    await page.locator('.room-tab', { hasText: 'Tasks' }).click();
    const tasks = await moduleText('tasks');
    expect(tasks).toMatch(/Tasks[\s\S]*Work[\s\S]*Synthetic ledger review[\s\S]*Classwork[\s\S]*Observe a seed/);
    await page.locator('.room-tab', { hasText: 'Files' }).click();
    await page.waitForFunction(() => !document.getElementById('drafts-slot')?.textContent?.includes('Reading'));
    const files = await moduleText('files');
    expect(files).toMatch(/Files from your assistant[\s\S]*summary\.txt[\s\S]*Synthetic ledger: weekly picture/);
    expect(files).toContain('No Content Studio drafts saved yet.');
    expect(await page.locator('[data-module="files"] a[download]').getAttribute('href')).toBe('/api/jarvis/files/synthetic');
    await page.locator('.room-tab', { hasText: 'Room' }).click();
    expect(await page.locator('[data-module="room"]').count()).toBe(1);
    await page.locator('[data-module="shopping"]').getByRole('button', { name: 'View list' }).click();
    expect(await page.locator('.breadcrumb').innerText()).toBe('Home / Shopping list');
    expect(await page.locator('.aside-column [data-module="locations"]').count()).toBe(1);
    expect(await page.locator('.room-tabs').count()).toBe(1);
    await open('company', '.home-shell');
    expect(await page.locator('.room-tabs').count()).toBe(0);
  });

  it('the Calendar page adds the day-by-day agenda; an event opens its details and + Add still adds a moment', async () => {
    await open('family', '.home-shell');
    await page.locator('[data-module="calendar"]').getByRole('button', { name: 'View all' }).click();
    expect(await page.locator('.breadcrumb').innerText()).toBe('Home / Calendar');
    expect(await page.locator('[data-module="calendar"] [data-page="calendar"]').count()).toBe(0);
    const agenda = await moduleText('agenda');
    expect(agenda).toMatch(/Upcoming schedule[\s\S]*Today[\s\S]*9:00[\s\S]*Science circle[\s\S]*Synthetic Science/);
    await page.locator('[data-module="agenda"] [data-action="event-detail"]').first().click();
    const detail = await dialogText();
    expect(detail).toMatch(/When[\s\S]*Today · 9:00[\s\S]*Class[\s\S]*Synthetic Science · Science[\s\S]*Kind[\s\S]*lecture/);
    expect(detail).toContain('offers no way to move an event from here');
    await page.keyboard.press('Escape');
    expect(await page.locator('#homebase-dialog').count()).toBe(0);
    await page.locator('[data-module="calendar"] [data-action="event"]').click();
    expect(await page.locator('#dialog-title').innerText()).toBe('Add a shared moment');
  });
});

describe('the existing calendar and display paths the design study lists', () => {
  it('+ Add posts a personal event to Little Monsters with its title, day and time, and says so', async () => {
    await open('family', '[data-module="calendar"]');
    await page.locator('[data-module="calendar"] [data-action="event"]').click();
    expect(await dialogText()).toContain('This adds a personal event to your Little Monsters calendar');
    await page.fill('#event-title', 'Synthetic <i>pizza</i> night'); await page.fill('#event-time', '18:30');
    const date = await page.inputValue('#event-date');
    await page.locator('#homebase-dialog').getByRole('button', { name: 'Add event' }).click();
    // The notice is shown, then the calendar is re-read and the page repainted: the notice must still be there after it.
    await expect.poll(() => fixture.state.calls.filter(c => c === 'GET /api/education/calendar').length).toBeGreaterThanOrEqual(4);
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#toast').innerText()).toBe('Event added to your calendar.');
    expect(fixture.state.education.created).toEqual([{ title: 'Synthetic <i>pizza</i> night', eventDate: date, eventTime: '18:30', eventType: 'custom' }]);
    expect(await page.locator('#homebase-dialog').count()).toBe(0);
  });

  it('compact density, a hidden activity panel and a hidden week strip are saved on this device, survive a reload and restore', async () => {
    await open('family', '[data-module="updates"]');
    expect(await page.locator('.week-strip').count()).toBe(1);
    await page.getByRole('button', { name: 'Configure home' }).click();
    await page.selectOption('#density-choice', 'compact');
    await page.locator('#show-updates').uncheck(); await page.locator('#show-week').uncheck();
    await page.getByRole('button', { name: 'Save on this device' }).click();
    await toastHas('Display choices saved on this device. No permissions changed.');
    const check = async () => {
      expect(await page.locator('.experience').getAttribute('data-density')).toBe('compact');
      expect(await page.locator('[data-module="updates"]').count()).toBe(0);
      expect(await page.locator('.week-strip').count()).toBe(0);
    };
    await check();
    await page.reload(); await page.waitForSelector('.home-shell'); await page.waitForLoadState('networkidle');
    await check();
    expect(await page.locator('.page-footer').innerText()).toContain('(v2)');
    await page.getByRole('button', { name: 'Configure home' }).click();
    await page.getByRole('button', { name: 'Restore previous' }).click();
    await toastHas('Previous display choices restored.');
    expect(await page.locator('.experience').getAttribute('data-density')).toBe('comfortable');
    expect(await page.locator('[data-module="updates"]').count()).toBe(1);
    expect(await page.locator('.week-strip').count()).toBe(1);
  });
});

describe('the access and application dialogs', () => {
  it('“My access” and “About access” state the boundary for the signed-in person; a sidebar application opens its own dialog with its summary', async () => {
    await open('company', '.home-shell');
    await page.getByRole('button', { name: 'My access' }).click();
    const policy = await dialogText();
    expect(policy).toContain('The same workspace, different access');
    expect(policy).toContain('Signed in as Synthetic Teacher · teacher in Little Monsters.');
    expect(policy).toContain('Skins, density and pins are saved on this device and never change permissions.');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'About access' }).click();
    expect(await dialogText()).toContain('Applications appear only when this swarm’s authorization admits you to them.');
    await page.keyboard.press('Escape');
    await page.locator('.home-sidebar [data-action="app"]').first().click();
    await page.waitForFunction(() => document.getElementById('app-summary-slot')?.textContent?.includes('Update from'));
    const appDialog = await dialogText();
    expect(appDialog).toMatch(/Isolated experience test source[\s\S]*available to you/);
    expect(await page.locator('#homebase-dialog a.button.primary').getAttribute('href')).toMatch(/^\/cockpit\/\?app=/);
    await page.keyboard.press('Escape');
    await page.locator('.home-sidebar').getByRole('button', { name: 'All applications' }).click();
    await page.waitForURL(/\/portal#catalog-directory$/);
  });
});

describe('the access dialog names each preset\'s own space', () => {
  it.each([['family', 'home'], ['classroom', 'classroom']])('“My access” on the %s preset reads “The same %s, different access”', async (preset, space) => {
    await open(preset, '.home-shell');
    await page.getByRole('button', { name: 'My access' }).click();
    expect(await dialogText()).toContain(`The same ${space}, different access`);
  });
});

describe('the assistant and the choices', () => {
  it('the inline composer asks the same Jarvis thread and the bubble shows its answer', async () => {
    await open('family', '#composer-input');
    await page.fill('#composer-input', 'What is on today?'); await page.press('#composer-input', 'Enter');
    await page.waitForSelector('[data-bubble="reply"]');
    expect(await page.locator('[data-bubble="reply"]').innerText()).toMatch(/Your home assistant[\s\S]*Latest reply[\s\S]*Synthetic answer: the ledger is ready/);
    expect(fixture.state.asks).toHaveLength(1);
    await page.locator('[data-bubble="reply"]').getByRole('button', { name: 'Open the conversation' }).click();
    expect(await dialogText()).toContain('What is on today?');
  });

  it('a catch-up of the day’s finished assistant tasks is offered once and dismissed on this device', async () => {
    await open('family', '[data-bubble="catch-up"]');
    expect(await page.locator('[data-bubble="catch-up"]').innerText()).toContain('While you were away: 1 task finished and 1 task failed.');
    await page.locator('[data-bubble="catch-up"]').getByRole('button', { name: 'Not now' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-bubble="catch-up"]'));
    await page.reload(); await page.waitForSelector('#composer-input'); await page.waitForLoadState('networkidle');
    expect(await page.locator('[data-bubble]').count()).toBe(0);
    fixture.state.tasks.push({ id: 'task-3', title: 'Synthetic new result', status: 'done', kind: 'simple', result: 'r', createdAt: iso(-60000), finishedAt: iso(-30000), files: [] });
    await page.reload(); await page.waitForSelector('[data-bubble="catch-up"]');
    expect(await page.locator('[data-bubble="catch-up"]').innerText()).toContain('2 tasks finished and 1 task failed');
    // "Waiting for me to ask": no catch-up is offered; the choice is saved on this device only.
    await page.getByRole('button', { name: 'Configure home' }).click();
    await page.selectOption('#bot-choice', 'ask');
    await page.getByRole('button', { name: 'Save on this device' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-bubble="catch-up"]'));
    await page.reload(); await page.waitForSelector('#composer-input'); await page.waitForLoadState('networkidle');
    expect(await page.locator('[data-bubble]').count()).toBe(0);
  });

  it('Display options reorders and trims the front page on this device only', async () => {
    installAssemblyHosts(fixture.state);
    await open('family', '[data-module="room"]');
    expect((await mainOrder()).slice(0, 3)).toEqual(['room', 'calendar', 'finance']);
    const before = fixture.state.calls.filter(c => !c.startsWith('GET ')).length;
    await page.locator('.room-tabs').getByRole('button', { name: 'Display options' }).click();
    await page.locator('input[name="lead-choice"][value="work"]').check();
    await page.locator('input[data-keep="room"]').uncheck();
    await page.locator('input[data-keep="shopping"]').uncheck();
    await page.getByRole('button', { name: 'Save on this device' }).click();
    await toastHas('No permissions changed');
    expect((await mainOrder()).slice(0, 3)).toEqual(['projects', 'calendar', 'finance']);
    expect(await page.locator('[data-module="room"]').count()).toBe(0);
    expect(await page.locator('.aside-column [data-module="shopping"]').count()).toBe(0);
    await page.reload(); await page.waitForSelector('.home-shell'); await page.waitForLoadState('networkidle');
    expect((await mainOrder())[0]).toBe('projects');
    expect(fixture.state.calls.filter(c => !c.startsWith('GET ')).length).toBe(before);
    await page.getByRole('button', { name: 'Configure home' }).click();
    await page.locator('input[name="lead-choice"][value="day"]').check();
    await page.getByRole('button', { name: 'Save on this device' }).click();
    expect((await mainOrder())[0]).toBe('calendar');
    await page.getByRole('button', { name: 'Configure home' }).click();
    await page.getByRole('button', { name: 'Restore previous' }).click();
    expect((await mainOrder())[0]).toBe('projects');
  });

  it('every preset fits six viewport widths with no horizontal overflow, the new modules included', async () => {
    home.tenants.push({ tenant_id: 'h1', kind: 'space', name: 'Synthetic household with a long name', role: 'admin' });
    home.members.h1 = [{ user_sub: 'synthetic-user', role: 'admin' }, { user_sub: 'other', role: 'member' }];
    for (const width of [1440, 1024, 768, 600, 390, 320]) {
      await context.close(); await openContext(width);
      for (const preset of ['family', 'classroom', 'company']) {
        await open(preset, '.home-shell');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${preset} at ${width}px`).toBeLessThanOrEqual(0);
      }
    }
    expect(errors).toEqual([]);
  });
});
