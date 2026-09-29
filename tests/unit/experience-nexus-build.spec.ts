/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The central assistant built to the demo, in headless Chromium through the real static routes over the synthetic fixture (routes mirror the real shapes): the welcome's connected capabilities from the Google connection, Travel's provider mode and the caller's preferences (Travel asked nothing when the plan does not admit it); the idle briefing readback from live counts; the Calendar view over the caller's busy windows (free weekends highlighted, busy days dotted, refusals named, unknown never free, retry, month navigation, the opening month under a pinned clock); the Travel view (only when admitted) from free weekend to Travel's search, offer cards, nonstop / after-3pm / sort / budget filters and the honest empty state, the source line and price read, sample-offer labelling, save to this device, the fare dialog and an explicit fare watch, and the shelf listing both; text refinements that stay on the page; preferences writing the departure airport through Travel and keeping the budget on the device; the trip suggestion opening its answer on Calendar; keyboard tabs across the dynamic tab list; speech stopping when the page is hidden and the transcript opening when no voice engine exists; and a phone-width layout without horizontal scroll.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Frame parity: the study bar, rail actions, topline brand, core caption, headline, live counts in the eyebrow, privacy footer, and the swarm and sources dialogs over the live snapshot (no Travel row for a caller Travel does not admit).
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Phase-8 corrections: every case opts into the lane routes (enableNexusBuild); the readback's states, meter, progress, pause-while-away, stop, natural completion, an engine that never started and the silent-audio watchdog; the best-match line with the busy weekend left out and its filter/sort sync; the comparison across every free weekend with card filtering and per-offer dates; typed dates that overlap plans or were not read; the page's own ledger rows; the in-context titles and the composer note; the destination city; the six demo widths across the welcome and every tab; and the fixture's fall-through before opt-in.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | The preferences case also renames the assistant (brand, rail mark and page title follow) and refuses an empty name in the dialog.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { enableNexusBuild, installTravelHost, silentWav, startExperienceBrowserFixture, syntheticOffers } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

interface BuildLane {
  active: boolean;
  voice: { audioData: string };
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
  enableNexusBuild(fixture.state);
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
    await page.fill('#assistant-name', ''); await page.fill('#trip-budget', '250'); await page.click('#settings-form button[type="submit"]');
    expect(await page.locator('#settings-error').innerText()).toContain('display name of 1 to 16 characters');
    await page.fill('#assistant-name', 'Nova'); await page.fill('#home-airport', 'atl');
    await page.click('#settings-form button[type="submit"]');
    await page.waitForFunction(() => !document.getElementById('nexus-dialog'));
    expect(await page.locator('.assistant-brand strong').innerText()).toBe('NOVA');
    expect(await page.locator('.rail-logo').innerText()).toBe('n');
    expect(await page.title()).toBe('Nova / Your swarm, in conversation');
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
});

/** @description The label the page gives a Friday-to-Sunday weekend ("November 6–8", or "Oct 30 – Nov 1" across two months). */
function weekendLabel(friday: Date) {
  const sunday = new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 2);
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
  return friday.getMonth() === sunday.getMonth() ? `${month(friday)} ${friday.getDate()}–${sunday.getDate()}` : `${month(friday).slice(0, 3)} ${friday.getDate()} – ${month(sunday).slice(0, 3)} ${sunday.getDate()}`;
}
const dayLabel = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const readbackStatus = () => page.locator('.readback-status').innerText();
const readbackVar = (name: string) => page.locator('.readback').evaluate((e, n) => (e as HTMLElement).style.getPropertyValue(n), name);
const ledgerRow = (name: string) => page.locator('.ledger-step').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

describe('Phase-8 corrections: the readback follows the demo\'s rules', () => {
  it('marks the readback speaking, keeps the meter at zero with motion off, pauses while away, stops on Stop, and completes on a natural end with progress', async () => {
    await open();
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('BROWSER VOICE'));
    expect(await page.locator('.readback').getAttribute('data-state')).toBe('speaking'); expect(await readbackStatus()).toContain('VISUAL MOTION IS OFF');
    await page.waitForTimeout(300);
    expect(await readbackVar('--voice-level')).toBe('0.000');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent === 'PAUSED WHILE AWAY · PRESS PLAY TO RESTART');
    expect(await page.locator('.readback').getAttribute('data-state')).toBe('idle');
    expect(await page.locator('.readback').getAttribute('data-outcome')).toBe('away');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); });
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback')?.getAttribute('data-state') === 'speaking');
    await page.locator('.readback-button').click();
    expect(await readbackStatus()).toBe('STOPPED · READY WHEN YOU ARE');
    expect(await page.locator('.readback-button').innerText()).toBe('▶ Play briefing');
    // An engine that reports boundaries and ends: progress moves, then the status says the readback completed and the meter rests.
    await page.evaluate(() => {
      Object.defineProperty(window, 'speechSynthesis', { value: { speak(u: { onboundary: (e: { charIndex: number }) => void; onend: () => void }) { setTimeout(() => u.onboundary({ charIndex: 5 }), 150); setTimeout(() => u.onend(), 600); }, cancel() {}, getVoices() { return []; } }, configurable: true });
    });
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => parseFloat((document.querySelector('.readback') as HTMLElement).style.getPropertyValue('--readback-progress')) > 0);
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent === 'READBACK COMPLETE · READY WHEN YOU ARE');
    expect(await readbackVar('--readback-progress')).toBe('0.000');
    expect(await page.locator('.readback').getAttribute('data-outcome')).toBe('complete');
    expect(errors).toEqual([]);
  });

  it('moves the meter with the voice when motion is on, and reports an engine that never started', async () => {
    await open();
    await page.click('[data-action="motion"]');
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => parseFloat((document.querySelector('.readback') as HTMLElement).style.getPropertyValue('--voice-level')) > 0);
    expect(await readbackStatus()).not.toContain('VISUAL MOTION IS OFF');
    await page.locator('.readback-button').click();
    await page.evaluate(() => { Object.defineProperty(window, 'speechSynthesis', { value: { speak() { throw new Error('synthetic: engine refused'); }, cancel() {}, getVoices() { return []; } }, configurable: true }); });
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent === 'AUDIO DID NOT START · PRESS PLAY TO RETRY');
    expect(await page.locator('.readback').getAttribute('data-state')).toBe('idle');
    expect(errors).toEqual([]);
  });

  it('reports swarm audio that stays silent as not started (the start watchdog)', async () => {
    lane().voice.audioData = silentWav(14);
    await open();
    await page.locator('.readback-button').click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent === 'AUDIO DID NOT START · PRESS PLAY TO RETRY', null, { timeout: 15000 });
    expect(fixture.state.calls.filter(c => c === 'POST /api/voice/synthesize').length).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('Phase-8 corrections: recommendation, comparison, fit, ledger, titles and widths', () => {
  it('recommends from the offers as they stand, names the busy weekend left out, and follows the filters and sort', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please'); await searchFirstWeekend();
    const rec = page.locator('[data-part="recommendation"]');
    expect(await rec.getAttribute('data-fit')).toBe('free');
    expect(await rec.innerText()).toContain(`${weekendLabel(plan.fridays[0])} looks like a good place to start`);
    expect(await rec.innerText()).toContain('the lowest matching fare is $218 round trip with 1 stop');
    expect(await rec.innerText()).toContain(`Left out ${weekendLabel(plan.busyFriday)} because your calendar has plans`);
    await page.check('#nonstop');
    expect(await rec.innerText()).toContain('$318 round trip, nonstop'); expect(await rec.innerText()).toContain('Kept nonstop offers');
    await page.uncheck('#nonstop'); await page.selectOption('#sort', 'duration');
    expect(await rec.innerText()).toContain('the shortest matching journey is $318 round trip, nonstop');
    await page.getByRole('tab', { name: 'Overview' }).click();
    expect(await page.locator('[data-part="plan-recommendation"]').innerText()).toContain('looks like a good place to start');
    expect(await page.locator('.workspace-title strong').innerText()).toBe('Flights please');
    expect(errors).toEqual([]);
  });

  it('compares every free weekend at once, lets the cards filter the merged offers, and keeps each offer on its own dates', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please');
    await page.getByRole('tab', { name: 'Calendar' }).click(); await toNextMonth();
    await page.getByRole('tab', { name: 'Travel' }).click(); await page.waitForSelector('.weekend-card');
    const button = page.locator('[data-action="compare-weekends"]');
    expect(await button.innerText()).toBe(plan.free.length === 2 ? 'Compare both free weekends' : `Compare all ${plan.free.length} free weekends`);
    await page.fill('#trip-destination', 'las');
    await button.click();
    await page.waitForSelector('.flight');
    expect(lane().travel.searches.map(s => s.departDate)).toEqual(plan.free);
    expect(await page.locator('.flight').count()).toBe(5);
    const first = page.locator('.flight').first();
    expect(await first.locator('.weekend-tag').innerText()).toBe(weekendLabel(plan.fridays[0]));
    expect(await first.innerText()).toContain('$218');
    expect(await page.locator('.trip-hero p').innerText()).toContain(`${plan.free.length} free weekends in ${new Date(plan.y, plan.m, 1).toLocaleDateString('en-US', { month: 'long' })}`);
    expect(await page.locator('[data-part="offers-source"]').innerText()).toContain(`One search per free weekend (${plan.free.length})`);
    expect(await page.locator('[data-part="recommendation"]').innerText()).toContain(`${weekendLabel(plan.fridays[0])} looks like a good place to start`);
    const second = plan.free[1], secondLabel = weekendLabel(new Date(`${second}T00:00:00`));
    await page.locator(`.weekend-card[data-week="${second}"]`).click();
    expect(await cardIds()).toEqual(['syn-c', 'syn-a', 'syn-d', 'syn-b'].map(id => `${second}/${id}`));
    expect(await page.locator('.weekend-tag').allInnerTexts()).toEqual([secondLabel, secondLabel, secondLabel, secondLabel]);
    await page.locator(`[data-action="fare"][data-fare="${second}/syn-b"]`).click();
    expect(await page.locator('[data-part="fare-detail"]').innerText()).toContain(`Outbound ${dayLabel(second)}`);
    await page.click('[data-action="close"]');
    await page.click('[data-action="save-best"]');
    await page.waitForFunction(() => document.getElementById('notice')?.textContent?.includes('Saved on this device'));
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('oshal-experience:nexus:shortlist') || '[]'))[0]).toMatchObject({ id: `${second}/syn-c`, departDate: second, price: 218 });
    await page.click('[data-action="all-weeks"]');
    expect(await page.locator('.flight').count()).toBe(5);
    expect(lane().travel.searches.length).toBe(plan.free.length);
    expect(errors).toEqual([]);
  });

  it('says when typed dates overlap plans or were not read, and never recommends them as a free weekend', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please');
    await page.getByRole('tab', { name: 'Calendar' }).click(); await toNextMonth();
    await page.getByRole('tab', { name: 'Travel' }).click(); await page.waitForSelector('.weekend-card');
    await page.fill('#trip-destination', 'las'); await page.fill('#trip-depart', key(plan.busyFriday)); await page.fill('#trip-return', plan.busySaturday);
    await page.click('#trip-form button[type="submit"]'); await page.waitForSelector('.flight');
    expect(await page.locator('[data-part="fit"]').getAttribute('data-fit')).toBe('busy');
    const rec = page.locator('[data-part="recommendation"]');
    expect(await rec.getAttribute('data-fit')).toBe('busy');
    expect(await rec.innerText()).toContain('overlaps plans in your calendar'); expect(await rec.innerText()).not.toContain('good place to start');
    const far = new Date(plan.y, plan.m + 2, 15), farBack = new Date(plan.y, plan.m + 2, 17);
    await page.fill('#trip-depart', key(far)); await page.fill('#trip-return', key(farBack));
    await page.click('#trip-form button[type="submit"]');
    await page.waitForSelector('[data-part="fit"][data-fit="unknown"]');
    expect(await page.locator('[data-part="fit"]').innerText()).toContain('unknown, not free');
    expect(await rec.innerText()).toContain('unknown, not free');
    expect(errors).toEqual([]);
  });

  it('adds the page\'s own Calendar, Travel and preferences rows to the ledger, titles the in-context views, and offers the refinements in the composer note', async () => {
    installTravelHost(fixture.state);
    await open(); await answered('Flights please');
    expect(await ledgerRow('Calendar').count()).toBe(0);
    expect(await page.locator('.composer-note').innerText()).not.toContain('after 3pm');
    await searchFirstWeekend();
    expect(await ledgerRow('Calendar').innerText()).toMatch(/read at .*free weekend/);
    expect(await ledgerRow('Travel').innerText()).toContain('4 offers from 1 search · DUFFEL TEST ENVIRONMENT · NOT BOOKABLE');
    expect(await ledgerRow('Your preferences').innerText()).toContain('From PNS · 1 adult · economy · no budget');
    expect(await page.locator('.ledger-step[data-mark="done"]').count()).toBeGreaterThanOrEqual(3);
    expect(await page.locator('.workspace-title strong').innerText()).toBe('Travel / in-context app preview');
    expect(await page.locator('[data-part="travel-context"]').innerText()).toContain('Nothing is booked here');
    expect(await page.locator('.composer-note').innerText()).toContain('“after 3pm” or “nonstop”');
    await page.getByRole('tab', { name: 'Calendar' }).click();
    expect(await page.locator('.workspace-title strong').innerText()).toBe('Calendar / in-context app preview');
    lane().travel.flightsStatus = 400;
    await page.getByRole('tab', { name: 'Travel' }).click();
    await page.click('#trip-form button[type="submit"]');
    await page.waitForSelector('.empty-result[data-state="refused"]');
    expect(await ledgerRow('Travel').innerText()).toContain('Travel refused the search (HTTP 400)');
    expect(await ledgerRow('Travel').getAttribute('data-mark')).toBe('failed');
    expect(errors).toEqual([]);
  });

  it('names the destination city in the hero when Travel\'s offers carry one', async () => {
    installTravelHost(fixture.state);
    const friday = plan.fridays[0], q = { origin: 'PNS', destination: 'LAS', departDate: plan.free[0], returnDate: key(new Date(friday.getFullYear(), friday.getMonth(), friday.getDate() + 2)) };
    lane().travel.offers = syntheticOffers(q).map(o => ({ ...o, slices: o.slices.map((s, i) => ({ ...s, originCity: i ? 'Las Vegas' : 'Pensacola', destinationCity: i ? 'Pensacola' : 'Las Vegas' })) }));
    await open(); await answered('Flights please'); await searchFirstWeekend();
    expect(await page.locator('.trip-hero h2').innerText()).toBe('Las Vegas.');
    expect(await page.locator('.trip-facts').innerText()).toContain('PNS → LAS');
  });

  it('lays the welcome and every answered view out at the demo\'s six widths without horizontal scroll', async () => {
    installTravelHost(fixture.state);
    await open();
    const widths = [1440, 1024, 768, 600, 390, 320];
    const overflow = () => page.evaluate(() => {
      const limit = window.innerWidth + 1;
      if (document.documentElement.scrollWidth <= limit) return '';
      return Array.from(document.querySelectorAll('body *')).filter(e => e.getBoundingClientRect().right > limit).slice(0, 4)
        .map(e => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}:${Math.round(e.getBoundingClientRect().right)}`).join(' ');
    });
    const bad: string[] = [];
    for (const width of widths) { await page.setViewportSize({ width, height: 900 }); const o = await overflow(); if (o) bad.push(`welcome@${width}: ${o}`); }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await answered('Flights please'); await searchFirstWeekend();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['Overview', 'Calendar', 'Travel', 'Applications', 'Shelf', 'Sources']) {
        await page.getByRole('tab', { name: tab }).click();
        const o = await overflow(); if (o) bad.push(`${tab}@${width}: ${o}`);
      }
    }
    expect(bad).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('Phase-8 corrections: the fixture keeps its contract', () => {
  it('lets the lane routes fall through until a case opts in', async () => {
    const fresh = await startExperienceBrowserFixture();
    try {
      expect((await fetch(`${fresh.origin}/api/travel/config`)).status).toBe(404);
      expect((await fetch(`${fresh.origin}/api/experience/availability?timeMin=2030-03-01T00:00:00Z&timeMax=2030-04-04T00:00:00Z`)).status).toBe(404);
      expect((await fetch(`${fresh.origin}/api/voice/synthesize`, { method: 'POST' })).status).toBe(404);
      enableNexusBuild(fresh.state);
      expect((await fetch(`${fresh.origin}/api/travel/config`)).status).toBe(200);
      expect((await fetch(`${fresh.origin}/api/voice/synthesize`, { method: 'POST' })).status).toBe(404);
    } finally { await fresh.close(); }
  });
});
