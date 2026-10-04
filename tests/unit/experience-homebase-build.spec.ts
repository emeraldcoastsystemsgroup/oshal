/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The design study's Home, classroom and learner pieces built into /homebase, in headless Chromium over the real static routes and the synthetic swarm (fixture routes shaped like the real ones): the opt-in check-in panel from ADR-169 location state (the caller's own place and age, household members with nothing shown, who can see the caller, the "share from this browser" switch that stops this browser's device and opens Settings, Location to turn on, refusals by the route's own message, nothing asked outside Home), the household group (people, roles, the directory's names only, the workspace label, badge and breadcrumb, People & roles with household creation and its refusal, Devices with stop reporting), the room strip, a learner's level and XP from Little Monsters' own dashboard (not asked for a teacher, not asked outside the classroom before the probe gate), the classwork due pill, the family learner's greeting, and unread Little Monsters notices with mark read.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Assert the approved operational class-updates heading while preserving unread notice and mark-read behavior.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Use operational panel labels in existing behavior checks; retain actual application data, interactions and caller-context assertions.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Click the refused check-in switch and assert its restored state; the expected immediate refusal can restore it before Playwright's uncheck postcondition.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { homeBuildState, startExperienceBrowserFixture, type HomeBuildState } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 120000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
let home: HomeBuildState;
const errors: string[] = [];
const now = () => new Date().toISOString();

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  home = homeBuildState(fixture.state);
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

/** @description Open one preset and wait until its live sources have answered. */
async function open(preset: string, ready: string) { await page.goto(`${fixture.origin}/homebase?preset=${preset}`); await page.waitForSelector(ready); await page.waitForLoadState('networkidle'); }
const moduleText = (name: string) => page.locator(`[data-module="${name}"]`).first().innerText();
const dialogText = () => page.locator('#homebase-dialog').innerText();
const toastHas = (text: string) => page.waitForFunction(t => document.getElementById('toast')?.textContent?.includes(t), text);
const calls = (prefix: string) => fixture.state.calls.filter(c => c.startsWith(prefix));
/** @description A household of three: the caller (admin), a member the directory names and one it does not. */
function household() {
  home.tenants.push({ tenant_id: 'h1', kind: 'space', name: 'Synthetic household', role: 'admin' });
  home.members.h1 = [{ user_sub: 'synthetic-user', role: 'admin' }, { user_sub: 'other', role: 'member' }, { user_sub: 'unnamed', role: 'member' }];
}
/** @description This browser opted in (its id stored where Settings, Location stores it) with a current place 8 minutes old. */
async function reportingHere() {
  home.location.devices.push({ deviceId: 'dev-1', kind: 'browser', reportingEnabled: true, precisionClass: 'block', lastSeenAt: now(), createdAt: now() });
  home.location.current = { deviceId: 'dev-1', source: 'browser', precisionClass: 'block', accuracyM: 50, receivedAt: now(), ageSeconds: 480, place: { placeId: 'p1', name: 'Synthetic home place', label: 'home' } };
  await context.addInitScript(() => { localStorage.setItem('oshal.location.browserDeviceId', 'dev-1'); });
}

describe('opt-in check-ins (ADR-169 location state)', () => {
  it('shows the caller’s own place and age, household members with nothing shown, and who can see the caller', async () => {
    household(); await reportingHere();
    home.location.visibility.memberShares.push({ shareId: 's1', groupName: 'Synthetic household', placeCount: 2, active: true });
    await open('family', '[data-module="locations"] [data-person="me"]');
    const panel = await moduleText('locations');
    expect(panel).toContain('Check-ins'); expect(panel).toContain('Opt-in check-ins');
    expect(await page.locator('[data-person="me"]').innerText()).toMatch(/At Synthetic home place[\s\S]*Updated 8 min/);
    const others = page.locator('[data-person="member"]');
    expect(await others.count()).toBe(2);
    expect(await others.nth(0).innerText()).toMatch(/Other Person[\s\S]*Not shown[\s\S]*No check-in is shared with you/);
    expect(await others.nth(1).innerText()).toContain('Household member');
    expect(panel).toContain('You share your check-in with Synthetic household.');
    expect(panel).toContain('never coordinates');
    expect(await page.locator('#share-location').isChecked()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('switching off stops this browser’s device through the location route; a refusal keeps it on and says why', async () => {
    await reportingHere();
    await open('family', '#share-location');
    fixture.state.status['home:opt-out'] = 500;
    await page.locator('#share-location').click();
    await toastHas('Could not stop sharing (HTTP 500');
    expect(await page.locator('#share-location').isChecked()).toBe(true);
    delete fixture.state.status['home:opt-out'];
    await page.locator('#share-location').uncheck();
    await toastHas('no longer reports your check-in');
    await page.waitForFunction(() => document.querySelector('[data-person="me"]')?.textContent?.includes('Not sharing'));
    expect(await page.locator('[data-person="me"]').innerText()).toContain('Reporting is off');
    expect(home.writes.filter(w => w.startsWith('opt-out'))).toEqual(['opt-out dev-1', 'opt-out dev-1']);
    expect(await page.locator('#share-location').isChecked()).toBe(false);
  });

  it('switching on writes nothing: it opens the way to Settings, Location, and coming back re-reads the check-in', async () => {
    await open('family', '#share-location');
    expect(await page.locator('[data-person="me"]').innerText()).toMatch(/Not sharing[\s\S]*Reporting is off/);
    await page.locator('#share-location').click();
    await page.waitForSelector('#homebase-dialog');
    expect(await dialogText()).toContain('needs a fresh sign-in and your browser’s permission');
    expect(await page.locator('#homebase-dialog a', { hasText: 'Open Settings, Location' }).getAttribute('href')).toBe('/cockpit/tools/location.html');
    expect(await page.locator('#share-location').isChecked()).toBe(false);
    expect(home.writes).toEqual([]);
    const before = calls('GET /api/location/state').length;
    await page.locator('#homebase-dialog').getByRole('button', { name: 'Not now' }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => calls('GET /api/location/state').length).toBe(before + 1);
    // Only once: a later focus without another visit to Settings reads nothing more.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForLoadState('networkidle');
    expect(calls('GET /api/location/state').length).toBe(before + 1);
  });

  it('names a refusal by the route’s own message, a missing route as not set up, and asks nothing outside Home', async () => {
    fixture.state.status['home:location'] = 403;
    await open('family', '[data-module="locations"]');
    await page.waitForFunction(() => document.querySelector('[data-module="locations"]')?.textContent?.includes('HTTP 403'));
    const refused = await moduleText('locations');
    expect(refused).toContain('Location settings are changed from a signed-in browser, not with a token. (HTTP 403: browser_session_required)');
    expect(await page.locator('#share-location').count()).toBe(0);
    fixture.state.status['home:location'] = 404;
    await page.reload(); await page.waitForLoadState('networkidle');
    expect(await moduleText('locations')).toContain('Location is not set up on this swarm (HTTP 404).');
    fixture.state.calls.length = 0;
    await open('company', '.home-shell'); await open('classroom', '.home-shell');
    expect(calls('GET /api/location')).toEqual([]);
    expect(await page.locator('[data-module="locations"]').count()).toBe(0);
  });
});

describe('the household group', () => {
  it('lists the household’s people and roles, names only what the directory shares, and labels the home with it', async () => {
    household();
    await open('family', '[data-module="room"]');
    expect(await page.locator('.workspace-label').innerText()).toContain('Synthetic household · 3 people');
    expect(await page.locator('.breadcrumb').innerText()).toBe('Synthetic household / Our home');
    expect(await page.locator('.hero-cta').innerText()).toContain('3 people · 1 admin');
    const room = await moduleText('room');
    expect(room).toMatch(/Your home assistant[\s\S]*Room host · 1 of 2 assistants online/);
    expect(room).toMatch(/Synthetic Teacher · you[\s\S]*Admin[\s\S]*Other Person[\s\S]*Member[\s\S]*Household member/);
    await page.getByRole('button', { name: 'Our people' }).click();
    const people = await moduleText('people');
    expect(people).toContain('3 people. One home.');
    expect(people).toContain('Members of your household group “Synthetic household” (3)');
    expect(people).toMatch(/Other Person[\s\S]*Member · Synthetic household/);
    expect(await page.locator('[data-module="family-admin"]').count()).toBe(1);
    await page.getByRole('button', { name: 'About this data' }).click();
    const about = await dialogText();
    expect(about).toContain('People: your household group (HTTP 200); names only where the swarm directory shares them.');
    expect(about).toContain('Check-ins: your own place from Location (HTTP 200), as a place name and never coordinates.');
    expect(about).not.toContain('No check-in, location or presence source exists');
    expect(errors).toEqual([]);
  });

  it('asks the directory only to name someone else, and a refused directory leaves them unnamed', async () => {
    home.tenants.push({ tenant_id: 'h1', kind: 'space', name: 'Synthetic household', role: 'admin' });
    home.members.h1 = [{ user_sub: 'synthetic-user', role: 'admin' }];
    await open('family', '[data-module="room"]');
    expect(calls('GET /api/user-directory')).toEqual([]);
    home.members.h1.push({ user_sub: 'other', role: 'member' });
    fixture.state.directory.status = 403;
    await page.reload(); await page.waitForLoadState('networkidle');
    expect(calls('GET /api/user-directory').length).toBe(1);
    expect(await moduleText('room')).toContain('Household member');
    expect(await moduleText('room')).not.toContain('Other Person');
  });

  it('Business lists the caller’s team group when the swarm directory is not theirs to read, and never borrows a household', async () => {
    household();
    home.tenants.push({ tenant_id: 'o1', kind: 'org', name: 'Synthetic works', role: 'member' });
    home.members.o1 = [{ user_sub: 'lead', role: 'admin' }, { user_sub: 'synthetic-user', role: 'member' }];
    fixture.state.directory.status = 403;
    await open('company', '.home-shell');
    expect(await page.locator('.workspace-label').innerText()).toContain('Synthetic works · 2 people');
    await page.getByRole('button', { name: 'People & specialists' }).click();
    const people = await moduleText('people');
    expect(people).toMatch(/Synthetic Teacher · you[\s\S]*Member · Synthetic works[\s\S]*Team member[\s\S]*Admin · Synthetic works/);
    expect(people).toContain('Members of your team group “Synthetic works” (2)');
    expect(people).not.toContain('Synthetic household');
    expect(await page.locator('[data-module="room"], [data-module="family-admin"], [data-module="locations"]').count()).toBe(0);
  });

  it('People & roles creates a household for a caller without one (they become its admin) and shows a refusal as text', async () => {
    await open('family', '[data-module="family-admin"]');
    expect(await moduleText('family-admin')).toContain('Set up your household');
    await page.getByRole('button', { name: /People & roles/ }).click();
    expect(await dialogText()).toContain('You are not in a household yet.');
    fixture.state.status['home:create-tenant'] = 500;
    await page.fill('#household-name', 'Synthetic <b>home</b>'); await page.getByRole('button', { name: 'Create household' }).click();
    await page.waitForFunction(() => document.getElementById('household-feedback')?.textContent?.includes('HTTP 500'));
    expect(await page.locator('#homebase-dialog b').count()).toBe(0);
    delete fixture.state.status['home:create-tenant'];
    await page.fill('#household-name', 'Synthetic nest'); await page.getByRole('button', { name: 'Create household' }).click();
    await toastHas('Synthetic nest is set up. You are its admin.');
    await page.waitForFunction(() => document.getElementById('dialog-title')?.textContent?.includes('Synthetic nest'));
    expect(await dialogText()).toMatch(/Synthetic Teacher · you[\s\S]*Admin/);
    expect(home.tenants.map(t => [t.name, t.kind, t.role])).toEqual([['Synthetic nest', 'space', 'admin']]);
  });

  it('Devices lists the caller’s location devices and stops one; a refusal stays in the dialog', async () => {
    await reportingHere();
    home.location.devices.push({ deviceId: 'dev-2', kind: 'node', reportingEnabled: false, precisionClass: 'city', lastSeenAt: null, createdAt: now() });
    await open('family', '[data-module="family-admin"]');
    expect(await moduleText('family-admin')).toContain('2 devices · reporting');
    await page.getByRole('button', { name: /Devices/ }).click();
    const rows = page.locator('.device-row');
    expect(await rows.nth(0).innerText()).toMatch(/This browser[\s\S]*Reporting · block \(about 110 m\)/);
    expect(await rows.nth(1).innerText()).toMatch(/node[\s\S]*Not reporting · city/);
    expect(await rows.nth(1).locator('button').count()).toBe(0);
    fixture.state.status['home:opt-out'] = 404;
    await page.getByRole('button', { name: 'Stop reporting' }).click();
    await page.waitForFunction(() => document.getElementById('device-feedback')?.textContent?.includes('HTTP 404'));
    delete fixture.state.status['home:opt-out'];
    await page.getByRole('button', { name: 'Stop reporting' }).click();
    await toastHas('That device no longer reports your check-in.');
    await page.waitForFunction(() => document.querySelectorAll('.device-row button').length === 0);
    expect(await page.locator('.device-row').first().innerText()).toContain('Not reporting');
  });
});

describe('the learner and the classroom', () => {
  it('a learner’s card shows their own level and XP from Little Monsters, with streak, quizzes and flashcards', async () => {
    fixture.state.education.me = { ...fixture.state.education.me, role: 'student' };
    await open('classroom', '[data-progress="level"]');
    const card = await moduleText('learning');
    expect(card).toMatch(/Level 2 · 160 XP[\s\S]*60 of 150 XP toward level 3[\s\S]*3-day streak · quiz average 84% · 12 cards reviewed/);
    const bar = page.locator('[data-module="learning"] [role="progressbar"]');
    expect(await bar.getAttribute('aria-valuenow')).toBe('60'); expect(await bar.getAttribute('aria-valuemax')).toBe('150');
    expect(calls('GET /api/education/student/')).toEqual(['GET /api/education/student/stu-1/dashboard']);
    home.dashboard.level = 5;   // the package's level no longer follows the rule the page knows: no bar, never a wrong one
    await page.reload(); await page.waitForSelector('[data-progress="level"]');
    expect(await page.locator('[data-module="learning"] [role="progressbar"]').count()).toBe(0);
    fixture.state.status['home:dashboard'] = 403;
    await page.reload(); await page.waitForLoadState('networkidle');
    expect(await moduleText('learning')).toContain('Your progress could not be read (HTTP 403).');
    expect(errors).toEqual([]);
  });

  it('a teacher’s home asks for no learner dashboard; outside the classroom nothing is asked before the probe answers 200', async () => {
    await open('classroom', '[data-module="teacher-roster"]');
    expect(calls('GET /api/education/student/')).toEqual([]);
    fixture.state.education.me = { ...fixture.state.education.me, role: 'student' };
    fixture.state.status['lm-home-summary'] = 403;
    fixture.state.calls.length = 0;
    await open('family', '.home-shell');
    expect(calls('GET /api/education')).toEqual([]);
    delete fixture.state.status['lm-home-summary'];
    await page.reload(); await page.waitForSelector('[data-progress="level"]');
    expect(await page.locator('.hero h1').innerText()).toBe('Your day, Synthetic.');
  });

  it('the classwork pill names the next due day and its class', async () => {
    await open('classroom', '[data-module="requirements"]');
    const due = fixture.state.education.assignments[0].due_date as string;
    const [y, m, d] = due.split('-').map(Number);
    const shown = await page.evaluate(([yy, mm, dd]) => new Date(yy, mm - 1, dd).toLocaleDateString(), [y, m, d]);
    expect(await page.locator('[data-module="requirements"] .quest-footer .pill').innerText()).toBe(`Due ${shown} · shared with Synthetic Science`);
  });

  it('unread Little Monsters notices lead the noticeboard and leave it when marked read', async () => {
    home.notices.push({ notification_id: 'n1', title: 'Synthetic notice', body: 'Bring a <b>synthetic</b> jar.', channel: 'in-app', read: false, sent_at: now() },
      { notification_id: 'n2', title: 'Old synthetic notice', body: 'Seen already.', channel: 'in-app', read: true, sent_at: now() });
    await open('classroom', '[data-notice="n1"]');
    const board = await moduleText('updates');
    expect(board).toMatch(/Class updates[\s\S]*Synthetic notice[\s\S]*Bring a <b>synthetic<\/b> jar\./);
    expect(board).not.toContain('Old synthetic notice');
    await page.locator('button[data-action="notice-read"][data-notice="n1"]').click();
    await page.waitForFunction(() => !document.querySelector('.update[data-notice="n1"]'));
    expect(home.writes).toContain('notice-read n1');
    expect(home.notices[0].read).toBe(true);
  });
});
