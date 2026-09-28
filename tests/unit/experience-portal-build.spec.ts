/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the full-swarm build in headless Chromium through the real static route registration over the isolated synthetic swarm: tickets in every canonical state land on the Commons board and in the Jarvis briefing where the shared status groups put them.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Work panels: a ticket's recorded workflow (stages, step progress, gates, history, children) and its full view, Approve for an approval gate that waits on a person with the route's refusal shown, Cancel behind a confirmation with its refusal, the indeterminate bar on Working items only, and the not-visible / unreadable states.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Routines panel: own routines with a switch, managed ones without, somebody else's absent, workflows by version; pause/resume and the 404 refusal that puts the switch back; an application's routines first; the ask-Jarvis empty state and the refused reads.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { portalState, startExperienceBrowserFixture } from '../fixtures/experience-browser';

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
    await toggle().uncheck();
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
