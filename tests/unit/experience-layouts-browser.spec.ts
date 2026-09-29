/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the real experience shells in headless Chromium through the real static route registration over an isolated synthetic swarm: auth gating, live catalog and work rendering, directory/pins/app panel, the Jarvis ask flow with thread roll and refusal, room-scoped Commons threads, the three homebase presets (list, money, calendar, roster, role-driven views, honest finance states), the central assistant, the portal chooser and per-layout skins.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Home and Business host their application assemblies: per-host sidebar sections and tile groups, hosted pages opened with the preset audience view (`?view=`), hidden tool prefixes honoured, and a refused tool is a notice never a fetch
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Hosted pages carry `?audience=` instead of `?view=`
 * 4 | maintainer@emeraldcoastsystemsgroup.com | The Studio app panel's relationship to Synthetic finance is now a declared app dependency read from the package record (waited for, never labelled an integration source), and its in-place frame requests the Studio's company audience
 * 5 | maintainer@emeraldcoastsystemsgroup.com | The learner view is recognised by its open classwork count: the classwork done/total count was removed (Little Monsters records no per-learner completion)
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Phase-4 assemblies: the classroom lists AI Office ("Make and share") and Circuit Lab ("Build and test"), Home lists Watch / Listen / Go, and Business lists its Office, Communications and Growth hosts, each host in its own group in both the sidebar and the tile row, each opened with the preset's audience, and only the view page of a host whose ribbon lists several surfaces. The Little Monsters case reads its own section now that the classroom hosts more than one application.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Homebase cases follow the home build lane: Home names the missing household group, and a caller Finance does not admit gets no money module at all: a teacher keeps the teaching card, anyone else gets their personal workspace (ADR-164 D10).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { installAssemblyHosts, startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const FIXTURE_ERA = /\b(sample|fictional|demo activity|Murphy home|Northstar|Vegas|Willowmere)\b/i;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  // Never let a test speak through the operator's speakers; the stub also proves the lifecycle fallback path.
  await context.addInitScript(() => {
    // window.speechSynthesis is a read-only accessor: a plain assignment leaves the real engine in place.
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {}, cancel() {}, getVoices() { return []; } }, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function SpeechSynthesisUtterance() {}, configurable: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

const errors: string[] = [];
/** @description Open one experience and wait for its live root; page errors are collected for the assertions. */
async function open(path: string, ready: string) {
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
  await page.goto(fixture.origin + path);
  await page.waitForSelector(ready);
}
const bodyText = () => page.evaluate(() => document.body.innerText);
const stored = (key: string) => page.evaluate(k => localStorage.getItem(k), key);
/**
 * @description A homebase's hosted-tool groups in page order: each group's kicker and the tool ids it offers.
 * @param groupSelector The group containers (sidebar sections or tile-row groups).
 * @param toolSelector The tool buttons inside one group.
 * @returns One entry per group that offers at least one tool.
 */
const railGroups = (groupSelector: string, toolSelector: string) => page.evaluate(([g, t]) => Array.from(document.querySelectorAll(g))
  .map(section => ({ kicker: section.querySelector('.side-kicker')?.textContent || '', tools: Array.from(section.querySelectorAll(t)).map(b => b.getAttribute('data-tool') || '') }))
  .filter(group => group.tools.length > 0), [groupSelector, toolSelector]);
/**
 * @description Open a hosted tool from the homebase sidebar and wait for its frame to carry the expected src.
 * @param toolId The admitted tool's id.
 * @param src The frame src the preset must request (surface plus its audience).
 * @returns Nothing; fails when the frame never carries `src`.
 */
async function openHosted(toolId: string, src: string) {
  await page.locator(`.home-sidebar [data-tool="${toolId}"]`).click();
  await expect.poll(() => page.locator('#tool-frame').getAttribute('src')).toBe(src);
}

describe('experience shells over the real routes', () => {
  it('gates every experience path behind the real requiresAuth seat and redirects the old classroom path', async () => {
    const denied = await startExperienceBrowserFixture({ denyAuth: true });
    try {
      for (const path of ['/portal', '/studio', '/jarvis', '/orbit', '/commons', '/homebase', '/nexus', '/experience/shell.js', '/little-monsters']) {
        expect((await fetch(denied.origin + path, { redirect: 'manual' })).status, path).toBe(401);
      }
    } finally { await denied.close(); }
    const redirect = await fetch(fixture.origin + '/little-monsters', { redirect: 'manual' });
    expect(redirect.status).toBe(302); expect(redirect.headers.get('location')).toBe('/homebase?preset=classroom');
    for (const path of ['/studio', '/homebase', '/nexus', '/portal']) {
      const res = await fetch(fixture.origin + path); expect(res.status, path).toBe(200); expect(res.headers.get('content-type')).toContain('text/html');
    }
  });

  it('Studio renders the signed-in swarm and its work instead of fixtures', async () => {
    await open('/studio', '.full-studio');
    await page.waitForSelector('.running-row');
    const text = await bodyText();
    expect(text).toContain('LIVE SWARM / 19 APPS');
    expect(text).toContain('Synthetic ledger review');
    expect(text).toContain('synthetic');
    expect(text).not.toMatch(FIXTURE_ERA);
    expect(await page.locator('.studio-sidebar .pinned-nav .nav-button').count()).toBeGreaterThan(0);
    expect(await page.locator('.studio-suite-strip .suite-chip').count()).toBe(6);
    expect(errors).toEqual([]);
  });

  it('Studio directory, device pins and the application panel read the app’s own summary', async () => {
    await open('/studio', '.full-studio');
    await page.keyboard.press('Control+k');
    await page.fill('#app-search', 'ledger');
    expect(await page.locator('.catalog-card').count()).toBe(1);
    const pinnedBefore = (await page.locator('.catalog-card [data-action="pin"]').getAttribute('aria-pressed')) === 'true';
    await page.locator('.catalog-card [data-action="pin"]').click();
    expect(JSON.parse((await stored('oshal-experience:pins:studio')) || '[]').includes('ledger')).toBe(!pinnedBefore);
    expect((await page.locator('.catalog-card [data-action="pin"]').getAttribute('aria-pressed')) === 'true').toBe(!pinnedBefore);
    await page.locator('.catalog-card .catalog-main').click();
    await page.waitForSelector('[data-summary-slot="ledger"] .run-strip');
    await page.waitForSelector('#full-dialog [data-detail-part="relations"] .dependency-row');
    const panel = await page.locator('#full-dialog').innerText();
    expect(panel).toContain('Reported items'); expect(panel).toContain('Update from ledger'); expect(panel).toContain('Available in your workspace');
    expect(panel).toContain('Synthetic finance'); expect(panel).not.toContain('Integration source');
    await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
    expect(await page.locator('#full-dialog iframe.embed-frame').getAttribute('src')).toBe('/fixture/surface/ledger?audience=company');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.fill('#app-search', 'unadmitted');
    expect(await page.locator('.catalog-card').innerText()).toContain('Not available here');
  });

  it('Studio conversation posts to the shared Jarvis thread and renders the real answer shape', async () => {
    await open('/studio', '#message-input');
    await page.fill('#message-input', 'What is ready?');
    await page.press('#message-input', 'Enter');
    await page.waitForSelector('.conversation-list .message-content p strong');
    const thread = await page.locator('.conversation-list').innerText();
    expect(thread).toContain('What is ready?'); expect(thread).toContain('ledger'); expect(thread).toContain('one');
    expect(await page.locator('.conversation-list a.mini-app').getAttribute('href')).toBe('/cockpit/?app=ledger');
    expect(await page.locator('.conversation-list .message-content p a[href="/cockpit/?app=ledger"]').innerText()).toBe('Synthetic ledger');
    expect(fixture.state.asks).toHaveLength(1);
    expect(fixture.state.asks[0]).toEqual({ message: 'What is ready?', sessionId: await stored('jarvisSessionId') });
    expect(errors).toEqual([]);
  });

  it('rolls a refused persisted thread once and reports an unavailable assistant without pretending', async () => {
    fixture.state.ask.refuseFirst = true;
    await open('/studio', '#message-input');
    await page.fill('#message-input', 'Hello'); await page.press('#message-input', 'Enter');
    await page.waitForSelector('.conversation-list .message-content p strong');
    expect(fixture.state.asks).toHaveLength(2);
    expect(fixture.state.asks[1].sessionId).not.toBe(fixture.state.asks[0].sessionId);
    expect(await stored('jarvisSessionId')).toBe(fixture.state.asks[1].sessionId);
    fixture.state.ask.status = 503;
    await page.fill('#message-input', 'Again'); await page.press('#message-input', 'Enter');
    await page.waitForSelector('.conversation-list .tone-warn');
    expect(await page.locator('.conversation-list').innerText()).toContain('Synthetic assistant unavailable');
    expect(await page.locator('.conversation-list .badge').last().innerText()).toContain('Could not answer');
  });

  it('Jarvis briefs from the real queue and lists suites with live counts', async () => {
    await open('/jarvis', '.full-jarvis');
    await page.waitForSelector('.briefing-item');
    const brief = await page.locator('.briefing-card').innerText();
    expect(brief).toContain('Synthetic failed task'); expect(brief).toContain('Synthetic ledger review');
    expect(await bodyText()).toContain('Your 6 worlds.');
    expect(await page.locator('.attention-card').count()).toBe(4);
    expect(await page.locator('.jarvis-date').innerText()).toContain('synthetic');
    expect(await bodyText()).not.toMatch(FIXTURE_ERA);
  });

  it('Orbit drills from a suite into its applications and inspects one', async () => {
    await open('/orbit', '.full-orbit');
    expect(await page.locator('.suite-node').count()).toBe(6);
    await page.locator('.suite-node[data-suite="ai-finance"]').click();
    expect(await page.locator('.orbit-app').count()).toBe(3);
    await page.locator('.orbit-app[data-app="ledger"]').click();
    expect(await page.locator('.orbit-inspector h2').innerText()).toBe('Synthetic ledger');
    await page.waitForSelector('.orbit-inspector [data-summary-slot="ledger"] .run-strip');
    expect(await page.locator('.orbit-inspector').innerText()).toContain('Synthetic ledger review');
  });

  it('Commons keeps one thread per room and boards the room’s real work', async () => {
    await open('/commons', '.full-commons');
    expect(await page.locator('.commons-sidebar').innerText()).toContain('Game room');
    await page.getByRole('tab', { name: 'Work board' }).click();
    const board = await page.locator('.full-board').innerText();
    expect(board).toMatch(/Working[\s\S]*Synthetic ledger review/); expect(board).toMatch(/Ready[\s\S]*Synthetic finished brief/);
    await page.getByRole('tab', { name: 'Conversation' }).click();
    await page.fill('#message-input', 'Room question'); await page.press('#message-input', 'Enter');
    await page.waitForSelector('.room-messages .message-content p strong');
    expect(fixture.state.asks[0].sessionId).toBe('jarvis-room-ai-finance-synthetic-user');
  });

  it('Home preset: the real shopping list, money picture, class calendar and honest people', async () => {
    await open('/homebase?preset=family', '.home-shell');
    await page.waitForSelector('[data-shopping-item="i1"]');
    const text = await bodyText();
    expect(text).toContain('Synthetic milk'); expect(text).toContain('$1,235'); expect(text).toContain('Science circle');
    expect(text).not.toContain('Synthetic Checking'); expect(text).not.toMatch(FIXTURE_ERA);
    await page.fill('#shopping-input', 'Synthetic eggs'); await page.press('#shopping-input', 'Enter');
    await page.waitForFunction(() => document.body.innerText.includes('Synthetic eggs'));
    expect(fixture.state.purchasing.added[0]).toMatchObject({ title: 'Synthetic eggs', quantity: 1 });
    await page.locator('[data-shopping-item="i1"]').check();
    await page.waitForFunction(() => !document.body.innerText.includes('Synthetic milk'));
    expect(fixture.state.purchasing.removed).toEqual(['i1']);
    await page.getByRole('button', { name: 'Our people' }).click();
    const people = await page.locator('.main-column').innerText();
    expect(people).toContain('synthetic@fixture.test'); expect(people).toContain('not in a household group yet'); expect(people).not.toContain('Other Person');
  });

  it('Classroom preset follows the caller’s real role: teacher roster, learner checklist, missing profile', async () => {
    await open('/homebase?preset=classroom', '.home-shell');
    await page.waitForSelector('[data-module="teacher-roster"]');
    let text = await bodyText();
    expect(text).toContain('Learner One'); expect(text).toContain('Observe a seed'); expect(text).toContain('Manage classwork in Little Monsters');
    expect(await page.locator('img.monster-logo').getAttribute('src')).toBe('/api/education/logo-96.png');
    fixture.state.education.me = { ...fixture.state.education.me, role: 'student' };
    await page.reload(); await page.waitForFunction(() => document.body.innerText.includes('open classwork item'));
    text = await bodyText();
    expect(text).not.toContain('A moment for each learner'); expect(text).toContain('1 open classwork item'); expect(text).toContain('Open my checklist');
    expect(text).not.toContain('classwork done');
    fixture.state.education.meStatus = 404;
    await page.reload(); await page.waitForFunction(() => document.body.innerText.includes('Open Little Monsters to join a class'));
  });

  it('Classroom preset hosts the Little Monsters tools in place: admitted tools by role, opened in a frame, bridge navigation honoured', async () => {
    await open('/homebase?preset=classroom', '.home-shell');
    await page.waitForSelector('.tool-nav');
    // The classroom hosts more than Little Monsters (the default catalog installs AI Office), so read its own section.
    const lmNav = page.locator('.home-sidebar .side-section').filter({ has: page.locator('.side-kicker', { hasText: /^LITTLE MONSTERS$/ }) }).locator('.tool-nav');
    const nav = await lmNav.innerText();
    expect(nav).toContain('Home'); expect(nav).toContain('My Day'); expect(nav).toContain('Teacher'); expect(nav).not.toContain('Synthetic Science');
    expect(await page.locator('.tool-group').filter({ has: page.locator('.side-kicker', { hasText: /^LITTLE MONSTERS$/ }) }).locator('.app-tile').count()).toBe(3);
    await lmNav.locator('button', { hasText: 'My Day' }).click();
    await page.waitForSelector('#tool-frame');
    expect(await page.locator('#tool-frame').getAttribute('src')).toBe('/fixture/surface/lm-myday?audience=classroom');
    expect(await page.locator('.breadcrumb').innerText()).toContain('My Day');
    expect(await page.locator('.hero').count()).toBe(0);
    await page.frameLocator('#tool-frame').locator('#post-class').click();
    await page.waitForFunction(() => document.querySelector('#tool-frame')?.getAttribute('src') === '/fixture/surface/lm-class-c1?audience=classroom');
    await page.frameLocator('#tool-frame').locator('#post-navigate').click();
    await page.waitForFunction(() => document.querySelector('#tool-frame')?.getAttribute('src') === '/fixture/surface/lm-myday?audience=classroom');
    await page.getByRole('button', { name: /Back to our classroom/ }).click();
    await page.waitForSelector('.hero');
    fixture.state.education.me = { ...fixture.state.education.me, role: 'student' };
    await page.reload(); await page.waitForSelector('.tool-nav');
    expect(await lmNav.innerText()).not.toContain('Teacher');
    await lmNav.locator('button', { hasText: 'Home' }).click(); await page.waitForSelector('#tool-frame');
    await page.frameLocator('#tool-frame').locator('#post-teacher').click();
    await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('not available to you here'));
    expect(await page.locator('#tool-frame').getAttribute('src')).toBe('/fixture/surface/lm-dashboard?audience=classroom');
    expect(errors).toEqual([]);
  });

  it('Home preset hosts several applications: one rail section per host, curated tiles, and the family view requested on each hosted page', async () => {
    await open('/homebase?preset=family', '.home-shell');
    await page.waitForSelector('.tool-nav');
    const kickers = await page.locator('.home-sidebar .side-kicker').allInnerTexts();
    expect(kickers).toEqual(expect.arrayContaining(['SMART HOME', 'SHOPPING', 'MONEY', 'LITTLE MONSTERS', 'OFFICE']));
    // Five hosts in the default catalog: the four above plus AI Office (the Recent documents card's application).
    expect(await page.locator('.tool-group').count()).toBe(5);
    const labels = await page.locator('.tool-nav button').allInnerTexts();
    expect(labels.join('|')).toContain('Synthetic home home'); expect(labels.join('|')).not.toContain('Synthetic Science');
    await page.locator('.tool-nav button', { hasText: 'Synthetic home home' }).first().click();
    await page.waitForSelector('#tool-frame');
    expect(await page.locator('#tool-frame').getAttribute('src')).toBe('/fixture/surface/home?audience=family');
    expect(await page.locator('.breadcrumb').innerText()).toContain('Synthetic home home');
    expect(errors).toEqual([]);
  });

  it('Business preset hosts the office applications and requests the company view', async () => {
    await open('/homebase?preset=company', '.home-shell');
    await page.waitForSelector('.tool-nav');
    const kickers = await page.locator('.home-sidebar .side-kicker').allInnerTexts();
    expect(kickers).toEqual(expect.arrayContaining(['PRESENTATIONS', 'FINANCE', 'COMMUNICATIONS', 'PAYROLL', 'PAYMENTS', 'IDENTITY', 'ENGINEERING']));
    expect(await page.locator('.tool-group').count()).toBe(7);
    await page.locator('.tool-nav button', { hasText: 'Synthetic presentations home' }).first().click();
    await page.waitForSelector('#tool-frame');
    expect(await page.locator('#tool-frame').getAttribute('src')).toBe('/fixture/surface/presentations?audience=company');
    expect(errors).toEqual([]);
  });

  it('the classroom also hosts AI Office and Circuit Lab, each in its own group, opened with the classroom audience', async () => {
    installAssemblyHosts(fixture.state);
    await open('/homebase?preset=classroom', '.home-shell');
    await page.waitForSelector('[data-tool="tool-circuit-lab"]');
    const groups = await railGroups('.home-sidebar .side-section', '.tool-nav [data-tool]');
    expect(groups.map(g => g.kicker)).toEqual(['LITTLE MONSTERS', 'MAKE AND SHARE', 'BUILD AND TEST']);
    expect(groups[1].tools).toEqual(['tool-presentations-studio']); expect(groups[2].tools).toEqual(['tool-circuit-lab']);
    expect((await railGroups('.tool-group', '.app-tile[data-tool]')).map(g => g.kicker)).toEqual(['LITTLE MONSTERS', 'MAKE AND SHARE', 'BUILD AND TEST']);
    await openHosted('tool-presentations-studio', '/fixture/surface/presentations-studio?audience=classroom');
    expect(await page.locator('.breadcrumb').innerText()).toContain('Synthetic AI Office');
    await openHosted('tool-circuit-lab', '/fixture/surface/circuit-lab?audience=classroom');
    expect(errors).toEqual([]);
  });

  it('Home adds Watch, Listen and Go (Movies & TV, Music, Travel), each in its own group, opened with the family audience', async () => {
    installAssemblyHosts(fixture.state);
    await open('/homebase?preset=family', '.home-shell');
    await page.waitForSelector('[data-tool="tool-travel-concierge"]');
    const groups = await railGroups('.home-sidebar .side-section', '.tool-nav [data-tool]');
    // OFFICE (AI Office) comes last: it backs the Recent documents card and matters less at home.
    expect(groups.map(g => g.kicker)).toEqual(['SMART HOME', 'SHOPPING', 'MONEY', 'LITTLE MONSTERS', 'WATCH', 'LISTEN', 'GO', 'OFFICE']);
    expect(groups.slice(4, 7).map(g => g.tools)).toEqual([['tool-movies-concierge'], ['tool-spotify-concierge'], ['tool-travel-concierge']]);
    expect(groups[7].tools).toEqual(['tool-presentations-studio']);
    expect(await page.locator('.tool-group').count()).toBe(8);
    for (const [tool, surface] of [['tool-movies-concierge', 'movies-concierge'], ['tool-spotify-concierge', 'spotify-concierge'], ['tool-travel-concierge', 'travel-concierge']]) {
      await openHosted(tool, `/fixture/surface/${surface}?audience=family`);
    }
    expect(errors).toEqual([]);
  });

  it('Business adds Office, Communications and Growth hosts beside its own, shows only each one’s view page, and asks for the company audience', async () => {
    installAssemblyHosts(fixture.state);
    await open('/homebase?preset=company', '.home-shell');
    await page.waitForSelector('[data-tool="tool-venture-home"]');
    const groups = await railGroups('.home-sidebar .side-section', '.tool-nav [data-tool]');
    expect(groups.map(g => g.kicker)).toEqual(['PRESENTATIONS', 'OFFICE · EMAIL', 'OFFICE · WORLD BRIEFING', 'FINANCE', 'COMMUNICATIONS', 'COMMUNICATIONS · SOCIAL',
      'GROWTH · MARKETING', 'GROWTH · VENTURES', 'PAYROLL', 'PAYMENTS', 'IDENTITY', 'ENGINEERING']);
    const byKicker = Object.fromEntries(groups.map(g => [g.kicker, g.tools]));
    // Where the ribbon lists several surfaces, only the page that carries the audience view is offered.
    expect(byKicker['OFFICE · EMAIL']).toEqual(['tool-email-myday']);
    expect(byKicker['COMMUNICATIONS · SOCIAL']).toEqual(['tool-social-composer']);
    expect(byKicker['GROWTH · MARKETING']).toEqual(['tool-marketing-engine']);
    expect(byKicker['OFFICE · WORLD BRIEFING']).toEqual(['tool-world-dashboard']); expect(byKicker['GROWTH · VENTURES']).toEqual(['tool-venture-home']);
    expect(await page.locator('.tool-group').count()).toBe(12);
    const hidden = ['tool-email-inbox', 'tool-email-social', 'tool-social-workspace', 'tool-linkedin-assistant', 'tool-social-signals', 'tool-social-accounts', 'tool-marketing-content-studio', 'tool-marketing-linkedin-assistant'];
    for (const id of hidden) expect(await page.locator(`[data-tool="${id}"]`).count(), id).toBe(0);
    for (const [tool, surface] of [['tool-email-myday', 'email-myday'], ['tool-world-dashboard', 'world-dashboard'], ['tool-social-composer', 'social-composer'], ['tool-marketing-engine', 'marketing-engine'], ['tool-venture-home', 'venture-home']]) {
      await openHosted(tool, `/fixture/surface/${surface}?audience=company`);
    }
    expect(errors).toEqual([]);
  });

  it('a homebase paints from identity and catalog before the work sources answer, then fills the work in', async () => {
    fixture.state.delays.tasks = 3000;
    const started = Date.now();
    await open('/homebase?preset=classroom', '.home-shell');
    await page.waitForFunction(() => !document.body.innerText.includes('Reading your home'));
    expect(Date.now() - started).toBeLessThan(2500);
    await page.waitForFunction(() => document.body.innerText.includes('Synthetic ledger review'), null, { timeout: 9000 });
    expect(errors).toEqual([]);
  });

  it('Business preset: projects from tickets, a dense account table and directory people', async () => {
    await open('/homebase?preset=company', '.home-shell');
    await page.waitForSelector('.finance-table');
    const text = await bodyText();
    expect(text).toContain('Synthetic ledger review'); expect(text).toContain('Synthetic Checking'); expect(text).toContain('$1,500');
    await page.getByRole('button', { name: 'People & specialists' }).click();
    const people = await page.locator('.main-column').innerText();
    expect(people).toContain('Other Person'); expect(people.match(/Synthetic Teacher/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('keeps finance honest: unsynced accounts and an unavailable application never render numbers', async () => {
    fixture.state.finance.status = 404;
    await open('/homebase?preset=family', '[data-module="finance"]');
    await page.waitForFunction(() => document.querySelector('[data-module="finance"]')?.textContent?.includes('No accounts are synced'));
    expect(await page.locator('[data-module="finance"]').innerText()).not.toContain('$');
    const finance = fixture.state.apps.find(a => a.summary.name === 'finance')!;
    finance.workspace = null; if (finance.plan) finance.plan.firstSurfaceUrl = undefined;
    // Not admitted to Finance: no money module at all (ADR-164 D10); this caller teaches, so the teaching card takes its place.
    await page.reload(); await page.waitForFunction(() => document.querySelector('[data-module="learning"]')?.textContent?.includes('You teach'));
    expect(await page.locator('[data-module="finance"]').count()).toBe(0);
    fixture.state.education.me = { ...fixture.state.education.me, role: 'parent' };
    await page.reload(); await page.waitForFunction(() => document.querySelector('[data-module="personal"]')?.textContent?.includes('Room for your best work.'));
    expect(await page.locator('[data-module="finance"]').count()).toBe(0);
  });

  it('the central assistant runs the real ask flow, opens handoffs and falls back to the labelled browser voice', async () => {
    await open('/nexus', '#intent-input');
    await page.fill('#intent-input', 'What is ready?'); await page.press('#intent-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('.mode-indicator')?.textContent === 'LIVE ANSWER');
    expect(await page.locator('.action-ledger').innerText()).toContain('1 application handoff');
    expect(await page.locator('.workspace-body').innerText()).toContain('ledger');
    await page.getByRole('tab', { name: 'Applications' }).click();
    expect(await page.locator('.workspace-body a.primary').getAttribute('href')).toBe('/cockpit/?app=ledger');
    await page.getByRole('tab', { name: 'Shelf' }).click();
    expect(await page.locator('.workspace-body').innerText()).toContain('Synthetic ledger: weekly picture');
    await page.locator('.readback-button').first().click();
    await page.waitForFunction(() => document.querySelector('.readback-status')?.textContent?.includes('BROWSER VOICE'));
    await page.locator('.readback-button').first().click();
    expect(await page.locator('.readback-status').innerText()).toContain('PRESS PLAY');
    expect(errors).toEqual([]);
  });

  it('the portal lists eight experiences, the chooser navigates, and skins are remembered per layout', async () => {
    await open('/portal', '.experience-cards');
    expect(await page.locator('.experience-card').count()).toBe(8);
    expect(await bodyText()).toContain('19 installed applications');
    await open('/studio', '#universal-skin-picker');
    await page.selectOption('#universal-skin-picker', 'ocean');
    expect(await page.evaluate(() => document.body.dataset.skin)).toBe('ocean');
    await page.reload(); await page.waitForSelector('.full-studio');
    expect(await page.evaluate(() => document.body.dataset.skin)).toBe('ocean');
    await open('/jarvis', '.full-jarvis');
    expect(await page.evaluate(() => document.body.dataset.skin)).toBe('jarvis');
    await page.selectOption('[data-role="experience-picker"]', 'orbit');
    await page.waitForURL(/\/orbit$/);
    await page.waitForSelector('.full-orbit');
    expect(await page.locator('.full-orbit').count()).toBe(1);
  });

  it('tells an unauthenticated session to sign in instead of rendering anything', async () => {
    fixture.state.authenticated = false;
    await open('/studio', '.loading-shell');
    const text = await bodyText();
    expect(text).toContain('Sign in to see your swarm.');
    expect(await page.locator('a[href="/login"]').count()).toBe(1);
    expect(text).not.toContain('Synthetic');
  });

  it('a chosen skin becomes the saved cockpit appearance and reaches an embedded application surface', async () => {
    await open('/studio', '#universal-skin-picker');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBeNull();
    await page.selectOption('#universal-skin-picker', 'orbit');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('orbit');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('orbit');
    await page.keyboard.press('Control+k');
    await page.fill('#app-search', 'ledger');
    await page.locator('.catalog-card .catalog-main').click();
    await page.locator('#full-dialog').getByRole('button', { name: 'Open here' }).click();
    const frame = page.frameLocator('#full-dialog iframe.embed-frame');
    await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('orbit');
    await page.selectOption('#universal-skin-picker', 'family');
    await expect.poll(() => frame.locator('html').getAttribute('data-theme')).toBe('family');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBe('family');
  });

  it('a homebase preset paints its own skin on first load without writing the cockpit appearance', async () => {
    await open('/homebase?preset=company', '.home-shell');
    expect(await page.evaluate(() => document.body.dataset.skin)).toBe('company');
    expect(await page.evaluate(() => document.querySelector('.experience')?.getAttribute('data-skin'))).toBe('professional');
    expect(await page.evaluate(() => localStorage.getItem('cockpit-theme'))).toBeNull();
  });
});
