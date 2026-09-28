/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The central assistant built to the demo, in headless Chromium through the real static routes over the synthetic fixture (routes mirror the real shapes): the welcome's connected capabilities from the Google connection, Travel's provider mode and the caller's preferences (Travel asked nothing when the plan does not admit it); the idle briefing readback from live counts; the Calendar view over the caller's busy windows (free weekends highlighted, busy days dotted, refusals named, unknown never free, retry, month navigation, the opening month under a pinned clock); the Travel view (only when admitted) from free weekend to Travel's search, offer cards, nonstop / after-3pm / sort / budget filters and the honest empty state, the source line and price read, sample-offer labelling, save to this device, the fare dialog and an explicit fare watch, and the shelf listing both; text refinements that stay on the page; preferences writing the departure airport through Travel and keeping the budget on the device; the trip suggestion opening its answer on Calendar; keyboard tabs across the dynamic tab list; speech stopping when the page is hidden and the transcript opening when no voice engine exists; and a phone-width layout without horizontal scroll.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Frame parity: the study bar, rail actions, topline brand, core caption, headline, live counts in the eyebrow, privacy footer, and the swarm and sources dialogs over the live snapshot (no Travel row for a caller Travel does not admit).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { installTravelHost, startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

interface BuildLane {
  availability: { status: number; state: string; error: string; busy: Array<{ start: string; end: string }>; calls: Array<{ timeMin: string; timeMax: string }> };
  google: { status: number; connected: boolean; expired: boolean };
  travel: { configStatus: number; config: Record<string, unknown>; profile: Record<string, unknown>; profileWrites: Array<Record<string, unknown>>; profileWriteStatus: number;
    flightsStatus: number; source: string; error: string; searches: Array<Record<string, string>>; watches: Array<Record<string, unknown>>; watchStatus: number; watchPosts: Array<Record<string, unknown>> };
}
let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const errors: string[] = [];
const lane = () => (fixture.state as unknown as { nexusBuild: BuildLane }).nexusBuild;
const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** @description Next month's Fridays (local), the weekends a month grid can offer; the second one is made busy on its Saturday. */
function nextMonthPlan() {
  const now = new Date(), y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear(), m = (now.getMonth() + 1) % 12;
  const fridays: Date[] = [];
  for (let d = new Date(y, m, 1); d.getMonth() === m; d = new Date(y, m, d.getDate() + 1)) if (d.getDay() === 5) fridays.push(d);
  const busyFriday = fridays[1], sat = new Date(y, m, busyFriday.getDate() + 1);
  return { y, m, fridays, busyFriday, busySaturday: key(sat), free: fridays.filter(f => f !== busyFriday).map(key),
    busy: [{ start: new Date(y, m, sat.getDate(), 10).toISOString(), end: new Date(y, m, sat.getDate(), 12).toISOString() }] };
}
const plan = nextMonthPlan();

async function open(path = '/nexus') {
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
  await page.goto(fixture.origin + path);
  await page.waitForSelector('#intent-input');
}
async function ask(text: string) { await page.fill('#intent-input', text); await page.press('#intent-input', 'Enter'); }
const waitMode = (mode: string) => page.waitForFunction(m => document.querySelector('.mode-indicator')?.textContent === m, mode, { timeout: 20000 });
async function answered(text = 'Plan a trip for me') { await ask(text); await waitMode('LIVE ANSWER'); }
const travelCalls = () => fixture.state.calls.filter(c => c.includes('/api/travel/'));
const cardIds = () => page.locator('.flight').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.flight));
/** @description Step the Calendar to next month (it opens on this month, or on the next once no Friday is left) and wait for its read. */
async function toNextMonth() {
  const title = new Date(plan.y, plan.m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  for (let i = 0; i < 2 && (await page.locator('.cal-nav strong').innerText()) !== title; i++) await page.click('[data-action="cal-next"]');
  expect(await page.locator('.cal-nav strong').innerText()).toBe(title);
  await page.waitForFunction(() => document.querySelector('[data-part="availability"]')?.getAttribute('data-state') !== 'loading');
}
/** @description From an answered workspace: Travel tab, next month's free weekends, pick the first, name LAS, search. */
async function searchFirstWeekend() {
  await page.getByRole('tab', { name: 'Calendar' }).click(); await toNextMonth();
  await page.getByRole('tab', { name: 'Travel' }).click();
  await page.waitForSelector('.weekend-card');
  await page.locator('.weekend-card').first().click();
  await page.fill('#trip-destination', 'las');
  await page.click('#trip-form button[type="submit"]');
  await page.waitForSelector('.flight');
}

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  lane().availability.busy = plan.busy;
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {}, cancel() {}, getVoices() { return []; } }, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function SpeechSynthesisUtterance() {}, configurable: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

describe('frame regions the demo shows, over the live snapshot', () => {
  it('renders the study bar, rail, topline, core caption, headline, footer and the swarm and sources dialogs', async () => {
    await open();
    expect(await page.locator('.study-bar').innerText()).toContain('CENTRAL ASSISTANT · LIVE');
    expect(await page.locator('.rail [data-action]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.action))).toEqual(['home', 'new', 'saved', 'swarm', 'settings']);
    expect(await page.locator('.assistant-brand').innerText()).toMatch(/JARVIS[\s\S]*Your swarm, in conversation\./);
    expect(await page.locator('.orb-caption').innerText()).toBe('YOUR WORLD. CONNECTED.');
    expect(await page.locator('.welcome h1').innerText()).toMatch(/A little ambition\.[\s\S]*A whole swarm behind you\./);
    expect(await page.locator('.welcome .eyebrow').innerText()).toContain(`${fixture.state.apps.length} APPS`);
    expect(await page.locator('.privacy-line').innerText()).toContain('never saves, sends, books or schedules');
    await page.click('.rail [data-action="swarm"]');
    const swarm = await page.locator('.nexus-dialog').innerText();
    expect(swarm).toContain(`${fixture.state.apps.length} applications across`); expect(swarm).toContain('Synthetic ledger');
    expect(await page.locator('.nexus-dialog a[href="/orbit"]').count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.click('.privacy-line [data-action="sources"]');
    const sources = await page.locator('.nexus-dialog').innerText();
    expect(sources).toContain('Calendar availability'); expect(sources).toContain('Your preferences'); expect(sources).not.toContain('Travel offers');
    expect(errors).toEqual([]);
  });
});

describe('welcome: connected capabilities and the briefing', () => {
  it('shows Calendar, Travel and preferences from their own reads, and reads the briefing from live counts', async () => {
    installTravelHost(fixture.state);
    await open();
    await page.waitForFunction(() => document.querySelector('[data-capability="travel"]')?.textContent?.includes('Duffel test'));
    await page.waitForFunction(() => document.querySelector('[data-capability="preferences"]')?.textContent?.includes('From PNS'));
    expect(await page.locator('[data-capability="calendar"]').innerText()).toContain('Google connected');
    expect(await page.locator('[data-capability="calendar"]').getAttribute('data-on')).toBe('true');
    expect(await page.locator('.readback-button').innerText()).toBe('▶ Play briefing');
    const transcript = await page.locator('.readback details p').textContent();
    expect(transcript).toContain(`${fixture.state.apps.length} applications are ready and 1 of 2 assistants are online`);
    expect(transcript).toContain('Synthetic ledger review');
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('BROWSER VOICE'));
    expect(errors).toEqual([]);
  });

  it('asks Travel nothing and shows no Travel item or tab when the plan does not admit it; a missing Google connection is off', async () => {
    installTravelHost(fixture.state, false);
    lane().google.connected = false;
    await open();
    await page.waitForFunction(() => document.querySelector('[data-capability="calendar"]')?.textContent?.includes('Connect Google'));
    expect(await page.locator('[data-capability="calendar"]').getAttribute('data-on')).toBe('false');
    expect(await page.locator('[data-capability="travel"]').count()).toBe(0);
    await answered('Find me flights');
    expect(await page.getByRole('tab', { name: 'Travel' }).count()).toBe(0);
    await page.getByRole('tab', { name: 'Calendar' }).click();
    expect(travelCalls()).toEqual([]);
  });
});

describe('Calendar view over the caller\'s busy windows', () => {
  it('highlights free weekends, dots busy days and lists what fits', async () => {
    await open(); await answered();
    await page.getByRole('tab', { name: 'Calendar' }).click();
    await toNextMonth();
    const call = lane().availability.calls.at(-1)!;
    expect(new Date(call.timeMin).getTime()).toBe(new Date(plan.y, plan.m, 1).getTime());
    expect(new Date(call.timeMax).getTime()).toBe(new Date(plan.y, plan.m + 1, 4).getTime());
    expect(await page.locator(`[data-day="${plan.busySaturday}"]`).getAttribute('data-state')).toBe('busy');
    expect(await page.locator(`[data-day="${plan.busySaturday}"]`).getAttribute('class')).toContain('busy');
    for (const f of plan.free) expect(await page.locator(`[data-day="${f}"]`).getAttribute('class')).toContain('clear');
    expect(await page.locator(`[data-day="${key(plan.busyFriday)}"]`).getAttribute('class')).not.toContain('clear');
    const explainer = await page.locator('.calendar-explainer').last().innerText();
    expect(explainer).toMatch(new RegExp(`${plan.free.length === 1 ? 'One complete weekend fits' : `${plan.free.length} complete weekends fit`}`));
    expect(explainer).toContain('unknown, not free');
    expect(await page.locator('.calendar-legend').innerText()).toContain('Gold dot: busy');
    expect(errors).toEqual([]);
  });

  it('names a refusal, never marks a day free without a read, and retries a failed read', async () => {
    Object.assign(lane().availability, { status: 409, state: 'not-connected', error: 'Connect Google in Utilities with calendar access to see your availability. Until then these days are unknown, not free.' });
    await open(); await answered();
    await page.getByRole('tab', { name: 'Calendar' }).click(); await toNextMonth();
    expect(await page.locator('[data-part="availability"]').getAttribute('data-state')).toBe('not-connected');
    expect(await page.locator('[data-part="availability"] a').getAttribute('href')).toBe('/utilities');
    expect(await page.locator('.calendar-day.clear').count()).toBe(0);
    expect(await page.locator('.calendar-day[data-state="free"]').count()).toBe(0);
    Object.assign(lane().availability, { status: 502, state: 'failed', error: 'Google Calendar did not answer, so nothing is known about these days. Try again in a moment.' });
    await page.click('[data-action="cal-next"]');
    await page.waitForSelector('[data-part="availability"][data-state="failed"]');
    const before = lane().availability.calls.length;
    lane().availability.status = 200;
    await page.click('[data-action="cal-retry"]');
    await page.waitForSelector('[data-part="availability"][data-state="ready"]');
    expect(lane().availability.calls.length).toBe(before + 1);
    expect(await page.locator('[data-action="cal-prev"]').isDisabled()).toBe(false);
  });
});

describe('Calendar opening month', () => {
  it('opens on this month while a Friday is ahead in it, otherwise on the next, and never steps before this month', async () => {
    const title = () => page.locator('.cal-nav strong').innerText();
    await context.clock.setFixedTime(new Date(2030, 2, 30, 12));
    await open(); await answered();
    await page.getByRole('tab', { name: 'Calendar' }).click();
    expect(await title()).toBe('April 2030');
    await page.click('[data-action="cal-prev"]');
    expect(await title()).toBe('March 2030');
    expect(await page.locator('[data-action="cal-prev"]').isDisabled()).toBe(true);
    await context.clock.setFixedTime(new Date(2030, 2, 20, 12));
    await page.reload(); await page.waitForSelector('#intent-input'); await answered();
    await page.getByRole('tab', { name: 'Calendar' }).click();
    expect(await title()).toBe('March 2030');
    expect(await page.locator('[data-day="2030-03-19"]').getAttribute('data-state')).toBe('past');
  });
});

describe('Travel view (admitted callers only)', () => {
  it('turns a free weekend into Travel\'s search and shows its offers, source and price read', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Find cheap flights to Vegas on a free weekend');
    await page.getByRole('tab', { name: 'Travel' }).click();
    expect(await page.locator('.trip-hero h2').innerText()).toBe('Where to?');
    expect(await page.inputValue('#trip-origin')).toBe('PNS');
    await searchFirstWeekend();
    const q = lane().travel.searches.at(-1)!;
    expect(q).toMatchObject({ origin: 'PNS', destination: 'LAS', departDate: plan.free[0], pax: '1', cabin: 'economy' });
    expect(q.returnDate).toBe(key(new Date(plan.fridays[0].getFullYear(), plan.fridays[0].getMonth(), plan.fridays[0].getDate() + 2)));
    expect(await page.locator('.trip-hero h2').innerText()).toBe('LAS.');
    expect(await cardIds()).toEqual(['syn-c', 'syn-a', 'syn-d', 'syn-b']);
    expect(await page.locator('.flight').first().innerText()).toMatch(/2:10 PM[\s\S]*1 stop · 6h 12m outbound[\s\S]*Synthetic Air C[\s\S]*\$218[\s\S]*Round trip/);
    const source = page.locator('[data-part="offers-source"]');
    expect(await source.innerText()).toContain('DUFFEL TEST ENVIRONMENT · NOT BOOKABLE');
    expect(await source.innerText()).toContain('Typical price — around the recent average ($260)');
    expect(await page.locator('.work-actions a.primary').getAttribute('href')).toBe('/cockpit/?app=travel');
    expect(errors).toEqual([]);
  });

  it('filters and sorts the offers locally, with an honest empty state and a way back', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please'); await searchFirstWeekend();
    const searches = lane().travel.searches.length;
    await page.check('#nonstop'); expect(await cardIds()).toEqual(['syn-b']);
    await page.check('#late');
    expect(await page.locator('.empty-result').innerText()).toContain('No offers match these filters. 4 came back from Travel.');
    await page.click('[data-action="clear-filters"]'); expect(await cardIds()).toEqual(['syn-c', 'syn-a', 'syn-d', 'syn-b']);
    await page.check('#late'); expect(await cardIds()).toEqual(['syn-a', 'syn-d']);
    await page.uncheck('#late'); await page.selectOption('#sort', 'duration');
    expect(await cardIds()).toEqual(['syn-b', 'syn-d', 'syn-a', 'syn-c']);
    expect(lane().travel.searches.length).toBe(searches);
  });

  it('saves an option on this device, opens its fare dialog, watches the route through Travel and lists both on the shelf', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please'); await searchFirstWeekend();
    await page.click('[data-action="save-best"]');
    await page.waitForFunction(() => document.getElementById('notice')?.textContent?.includes('Saved on this device'));
    await page.locator('[data-action="fare"][data-fare="syn-b"]').click();
    const detail = await page.locator('[data-part="fare-detail"]').innerText();
    expect(detail).toMatch(/PNS → LAS · Synthetic Air B[\s\S]*Outbound[\s\S]*1:15 PM[\s\S]*nonstop[\s\S]*Return[\s\S]*\$318 round trip/);
    expect(await page.locator('.nexus-dialog').innerText()).toContain('expires');
    await page.click('[data-action="watch-offer"]');
    await page.waitForFunction(() => document.querySelector('[data-part="watch-note"]')?.textContent?.includes('Watching'));
    expect(lane().travel.watchPosts.at(-1)).toMatchObject({ kind: 'flight', origin: 'PNS', destination: 'LAS', departDate: plan.free[0], lastPrice: 318 });
    await page.click('[data-action="close"]');
    await page.click('.rail [data-action="saved"]');
    await page.waitForFunction(() => document.querySelector('[data-part="trip-watches"]')?.textContent?.includes('flight:PNS-LAS'));
    const shelf = await page.locator('.nexus-dialog').innerText();
    expect(shelf).toContain('Synthetic Air C · $218'); expect(shelf).toContain('Saved on this device only. Not a reservation');
    await page.click('[data-action="resume-trip"]');
    expect(await page.getByRole('tab', { name: 'Travel' }).getAttribute('aria-selected')).toBe('true');
  });

  it('labels Travel\'s sample offers, offers no watch on them, and shows a refused search as refused', async () => {
    installTravelHost(fixture.state);
    lane().travel.source = 'demo';
    await open(); await answered('Flights please'); await searchFirstWeekend();
    expect(await page.locator('[data-part="offers-source"]').innerText()).toContain('SAMPLE OFFERS FROM TRAVEL · NOT QUOTES');
    expect(await page.locator('.flight').first().innerText()).toContain('sample offer');
    await page.locator('[data-action="fare"]').first().click();
    expect(await page.locator('[data-action="watch-offer"]').count()).toBe(0);
    await page.click('[data-action="close"]');
    lane().travel.flightsStatus = 400;
    await page.click('#trip-form button[type="submit"]');
    await page.waitForSelector('.empty-result[data-state="refused"]');
    expect(await page.locator('.empty-result').innerText()).toContain('Travel refused the search (HTTP 400)');
    await page.fill('#trip-destination', 'PN');
    await page.click('#trip-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('.empty-result')?.textContent?.includes('three-letter airport codes'));
  });
});

describe('refinements, preferences, suggestion, keyboard and voice', () => {
  it('keeps "after 3pm", "nonstop" and "calendar" on the page and sends a real question to Jarvis', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please'); await searchFirstWeekend();
    const asks = fixture.state.asks.length;
    await page.fill('#intent-input', 'after 3pm'); await page.press('#intent-input', 'Enter');
    expect(await cardIds()).toEqual(['syn-a', 'syn-d']);
    expect(await page.locator('#notice').innerText()).toContain('nothing new was searched');
    await page.fill('#intent-input', 'calendar'); await page.press('#intent-input', 'Enter');
    expect(await page.getByRole('tab', { name: 'Calendar' }).getAttribute('aria-selected')).toBe('true');
    expect(fixture.state.asks.length).toBe(asks);
    await ask('What else should I pack for a desert weekend?');
    await waitMode('LIVE ANSWER');
    expect(fixture.state.asks.length).toBe(asks + 1);
  });

  it('writes the departure airport through Travel, keeps the budget on this device, and refuses a bad budget in the dialog', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please'); await searchFirstWeekend();
    await page.click('.top-options [data-action="settings"]');
    await page.fill('#trip-budget', '10'); await page.click('#settings-form button[type="submit"]');
    expect(await page.locator('#settings-error').innerText()).toContain('from 50 to 20000');
    await page.fill('#trip-budget', '250'); await page.fill('#home-airport', 'atl');
    await page.click('#settings-form button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('nexus-dialog'));
    expect(lane().travel.profileWrites).toEqual([{ homeAirport: 'ATL' }]);
    expect(await page.evaluate(() => localStorage.getItem('oshal-experience:nexus:budget'))).toBe('250');
    await page.getByRole('tab', { name: 'Travel' }).click();
    expect(await cardIds()).toEqual(['syn-c', 'syn-a']);
    expect(await page.locator('.trip-facts').innerText()).toContain('Up to $250 USD');
  });

  it('opens the trip suggestion\'s answer on Calendar, offers the trip views in the answer and moves between tabs by keyboard', async () => {
    installTravelHost(fixture.state);
    await open();
    await page.getByRole('button', { name: /Find a free weekend to get away/ }).click();
    await waitMode('LIVE ANSWER');
    expect(await page.getByRole('tab', { name: 'Calendar' }).getAttribute('aria-selected')).toBe('true');
    expect(fixture.state.asks.at(-1)!.message).toContain('free weekend');
    await page.getByRole('tab', { name: 'Overview' }).click();
    expect(await page.locator('[data-part="plan"]').innerText()).toContain('Compare flights in Travel');
    await page.getByRole('tab', { name: 'Overview' }).focus();
    const names: string[] = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowRight'); names.push(await page.locator('[role="tab"][aria-selected="true"]').innerText()); }
    expect(names).toEqual(['Calendar', 'Travel', 'Applications', 'Shelf', 'Sources', 'Overview']);
    await page.keyboard.press('End');
    expect(await page.locator('[role="tab"][aria-selected="true"]').innerText()).toBe('Sources');
    const sources = await page.locator('.workspace-body').innerText();
    expect(sources).toContain('Calendar availability'); expect(sources).toContain('Travel offers'); expect(sources).toContain('Departure airport PNS from your Travel profile');
  });

  it('stops speaking when the page is hidden and opens the transcript when no voice engine exists', async () => {
    await open();
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('BROWSER VOICE'));
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('PRESS PLAY'));
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true }); });
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('TRANSCRIPT BELOW'), null, { timeout: 8000 });
    expect(await page.locator('.readback details').evaluate(d => (d as HTMLDetailsElement).open)).toBe(true);
  });

  it('lays the Travel view out at phone width without horizontal scroll', async () => {
    installTravelHost(fixture.state);
    await page.setViewportSize({ width: 390, height: 900 });
    await open(); await answered('Flights please'); await searchFirstWeekend();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
});
