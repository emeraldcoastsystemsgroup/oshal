/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Full-swarm gap closure: audience-aware hosting in Studio, Jarvis, Orbit and Commons (one shared helper, the Summary view / Full application switch remembered per layout), declared assistants and member / Required / Optional relationships read lazily from the package record (group members read one by one, 404 and failure states), the shared games predicate behind the directory chip and the Game room, the Commons swarm roster with the non-admin fallback, and the Jarvis agenda from the overview feed plus the Little Monsters calendar with empty, refused and not-installed states. Adapter reads are proven headlessly; the shells run in Chromium over the real static routes and the synthetic fixture.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | A dependency absent from the viewer catalog reads 'not in your catalog'
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Integration review: the Jarvis agenda reads Little Monsters' read-only home-summary probe first and sends zero /api/education requests when it answers 403 (or fails), reading the calendar only on 200; agenda copy names the Little Monsters calendar (classes and personal events) and an absent package as not in your catalog; Orbit's inspector shows the declared assistants; the Games chip reads 'Looks like a game'; a roster_scope_denied refusal is told apart from the admin requirement, and the roster read keeps the refusal code.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Acceptance fixes: calendarDay and the agenda's class events read UTC-midnight DATE values as their own day under America/Chicago; littleMonstersRefusal and the probe's carried code; an agenda for a caller whose plan does not admit Little Monsters, or whose probe is refused by authorization, says "not available to you" and sends no education request; the no-profile copy says to open Little Monsters once to set up the school profile.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Actual renderer source-state cases: loading,503/refusal/partial/unreadable/empty and keyboard retry without invented totals or discarded successful rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startExperienceBrowserFixture, syntheticApp } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

const require = createRequire(import.meta.url);
const LIVE = require('../../src/experience/live-data.js') as Record<string, any>;

type Fixture = Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
type GapState = Fixture['state'] & { fullSwarm: { manifests: Record<string, Record<string, unknown>>; overviewEvents: Array<{ title: string; when: string }>; directoryError: string } };
let browser: Browser, context: BrowserContext, page: Page, fixture: Fixture;
const errors: string[] = [];
const gaps = () => (fixture.state as GapState).fullSwarm;
const callsTo = (entry: string) => fixture.state.calls.filter(c => c === entry).length;

/** @description A fetch double keyed by path prefix that records every URL. @param routes Replies by path prefix. @returns The fetch and its call list. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find(k => url.startsWith(k));
    const reply = key ? routes[key] : { status: 404, body: { error: 'missing' } };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response;
  };
  return { fetch, calls };
}
const memoryStorage = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } }; };

describe('full-swarm gap reads in the adapter', () => {
  it('lists declared assistants by name, marks only an explicit concierge and joins online state by agentId', () => {
    const record = { manifest: { chatBot: 'Synthetic Concierge', bots: [{ agentId: 'a1', name: 'Synthetic Concierge', role: 'assistant' }, { agentId: 'a2', name: 'Synthetic Idle' }, { agentId: 'zz', name: 'Synthetic Declared' }, { name: '' }] } };
    const bots = [{ agentId: 'a1', online: true, active: true }, { agentId: 'a2', online: false, active: false }];
    expect(LIVE.declaredAssistants(record, bots)).toEqual([
      { name: 'Synthetic Concierge', role: 'assistant', agentId: 'a1', concierge: true, state: 'working' },
      { name: 'Synthetic Idle', role: '', agentId: 'a2', concierge: false, state: 'offline' },
      { name: 'Synthetic Declared', role: '', agentId: 'zz', concierge: false, state: 'declared' },
    ]);
    expect(LIVE.declaredAssistants({ manifest: { bots: [{ agentId: 'a1', name: 'Synthetic Concierge' }] } }, bots)[0].concierge).toBe(false);
    expect(LIVE.declaredAssistants(record, bots, '').some((r: any) => r.concierge)).toBe(false);
    expect(LIVE.declaredAssistants(null, bots)).toEqual([]);
  });

  it('reads the roster as accounts, never presence, and keeps a refusal honest', () => {
    const ok = LIVE.directoryPeople({ ok: true, status: 200, body: { users: [{ sub: 'me', label: 'Synthetic Me (google; active)', source: 'verified-sign-in', signIn: 'active' }, { sub: 'x', label: 'Synthetic Local (local; active)', source: 'local-account', signIn: 'local-account' }, { sub: 'y', label: 'Synthetic New (registered; awaiting verified sign-in)', source: 'access-assignment', signIn: 'awaiting-sign-in' }, { label: 'no sub' }] } }, 'me');
    expect(ok).toEqual({ ok: true, status: 200, error: '', people: [
      { sub: 'me', name: 'Synthetic Me', detail: 'Verified sign-in · account active', self: true },
      { sub: 'x', name: 'Synthetic Local', detail: 'Local account', self: false },
      { sub: 'y', name: 'Synthetic New', detail: 'Access assignment · awaiting first sign-in', self: false },
    ] });
    expect(LIVE.directoryPeople({ ok: false, status: 403, body: { error: 'roster_administrator_required' } }, 'me')).toEqual({ ok: false, status: 403, error: 'roster_administrator_required', people: [] });
    expect(LIVE.directoryPeople({ ok: false, status: 403, body: { error: 'roster_scope_denied' } }, 'me').error).toBe('roster_scope_denied');
    expect(LIVE.directoryPeople({ ok: false, status: 0, body: null }, 'me')).toEqual({ ok: false, status: 0, error: '', people: [] });
  });

  it('reads one app record, the roster and two months of classwork over the existing routes', async () => {
    const now = new Date(2026, 11, 20);
    const { fetch, calls } = fakeFetch({
      '/api/swarm/apps/': { status: 200, body: { app: { manifest: { bots: [] } } } },
      '/api/user-directory': { status: 403, body: { error: 'roster_administrator_required' } },
      '/api/education/calendar?month=2026-12': { status: 200, body: { events: [{ event_id: 'e2', title: 'Synthetic later', event_date: '2026-12-24', event_time: null }, { event_id: 'e1', title: 'Synthetic first', event_date: '2026-12-21', event_time: '09:30:00', class_name: 'Synthetic Class' }] } },
      '/api/education/calendar?month=2027-01': { status: 200, body: { events: [{ event_id: 'e1', title: 'Synthetic first', event_date: '2026-12-21' }, { event_id: 'e3', title: 'Synthetic bad', event_date: 'not a date' }] } },
    });
    const client = LIVE.createClient({ fetch, storage: memoryStorage() });
    expect((await client.packages.appDetail('synthetic app')).ok).toBe(true);
    expect(calls).toContain('/api/swarm/apps/synthetic%20app');
    expect(await client.packages.people('me')).toEqual({ ok: false, status: 403, error: 'roster_administrator_required', people: [] });
    const agenda = await client.packages.education.agenda(now);
    expect(calls).toEqual(expect.arrayContaining(['/api/education/calendar?month=2026-12', '/api/education/calendar?month=2027-01']));
    expect(agenda.ok).toBe(true);
    expect(agenda.events.map((e: any) => [e.id, e.title, e.timed, e.className])).toEqual([['e1', 'Synthetic first', true, 'Synthetic Class'], ['e2', 'Synthetic later', false, '']]);
    const refused = LIVE.createClient({ fetch: fakeFetch({ '/api/education/calendar': { status: 403, body: { error: 'no' } } }).fetch, storage: memoryStorage() });
    expect(await refused.packages.education.agenda(now)).toEqual({ ok: false, status: 403, events: [] });
  });

  it('reads a date-only Little Monsters field as the day it names in a US zone, agenda rows included', () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = 'America/Chicago';
    try {
      // Precondition: in this zone the instant form of a DATE column is the evening before, the defect this guards.
      expect(new Date('2026-09-29T00:00:00.000Z').getDate()).toBe(28);
      const parts = (d: Date | null) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
      expect(parts(LIVE.calendarDay('2026-09-29T00:00:00.000Z'))).toEqual([2026, 9, 29, 0, 0]);
      expect(parts(LIVE.calendarDay('2026-09-29T00:00:00Z'))).toEqual([2026, 9, 29, 0, 0]);
      expect(parts(LIVE.calendarDay('2026-09-29'))).toEqual([2026, 9, 29, 0, 0]);
      expect(parts(LIVE.calendarDay('2026-09-29T00:00:00.000Z', '17:30:00'))).toEqual([2026, 9, 29, 17, 30]);
      expect(LIVE.calendarDay('2026-02-30')).toBeNull(); expect(LIVE.calendarDay('not a date')).toBeNull(); expect(LIVE.calendarDay(null)).toBeNull();
      const rows = LIVE.classEvents([{ ok: true, body: { events: [
        { event_id: 'e2', title: 'Synthetic lab', event_date: '2026-09-30T00:00:00.000Z', event_time: '17:00:00' },
        { event_id: 'e1', title: 'Synthetic due', event_date: '2026-09-29T00:00:00.000Z', event_time: null },
      ] } }]);
      expect(rows.map((r: any) => [r.id, parts(r.when), r.timed])).toEqual([['e1', [2026, 9, 29, 0, 0], false], ['e2', [2026, 9, 30, 17, 0], true]]);
    } finally { process.env.TZ = zone; }
  });

  it('names a Little Monsters refusal by its code and carries the probe’s code with its status', async () => {
    expect(LIVE.littleMonstersRefusal(403, 'app_access_denied')).toBe('not-granted');
    expect(LIVE.littleMonstersRefusal(403, 'app_access_identity_required')).toBe('not-granted');
    expect(LIVE.littleMonstersRefusal(403, 'authorization_tier_denied')).toBe('not-granted');
    expect(LIVE.littleMonstersRefusal(403, 'Open Little Monsters to complete school setup')).toBe('no-profile');
    expect(LIVE.littleMonstersRefusal(403, 'School identity configuration requires review')).toBe('');
    expect(LIVE.littleMonstersRefusal(503, 'authorization_app_unavailable')).toBe('');
    expect(LIVE.littleMonstersRefusal(404, 'Open Little Monsters to complete school setup')).toBe('');
    const client = LIVE.createClient({ fetch: fakeFetch({ '/api/little-monsters/home-summary': { status: 403, body: { error: 'app_access_denied', app: 'little-monsters', tier: 'deny' } } }).fetch, storage: memoryStorage() });
    const probe = await client.probeSummary({ id: 'little-monsters', probes: [{ path: '/api/little-monsters/home-summary', tilesPointer: '/tiles', itemsPointer: '/items' }] });
    expect(probe).toMatchObject({ ok: false, status: 403, error: 'app_access_denied' });
    expect(await client.probeSummary({ id: 'none', probes: [] })).toMatchObject({ none: true, status: 0, error: '' });
  });
});

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

/** @description Open one experience and wait for its live root. @param path Route. @param ready Selector. */
async function open(path: string, ready: string) { await page.goto(fixture.origin + path); await page.waitForSelector(ready); }
/** @description Open an application's panel through the directory and wait for its package-record slots. @param id App name. */
async function openPanel(id: string) {
  await page.keyboard.press('Control+k');
  await page.fill('#app-search', id);
  await page.locator(`.catalog-card[data-catalog-app="${id}"] .catalog-main`).click();
  await page.waitForSelector(`#full-dialog [data-detail-slot="${id}"][data-detail-part="assistants"]`);
}
const detailText = (part: string) => page.locator(`#full-dialog [data-detail-part="${part}"]`).innerText();
/** @description Wait until a package-record slot has left its reading state. @param part assistants | relations. */
async function detailSettled(part: string) { await page.waitForFunction(p => !(document.querySelector(`#full-dialog [data-detail-part="${p}"]`)?.textContent || 'Reading').includes('Reading'), part); }
const frameSrc = (selector: string) => page.locator(selector).getAttribute('src');

describe('audience-aware hosting', () => {
  it('the shared helper appends the audience once and keeps the query, the hash and an audience already named', async () => {
    await open('/studio', '.full-studio');
    const cases = await page.evaluate(() => { const w = (window as any).OSHAL_SHELL.withAudience; return [w('/x', 'company'), w('/x?tab=a%20b#top', 'company'), w('/x?audience=family', 'company'), w('/x?', 'family'), w('/x?a=1&', 'family'), w('', 'company'), w('/x', '')]; });
    expect(cases).toEqual(['/x?audience=company', '/x?tab=a%20b&audience=company#top', '/x?audience=family', '/x?audience=family', '/x?a=1&audience=family', '', '/x']);
  });

  it('Studio’s selected workspace asks for the company view, switches to the full application and remembers it on this device', async () => {
    await open('/studio', '.full-studio');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Use as my context' }).click();
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    expect(await frameSrc('.full-context iframe.embed-frame')).toBe('/fixture/surface/ledger?audience=company');
    expect(await page.locator('.full-context [data-view="summary"]').getAttribute('aria-pressed')).toBe('true');
    expect(await page.locator('.full-context .embed-switch').innerText()).toContain('a page without that view runs its full UI');
    await page.locator('.full-context').getByRole('button', { name: 'Full application' }).click();
    await page.waitForFunction(() => document.querySelector('.full-context iframe.embed-frame')?.getAttribute('src') === '/fixture/surface/ledger');
    expect(await page.evaluate(() => localStorage.getItem('oshal-experience:embed-view:studio'))).toBe('"full"');
    await page.reload(); await page.waitForSelector('.full-context iframe.embed-frame');
    expect(await frameSrc('.full-context iframe.embed-frame')).toBe('/fixture/surface/ledger');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
    expect(await frameSrc('#full-dialog iframe.embed-frame')).toBe('/fixture/surface/ledger');
    expect(errors).toEqual([]);
  });

  it('Jarvis, Orbit and Commons open in place with their own audience, and the switch is kept per layout', async () => {
    const expected: Array<[string, string, string]> = [['/jarvis', '.full-jarvis', 'family'], ['/orbit', '.full-orbit', 'company'], ['/commons', '.full-commons', 'company']];
    for (const [path, ready, audience] of expected) {
      await open(path, ready);
      await openPanel('ledger');
      await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
      expect(await frameSrc('#full-dialog iframe.embed-frame'), path).toBe(`/fixture/surface/ledger?audience=${audience}`);
    }
    await open('/jarvis', '.full-jarvis');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
    await page.locator('#full-dialog').getByRole('button', { name: 'Full application' }).click();
    await page.waitForFunction(() => document.querySelector('#full-dialog iframe.embed-frame')?.getAttribute('src') === '/fixture/surface/ledger');
    expect(await page.locator('#full-dialog [data-view="full"]').getAttribute('aria-pressed')).toBe('true');
    await open('/orbit', '.full-orbit');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
    expect(await frameSrc('#full-dialog iframe.embed-frame')).toBe('/fixture/surface/ledger?audience=company');
    expect(errors).toEqual([]);
  });

  it('never overrides an audience the application’s own surface already names', async () => {
    const ledger = fixture.state.apps.find(a => a.summary.name === 'ledger')!;
    ledger.plan!.firstSurfaceUrl = '/fixture/surface/ledger?audience=family#top';
    await open('/studio', '.full-studio');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
    expect(await frameSrc('#full-dialog iframe.embed-frame')).toBe('/fixture/surface/ledger?audience=family#top');
  });
});

describe('declared assistants and relationships from the package record', () => {
  it('names the declared assistants with the concierge and online state, labels Required / Optional, and reads only on demand', async () => {
    await open('/studio', '.full-studio');
    expect(callsTo('GET /api/swarm/apps/forge')).toBe(0);
    await openPanel('ledger'); await detailSettled('assistants'); await detailSettled('relations');
    const assistants = await detailText('assistants');
    expect(assistants).toMatch(/Synthetic Bot\s*Concierge · assistant · working now/);
    expect(assistants).toMatch(/Synthetic reviewer\s*reviewer · declared in the package/);
    const relations = await detailText('relations');
    expect(relations).toMatch(/Synthetic finance\s*Required/); expect(relations).toMatch(/synthetic-absent\s*Optional · not in your catalog/);
    expect(relations).not.toContain('Integration source');
    await page.keyboard.press('Escape');
    await openPanel('forge'); await detailSettled('assistants');
    expect(await detailText('assistants')).toMatch(/Synthetic forge assistant\s*assistant · declared in the package/);
    expect(await detailText('relations')).toContain('No application relationships declared.');
    await page.keyboard.press('Escape'); await openPanel('forge');
    expect(callsTo('GET /api/swarm/apps/forge')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('says so when the record is not visible or cannot be read, instead of inventing assistants', async () => {
    fixture.state.status['detail:forge'] = 404; fixture.state.status['detail:deck'] = 500;
    await open('/studio', '.full-studio');
    await openPanel('forge'); await detailSettled('assistants');
    expect(await detailText('assistants')).toContain('Synthetic forge: its package record is not visible to you.');
    expect(await detailText('relations')).toContain('The package record is not visible to you, so declared dependencies are not listed.');
    await page.keyboard.press('Escape');
    await openPanel('deck'); await detailSettled('assistants');
    expect(await detailText('assistants')).toContain('Synthetic deck: package record unavailable (HTTP 500).');
    expect(await detailText('relations')).toContain('Declared dependencies could not be read (HTTP 500).');
    expect(await detailText('assistants')).not.toContain('declared in the package');
  });

  it('a group lists its members as required, reads each installed member’s assistants and marks the group’s concierge', async () => {
    const group = syntheticApp('suite', 'ai-productivity');
    group.plan!.kind = 'group'; group.plan!.members = ['ledger', 'finance'];
    fixture.state.apps.push(group);
    gaps().manifests.suite = { kind: 'group', bots: [], chatBot: 'Synthetic Bot', dependencies: { required: { apps: ['ledger', 'finance'] }, optional: { apps: ['atlas', 'synthetic-missing'] } } };
    await open('/studio', '.full-studio');
    await openPanel('suite'); await detailSettled('assistants'); await detailSettled('relations');
    const relations = await detailText('relations');
    expect(relations).toMatch(/Synthetic ledger\s*Member \(required\)/); expect(relations).toMatch(/Synthetic finance\s*Member \(required\)/);
    expect(relations).toMatch(/Synthetic atlas\s*Optional/); expect(relations).toMatch(/synthetic-missing\s*Optional · not in your catalog/);
    const assistants = await detailText('assistants');
    expect(assistants).toMatch(/Synthetic Bot\s*Concierge · assistant · from Synthetic ledger · working now/);
    expect(assistants).toMatch(/Synthetic finance assistant\s*assistant · from Synthetic finance · declared in the package/);
    for (const name of ['suite', 'ledger', 'finance']) expect(callsTo(`GET /api/swarm/apps/${name}`), name).toBeGreaterThanOrEqual(1);
  });

  it('a legacy flat block reads as required and a mixed block shows no tiers, only a neutral note', async () => {
    gaps().manifests.forge = { dependencies: { apps: ['atlas'] } };
    gaps().manifests.deck = { dependencies: { apps: ['atlas'], optional: { apps: ['stage'] } } };
    await open('/studio', '.full-studio');
    await openPanel('forge'); await detailSettled('relations');
    expect(await detailText('relations')).toMatch(/Synthetic atlas\s*Required/);
    await page.keyboard.press('Escape');
    await openPanel('deck'); await detailSettled('relations');
    const mixed = await detailText('relations');
    expect(mixed).toContain('This package mixes the flat and tiered dependency forms, so no tiers are shown.');
    expect(await page.locator('#full-dialog [data-detail-part="relations"] .dependency-row').count()).toBe(0);
  });

  it('Studio’s selected workspace and Orbit’s inspector show the same declared facts, assistants and relationships', async () => {
    await open('/studio', '.full-studio');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Use as my context' }).click();
    await page.waitForFunction(() => (document.querySelector('.full-context [data-detail-part="relations"]')?.textContent || '').includes('Required'));
    const aside = await page.locator('.full-context').innerText();
    expect(aside.toLowerCase()).toContain('declared assistants'); expect(aside).toContain('Synthetic Bot'); expect(aside.toLowerCase()).not.toContain('integration source');
    await open('/orbit', '.full-orbit');
    await page.locator('.suite-node[data-suite="ai-finance"]').click();
    await page.locator('.orbit-app[data-app="ledger"]').click();
    await page.waitForFunction(() => (document.querySelector('.orbit-inspector [data-detail-part="relations"]')?.textContent || '').includes('Required'));
    expect(await page.locator('.orbit-inspector').innerText()).toMatch(/Synthetic finance\s*Required/);
    await page.waitForFunction(() => (document.querySelector('.orbit-inspector [data-detail-part="assistants"]')?.textContent || '').includes('Synthetic Bot'));
    const inspectorAssistants = await page.locator('.orbit-inspector [data-detail-part="assistants"]').innerText();
    expect(inspectorAssistants).toMatch(/Synthetic Bot\s*Concierge · assistant · working now/);
    expect(inspectorAssistants).toMatch(/Synthetic reviewer\s*reviewer · declared in the package/);
    expect(errors).toEqual([]);
  });
});

describe('games chip, Commons people and the Jarvis agenda', () => {
  it('the directory’s Games chip and the Commons Game room share one predicate that claims no manifest marker', async () => {
    fixture.state.apps.push(syntheticApp('dungeon-crawl', 'ai-creative'), syntheticApp('gamebook', 'ai-knowledge'));
    await open('/studio', '.full-studio');
    await page.keyboard.press('Control+k');
    const chip = page.locator('[data-action="filter"][data-suite="games"]');
    expect(await chip.getAttribute('title')).toBe('Creative apps that look like games');
    // The visible label carries the hedge, not only the title: no manifest field marks a game.
    expect(await chip.innerText()).toMatch(/^Looks like a game\s*2$/);
    expect(await chip.locator('span').innerText()).toBe('2');
    await chip.click();
    expect((await page.locator('.catalog-card').evaluateAll(cards => cards.map(c => c.getAttribute('data-catalog-app')))).sort()).toEqual(['arcade-games', 'dungeon-crawl']);
    await open('/commons', '.full-commons');
    expect(await page.locator('.commons-sidebar [data-suite="games"] .nav-count').innerText()).toBe('2');
    await page.locator('.commons-sidebar [data-suite="games"]').click();
    await page.getByRole('tab', { name: /Applications/ }).click();
    expect((await page.locator('.room-app-grid .catalog-main .app-package').allInnerTexts()).sort()).toEqual(['arcade-games', 'dungeon-crawl']);
    expect(await page.evaluate(() => (window as any).OSHAL_SHELL.isGameApp({ suite: 'ai-knowledge', name: 'Synthetic gamebook', id: 'gamebook' }))).toBe(false);
  });

  it('without a game-like application there is no Games chip and no Game room', async () => {
    fixture.state.apps = fixture.state.apps.filter(a => a.summary.name !== 'arcade-games');
    await open('/commons', '.full-commons');
    expect(await page.locator('.commons-sidebar [data-suite="games"]').count()).toBe(0);
    await page.keyboard.press('Control+k');
    expect(await page.locator('[data-action="filter"][data-suite="games"]').count()).toBe(0);
  });

  it('Commons shows the swarm roster as a roster, in the room and in the People panel, read once', async () => {
    await open('/commons', '.full-commons');
    await page.waitForFunction(() => (document.querySelector('.presence-panel [data-roster-slot="room"]')?.textContent || '').includes('Other Person'));
    const room = await page.locator('.presence-panel').innerText();
    expect(room.toLowerCase()).toContain('people on this swarm'); expect(room.toLowerCase()).not.toContain('in this room');
    expect(room).toContain('synthetic · you'); expect(room).toContain('A roster, not presence or room membership.');
    await page.locator('.commons-rail [data-action="people"]').click();
    const panel = await page.locator('#full-dialog [data-roster-slot="panel"]').innerText();
    expect(panel).toMatch(/Other Person\s*Verified sign-in · account active/);
    expect(panel.match(/Synthetic Teacher/g)).toBeNull();
    expect(callsTo('GET /api/user-directory')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('a caller the directory refuses sees only their own identity and why', async () => {
    fixture.state.directory.status = 403;
    await open('/commons', '.full-commons');
    await page.waitForFunction(() => (document.querySelector('.presence-panel [data-roster-slot="room"]')?.textContent || '').includes('swarm admin'));
    const room = await page.locator('.presence-panel').innerText();
    expect(room).toContain('Only a swarm admin can list everyone on this swarm, so only your own identity is shown.');
    expect(room).toContain('synthetic · you'); expect(room).not.toContain('Other Person');
    fixture.state.directory.status = 503;
    await page.reload(); await page.waitForFunction(() => (document.querySelector('.presence-panel')?.textContent || '').includes('HTTP 503'));
    expect(await page.locator('.presence-panel').innerText()).toContain('The swarm roster could not be read (HTTP 503), so only your own identity is shown.');
    // roster_scope_denied: this session's permission scope excludes the read, which is not the same as lacking the admin role.
    gaps().directoryError = 'roster_scope_denied';
    await page.reload(); await page.waitForFunction(() => (document.querySelector('.presence-panel')?.textContent || '').includes('not permitted'));
    const scoped = await page.locator('.presence-panel').innerText();
    expect(scoped).toContain('This session is not permitted to read the roster.'); expect(scoped).not.toContain('swarm admin');
    expect(scoped).toContain('synthetic · you'); expect(scoped).not.toContain('Other Person');
    gaps().directoryError = 'roster_administrator_required';
    await page.reload(); await page.waitForFunction(() => (document.querySelector('.presence-panel')?.textContent || '').includes('swarm admin'));
    expect(await page.locator('.presence-panel').innerText()).toContain('Only a swarm admin can list everyone on this swarm, so only your own identity is shown.');
  });

  it('layouts that do not opt in keep their People panel and never read the directory', async () => {
    await open('/studio', '.full-studio');
    await page.locator('.studio-sidebar [data-action="people"]').click();
    expect(await page.locator('#full-dialog').innerText()).toContain('does not expose a general people directory');
    expect(callsTo('GET /api/user-directory')).toBe(0);
  });

  it('the Jarvis agenda lists the caller’s classwork and names each source', async () => {
    await open('/jarvis', '.full-jarvis');
    await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('Science circle'));
    const agenda = await page.locator('.live-agenda').innerText();
    expect(agenda.toLowerCase()).toContain('your agenda'); expect(agenda).toMatch(/Today\s*Science circle/);
    expect(agenda).toContain('Little Monsters · Synthetic Science');
    expect(agenda).toContain('No application contributes events to the swarm calendar feed yet.');
    expect(agenda).toContain('Little Monsters calendar (classes and personal events), this month and next.');
    expect(callsTo('GET /api/education/calendar')).toBe(2);
    // The read-only probe answers first; the calendar (whose route can provision a learner) is read only after its 200.
    const calls = fixture.state.calls, probeAt = calls.indexOf('GET /api/little-monsters/home-summary');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(calls.indexOf('GET /api/education/calendar'));
    expect(errors).toEqual([]);
  });

  it('a Little Monsters probe that refuses (no school profile yet) or fails means no /api/education request at all', async () => {
    const educationCalls = () => fixture.state.calls.filter(c => c.includes('/api/education/'));
    fixture.state.status['lm-home-summary'] = 403;
    await open('/jarvis', '.full-jarvis');
    await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('Open Little Monsters once'));
    await page.waitForLoadState('networkidle');
    const agenda = await page.locator('.live-agenda').innerText();
    expect(agenda).toContain('Open Little Monsters once to set up your school profile; its calendar then shows here.');
    expect(agenda).not.toContain('Science circle');
    expect(callsTo('GET /api/little-monsters/home-summary')).toBeGreaterThanOrEqual(1);
    expect(educationCalls()).toEqual([]);
    fixture.state.status['lm-home-summary'] = 500;
    fixture.state.calls.length = 0;
    await page.reload(); await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('could not be checked'));
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.live-agenda').innerText()).toContain('Little Monsters could not be checked (HTTP 500), so its calendar is not read.');
    expect(educationCalls()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('the agenda renders overview feed rows and stays honest when the classwork calendar is empty', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000); tomorrow.setHours(10, 0, 0, 0);
    gaps().overviewEvents = [{ title: 'Synthetic swarm review', when: tomorrow.toISOString() }];
    fixture.state.education.events = [];
    await open('/jarvis', '.full-jarvis');
    await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('nothing this month or next'));
    const agenda = await page.locator('.live-agenda').innerText();
    expect(agenda).toContain('Synthetic swarm review'); expect(agenda).toContain('Swarm calendar');
    expect(agenda).toContain('Swarm calendar feed from the overview.');
    expect(agenda).not.toContain('Science circle');
  });

  it('a refused classwork calendar and an uninstalled Little Monsters render their own states', async () => {
    fixture.state.status['edu-calendar'] = 403;
    await open('/jarvis', '.full-jarvis');
    await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('refused'));
    let agenda = await page.locator('.live-agenda').innerText();
    expect(agenda).toContain('Little Monsters calendar (classes and personal events) refused (HTTP 403).'); expect(agenda).not.toContain('Science circle');
    expect(agenda).toContain('Nothing on your agenda from the sources below.');
    fixture.state.apps = fixture.state.apps.filter(a => a.summary.name !== 'little-monsters');
    fixture.state.calls.length = 0;
    await page.reload(); await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('not in your catalog'));
    agenda = await page.locator('.live-agenda').innerText();
    expect(agenda).toContain('Little Monsters is not in your catalog, so its calendar is not read.');
    expect(callsTo('GET /api/education/calendar')).toBe(0);
    expect(callsTo('GET /api/little-monsters/home-summary')).toBe(0);
  });

  it('a Little Monsters outside the caller’s plan, or a probe refused by authorization, is not available: no education request, no "could not be checked"', async () => {
    const educationCalls = () => fixture.state.calls.filter(c => c.includes('/api/education/'));
    const lm = fixture.state.apps.find(a => a.summary.name === 'little-monsters')!, plan = lm.plan;
    lm.plan = null;
    await open('/jarvis', '.full-jarvis');
    await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('not available to you'));
    await page.waitForLoadState('networkidle');
    let agenda = await page.locator('.live-agenda').innerText();
    expect(agenda).toContain('Little Monsters is not available to you, so its calendar is not read.');
    expect(agenda).not.toMatch(/could not be checked|unreachable|Open Little Monsters once/);
    expect(callsTo('GET /api/little-monsters/home-summary')).toBe(0);
    expect(educationCalls()).toEqual([]);
    lm.plan = plan;
    fixture.state.calls.length = 0;
    await page.route('**/api/little-monsters/home-summary', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'authorization_permission_denied', decisionId: 'synthetic-decision' }) }));
    await page.reload(); await page.waitForFunction(() => (document.querySelector('[data-agenda-slot]')?.textContent || '').includes('not available to you'));
    await page.waitForLoadState('networkidle');
    agenda = await page.locator('.live-agenda').innerText();
    expect(agenda).toContain('Little Monsters is not available to you, so its calendar is not read.');
    expect(educationCalls()).toEqual([]);
    expect(errors).toEqual([]);
  });
});

const workReadUrl = /\/api\/(?:jarvis\/(?:tasks|overview)|tickets)(?:\?.*)?$/;
/** @description Control only existing read-only work answers in this isolated browser. @param statuses HTTP status by source. @returns Resolves after interception is installed. */
async function controlWorkReads(statuses: Record<string, number>) {
  await page.route(workReadUrl, route => {
    const key = new URL(route.request().url()).pathname.split('/').pop()!;
    const status = statuses[key] || 200;
    return status === 200 ? route.continue() : route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'source_fixture_refusal' }) });
  });
}
/** @description Assert unavailable work never claims an empty queue or a zero overview. @returns Resolves after visible text is checked. */
async function noInventedWork() {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/0 open items|0 open ·|0\/0 assistants online|0 assistants online|No open tickets or (?:assistant )?tasks|No tickets or tasks yet\.|Nothing recorded yet\.|Nothing is waiting on you|Nothing is in your queue yet/);
}

const sourceStateViews = ["/studio","/jarvis","/orbit","/commons"];
/** @description Optional isolated synthetic renderer captures, never deployed acceptance. @param path View route. @returns Resolves after desktop/phone capture if explicitly requested. */
async function captureSourceState(path: string): Promise<void> {
  const directory = process.env.OSHAL_SOURCE_STATE_CAPTURE_DIR; if (!directory) return;
  await mkdir(directory, { recursive: true });
  const name = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  for (const [size, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const bounds = await page.locator('.work-source-status').boundingBox();
    expect(bounds!.x).toBeGreaterThan(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: join(directory, name + '-' + size + '.png'), fullPage: true });
  }
}

describe('visible work source states', () => {
  it.each(sourceStateViews)('%s keeps503 visible and retries by keyboard through the real current reads', async path => {
    await page.setViewportSize({ width: 390, height: 844 });
    const statuses = { tasks: 503, tickets: 503, overview: 503 };
    await controlWorkReads(statuses);
    let requests = 0;
    page.on('request', request => { if (workReadUrl.test(request.url())) requests++; });
    await open(path, ".full-swarm .app-shell");
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').innerText()).toContain('Work could not be loaded.');
    expect(await page.locator('.work-source-status').innerText()).not.toMatch(/HTTP|Tickets|Assistant tasks/);
    await noInventedWork();
    expect(requests).toBe(3);
    await captureSourceState(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    Object.assign(statuses, { tasks: 200, tickets: 200, overview: 200 });
    const retry = page.getByRole('button', { name: 'Retry work sources', exact: true });
    expect(await retry.evaluate(element => parseFloat(getComputedStyle(element).borderRadius))).toBeGreaterThan(0);
    await retry.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.work-source-status').count()).toBe(0);
    expect(requests).toBe(6);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
    expect(errors).toEqual([]);
  });
  it.each(sourceStateViews)('%s distinguishes current refusal from an empty queue', async path => {
    await controlWorkReads({ tasks: 403, tickets: 403, overview: 403 });
    await open(path, ".full-swarm .app-shell");
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').innerText()).toContain('not available to you');
    await noInventedWork();
    expect(await page.locator('body').innerText()).not.toContain('Synthetic ledger review');
  });
  it.each(sourceStateViews)('%s keeps admitted tasks while tickets and overview are unavailable', async path => {
    fixture.state.tasks = [{ ...fixture.state.tasks[1], title: 'Synthetic ledger: AVAILABLE_TASK_SENTINEL', status: 'running' }];
    await controlWorkReads({ tasks: 200, tickets: 503, overview: 503 });
    await open(path, ".full-swarm .app-shell");
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').innerText()).toContain('Only loaded work is shown.');
    await page.locator('[data-action="all-work"]').first().click();
    expect(await page.locator('#full-dialog').innerText()).toContain('AVAILABLE_TASK_SENTINEL');
    const text = await page.locator('body').innerText();
    expect(text).toContain('loaded');
    expect(text).toContain('Assistant status unavailable');
    expect(text).not.toContain('Synthetic ledger review');
    await noInventedWork();
  });
  it.each(sourceStateViews)('%s displays successful empty separately from unavailable', async path => {
    fixture.state.tickets = []; fixture.state.tasks = []; fixture.state.bots = [];
    await open(path, ".full-swarm .app-shell");
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').count()).toBe(0);
    expect(await page.locator('body').innerText()).toMatch(/No (?:recorded work|tickets or tasks|review items)|Nothing (?:recorded|in this stage|is in your queue)/);
    expect(errors).toEqual([]);
  });
  it.each(sourceStateViews)('%s does not fabricate zero while work is pending', async path => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/jarvis/tasks', async route => { await held; await route.continue(); });
    try {
      await page.goto(fixture.origin + path, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.loading-shell');
      expect(await page.locator('.loading-shell').innerText()).toContain('Reading your applications, work and assistants');
      await noInventedWork();
    } finally { release(); }
    await page.waitForSelector(".full-swarm .app-shell");
    await expect.poll(() => page.locator('.work-source-status').count()).toBe(0);
  });
  it.each(sourceStateViews)('%s refuses unreadable200 work instead of inventing an empty queue', async path => {
    await page.route(workReadUrl, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await open(path, ".full-swarm .app-shell");
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').innerText()).toContain('Work could not be loaded.');
    await noInventedWork();
    expect(await page.locator('body').innerText()).not.toContain('HTTP 200');
    if (!await page.locator('[data-action="provenance"]').count()) await page.locator('[data-action="directory"]').first().click();
    await page.locator('[data-action="provenance"]').click();
    expect(await page.locator('#full-dialog').innerText()).toContain('returned an unreadable response');
    expect(await page.locator('#full-dialog').innerText()).toContain('HTTP 200');

  });
  it.each(sourceStateViews)('%s rejects identities from another response family without inventing rows', async path => {
    await context.route(workReadUrl, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [{ ticketId: 'wrong-task-family', title: 'Unqualified phantom task' }], tickets: [{ id: 'wrong-ticket-family', title: 'Unqualified phantom ticket' }], bots: [{ id: 'wrong-bot-family', online: true }] }) }));
    await open(path, '.full-swarm .app-shell');
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').innerText()).toContain('Work could not be loaded.');
    expect(await page.locator('.work-source-status').getAttribute('data-work-source-state')).toBe('unavailable');
    expect(await page.locator('body').innerText()).not.toMatch(/Unqualified phantom (task|ticket)/);
    await noInventedWork();
    expect(errors).toEqual([]);
  });

  it.each(sourceStateViews)('%s rejects malformed list rows without stalling or inventing data', async path => {
    await page.route(workReadUrl, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [null], tickets: [{}], bots: [{}] }) }));
    await open(path, '.full-swarm .app-shell');
    await page.waitForLoadState('networkidle');
    expect(await page.locator('.work-source-status').innerText()).toContain('Work could not be loaded.');
    expect(await page.locator('.work-source-status').getAttribute('data-work-source-state')).toBe('unavailable');
    await noInventedWork();
    expect(errors).toEqual([]);
  });

  it('keeps an open member frame and its unsaved draft intact until the user closes that view', async () => {
    const statuses = { tasks: 503, tickets: 503, overview: 503 };
    await controlWorkReads(statuses);
    let requests = 0;
    page.on('request', request => { if (workReadUrl.test(request.url())) requests++; });
    await open('/studio', '.full-studio');
    await openPanel('ledger');
    await page.locator('#full-dialog').getByRole('button', { name: 'Use as my context' }).click();
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    await page.waitForLoadState('networkidle');
    const element = await page.locator('.full-context iframe.embed-frame').elementHandle();
    const frame = await element!.contentFrame();
    const before = await frame!.evaluate(() => { const input = document.createElement('input'); input.id = 'member-draft'; input.value = 'Unsent member draft'; document.body.append(input); return performance.timeOrigin; });
    const retry = page.getByRole('button', { name: 'Retry work sources', exact: true });
    expect(await retry.isDisabled()).toBe(true);
    expect(await page.locator('.work-source-status').innerText()).toContain('Close the application view before retrying');
    await retry.dispatchEvent('click');
    expect(requests).toBe(3);
    expect(await frame!.evaluate(() => performance.timeOrigin)).toBe(before);
    expect(await frame!.locator('#member-draft').inputValue()).toBe('Unsent member draft');
    Object.assign(statuses, { tasks: 200, tickets: 200, overview: 200 });
    await page.locator('.full-context [data-action="toggle-embed"]').click();
    expect(await page.getByRole('button', { name: 'Retry work sources', exact: true }).isEnabled()).toBe(true);
    await page.getByRole('button', { name: 'Retry work sources', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('.work-source-status').count()).toBe(0);
    expect(requests).toBe(6);
    expect(errors).toEqual([]);
  });

});
