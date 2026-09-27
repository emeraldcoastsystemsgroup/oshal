/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the homebase gap closure in headless Chromium through the real static route registration over the isolated synthetic swarm: learner activity pills and the class summary from the teacher analytics read (and its 403/404 notes), teacher classwork posted to assignments-with-events with the class picker limited to taught classes and refusals rendered as text, the learner checklist opening My Day in place, the ticket project dialog's approval transition with its refusal and no-approval states, the caller's saved drafts and newest finished Jarvis task with empty and failure states, and "Configure home" hidden for guests.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Integration review: the ticket dialog's Reason and Next action rows appear only when metadata.lastStatusTransition describes the current status (after an approval, and for a mirror of an older state, only State shows); the drafts dialog names Content Studio drafts in its heading, empty and failure copy.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Acceptance fixes: family and company send no /api/education request, and Home no Little Monsters ribbon-profile read, unless Little Monsters' read-only probe answers 200 (and none for an entry outside the plan) while the classroom still reads; authorization refusals read "not available to you", the no-profile refusal says to open Little Monsters once, other refusals show their status; UTC-midnight due and event dates show their own day in America/Chicago; the learner card has no completion count or progress bar; an approval_required ticket leads the six project rows; a timed event shows its day. The context setup moved into openContext so a case can choose a zone and locale.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startExperienceBrowserFixture } from '../fixtures/experience-browser';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.setConfig({ testTimeout: 90000, hookTimeout: 60000 });

let browser: Browser, context: BrowserContext, page: Page;
let fixture: Awaited<ReturnType<typeof startExperienceBrowserFixture>>;
const HOUR = 3600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const day = (offsetDays: number) => { const d = new Date(Date.now() + offsetDays * 24 * HOUR); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
/**
 * @description A browser context over the fixture only (every other origin aborted) with speech stubbed, and its page.
 * @param zone Optional timezoneId/locale, so a case can read the page as a reader in a US zone would.
 * @returns Nothing; sets the shared context and page.
 */
async function openContext(zone: { timezoneId?: string; locale?: string } = {}) {
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...zone });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.origin ? route.continue() : route.abort());
  await context.addInitScript(() => {
    // window.speechSynthesis is a read-only accessor: a plain assignment leaves the real engine in place.
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {}, cancel() {}, getVoices() { return []; } }, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: function SpeechSynthesisUtterance() {}, configurable: true });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
}
beforeEach(async () => {
  fixture = await startExperienceBrowserFixture();
  await openContext();
});
afterEach(async () => { await context?.close(); await fixture?.close(); });

const errors: string[] = [];
/** @description Open one homebase, wait for its root and for every live source to answer, so a late repaint never races an assertion. */
async function open(path: string, ready: string) {
  errors.length = 0;
  page.on('pageerror', e => errors.push(String(e && (e as Error).message || e)));
  await page.goto(fixture.origin + path);
  await page.waitForSelector(ready);
  await page.waitForLoadState('networkidle');
}
const dialogText = () => page.locator('#homebase-dialog').innerText();
const toastHas = (text: string) => page.waitForFunction(t => document.getElementById('toast')?.textContent?.includes(t), text);
/**
 * @description The metadata the ticket service writes for one transition: the row-level reason/nextAction board fields
 * and the lastStatusTransition mirror ({ status, ...transition metadata }) that says which state they describe.
 */
const mirror = (status: string, reason: string, nextAction: string) => ({ reason, nextAction, lastStatusTransition: { status, reason, nextAction } });
/** @description A synthetic ticket parked at approval_required with the metadata mirror the ticket service writes. */
function approvalTicket(nextAction: string, reason: string) {
  const ticket = { ticketId: APPROVAL_ID, title: 'Synthetic approval gate', status: 'approval_required', ticketType: 'ledger-review', updatedAt: iso(0), description: 'A synthetic workflow paused at an approval gate.', metadata: mirror('approval_required', reason, nextAction) };
  fixture.state.tickets.push(ticket);
  return ticket;
}
/** @description The fact labels (dt) the open ticket dialog shows. */
const factLabels = () => page.locator('.ticket-facts dt').allInnerTexts();

describe('homebase gap closure over the real routes', () => {
  it('the teacher roster shows each learner’s activity and the class summary, labelled as activity, never completion', async () => {
    fixture.state.education.students.c1 = [
      { student_id: 's1', name: 'Learner One', email: null, enrolled_at: iso(-72 * HOUR), xp: 340, level: 3, streak_days: 4, quiz_average: 82, quiz_count: 2, cards_reviewed: 12, last_active_date: day(0) },
      { student_id: 's2', name: 'Synthetic Learner Two', email: null, enrolled_at: iso(-24 * HOUR), xp: 0, level: 1, streak_days: 0, quiz_average: 0, quiz_count: 0, cards_reviewed: 0, last_active_date: null },
    ];
    fixture.state.education.classes.push({ class_id: 'c2', name: 'Synthetic Art', subject: 'Art', grade_level: '6', teacher_name: 'Synthetic Other Teacher', teacher_student_id: 'stu-9', student_count: '3', status: 'active', published: true });
    await open('/homebase?preset=classroom', '[data-learner="s1"] .activity-pill');
    expect(await page.locator('[data-learner="s1"] .activity-pill').innerText()).toBe('Level 3 · 4-day streak · quiz avg 82% · 12 cards reviewed');
    expect(await page.locator('[data-learner="s2"] .activity-pill').innerText()).toBe('Level 1 · no quiz or flashcard activity yet');
    const roster = await page.locator('[data-module="teacher-roster"]').innerText();
    expect(roster).toContain('Class activity: 1 of 2 learners active in quizzes or flashcards · class quiz average 82% · 12 cards reviewed');
    expect(roster).toContain('last active');
    expect(roster).toContain('is not classwork completion');
    expect(roster).toContain('Only this class’s teacher sees its roster.');
    expect(roster).not.toMatch(/Submitted|\d+\s*\/\s*\d+\s*steps/);
    expect(fixture.state.calls).toContain('GET /api/education/teacher/classes/c1/analytics');
    expect(fixture.state.calls).not.toContain('GET /api/education/teacher/classes/c2/analytics');
    expect(errors).toEqual([]);
  });

  it('an analytics refusal leaves the roster names and states why there is no activity', async () => {
    fixture.state.status['homebase:analytics'] = 403;
    await open('/homebase?preset=classroom', '[data-module="teacher-roster"]');
    let roster = await page.locator('[data-module="teacher-roster"]').innerText();
    expect(roster).toContain('Learner One'); expect(roster).toContain('Only this class’s teacher sees its learners’ activity.');
    expect(await page.locator('.activity-pill').count()).toBe(0);
    fixture.state.status['homebase:analytics'] = 404;
    await page.reload(); await page.waitForSelector('[data-module="teacher-roster"]'); await page.waitForLoadState('networkidle');
    roster = await page.locator('[data-module="teacher-roster"]').innerText();
    expect(roster).toContain('This class’s activity was not found (HTTP 404).');
    expect(await page.locator('.activity-pill').count()).toBe(0);
  });

  it('a teacher posts classwork to a class they teach; the class data refreshes with the item and its calendar event', async () => {
    fixture.state.education.classes.push({ class_id: 'c2', name: 'Synthetic Art', subject: 'Art', grade_level: '6', teacher_name: 'Synthetic Other Teacher', teacher_student_id: 'stu-9', student_count: '3', status: 'active', published: true });
    await open('/homebase?preset=classroom', '[data-module="teacher-roster"]');
    await page.getByRole('button', { name: 'Add classwork' }).click();
    expect(await page.locator('#classwork-class option').allInnerTexts()).toEqual(['Synthetic Science']);
    expect(await page.locator('#classwork-type option').evaluateAll(o => o.map(x => (x as HTMLOptionElement).value))).toEqual(['homework', 'reading', 'project', 'lab', 'quiz-prep', 'test']);
    await page.fill('#classwork-title', 'Synthetic leaf rubbing');
    await page.selectOption('#classwork-type', 'lab');
    await page.fill('#classwork-due', day(3));
    await page.fill('#classwork-description', 'Synthetic: rub two leaves.');
    await page.getByRole('button', { name: 'Post classwork' }).click();
    await toastHas('Classwork added to Synthetic Science and its class calendar.');
    expect(fixture.state.education.assignments.find(a => a.title === 'Synthetic leaf rubbing')).toMatchObject({ class_id: 'c1', assignment_type: 'lab', due_date: day(3), description: 'Synthetic: rub two leaves.' });
    expect(fixture.state.calls).toContain('POST /api/education/assignments-with-events');
    expect(await page.locator('#homebase-dialog').count()).toBe(0);
    expect(await page.locator('[data-module="requirements"]').innerText()).toContain('Synthetic leaf rubbing');
    expect(await page.locator('[data-module="calendar"]').innerText()).toContain('Synthetic Science: Synthetic leaf rubbing');
    expect(errors).toEqual([]);
  });

  it('a classwork refusal stays in the dialog as text, markup included, and nothing is recorded', async () => {
    fixture.state.status['homebase:classwork'] = 403;
    await open('/homebase?preset=classroom', '[data-module="teacher-roster"]');
    const before = fixture.state.education.assignments.length;
    await page.getByRole('button', { name: 'Add classwork' }).click();
    await page.fill('#classwork-title', 'Synthetic refused item');
    await page.getByRole('button', { name: 'Post classwork' }).click();
    await page.waitForFunction(() => document.getElementById('classwork-feedback')?.textContent?.includes('HTTP 403'));
    expect(await page.locator('#classwork-feedback').innerText()).toBe('Could not add the classwork (HTTP 403: You do not teach this class).');
    expect(fixture.state.education.assignments.length).toBe(before);
    await page.route('**/api/education/assignments-with-events', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '<img src=x onerror="window.__refusalRan=1">Synthetic refusal' }) }));
    await page.getByRole('button', { name: 'Post classwork' }).click();
    await page.waitForFunction(() => document.getElementById('classwork-feedback')?.textContent?.includes('HTTP 400'));
    expect(await page.locator('#classwork-feedback').innerText()).toContain('<img src=x');
    expect(await page.locator('#classwork-feedback img').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __refusalRan?: number }).__refusalRan)).toBeUndefined();
  });

  it('a learner gets no classwork form; the checklist claims no submission and opens My Day in place', async () => {
    fixture.state.education.me = { ...fixture.state.education.me, role: 'student' };
    await open('/homebase?preset=classroom', '[data-module="learning"]');
    expect(await page.getByRole('button', { name: 'Add classwork' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Open my checklist' }).first().click();
    const dialog = await dialogText();
    expect(dialog).toContain('Nothing is submitted from here: Little Monsters keeps no per-learner submission record.');
    expect(dialog).not.toMatch(/Submit my|Mark (as )?done|Submitted|Submitting work/);
    await page.locator('#homebase-dialog').getByRole('button', { name: 'Open My Day here' }).click();
    await page.waitForSelector('#tool-frame');
    expect(await page.locator('#tool-frame').getAttribute('src')).toBe('/fixture/surface/lm-myday?audience=classroom');
    expect(await page.locator('#homebase-dialog').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a ticket awaiting a human approval offers "Approve": approval_required moves to approved and the work list reloads', async () => {
    approvalTicket('operator_approve_to_resume', 'approval_gate');
    await open('/homebase?preset=company', `[data-work="ticket:${APPROVAL_ID}"]`);
    await page.locator(`[data-work="ticket:${APPROVAL_ID}"]`).click();
    await page.waitForSelector('.ticket-facts');
    const facts = await page.locator('.ticket-facts').innerText();
    expect(facts).toContain('Approval required'); expect(facts).toContain('approval gate'); expect(facts).toContain('operator approve to resume');
    expect(await factLabels()).toEqual(['State', 'Reason', 'Next action']);
    expect(await dialogText()).not.toMatch(/Mark reviewed|Reviewed/);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await toastHas('the queue picks it up on its next cycle');
    expect(fixture.state.tickets.find(t => t.ticketId === APPROVAL_ID)?.status).toBe('approved');
    expect(fixture.state.calls).toContain(`PUT /api/tickets/${APPROVAL_ID}/status`);
    expect(await page.locator(`[data-work="ticket:${APPROVAL_ID}"]`).innerText()).toContain('Approved');
    // Reopened: the row-level reason/nextAction still name the approval gate, but the mirror now describes 'approved' with no reason.
    await page.locator(`[data-work="ticket:${APPROVAL_ID}"]`).click();
    await page.waitForSelector('.ticket-facts');
    expect(await factLabels()).toEqual(['State']);
    expect(await page.locator('.ticket-facts').innerText()).not.toMatch(/approval gate|operator approve to resume/);
    expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('Reason and Next action show only when the transition mirror describes the ticket’s current state', async () => {
    const older = fixture.state.tickets[0] as unknown as { metadata: Record<string, unknown> };
    older.metadata = mirror('escalated', 'synthetic_escalation', 'synthetic_follow_up');
    const matching = { ticketId: '44444444-4444-4444-8444-444444444444', title: 'Synthetic blocked build', status: 'blocked', ticketType: 'ledger-review', updatedAt: iso(0), description: 'A synthetic blocked ticket.', metadata: mirror('blocked', 'synthetic_dependency_missing', 'synthetic_install_dependency') };
    fixture.state.tickets.push(matching);
    await open('/homebase?preset=company', `[data-work="ticket:${matching.ticketId}"]`);
    await page.locator('[data-work="ticket:11111111-1111-4111-8111-111111111111"]').click();
    await page.waitForSelector('.ticket-facts');
    expect(await factLabels()).toEqual(['State']);
    expect(await page.locator('.ticket-facts').innerText()).not.toMatch(/synthetic escalation|synthetic follow up/);
    await page.keyboard.press('Escape');
    await page.locator(`[data-work="ticket:${matching.ticketId}"]`).click();
    await page.waitForSelector('.ticket-facts');
    expect(await factLabels()).toEqual(['State', 'Reason', 'Next action']);
    const facts = await page.locator('.ticket-facts').innerText();
    expect(facts).toContain('Blocked'); expect(facts).toContain('synthetic dependency missing'); expect(facts).toContain('synthetic install dependency');
    expect(errors).toEqual([]);
  });

  it('the ticket route’s refusal is shown and the ticket is unchanged; no approval is offered when none is awaited', async () => {
    approvalTicket('operator_approve_to_resume', 'approval_gate');
    fixture.state.status['homebase:ticket-status'] = 404;
    await open('/homebase?preset=company', `[data-work="ticket:${APPROVAL_ID}"]`);
    await page.locator(`[data-work="ticket:${APPROVAL_ID}"]`).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('ticket-feedback')?.textContent?.includes('HTTP 404'));
    expect(await page.locator('#ticket-feedback').innerText()).toBe('Could not approve this ticket (HTTP 404: Ticket not found).');
    expect(fixture.state.tickets.find(t => t.ticketId === APPROVAL_ID)?.status).toBe('approval_required');
    await page.keyboard.press('Escape');
    const planning = fixture.state.tickets.find(t => t.ticketId === APPROVAL_ID) as unknown as { metadata: Record<string, string> };
    planning.metadata = mirror('approval_required', 'planning_complete', 'none_children_dispatch_independently') as unknown as Record<string, string>;
    await page.locator(`[data-work="ticket:${APPROVAL_ID}"]`).click();
    await page.waitForSelector('.ticket-facts');
    expect(await dialogText()).toContain('Nothing here waits for your approval: its child tickets dispatch on their own.');
    expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.locator('[data-work="ticket:11111111-1111-4111-8111-111111111111"]').click();
    await page.waitForSelector('.ticket-facts');
    expect(await page.locator('.ticket-facts').innerText()).toContain('Working');
    expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    await page.keyboard.press('Escape');
    fixture.state.status['homebase:ticket'] = 404;
    await page.locator(`[data-work="ticket:${APPROVAL_ID}"]`).click();
    await page.waitForFunction(() => document.getElementById('ticket-slot')?.textContent?.includes('could not be read'));
    expect(await page.locator('#ticket-slot').innerText()).toBe('This ticket’s current state could not be read (HTTP 404: Ticket not found).');
  });

  it('"My drafts" lists the caller’s saved drafts and newest finished Jarvis task, and keeps Open Jarvis', async () => {
    fixture.state.apps = fixture.state.apps.filter(a => a.summary.name !== 'finance');
    const saved = await fetch(`${fixture.origin}/api/content/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: 'Synthetic topic', take: 'Synthetic take', draft: 'Synthetic first line.\nSynthetic second line.\nSynthetic third line.' }) });
    expect(saved.status).toBe(200);
    await open('/homebase?preset=company', '[data-module="personal"]');
    await page.getByRole('button', { name: 'My drafts' }).click();
    await page.waitForFunction(() => document.getElementById('drafts-slot')?.textContent?.includes('Newest finished Jarvis task'));
    const dialog = await dialogText();
    expect(dialog).toContain('Synthetic topic'); expect(dialog).toContain('Your take: Synthetic take');
    expect(dialog).toContain('Synthetic first line. Synthetic second line.'); expect(dialog).not.toContain('Synthetic third line');
    expect(dialog).toContain('Saved just now');
    expect(dialog).toContain('Synthetic ledger: weekly picture'); expect(dialog).toContain('Finished');
    expect(await page.locator('#drafts-slot a[download]').getAttribute('href')).toBe('/api/jarvis/files/synthetic');
    expect(await page.locator('#homebase-dialog a', { hasText: 'Open Jarvis' }).getAttribute('href')).toBe('/api/jarvis/');
    expect(fixture.state.calls).toContain('GET /api/content/drafts');
    expect(errors).toEqual([]);
  });

  it('"My drafts" states empty and failed reads honestly', async () => {
    fixture.state.apps = fixture.state.apps.filter(a => a.summary.name !== 'finance');
    fixture.state.tasks = fixture.state.tasks.filter(t => t.status !== 'done');
    await open('/homebase?preset=company', '[data-module="personal"]');
    await page.getByRole('button', { name: 'My drafts' }).click();
    await page.waitForFunction(() => document.getElementById('drafts-slot')?.textContent?.includes('Newest finished Jarvis task'));
    let dialog = await dialogText();
    expect(dialog).toContain('Your saved Content Studio drafts');
    expect(dialog).toContain('No Content Studio drafts saved yet.'); expect(dialog).toContain('No finished Jarvis task yet.');
    await page.keyboard.press('Escape');
    fixture.state.status['homebase:drafts'] = 500; fixture.state.status.tasks = 503;
    await page.getByRole('button', { name: 'My drafts' }).click();
    await page.waitForFunction(() => document.getElementById('drafts-slot')?.textContent?.includes('Newest finished Jarvis task'));
    dialog = await dialogText();
    expect(dialog).toContain('Your saved Content Studio drafts could not be read (HTTP 500).'); expect(dialog).toContain('Your Jarvis tasks could not be read (HTTP 503).');
    expect(await page.locator('#homebase-dialog a', { hasText: 'Open Jarvis' }).count()).toBe(1);
  });

  it('"Configure home" is offered to a signed-in member and hidden for a guest', async () => {
    await open('/homebase?preset=family', '.home-shell');
    expect(await page.getByRole('button', { name: /^Configure (this )?home$/ }).count()).toBe(2);
    await page.route('**/api/auth/user', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, user: { sub: 'synthetic-guest', email: '', preferred_username: 'Synthetic Guest' }, mode: 'mock', guestMode: true, capabilities: null }) }));
    await page.reload(); await page.waitForSelector('.home-shell'); await page.waitForLoadState('networkidle');
    expect(await page.getByRole('button', { name: /Configure/ }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'My access' }).count()).toBe(1);
    expect(errors).toEqual([]);
  });
});

/** @description Every request the page sent to a Little Monsters education route, as the fixture's request log saw it. */
const educationCalls = () => fixture.state.calls.filter(c => c.includes('/api/education/'));
/** @description Answer a path in the browser with an application-authorization refusal, shaped as the platform's app-access gate writes it. */
const refuseAsAuthorization = (glob: string) => page.route(glob, route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'app_access_denied', app: 'little-monsters', tier: 'deny' }) }));
/** @description A Y-M-D as an en-US reader's calendar prints it, built from its own parts (never through an instant). */
const onCalendar = (ymd: string, options?: Intl.DateTimeFormatOptions) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', options); };
const moduleText = (name: string) => page.locator(`[data-module="${name}"]`).innerText();
/** @description Wait until a module's text contains a phrase. */
const moduleHas = (name: string, text: string) => page.waitForFunction(([n, t]) => (document.querySelector(`[data-module="${n}"]`)?.textContent || '').includes(t), [name, text]);

describe('acceptance fixes: Little Monsters reads, dates, the learner card, projects and the calendar', () => {
  it('family and company read the Little Monsters probe first and send no /api/education request (nor its ribbon profile) unless it answers 200; the classroom still reads', async () => {
    // The ribbon profile asks the package's visibility route, which can provision a learner too; the request log drops the query, so watch the browser.
    const profiles: string[] = [];
    page.on('request', req => { const u = new URL(req.url()); if (u.pathname === '/api/ui/profile') profiles.push(u.searchParams.get('name') || ''); });
    fixture.state.status['lm-home-summary'] = 403;
    for (const preset of ['family', 'company']) {
      fixture.state.calls.length = 0;
      await open(`/homebase?preset=${preset}`, '[data-module="calendar"]');
      await moduleHas('calendar', 'school profile');
      expect(await moduleText('calendar')).toContain('Open Little Monsters once to set up your school profile.');
      expect(fixture.state.calls).toContain('GET /api/little-monsters/home-summary');
      expect(educationCalls()).toEqual([]);
      if (preset === 'family') expect(await page.locator('.home-sidebar .side-kicker', { hasText: 'LITTLE MONSTERS' }).count()).toBe(0);
    }
    expect(profiles).toContain('home'); expect(profiles).not.toContain('little-monsters');
    fixture.state.calls.length = 0;
    await open('/homebase?preset=classroom', '[data-module="teacher-roster"]');
    expect(educationCalls()).toEqual(expect.arrayContaining(['GET /api/education/me', 'GET /api/education/classes', 'GET /api/education/assignments', 'GET /api/education/calendar']));
    expect(profiles).toContain('little-monsters');
    // A 200 probe is what lets the family home read the calendar and host the tools, and it is asked first.
    fixture.state.status['lm-home-summary'] = 200;
    fixture.state.calls.length = 0; profiles.length = 0;
    await open('/homebase?preset=family', '[data-module="calendar"] .event');
    const calls = fixture.state.calls, probeAt = calls.indexOf('GET /api/little-monsters/home-summary');
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(probeAt).toBeLessThan(calls.findIndex(c => c.includes('/api/education/')));
    expect(await moduleText('calendar')).toContain('Science circle');
    expect(profiles).toContain('little-monsters');
    expect(errors).toEqual([]);
  });

  it('an authorization refusal or an entry outside the plan reads "not available to you", never "open Little Monsters once"', async () => {
    await refuseAsAuthorization('**/api/little-monsters/home-summary');
    fixture.state.calls.length = 0;
    await open('/homebase?preset=family', '[data-module="calendar"]');
    await moduleHas('calendar', 'not available to you');
    expect(await moduleText('calendar')).toContain('Little Monsters is not available to you.');
    expect(await moduleText('calendar')).not.toMatch(/Open Little Monsters once|learner profile|HTTP 403/);
    expect(educationCalls()).toEqual([]);
    await page.unroute('**/api/little-monsters/home-summary');
    const lm = fixture.state.apps.find(a => a.summary.name === 'little-monsters')!;
    lm.plan = null;
    fixture.state.calls.length = 0;
    await open('/homebase?preset=company', '[data-module="calendar"]');
    await moduleHas('calendar', 'not available to you');
    expect(await moduleText('calendar')).toContain('Little Monsters is not available to you.');
    expect(fixture.state.calls).not.toContain('GET /api/little-monsters/home-summary');
    expect(educationCalls()).toEqual([]);
    await page.getByRole('button', { name: 'About this data' }).click();
    expect(await dialogText()).toContain('Calendar, classes, classwork and rosters: Little Monsters (not available to you).');
    expect(errors).toEqual([]);
  });

  it('in the classroom an authorization refusal offers no way in; any other refusal shows its status', async () => {
    await refuseAsAuthorization('**/api/education/**');
    await open('/homebase?preset=classroom', '[data-module="learning"]');
    expect(await moduleText('requirements')).toContain('Little Monsters is not available to you.');
    expect(await moduleText('calendar')).toContain('Little Monsters is not available to you.');
    expect(await moduleText('learning')).toContain('Little Monsters is not available to you.');
    expect(await page.locator('[data-module="learning"] a', { hasText: 'Open Little Monsters' }).count()).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Open Little Monsters once|learner profile/);
    await page.unroute('**/api/education/**');
    fixture.state.status['lm-home-summary'] = 500;
    await open('/homebase?preset=family', '[data-module="calendar"]');
    await moduleHas('calendar', 'could not be read');
    expect(await moduleText('calendar')).toContain('The calendar could not be read (HTTP 500: Synthetic summary unavailable).');
  });

  it('date-only due and event dates show the day they name for a reader in a US zone', async () => {
    const due = `${day(3)}T00:00:00.000Z`, edu = fixture.state.education;
    edu.me = { ...edu.me, role: 'student' };
    edu.assignments = [{ assignment_id: 'a9', class_id: 'c1', title: 'Synthetic weather chart', description: 'Synthetic.', status: 'open', due_date: due, class_name: 'Synthetic Science', assignment_type: 'homework' }];
    edu.events = [
      { event_id: 'e8', class_id: 'c1', student_id: null, title: 'Synthetic field trip', event_date: `${day(4)}T00:00:00.000Z`, event_time: null as unknown as string, event_type: 'field-trip', class_name: 'Synthetic Science', subject: 'Science' },
      { event_id: 'e9', class_id: 'c1', student_id: null, title: 'Synthetic lab night', event_date: `${day(5)}T00:00:00.000Z`, event_time: '17:00:00', event_type: 'lab', class_name: 'Synthetic Science', subject: 'Science' },
    ];
    await context.close();
    await openContext({ timezoneId: 'America/Chicago', locale: 'en-US' });
    await open('/homebase?preset=classroom', '[data-module="learning"]');
    // Precondition: in this zone the instant form of the due date is the evening before, the defect this guards.
    expect(await page.evaluate(v => new Date(v).toLocaleDateString('en-US'), due)).not.toBe(onCalendar(day(3)));
    expect(await moduleText('requirements')).toContain(`due ${onCalendar(day(3))}`);
    expect(await moduleText('learning')).toContain(`due ${onCalendar(day(3))}`);
    const trip = page.locator('[data-module="calendar"] .event', { hasText: 'Synthetic field trip' }), lab = page.locator('[data-module="calendar"] .event', { hasText: 'Synthetic lab night' });
    expect((await trip.locator('.event-time').innerText()).trim()).toBe(onCalendar(day(4), { month: 'short', day: 'numeric' }));
    expect((await lab.locator('.event-time').innerText()).replace(/\s+/g, ' ').trim()).toBe(`5:00 PM ${onCalendar(day(5), { weekday: 'short', month: 'short', day: 'numeric' })}`);
    await page.getByRole('button', { name: 'Open my checklist' }).first().click();
    expect(await dialogText()).toContain(`due ${onCalendar(day(3))}`);
    expect(errors).toEqual([]);
  });

  it('the learner card counts open classwork and claims no per-learner completion', async () => {
    const edu = fixture.state.education;
    edu.me = { ...edu.me, role: 'student' };
    edu.assignments.push({ assignment_id: 'a2', class_id: 'c1', title: 'Synthetic finished item', description: '', status: 'completed', due_date: day(-1), class_name: 'Synthetic Science', assignment_type: 'homework' });
    await open('/homebase?preset=classroom', '[data-module="learning"]');
    const card = await moduleText('learning');
    expect(card).toContain('1 class · 1 open classwork item.'); expect(card).toContain('Next: Observe a seed · Synthetic Science · due');
    expect(card).not.toContain('classwork done'); expect(card).not.toMatch(/\d+ \/ \d+/);
    expect(await page.locator('[data-module="learning"] :is([role="progressbar"], .progress-track, .focus-count)').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('a ticket awaiting approval leads the six project rows; the rest stay newest first', async () => {
    const approval = approvalTicket('operator_approve_to_resume', 'approval_gate');
    approval.updatedAt = iso(-10 * HOUR);
    const newer = Array.from({ length: 6 }, (_, i) => ({ ticketId: `5555555${i}-5555-4555-8555-555555555555`, title: `Synthetic newer ${i}`, status: 'in_process', ticketType: 'ledger-review', updatedAt: iso(-(i + 1) * 60_000), description: '' }));
    fixture.state.tickets.push(...newer);
    await open('/homebase?preset=company', '[data-module="projects"] .project-row');
    const rows = await page.locator('[data-module="projects"] .project-row [data-work]').evaluateAll(els => els.map(e => e.getAttribute('data-work')));
    expect(rows).toEqual([`ticket:${APPROVAL_ID}`, ...newer.slice(0, 5).map(t => `ticket:${t.ticketId}`)]);
    expect(await moduleText('projects')).toContain('8 open');
    expect(errors).toEqual([]);
  });

  it('a timed calendar event shows the day it falls on beside its time', async () => {
    fixture.state.education.events.push({ event_id: 'e5', class_id: 'c1', student_id: null, title: 'Synthetic recital', event_date: day(3), event_time: '14:30:00', event_type: 'custom', class_name: 'Synthetic Science', subject: 'Science' });
    await context.close();
    await openContext({ locale: 'en-US' });
    await open('/homebase?preset=family', '[data-module="calendar"] .event');
    const time = (title: string) => page.locator('[data-module="calendar"] .event', { hasText: title }).locator('.event-time').innerText().then(t => t.replace(/\s+/g, ' ').trim());
    expect(await time('Science circle')).toBe('9:00 AM Today');
    expect(await time('Synthetic recital')).toBe(`2:30 PM ${onCalendar(day(3), { weekday: 'short', month: 'short', day: 'numeric' })}`);
    expect(errors).toEqual([]);
  });
});
