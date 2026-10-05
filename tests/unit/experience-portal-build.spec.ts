/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the full-swarm build in headless Chromium through the real static route registration over the isolated synthetic swarm: tickets in every canonical state land on the Commons board and in the Jarvis briefing where the shared status groups put them.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Work panels: a ticket's recorded workflow (stages, step progress, gates, history, children) and its full view, Approve for an approval gate that waits on a person with the route's refusal shown, Cancel behind a confirmation with its refusal, the indeterminate bar on Working items only, and the not-visible / unreadable states.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Routines panel: own routines with a switch, managed ones without, somebody else's absent, workflows by version; pause/resume and the 404 refusal that puts the switch back; an application's routines first; the ask-Jarvis empty state and the refused reads.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Day focus: Studio's ordering, heading and device-only memory; Jarvis's evening copy and the games prompt; Orbit's ringed suites and stream; Commons moving to the Game room and back.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Visual cards: the selected workspace's document picture from the latest work, Finance's monthly spend bars read once, the no-data state, a Finance outside the plan never read, Orbit's engineering illustration, the Game room table and the work panel's picture.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Package facts (registry and record, the listed-only and not-visible states), Orbit's cross-suite follow and Studio's related context, pin focus in the directory and the Commons room grid with the sidebar following, and Orbit's six hubs clear of the legend.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Membership and the caller's place: Commons' team name, members by role with the caller's place and each source read once; the no-team state; Studio's People panel without a directory read; the tenants and location refusals.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Portal sections: the central assistant feature, the three homebases and the four numbered layouts with their live facts and no screenshot, in the demo's order; the classroom card's listed-only and not-in-catalog states without any Little Monsters request.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | The demo's six-width layout check over the four layouts (home, directory, application panel with its package facts, work panel with its workflow) and the portal at four widths; the provenance panel's on-demand reads before and after they are made; the other games in a game's panel.
 * 10 | maintainer@emeraldcoastsystemsgroup.com | Markup the caller types renders as text in the Jarvis thread (the demo's "input remains text" check).
 * 11 | maintainer@emeraldcoastsystemsgroup.com | The demo's remaining interactions end to end: the directory's empty state, Studio's use-as-context, Commons drafts per room, keyboard tabs (arrows, Home, End), an application leading to its room, Room details and the private space opening (they opened nothing before), Orbit's hub ask and its way back, a fresh conversation and the phone-width menu.
 * 12 | maintainer@emeraldcoastsystemsgroup.com | Discover and host installed experience packages through current authorization, preserving member visibility and supported assets.
 * 13 | maintainer@emeraldcoastsystemsgroup.com | Align day-focus wording with operational headings while retaining ordering, device memory and real games question checks.
 * 14 | maintainer@emeraldcoastsystemsgroup.com | Exercise day focus through native Settings while retaining live ordering, local memory and application/room transitions; empty conversations show actual-work briefings.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { portalState, startExperienceBrowserFixture, syntheticApp } from '../fixtures/experience-browser';

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

const LEDGER = '11111111-1111-4111-8111-111111111111';
const APPROVAL = '55555555-5555-4555-8555-555555555555';
/** @description A recorded run over a four-stage registered workflow: two stages done, the third suspended at its gate. */
function recordedWorkflow() {
  const node = (id: string, type: string, title: string) => ({ id, type, title, agentBinding: '' });
  const step = (seq: number, nodeId: string, status: string) => ({ stepId: `s${seq}`, seq, nodeId, nodeType: 'x', nodeTitle: nodeId, agentId: '', status, inputSummary: null, outputSummary: null, startedAt: iso(-HOUR), finishedAt: iso(-HOUR + 1000) });
  return {
    definition: { name: 'Synthetic ledger route', pipeline: 'graph', ticketType: 'ledger-review', defaultWorkerBot: '', declaredReviewerBot: '', historicalSnapshot: false, graphTruncated: false,
      nodes: [node('intake', 'intake', 'Synthetic intake'), node('draft', 'execute-agent', 'Synthetic draft'), node('gate', 'approval-gate', 'Synthetic approval'), node('deliver', 'deliver', 'Synthetic delivery')], edges: [] },
    run: { runId: 'run-1', workflowName: 'Synthetic ledger route', status: 'suspended', outcome: '', reason: '', startedAt: iso(-HOUR), finishedAt: null, resumedCount: 0, stepCount: 3, stepsTruncated: false,
      steps: [step(1, 'intake', 'completed'), step(2, 'draft', 'completed'), step(3, 'gate', 'suspended')] },
    history: [{ fromStatus: 'approved', toStatus: 'in_process_build', changedByLabel: 'Synthetic queue', createdAt: iso(-HOUR) }],
    approvalGates: [{ gateNodeId: 'gate', workflowRunId: 'run-1', requestedAt: iso(-HOUR), disposition: 'awaiting', decision: null }],
    children: [{ ticketId: 'child-1', title: 'Synthetic child ticket', status: 'complete', ticketType: 'ledger-review', assignedAgentId: '' }],
  };
}
/** @description Park a synthetic ticket at approval_required with the transition mirror the ticket service writes. */
function approvalTicket(next: string) {
  const t = { ...ticket(APPROVAL, 'Synthetic approval gate', 'approval_required', -5 * 60000), metadata: { lastStatusTransition: { status: 'approval_required', reason: 'approval_gate', nextAction: next } } };
  fixture.state.tickets.push(t as typeof fixture.state.tickets[number]);
}
const panelText = () => page.locator('#full-dialog').innerText();
type CancelLane = { nexusGap: { cancelStatus: Record<string, number>; cancels: string[] } };

describe('work panels over the ticket routes', () => {
  it('a ticket shows its recorded workflow, and the full view lists every stage, gate, change and child', async () => {
    portalState(fixture.state).ticketWorkflows[LEDGER] = recordedWorkflow();
    await open('/studio', '.running-row');
    await page.locator(`.running-row[data-work="ticket:${LEDGER}"]`).click();
    await page.waitForSelector('#full-dialog .live-stages');
    let text = await panelText();
    expect(text).toContain('Its workflow'); expect(text).toContain('Synthetic ledger route · run suspended');
    expect(text).toMatch(/Step 3 of 4 · now: Synthetic approval\s*50%/);
    expect(await page.locator('#full-dialog .live-stages li').count()).toBe(4);
    expect(await page.locator('#full-dialog .live-stages li.stage-waiting').innerText()).toContain('Synthetic approval');
    expect(fixture.state.calls).toContain(`GET /api/v1/tickets/${LEDGER}/workflow`);
    await page.locator('#full-dialog [data-action="ticket-workflow"]').click();
    await page.waitForSelector('#ticket-workflow-body .live-stages');
    text = await panelText();
    expect(await page.locator('#full-dialog-title').innerText()).toBe('Workflow · Synthetic ledger review');
    expect(text).toContain('gate · awaiting a decision'); expect(text).toMatch(/Approved → Working\s*Synthetic queue/); expect(text).toContain('Synthetic child ticket · Ready');
    expect(text).toContain('not a snapshot of the run');
    expect(await page.locator('#full-dialog a', { hasText: 'Workflow tab' }).getAttribute('href')).toBe(`/cockpit/?ticket=${LEDGER}`);
    expect(errors).toEqual([]);
  });

  it('Approve moves an approval gate to Approved; the route’s refusal is shown and the ticket is unchanged', async () => {
    approvalTicket('operator_approve_to_resume');
    fixture.state.status['homebase:ticket-status'] = 404;
    await open('/jarvis', '.briefing-item');
    await page.locator(`.briefing-item[data-work="ticket:${APPROVAL}"]`).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('work-feedback')?.textContent?.includes('HTTP 404'));
    expect(await page.locator('#work-feedback').innerText()).toBe('Could not approve this ticket (HTTP 404: Ticket not found).');
    expect(fixture.state.tickets.find(t => t.ticketId === APPROVAL)?.status).toBe('approval_required');
    delete fixture.state.status['homebase:ticket-status'];
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('waits for the queue'));
    expect(fixture.state.tickets.find(t => t.ticketId === APPROVAL)?.status).toBe('approved');
    await page.waitForFunction(() => document.querySelector('#full-dialog .badge')?.textContent === 'Approved');
    expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    expect(await page.locator('.jarvis-greeting').innerText()).not.toContain('Synthetic approval gate');
    expect(errors).toEqual([]);
  });

  it('no Approve when the children dispatch on their own, and Cancel asks first, then sends, with its refusal shown', async () => {
    approvalTicket('none_children_dispatch_independently');
    await open('/studio', '.running-row');
    await page.locator(`.running-row[data-work="ticket:${APPROVAL}"]`).click();
    await page.waitForSelector('[data-work-actions]');
    expect(await panelText()).toContain('Nothing here waits for your approval');
    expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
    const lane = (fixture.state as unknown as CancelLane).nexusGap;
    lane.cancelStatus[APPROVAL] = 404;
    await page.getByRole('button', { name: 'Cancel this work' }).click();
    expect(await panelText()).toContain('Cancel “Synthetic approval gate”?');
    await page.getByRole('button', { name: 'Keep it' }).click();
    expect(lane.cancels).toEqual([]);
    await page.getByRole('button', { name: 'Cancel this work' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await page.waitForFunction(() => document.getElementById('work-feedback')?.textContent?.includes('HTTP 404'));
    expect(await page.locator('#work-feedback').innerText()).toBe('Could not cancel this ticket (HTTP 404: Ticket not found).');
    expect(fixture.state.tickets.find(t => t.ticketId === APPROVAL)?.status).toBe('approval_required');
    delete lane.cancelStatus[APPROVAL];
    await page.getByRole('button', { name: 'Cancel this work' }).click();
    await page.getByRole('button', { name: 'Yes, cancel it' }).click();
    await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('Cancelled: Synthetic approval gate'));
    expect(lane.cancels).toEqual([APPROVAL, APPROVAL]);
    expect(fixture.state.tickets.find(t => t.ticketId === APPROVAL)?.status).toBe('cancelled');
    await page.waitForFunction(() => document.querySelector('#full-dialog .badge')?.textContent === 'Cancelled');
    expect(await page.getByRole('button', { name: 'Cancel this work' }).count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('only Working items carry the indeterminate bar, and unreadable or invisible workflows say so', async () => {
    portalState(fixture.state).workflowStatus[LEDGER] = 404;
    fixture.state.status['homebase:ticket'] = 500;
    await open('/studio', '.running-row');
    expect(await page.locator(`.running-row[data-work="ticket:${LEDGER}"] .live-indeterminate`).count()).toBe(1);
    expect(await page.locator('.running-row[data-work="task:task-1"] .live-indeterminate').count()).toBe(0);
    expect(await page.locator('.live-indeterminate').first().getAttribute('aria-label')).toBe('In progress; the queue reports no percentage');
    await page.locator(`.running-row[data-work="ticket:${LEDGER}"]`).click();
    await page.waitForFunction(() => document.querySelector('[data-work-flow]')?.textContent?.includes('not visible to you'));
    expect(await panelText()).toContain('This ticket’s current state could not be read (HTTP 500), so no action is offered.');
    expect(await page.locator('#full-dialog [data-work-actions]').count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.locator('.running-row[data-work="task:task-1"]').click();
    expect(await page.locator('#full-dialog [data-work-flow]').count()).toBe(0);
    expect(errors).toEqual([]);
  });
});

/** @description Seed the caller's routines (one of their own, one an application manages, one an operator's workflow, one somebody else's) and two workflows. */
function seedRoutines() {
  const p = portalState(fixture.state), at = (h: number) => iso(h * HOUR);
  p.schedules.push(
    { id: 'own-1', taskType: 'jarvis-routine', cron: '0 8 * * 1-5', timezone: 'America/Chicago', taskData: { prompt: 'Synthetic weekday briefing' }, status: 'active', createdAt: at(-48), updatedAt: at(-48), nextRunAt: at(14), lastRunAt: at(-10), executionCount: 3, ownerSub: 'synthetic-user', queue: 'ledger' },
    { id: 'app-1', taskType: 'app:finance', cron: '0 6 * * *', taskData: { kind: 'manifest-service-route', scheduleKey: 'sync' }, status: 'active', createdAt: at(-48), updatedAt: at(-48), nextRunAt: at(12), lastRunAt: null, executionCount: 0, ownerSub: null, queue: 'finance' },
    { id: 'wf-1', taskType: 'workflow:ledger-review', cron: '30 7 * * 1', taskData: { prompt: 'Synthetic weekly ledger review' }, status: 'paused', createdAt: at(-48), updatedAt: at(-48), nextRunAt: null, lastRunAt: null, executionCount: 0, ownerSub: 'synthetic-user', queue: 'ledger' },
    { id: 'other-1', taskType: 'jarvis-routine', cron: '0 9 * * *', taskData: { prompt: 'Somebody else’s routine' }, status: 'active', createdAt: at(-48), updatedAt: at(-48), nextRunAt: at(3), lastRunAt: null, executionCount: 0, ownerSub: 'another-user', queue: null },
  );
  p.workflows.push({ id: 'wf-def-1', name: 'Synthetic delivery flow', description: '', version: 4, updatedAt: at(-24), nodeCount: 6, edgeCount: 7 },
    { id: 'wf-def-2', name: 'Synthetic intake flow', description: '', version: 1, updatedAt: at(-72), nodeCount: 3, edgeCount: 2 });
}
const routineRow = (id: string) => page.locator(`[data-routine-row="${id}"]`);

describe('Routines panel over the schedules and Workflow Studio routes', () => {
  it('Jarvis Routines lists the caller’s routines with a switch only on their own, and the workflows by version', async () => {
    seedRoutines();
    await open('/jarvis', '.full-jarvis');
    await page.locator('.jarvis-rail [data-action="routines"]').click();
    await page.waitForSelector('[data-routine-row="own-1"]');
    expect(await page.locator('#full-dialog-title').innerText()).toBe('Routines and workflows');
    expect(await routineRow('own-1').innerText()).toMatch(/Synthetic weekday briefing\s*Weekdays at 08:00 \(America\/Chicago\) · next .* · 3 runs · last 10 h ago/);
    expect(await routineRow('own-1').locator('input[type="checkbox"]').isChecked()).toBe(true);
    expect(await routineRow('app-1').innerText()).toContain('Managed by its application');
    expect(await routineRow('wf-1').innerText()).toContain('Managed by an operator');
    expect(await routineRow('app-1').locator('input').count()).toBe(0);
    expect(await page.locator('#full-dialog').innerText()).not.toContain('Somebody else’s routine');
    const flows = await page.locator('#routines-body .flow-step').allInnerTexts();
    expect(flows[0]).toMatch(/v4\s*Synthetic delivery flow\s*6 steps · updated 1 d ago/); expect(flows).toHaveLength(2);
    expect(await page.locator('#full-dialog a', { hasText: 'Open Workflow Studio' }).getAttribute('href')).toBe('/workflow-studio/');
    expect(errors).toEqual([]);
  });

  it('the switch pauses and resumes only the caller’s routine; a refusal puts it back and says why', async () => {
    seedRoutines();
    await open('/jarvis', '.full-jarvis');
    await page.locator('.jarvis-rail [data-action="routines"]').click();
    const toggle = () => routineRow('own-1').locator('input[type="checkbox"]');
    await toggle().uncheck();
    await page.waitForFunction(() => document.querySelector('[data-routine-note="own-1"]')?.textContent?.includes('Paused for you'));
    expect(portalState(fixture.state).schedules.find(s => s.id === 'own-1')?.status).toBe('paused');
    expect(fixture.state.calls).toContain('POST /api/v1/agent/schedules/own-1/pause');
    expect(await routineRow('own-1').innerText()).toContain('paused');
    await toggle().check();
    await page.waitForFunction(() => document.querySelector('[data-routine-note="own-1"]')?.textContent === 'Resumed for you.');
    expect(portalState(fixture.state).schedules.find(s => s.id === 'own-1')?.status).toBe('active');
    portalState(fixture.state).schedules.find(s => s.id === 'own-1')!.ownerSub = 'another-user';
    await toggle().click();
    await page.waitForFunction(() => document.querySelector('[data-routine-note="own-1"]')?.textContent?.includes('HTTP 404'));
    expect(await page.locator('[data-routine-note="own-1"]').innerText()).toBe('Could not pause this routine (HTTP 404: Schedule not found).');
    expect(await toggle().isChecked()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('an application’s own routines come first when the panel opens from that application', async () => {
    seedRoutines();
    await open('/orbit', '.full-orbit');
    await page.keyboard.press('Control+k'); await page.fill('#app-search', 'ledger');
    await page.locator('.catalog-card .catalog-main').click();
    await page.locator('#full-dialog [data-action="routines"]').click();
    await page.waitForSelector('[data-routine-row="own-1"]');
    const body = await page.locator('#routines-body').innerText();
    expect(body).toMatch(/For Synthetic ledger[\s\S]*Synthetic weekday briefing[\s\S]*Synthetic weekly ledger review[\s\S]*Your other routines[\s\S]*app:finance/);
    expect(errors).toEqual([]);
  });

  it('without routines the panel offers to ask Jarvis for one, and refused reads say so', async () => {
    portalState(fixture.state).workflowsStatus = 503;
    await open('/jarvis', '.full-jarvis');
    await page.locator('.jarvis-rail [data-action="routines"]').click();
    await page.waitForSelector('#routines-body [data-action="prompt"]');
    expect(await page.locator('#routines-body').innerText()).toContain('Workflow Studio definitions could not be read (HTTP 503).');
    await page.locator('#routines-body [data-action="prompt"]').click();
    await page.waitForSelector('.conversation-list .message-content p strong');
    expect(fixture.state.asks[0].message).toBe('Every weekday at 8am, brief me on what is waiting for me across my swarm.');
    portalState(fixture.state).schedulesStatus = 500;
    await page.reload(); await page.waitForSelector('.full-jarvis');
    await page.locator('.jarvis-rail [data-action="routines"]').click();
    await page.waitForFunction(() => document.getElementById('routines-body')?.textContent?.includes('HTTP 500'));
    expect(await page.locator('#routines-body').innerText()).toContain('Your routines could not be read (HTTP 500).');
    expect(errors).toEqual([]);
  });
});

/** @description A finished Jarvis task attributed (by its title prefix) to the synthetic Home & life application. */
function homeTask() {
  fixture.state.tasks.unshift({ id: 'task-home', title: 'Synthetic hearth: evening lights', status: 'running', kind: 'simple', result: '', createdAt: iso(-4 * HOUR), finishedAt: iso(-4 * HOUR) } as typeof fixture.state.tasks[number]);
}
async function openSettings() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForSelector('#full-dialog #scene-picker');
}
async function currentFocus() {
  await openSettings();
  const value = await page.locator('#scene-picker').inputValue();
  await page.keyboard.press('Escape');
  return value;
}
async function focus(value: string) {
  await openSettings();
  await page.selectOption('#scene-picker', value);
  await page.keyboard.press('Escape');
}

describe('day focus (workday / evening at home)', () => {
  it('Studio orders its work by the focus, changes its heading and remembers the choice on this device only', async () => {
    homeTask();
    await open('/studio', '.running-row');
    expect(await currentFocus()).toBe('workday');
    expect(await page.locator('.studio-conversation h1').innerText()).toBe('Recent Work');
    const rows = () => page.locator('.running-row').evaluateAll(es => es.map(e => e.getAttribute('data-work')));
    expect(await rows()).not.toContain('task:task-home');
    await focus('evening');
    await page.waitForFunction(() => document.querySelector('.studio-conversation h1')?.textContent === 'Evening Work');
    const evening = await rows();
    expect(evening.indexOf('task:task-home')).toBeGreaterThanOrEqual(0);
    expect(evening.indexOf('task:task-home')).toBeLessThan(evening.indexOf(`ticket:${LEDGER}`));
    expect(await page.locator('.running-row').count()).toBe(4);
    expect(await page.locator('.studio-conversation .user-message').count()).toBe(0);
    expect(await page.locator('.work-briefing .badge').innerText()).toBe('Evening');
    expect(await page.locator('.work-briefing').innerText()).toContain('Synthetic failed task');
    expect(await page.locator('#toast').innerText()).toContain('Nothing is hidden');
    expect(await page.locator('.context-app small').innerText()).toMatch(/^(Home & life|Creative & games)/);
    expect(await page.evaluate(() => localStorage.getItem('oshal-experience:scene:studio'))).toBe('"evening"');
    await page.reload(); await page.waitForSelector('.running-row');
    expect(await currentFocus()).toBe('evening');
    expect(fixture.state.calls.some(c => /scene/i.test(c))).toBe(false);
    expect(errors).toEqual([]);
  });

  it('Jarvis greets the evening, offers what to play from the installed games and asks Jarvis with their names', async () => {
    await open('/jarvis', '.full-jarvis');
    expect(await page.getByRole('button', { name: 'What can I play tonight?' }).count()).toBe(0);
    await focus('evening');
    await expect.poll(() => page.locator('.jarvis-greeting h1').innerText()).toMatch(/^Evening\s*Work overview$/);
    expect(await page.locator('.briefing-card .badge').first().innerText()).toBe('This evening · from your queue');
    expect(await page.locator('.briefing-card h2').innerText()).toMatch(/^\d+ items? to review this evening\.$/);
    await page.getByRole('button', { name: 'What can I play tonight?' }).click();
    await page.waitForSelector('.conversation-list .message-content p strong');
    expect(fixture.state.asks[0].message).toBe('Which of my games could we play tonight: Synthetic arcade-games? Suggest one and what it needs.');
    expect(errors).toEqual([]);
  });

  it('Orbit rings the focus suites and streams their work first; Commons moves to the Game room and back', async () => {
    homeTask();
    await open('/orbit', '.full-orbit');
    expect(await page.locator('.suite-node.in-focus').count()).toBe(4);
    await focus('evening');
    await page.waitForFunction(() => document.querySelectorAll('.suite-node.in-focus').length === 2);
    const ringed = await page.locator('.suite-node.in-focus').evaluateAll(es => es.map(e => e.getAttribute('data-suite')).sort());
    expect(ringed).toEqual(['ai-creative', 'ai-home']);
    const stream = await page.locator('.orbit-stream .work-item').evaluateAll(es => es.map(e => e.getAttribute('data-work')));
    expect(stream.slice(0, 2)).toContain('task:task-home');
    expect(await page.locator('.orbit-map-heading .eyebrow').innerText()).toMatch(/an evening at home/i);
    await open('/commons', '.full-commons');
    expect(await page.locator('.room-header h1').innerText()).toContain('Finance room');
    await focus('evening');
    await page.waitForFunction(() => document.querySelector('.room-header h1')?.textContent?.includes('Game room'));
    await focus('workday');
    await page.waitForFunction(() => document.querySelector('.room-header h1')?.textContent?.includes('Finance room'));
    expect(errors).toEqual([]);
  });
});

const financeReads = () => fixture.state.calls.filter(c => c === 'GET /api/finance/summary').length;
/** @description Make Synthetic finance the Studio's selected application through the directory's "Use as my context". */
async function selectFinance() {
  await page.keyboard.press('Control+k'); await page.fill('#app-search', 'Synthetic finance');
  await page.locator('.catalog-card[data-catalog-app="finance"] .catalog-main').click();
  await page.locator('#full-dialog [data-action="use-context"]').click();
  await page.waitForSelector('.full-context [data-visual-finance="finance"]');
}

describe('visual cards over real facts', () => {
  it('Studio pictures the selected application with its latest work, and Finance draws the caller’s monthly spend', async () => {
    await open('/studio', '.full-context');
    const ledger = page.locator('.full-context [data-visual="ledger"]');
    expect(await ledger.getAttribute('class')).toContain('document-visual');
    expect(await ledger.locator('.visual-label').innerText()).toBe('FINANCE / WORKING');
    expect(await ledger.locator('h3').innerText()).toBe('Synthetic ledger review');
    expect(await ledger.locator('.visual-footer').innerText()).toMatch(/^Synthetic ledger · ledger review · 1 h ago$/);
    await selectFinance();
    await page.waitForSelector('.full-context .finance-bars span');
    const money = page.locator('.full-context [data-visual-finance="finance"]');
    expect(await money.locator('.finance-bars small').allInnerTexts()).toEqual(['Aug', 'Sep']);
    expect(await money.locator('.finance-bars span').first().getAttribute('style')).toBe('height:50%');
    expect(await money.locator('h3').innerText()).toMatch(/200 spent\s*in Sep\./);
    expect(await money.locator('.visual-footer').innerText()).toBe('Synced 2 d ago · from Finance');
    expect(await money.locator('.finance-bars').getAttribute('aria-label')).toBe('Monthly spend from your synced accounts: Aug 100, Sep 200');
    expect(financeReads()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('Finance with nothing synced says so; a Finance outside the caller’s plan is never read and gets an illustration', async () => {
    fixture.state.finance.status = 404;
    await open('/studio', '.full-context');
    await selectFinance();
    await page.waitForFunction(() => document.querySelector('.full-context [data-visual-finance] h3')?.textContent === 'No synced accounts yet.');
    await fixture.close();
    fixture = await startExperienceBrowserFixture();
    const finance = fixture.state.apps.find(a => a.summary.name === 'finance')!;
    (finance as { plan: unknown }).plan = null;
    await open('/studio', '.full-context');
    await page.keyboard.press('Control+k'); await page.fill('#app-search', 'Synthetic finance');
    await page.locator('.catalog-card[data-catalog-app="finance"] .catalog-main').click();
    await page.waitForSelector('#full-dialog [data-visual="finance"]');
    expect(await page.locator('#full-dialog [data-visual="finance"]').getAttribute('class')).toContain('document-visual');
    expect(await page.locator('#full-dialog [data-visual-finance]').count()).toBe(0);
    expect(financeReads()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('Orbit pictures an engineering application as a labelled illustration; the Game room and a work panel carry theirs', async () => {
    await open('/orbit', '.full-orbit');
    await page.locator('.suite-node[data-suite="ai-engineering"]').click();
    await page.locator('.orbit-app[data-app="forge"]').click();
    const forge = page.locator('.orbit-inspector [data-visual="forge"]');
    expect(await forge.getAttribute('class')).toContain('engineering-visual');
    expect(await forge.locator('svg').count()).toBe(1);
    expect(await forge.locator('.visual-footer').innerText()).toBe('Illustration · Synthetic forge has no recorded work yet');
    await open('/commons', '.full-commons');
    await page.locator('.commons-sidebar [data-action="room"][data-suite="games"]').click();
    const table = page.locator('.room-feed [data-visual="arcade-games"]');
    expect(await table.getAttribute('class')).toContain('game-visual');
    expect(await table.locator('h3').innerText()).toMatch(/Synthetic arcade-games\s*awaits\./);
    await open('/studio', '.running-row');
    await page.locator(`.running-row[data-work="ticket:${LEDGER}"]`).click();
    expect(await page.locator('#full-dialog [data-visual="ledger"] h3').innerText()).toBe('Synthetic ledger review');
    expect(errors).toEqual([]);
  });
});

type Manifests = { fullSwarm: { manifests: Record<string, Record<string, unknown>> } };
/** @description Open one application's panel from the directory. */
async function appPanel(name: string) {
  await page.keyboard.press('Control+k'); await page.fill('#app-search', name);
  await page.locator(`.catalog-card[data-catalog-app="${name}"] .catalog-main`).click();
  await page.waitForSelector('#full-dialog .app-detail-header');
}

describe('package facts, relationship navigation and pins', () => {
  it('the application panel lists its package facts from the registry and the viewer-scoped record', async () => {
    await open('/studio', '.full-studio');
    await appPanel('ledger');
    await page.waitForFunction(() => (document.querySelector('#full-dialog [data-detail-part="facts"]')?.textContent || '').includes('Registered agents'));
    await page.locator('#full-dialog .package-facts summary').click();
    const facts = await page.locator('#full-dialog .package-facts').innerText();
    for (const line of [/Package\s*ledger/, /Version\s*0\.0\.1/, /Kind\s*Application/, /Suite\s*Finance/, /Listing status\s*active \(registry metadata, not live verification\)/, /In your plan\s*Yes/,
      /Ticket type\s*ledger-review/, /First surface\s*ledger-home/, /Skin\s*midnight/, /Tools declared\s*2/, /Kernel skills used\s*app-dependencies/, /Registered agents\s*2/, /Record status\s*active/]) expect(facts).toMatch(line);
    await page.keyboard.press('Escape');
    fixture.state.status['detail:unadmitted'] = 404;
    await appPanel('unadmitted');
    await page.waitForFunction(() => (document.querySelector('#full-dialog [data-detail-part="facts"]')?.textContent || '').includes('Not visible to you'));
    await page.locator('#full-dialog .package-facts summary').click();
    expect(await page.locator('#full-dialog .package-facts').innerText()).toMatch(/In your plan\s*No: listed only, not admitted for you/);
    expect(errors).toEqual([]);
  });

  it('Orbit follows a relationship into another suite, and Studio makes a related application the context', async () => {
    (fixture.state as unknown as Manifests).fullSwarm.manifests.forge = { dependencies: { optional: { apps: ['arcade-games'] } } };
    await open('/orbit', '.full-orbit');
    await page.locator('.suite-node[data-suite="ai-engineering"]').click();
    await page.locator('.orbit-app[data-app="forge"]').click();
    await page.locator('.orbit-inspector [data-detail-part="relations"] [data-action="select-app"][data-app="arcade-games"]').click();
    await page.waitForFunction(() => document.querySelector('.orbit-inspector h2')?.textContent === 'Synthetic arcade-games');
    expect(await page.locator('.orbit-map-heading h1').innerText()).toBe('Creative & games');
    expect(await page.locator('.orbit-app').count()).toBe(2);
    await open('/studio', '.full-context');
    await page.waitForSelector('.full-context [data-detail-part="relations"] [data-action="select-app"][data-app="finance"]');
    await page.locator('.full-context [data-detail-part="relations"] [data-action="select-app"][data-app="finance"]').click();
    await page.waitForFunction(() => document.querySelector('.crumb .title')?.textContent === 'Synthetic finance');
    expect(await page.locator('#full-dialog').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('pinning keeps the keyboard on the pin in the directory and in the Commons room grid, and the sidebar follows', async () => {
    await open('/commons', '.full-commons');
    await page.keyboard.press('Control+k'); await page.fill('#app-search', 'Synthetic');
    const pin = page.locator('.catalog-card[data-catalog-app="stage"] [data-action="pin"]');
    await pin.focus(); await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.closest('[data-catalog-app]')?.getAttribute('data-catalog-app'))).toBe('stage');
    expect(await pin.getAttribute('aria-pressed')).toBe('true');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /Applications/ }).click();
    const roomPin = page.locator('.room-app-grid [data-catalog-app="ledger"] [data-action="pin"]');
    const before = await roomPin.getAttribute('aria-pressed');
    await roomPin.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(b => document.querySelector('.room-app-grid [data-catalog-app="ledger"] [data-action="pin"]')?.getAttribute('aria-pressed') !== b, before);
    expect(await page.evaluate(() => document.activeElement?.closest('[data-catalog-app]')?.getAttribute('data-catalog-app'))).toBe('ledger');
    const pinnedSide = await page.locator('.commons-sidebar .side-navigation').nth(1).innerText();
    expect(pinnedSide.includes('Synthetic ledger')).toBe(before !== 'true');
    expect(errors).toEqual([]);
  });

  it('Orbit seats six suites around the hub without covering the legend', async () => {
    await open('/orbit', '.full-orbit');
    const boxes = await page.evaluate(() => {
      const r = (e: Element) => e.getBoundingClientRect();
      return { legend: r(document.querySelector('.map-legend')!), nodes: Array.from(document.querySelectorAll('.suite-node')).map(r) };
    });
    expect(boxes.nodes).toHaveLength(6);
    for (const n of boxes.nodes) expect(n.bottom <= boxes.legend.top || n.top >= boxes.legend.bottom || n.right <= boxes.legend.left || n.left >= boxes.legend.right).toBe(true);
    expect(await page.locator('.suite-node[data-suite="ai-productivity"]').getAttribute('style')).toContain('--node-y:84.0%');
  });
});

/** @description The caller belongs to a synthetic household and a synthetic team (admin of the team, with two other members). */
function seedTeam() {
  const p = portalState(fixture.state);
  p.tenants.push({ tenant_id: 't-home', kind: 'space', name: 'Synthetic household', role: 'member' }, { tenant_id: 't-team', kind: 'org', name: 'Synthetic team', role: 'admin' });
  p.members['t-team'] = [{ user_sub: 'synthetic-user', role: 'admin' }, { user_sub: 'other', role: 'member' }, { user_sub: 'unlisted-sub', role: 'member' }];
  p.members['t-home'] = [{ user_sub: 'synthetic-user', role: 'member' }];
  p.location.body = { ...p.location.body, current: { deviceId: 'd1', source: 'browser', precisionClass: 'place', accuracyM: 30, receivedAt: iso(-300000), ageSeconds: 300, place: { placeId: 'p1', name: 'Synthetic home', label: 'home' } } };
}
const callsTo = (entry: string) => fixture.state.calls.filter(c => c === entry).length;

describe('household and team membership, and the caller’s own place', () => {
  it('Commons names the team, lists its members by role with the caller’s place, and reads each source once', async () => {
    seedTeam();
    await open('/commons', '.full-commons');
    await page.waitForFunction(() => document.querySelector('.workspace-name h2')?.textContent === 'Synthetic team');
    expect(await page.locator('.workspace-name small').innerText()).toMatch(/^Your team · 19 applications · 6 suites$/);
    await page.waitForFunction(() => (document.querySelector('.presence-panel [data-membership-slot="room"]')?.textContent || '').includes('Other Person'));
    const team = await page.locator('.presence-panel [data-membership-slot="room"]').innerText();
    expect(team).toMatch(/synthetic · you\s*Admin · At Synthetic home · 5 min ago/);
    expect(team).toMatch(/Other Person\s*Member/); expect(team).toMatch(/\nMember\s*\nMember/);
    expect(team).toContain('Synthetic team · your team · 3 members. Membership, not presence');
    expect(await page.locator('.room-header .avatars').getAttribute('aria-label')).toBe('3 members of Synthetic team, and Jarvis');
    expect(await page.locator('.presence-panel').innerText()).toMatch(/Your team[\s\S]*People on this swarm/i);
    for (const call of ['GET /api/tenants', 'GET /api/tenants/t-team/members', 'GET /api/location/state', 'GET /api/user-directory']) expect(callsTo(call), call).toBe(1);
    expect(callsTo('GET /api/tenants/t-home/members')).toBe(0);
    expect(errors).toEqual([]);
  });

  it('without a household or team Commons stays the caller’s swarm and the People panel says so', async () => {
    await open('/commons', '.full-commons');
    await page.waitForFunction(() => document.querySelector('.presence-panel [data-roster-slot="room"]')?.textContent?.includes('Location sharing is off'));
    expect(await page.locator('.workspace-name h2').innerText()).toBe('synthetic’s swarm');
    expect(await page.locator('.presence-panel [data-membership-slot]').count()).toBe(0);
    await page.locator('.commons-rail [data-action="people"]').click();
    await page.waitForFunction(() => document.querySelector('#full-dialog [data-membership-slot="panel"]')?.textContent?.includes('no household or team'));
    expect(errors).toEqual([]);
  });

  it('Studio’s People panel lists the team by role without reading the directory; refusals read as such', async () => {
    seedTeam();
    await open('/studio', '.full-studio');
    await page.locator('.studio-sidebar [data-action="people"]').click();
    await page.waitForFunction(() => (document.querySelector('#full-dialog [data-membership-slot="panel"]')?.textContent || '').includes('3 members'));
    const panel = await page.locator('#full-dialog [data-membership-slot="panel"]').innerText();
    expect(panel).toMatch(/synthetic · you\s*Admin · At Synthetic home/); expect(panel).not.toContain('Other Person');
    expect(callsTo('GET /api/user-directory')).toBe(0);
    portalState(fixture.state).tenantsStatus = 500;
    portalState(fixture.state).location.status = 403;
    await page.reload(); await page.waitForSelector('.full-studio');
    await page.locator('.studio-sidebar [data-action="people"]').click();
    await page.waitForFunction(() => (document.querySelector('#full-dialog [data-membership-slot="panel"]')?.textContent || '').includes('HTTP 500'));
    expect(await page.locator('#full-dialog [data-membership-slot="panel"]').innerText()).toBe('Your households and teams could not be read (HTTP 500).');
    await page.keyboard.press('Escape');
    await open('/commons', '.full-commons');
    await page.waitForFunction(() => (document.querySelector('.presence-panel [data-roster-slot="room"]')?.textContent || '').includes('HTTP 403'));
    expect(await page.locator('.presence-panel [data-roster-slot="room"]').innerText()).toContain('Location is not available to this session (HTTP 403)');
    expect(errors).toEqual([]);
  });
});

describe('portal sections over the installed authorized experiences', () => {
  it('lists package entries and current work without advertising an uninstalled layout', async () => {
    await open('/portal', '[data-experience-package]');
    expect(await page.locator('[data-experience-package]').count()).toBe(7);
    expect(await page.locator('[data-experience-package]').evaluateAll(es => es.map(e => e.getAttribute('href')))).toEqual(fixture.state.experiences.map(e => `/api/ui/experiences/${e.app}/open`));
    expect(await page.locator('#recent-work').innerText()).toContain('Synthetic ledger review');
    expect(await page.locator('#portal-root img').count()).toBe(0);
    expect(await page.getByRole('link', { name: 'Assistant', exact: true }).getAttribute('href')).toBe('/nexus');
    expect(await page.getByRole('link', { name: 'Simple chat', exact: true }).getAttribute('href')).toBe('/simple');
    expect(errors).toEqual([]);
  });

  it('updates the chooser from discovery and follows the package entry', async () => {
    fixture.state.experiences = fixture.state.experiences.filter(e => e.skin === 'classroom');
    await open('/portal', '[data-experience-package]');
    expect(await page.locator('[data-experience-package]').count()).toBe(1);
    await page.locator('[data-experience-package]').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/fixture/experience/classroom.html');
    expect(errors).toEqual([]);
  });

  it('distinguishes an empty authorized catalog from a discovery outage', async () => {
    fixture.state.experiences = [];
    await open('/portal', '#experiences');
    expect(await page.locator('#experiences').innerText()).toContain('No experiences are available');
    fixture.state.status.experiences = 503;
    await page.reload();
    await page.getByRole('heading', { name: 'Experiences unavailable' }).waitFor();
    expect(await page.locator('[data-experience-package]').count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
/** @description The demo's layout check: no horizontal page overflow and no control or heading outside the viewport (closed dialogs excepted). */
async function layoutProblems() {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out = Array.from(document.querySelectorAll('button,input,textarea,select,h1,h2,h3')).filter(e => {
      if (e.closest('dialog:not([open])')) return false;
      const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > width + 2 || r.left < -2);
    }).map(e => e.outerHTML.slice(0, 120));
    return { pageOverflow: document.documentElement.scrollWidth > width + 1, elements: out };
  });
}
const CLEAN = { pageOverflow: false, elements: [] };

describe('six widths, the provenance of on-demand reads, and the other games', () => {
  for (const layout of ['studio', 'jarvis', 'orbit', 'commons']) {
    it(`${layout}: home, directory, application panel and work panel fit from 1440 down to 320 pixels`, async () => {
      portalState(fixture.state).ticketWorkflows[LEDGER] = recordedWorkflow();
      for (const width of [1440, 1024, 768, 600, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await open(`/${layout}`, '.app-shell');
        await page.waitForTimeout(150);
        expect(await layoutProblems(), `${layout} home ${width}`).toEqual(CLEAN);
        await page.keyboard.press('Control+k'); await page.waitForSelector('#app-search');
        await page.locator('[data-action="filter"][data-suite="ai-engineering"]').click();
        expect(await layoutProblems(), `${layout} directory ${width}`).toEqual(CLEAN);
        expect(await page.locator('.directory-panel').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
        await page.locator('.catalog-card[data-catalog-app="forge"] .catalog-main').click();
        await page.waitForSelector('#full-dialog [data-detail-part="facts"] .package-facts');
        expect(await layoutProblems(), `${layout} app panel ${width}`).toEqual(CLEAN);
        await page.keyboard.press('Escape');
        // The work list is opened programmatically: at phone width the layout's own entry sits in a collapsed menu.
        await page.evaluate(() => (document.querySelector('[data-action="all-work"]') as HTMLElement).click());
        await page.locator(`#full-dialog [data-work="ticket:${LEDGER}"]`).click();
        await page.waitForSelector('#full-dialog .live-stages');
        expect(await layoutProblems(), `${layout} work panel ${width}`).toEqual(CLEAN);
        await page.keyboard.press('Escape');
      }
      expect(errors).toEqual([]);
    });
  }

  it('the portal fits at 1440, 768, 390 and 320 pixels', async () => {
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await open('/portal', '#experiences');
      expect(await layoutProblems(), `portal ${width}`).toEqual(CLEAN);
    }
  });

  it('"What is live" names each on-demand read with its status once made, and a game lists the other games', async () => {
    fixture.state.apps.push(syntheticApp('dungeon-crawl', 'ai-creative'));
    portalState(fixture.state).tenantsStatus = 503;
    await open('/jarvis', '.full-jarvis');
    await page.locator('.jarvis-footer [data-action="provenance"]').click();
    let facts = await page.locator('#full-dialog .provenance-facts').innerText();
    expect(facts).toMatch(/Your routines\s*\/api\/v1\/agent\/schedules · read when you open it/);
    expect(facts).toMatch(/Your households and teams\s*\/api\/tenants · read when you open it/);
    await page.keyboard.press('Escape');
    await page.locator('.jarvis-rail [data-action="routines"]').click();
    await page.waitForSelector('#routines-body .note-line');
    await page.keyboard.press('Escape');
    await page.locator('.jarvis-rail [data-action="people"]').click();
    await page.waitForFunction(() => (document.querySelector('#full-dialog [data-membership-slot]')?.textContent || '').includes('HTTP 503'));
    await page.keyboard.press('Escape');
    await page.locator('.jarvis-footer [data-action="provenance"]').click();
    facts = await page.locator('#full-dialog .provenance-facts').innerText();
    expect(facts).toMatch(/Your routines\s*\/api\/v1\/agent\/schedules · live/);
    expect(facts).toMatch(/Your households and teams\s*\/api\/tenants · HTTP 503/);
    expect(facts).toMatch(/Your own place \(ADR-169\)\s*\/api\/location\/state · live/);
    expect(await page.locator('#full-dialog').innerText()).toContain('only your own place is shown');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k'); await page.fill('#app-search', 'arcade');
    await page.locator('.catalog-card[data-catalog-app="arcade-games"] .catalog-main').click();
    expect(await page.locator('#full-dialog').innerText()).toMatch(/Other games on this swarm\s*Synthetic dungeon-crawl/);
    await page.locator('#full-dialog [data-action="open-app"][data-app="dungeon-crawl"]').click();
    expect(await page.locator('#full-dialog-title').innerText()).toBe('Synthetic dungeon-crawl');
    expect(errors).toEqual([]);
  });
});

describe('the conversation keeps what the caller types as text', () => {
  it('markup sent to Jarvis renders as text in the thread, never as an element', async () => {
    await open('/studio', '#message-input');
    await page.fill('#message-input', '<img src=x onerror="window.__owned=1">');
    await page.press('#message-input', 'Enter');
    await page.waitForSelector('.conversation-list .message-content p strong');
    expect(await page.locator('.conversation-list .user-message img').count()).toBe(0);
    expect(await page.locator('.conversation-list .user-message').last().innerText()).toBe('<img src=x onerror="window.__owned=1">');
    expect(await page.evaluate(() => (window as unknown as { __owned?: number }).__owned)).toBeUndefined();
    expect(fixture.state.asks[0].message).toBe('<img src=x onerror="window.__owned=1">');
    expect(errors).toEqual([]);
  });
});

describe('demo interactions end to end: directory, rooms, drafts, tabs, room details, private space, Orbit ask and back, new conversation, phone menu', () => {
  it('the directory says when nothing matches, and Studio makes an application the conversation context', async () => {
    await open('/studio', '.full-studio');
    await page.keyboard.press('Control+k'); await page.fill('#app-search', 'no-such-application-123');
    expect(await page.locator('#catalog-results').innerText()).toContain('No matching applications');
    expect(await page.locator('#catalog-result-count').innerText()).toBe('0 of 19 applications');
    await page.fill('#app-search', 'forge');
    await page.locator('.catalog-card[data-catalog-app="forge"] .catalog-main').click();
    await page.locator('#full-dialog [data-action="use-context"]').click();
    expect(await page.locator('.context-token').innerText()).toBe('Synthetic forge');
    expect(await page.locator('.crumb .title').innerText()).toBe('Synthetic forge');
    expect(errors).toEqual([]);
  });

  it('Commons keeps drafts per room, moves between tabs by keyboard, and an application leads to its room', async () => {
    await open('/commons', '.full-commons');
    await page.fill('#message-input', 'Draft for finance only');
    await page.locator('.commons-sidebar [data-action="room"][data-suite="ai-engineering"]').click();
    expect(await page.locator('#message-input').inputValue()).toBe('');
    await page.locator('.commons-sidebar [data-action="room"][data-suite="ai-finance"]').click();
    expect(await page.locator('#message-input').inputValue()).toBe('Draft for finance only');
    await page.getByRole('tab', { name: 'Conversation' }).focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.locator('#full-tab-apps').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('End');
    expect(await page.locator('#full-tab-board').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Home');
    expect(await page.locator('#full-tab-conversation').getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Control+k'); await page.fill('#app-search', 'forge');
    await page.locator('.catalog-card[data-catalog-app="forge"] .catalog-main').click();
    await page.locator('#full-dialog [data-action="use-context"]').click();
    expect(await page.locator('.room-header h1').innerText()).toContain('Engineering room');
    expect(await page.locator('.context-token').innerText()).toBe('Engineering room');
    expect(await page.locator('#toast').innerText()).toBe('Opened the room for Synthetic forge.');
    expect(errors).toEqual([]);
  });

  it('Commons room details and the private space open and describe what is shared; Orbit asks Jarvis from its hub and returns to the whole swarm', async () => {
    await open('/commons', '.full-commons');
    await page.locator('.room-header [data-action="room-details"]').click();
    expect(await page.locator('#full-dialog-title').innerText()).toBe('Finance room');
    expect(await page.locator('#full-dialog').innerText()).toMatch(/3 applications in this room[\s\S]*no other person’s accounts or conversations are read/);
    await page.keyboard.press('Escape');
    await page.locator('.commons-rail [data-action="private"]').click();
    expect(await page.locator('#full-dialog-title').innerText()).toBe('Your private space');
    expect(await page.locator('#full-dialog').innerText()).toContain('stay in their own applications and your own Jarvis thread');
    await page.keyboard.press('Escape');
    await open('/orbit', '.full-orbit');
    await page.locator('.orbit-hub[data-action="ask"]').click();
    await page.fill('#ask-input', 'What needs me in Orbit?');
    await page.locator('#ask-form button[type="submit"]').click();
    await page.waitForSelector('#ask-response .message-content p strong');
    expect(fixture.state.asks[0].message).toBe('What needs me in Orbit?');
    await page.keyboard.press('Escape');
    await page.locator('.suite-node[data-suite="ai-finance"]').click();
    expect(await page.locator('.suite-node').count()).toBe(0);
    await page.locator('[data-action="orbit-back"]').click();
    expect(await page.locator('.suite-node').count()).toBe(6);
    expect(errors).toEqual([]);
  });

  it('Studio starts a fresh conversation, and its phone-width menu opens and says so', async () => {
    await open('/studio', '#message-input');
    const before = await page.evaluate(() => localStorage.getItem('jarvisSessionId'));
    await page.locator('.studio-sidebar [data-action="new"]').click();
    expect(await page.locator('#toast').innerText()).toBe('Started a fresh conversation.');
    expect(await page.evaluate(() => localStorage.getItem('jarvisSessionId'))).not.toBe(before);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.reload(); await page.waitForSelector('.full-studio');
    const toggle = page.locator('.mobile-nav-toggle');
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    await toggle.click();
    expect(await page.locator('.full-studio.nav-open').count()).toBe(1);
    expect(await page.locator('.mobile-nav-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(errors).toEqual([]);
  });
});
