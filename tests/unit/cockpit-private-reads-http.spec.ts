/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise private ticket streams, global escalation refusal and caller-scoped projects over actual HTTP and current policy.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { privateReadsFixture, observeStream } from '../fixtures/cockpit-private-reads';
import type { ClientRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { RESULT_AGENT } from '../fixtures/protected-results';

let f: Awaited<ReturnType<typeof privateReadsFixture>>;
let requests: ClientRequest[];
beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'admin'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
  vi.stubEnv('OSHAL_ALLOW_LEGACY_UNOWNED', 'false'); requests = []; f = await privateReadsFixture();
});
afterEach(async () => { requests.forEach(r => r.destroy()); vi.restoreAllMocks(); await f?.close(); vi.unstubAllEnvs(); });

it('refuses foreign/missing/revoked protected tickets before SSE bytes or subscription', async () => {
  const ticket = await f.ticket(); await f.seed(ticket.ticketId);
  for (const user of ['bob', 'twin', 'admin']) {
    const response = await f.call(`/api/v1/tickets/${ticket.ticketId}/activity/stream`, user);
    expect(response.status).toBe(404); expect(response.headers.get('content-type')).not.toContain('event-stream');
    expect(await response.text()).not.toContain('connected');
  }
  expect((await f.call('/api/v1/tickets/missing/activity/stream')).status).toBe(404);
  await f.change('alice', 'revoke');
  expect((await f.call(`/api/v1/tickets/${ticket.ticketId}/activity/stream`)).status).toBe(404);
  expect((await f.call(`/api/v1/tickets/${ticket.ticketId}/activity`)).status).toBe(404);
  expect(f.bus.size).toBe(0);
});

it('delivers matching events only, then closes on actual protected-grant revocation', async () => {
  const ticket = await f.ticket(); await f.seed(ticket.ticketId);
  const stream = await observeStream(`${f.base}/helper/${ticket.ticketId}/stream`); requests.push(stream.request);
  expect(stream.status).toBe(200); expect(await stream.next()).toContain('event: connected');
  expect(stream.cacheControl).toBe('no-store');
  for (const listener of f.bus) {
    listener({ ticketId: '*', entry: { text: 'WILDCARD PRIVATE' } });
    listener({ ticketId: 'other', entry: { text: 'FOREIGN PRIVATE' } });
    listener({ ticketId: ticket.ticketId, entry: { text: 'OWN EVENT' } });
  }
  expect(await stream.next()).toContain('OWN EVENT');
  await f.change('alice', 'revoke');
  for (const listener of f.bus) listener({ ticketId: ticket.ticketId, entry: { text: 'REVOKED PRIVATE' } });
  await stream.ended;
  expect(stream.text()).not.toMatch(/WILDCARD PRIVATE|FOREIGN PRIVATE|REVOKED PRIVATE/);
  expect(f.bus.size).toBe(0);
});

it('admits the owner through the actual cockpit stream registration and legacy task fallback', async () => {
  const ticket = await f.ticket();
  const stream = await observeStream(`${f.base}/api/v1/tickets/${ticket.ticketId}/activity/stream`); requests.push(stream.request);
  expect(await stream.next()).toContain('event: connected');
  await f.seed('legacy-task');
  const task = (await f.tasks.get('legacy-task'))!;
  await f.tasks.replace({ ...task, agentId: 'legacy-bot', metadata: {} });
  const fallback = await observeStream(`${f.base}/helper/legacy-task/stream`); requests.push(fallback.request);
  expect(await fallback.next()).toContain('event: connected');
  expect((await f.call('/helper/legacy-task/stream', 'bob')).status).toBe(404);
});

it('refuses global escalation reads before the controller, including query spoofing', async () => {
  expect((await f.call('/api/swarm/escalations', 'unknown')).status).toBe(401);
  expect((await f.call('/api/swarm/escalations?scope=all&ownerSub=admin')).status).toBe(403);
  expect(f.listEscalations).not.toHaveBeenCalled();
  expect((await f.call('/api/swarm/escalations', 'admin')).status).toBe(200);
  expect(f.listEscalations).toHaveBeenCalledTimes(1);
});

it('lists only readable owner projects without global registry collision labels or counts', async () => {
  await f.ticket('alice', { projectId: 'shared-id', projectName: 'OWN PROJECT' });
  await f.ticket('bob', { projectId: 'shared-id', projectName: 'FOREIGN TICKET LABEL' });
  await f.ticket('bob', { projectId: 'foreign-only', projectName: 'FOREIGN PROJECT' });
  const response = await f.call('/api/v1/projects?scope=all&ownerSub=bob');
  const body = await response.json(); expect(response.status).toBe(200);
  expect(body.projects).toEqual([expect.objectContaining({ id: 'shared-id', name: 'OWN PROJECT', ticketCount: 1 })]);
  expect(JSON.stringify(body)).not.toMatch(/FOREIGN|registry-secret|foreign-only/);
  const admin = await (await f.call('/api/v1/projects', 'admin')).json();
  expect(admin.projects).toContainEqual(expect.objectContaining({ id: 'registry-secret' }));
});

it('withholds protected and wrong-issuer projects in cockpit-first and fallback mounts', async () => {
  const ticket = await f.ticket('alice', { projectId: 'private-project', projectName: 'PRIVATE PROJECT' });
  await f.seed(ticket.ticketId);
  const task = (await f.tasks.get(ticket.ticketId))!;
  await f.tasks.replace({ ...task, metadata: { ...task.metadata, projectId: 'private-project', projectName: 'PRIVATE PROJECT' } });
  for (const route of ['/api/v1/projects', '/fallback/projects']) {
    expect(JSON.stringify(await (await f.call(route)).json())).toContain('PRIVATE PROJECT');
    for (const user of ['bob', 'twin', 'admin']) expect(JSON.stringify(await (await f.call(route, user)).json())).not.toContain('PRIVATE PROJECT');
  }
  await f.change('alice', 'revoke');
  for (const route of ['/api/v1/projects', '/fallback/projects'])
    expect(JSON.stringify(await (await f.call(route)).json())).not.toContain('PRIVATE PROJECT');
});

it.each(['owner', 'inactive', 'error'])('closes a stream on current %s refusal without delivering a frame', async reason => {
  const ticket = await f.ticket();
  const stream = await observeStream(`${f.base}/helper/${ticket.ticketId}/stream`); requests.push(stream.request);
  await stream.next();
  if (reason === 'owner') vi.spyOn(f.ctx.ticketService, 'getTicket').mockResolvedValueOnce({ ...ticket, ownerSub: 'bob' });
  if (reason === 'inactive') f.actors.alice.isActive = false;
  if (reason === 'error') vi.spyOn(f.ctx.ticketService, 'getTicket').mockRejectedValueOnce(new Error('Isolated read failure'));
  for (const listener of f.bus) listener({ ticketId: ticket.ticketId, entry: { text: 'REFUSED EVENT' } });
  await stream.ended; expect(stream.text()).not.toContain('REFUSED EVENT'); expect(f.bus.size).toBe(0);
});

it('removes the listener and timer when the client closes during a deferred check', async () => {
  const ticket = await f.ticket();
  const stream = await observeStream(`${f.base}/helper/${ticket.ticketId}/stream`); requests.push(stream.request);
  await stream.next(); const before = stream.text(); const clear = vi.spyOn(globalThis, 'clearInterval');
  let release!: (value: typeof ticket) => void;
  let started!: () => void; const checking = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(f.ctx.ticketService, 'getTicket').mockImplementationOnce(() => {
    started(); return new Promise(resolve => { release = resolve; });
  });
  for (const listener of f.bus) listener({ ticketId: ticket.ticketId, entry: { text: 'POST-CLOSE EVENT' } });
  await checking; stream.request.destroy(); await vi.waitFor(() => expect(f.bus.size).toBe(0));
  release(ticket); await Promise.resolve(); await Promise.resolve();
  expect(clear).toHaveBeenCalled(); expect(stream.text()).toBe(before);
});

it('refuses missing principals before project stores and retains only readable task-only projects', async () => {
  f.actors.blank = { ...f.actors.alice, sub: '' };
  const tickets = vi.spyOn(f.ctx.ticketService, 'listTickets'); const tasks = vi.spyOn(f.tasks, 'list');
  for (const route of ['/api/v1/projects', '/fallback/projects']) expect((await f.call(route, 'blank')).status).toBe(401);
  expect(tickets).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled();
  tickets.mockRestore(); tasks.mockRestore();
  await f.seed('task-only'); const task = (await f.tasks.get('task-only'))!;
  await f.tasks.replace({ ...task, agentId: 'legacy-bot', metadata: { projectId: 'task-project', project: 'OWN TASK PROJECT' } });
  await f.tasks.replace({ ...task, taskId: 'foreign-task', ownerSub: 'bob', agentId: 'legacy-bot',
    metadata: { projectId: 'foreign-task-project', project: 'FOREIGN TASK PROJECT' } });
  await f.tasks.replace({ ...task, taskId: 'unowned-task', ownerSub: undefined, agentId: 'legacy-bot',
    metadata: { projectId: 'unowned-project', project: 'UNOWNED PROJECT' } });
  await f.ticket('bob', { projectId: 'foreign-ticket', projectName: 'FOREIGN TICKET PROJECT' });
  const allTasks = await f.tasks.list({ limit: 500 }); const allTickets = await f.ctx.ticketService.listTickets({ limit: 500 });
  vi.spyOn(f.tasks, 'list').mockResolvedValue(allTasks); vi.spyOn(f.ctx.ticketService, 'listTickets').mockResolvedValue(allTickets);
  for (const route of ['/api/v1/projects', '/fallback/projects']) {
    const body = JSON.stringify(await (await f.call(route)).json());
    expect(body).toContain('OWN TASK PROJECT'); expect(body).not.toMatch(/FOREIGN|UNOWNED/);
  }
});

it('closes a legacy task stream when its actor becomes inactive', async () => {
  await f.seed('legacy-inactive'); const task = (await f.tasks.get('legacy-inactive'))!;
  await f.tasks.replace({ ...task, agentId: 'legacy-bot', metadata: {} });
  const stream = await observeStream(`${f.base}/helper/legacy-inactive/stream`); requests.push(stream.request);
  await stream.next(); f.actors.alice.isActive = false;
  for (const listener of f.bus) listener({ ticketId: 'legacy-inactive', entry: { text: 'INACTIVE LEGACY EVENT' } });
  await stream.ended; expect(stream.text()).not.toContain('INACTIVE LEGACY EVENT'); expect(f.bus.size).toBe(0);
});

it('excludes unreadable children, linked task messages and unqualified SQL costs', async () => {
  const parent = await f.ticket(); const foreign = await f.ticket('bob'); const denied = await f.ticket();
  await f.ctx.ticketService.updateTicket(foreign.ticketId, { parentTicketId: parent.ticketId, title: 'FOREIGN CHILD' });
  await f.ctx.ticketService.updateTicket(denied.ticketId, { parentTicketId: parent.ticketId, title: 'DENIED CHILD' });
  await f.seed(denied.ticketId); const template = (await f.tasks.get(denied.ticketId))!;
  await f.tasks.replace({ ...template, taskId: 'forged-task', ownerSub: 'bob', agentId: 'legacy-bot',
    metadata: { ticketId: parent.ticketId }, totalCost: 9000 });
  await f.messages.save({ taskId: 'forged-task', role: 'assistant', type: 'completion', text: 'FOREIGN MESSAGE', contentBlocks: [], metadata: {} });
  await f.ctx.ticketService.linkTask(parent.ticketId, 'forged-task');
  const queryCostByTicket = vi.fn(async () => ({ totalCost: 99999 }));
  Object.assign(f.ctx, { swarm: { costTrackingService: { queryCostByTicket } } });
  await f.change('alice', 'revoke');
  const response = await f.call(`/api/v1/tickets/${parent.ticketId}/activity`);
  expect(response.status).toBe(200); const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(/FOREIGN CHILD|DENIED CHILD|FOREIGN MESSAGE|PRIVATE RESULT 42|9000|99999/);
  expect(body.ticket.children).toEqual([]); expect(body.cost.totalCost).toBe(0);
  expect(queryCostByTicket).not.toHaveBeenCalled();
});

it('excludes foreign metadata matches from fallback activity costs and messages', async () => {
  await f.seed('legacy-root'); const template = (await f.tasks.get('legacy-root'))!;
  await f.tasks.replace({ ...template, agentId: 'legacy-bot', metadata: {}, totalCost: 2 });
  await f.tasks.replace({ ...template, taskId: 'foreign-match', ownerSub: 'bob', agentId: 'legacy-bot',
    metadata: { ticketId: 'legacy-root' }, totalCost: 9000 });
  const response = await f.call('/api/v1/tickets/legacy-root/activity');
  expect(response.status).toBe(200); const body = await response.json();
  expect(body.cost.totalCost).toBe(2); expect(JSON.stringify(body)).not.toContain('9000');
});

it('rechecks a deferred event after revocation and discards the next queued event', async () => {
  const ticket = await f.ticket(); await f.seed(ticket.ticketId);
  const stream = await observeStream(`${f.base}/helper/${ticket.ticketId}/stream`); requests.push(stream.request);
  await stream.next(); let release!: (value: typeof ticket) => void;
  let started!: () => void; const checking = new Promise<void>(resolve => { started = resolve; });
  const reads = vi.spyOn(f.ctx.ticketService, 'getTicket').mockImplementationOnce(() => {
    started(); return new Promise(resolve => { release = resolve; });
  });
  for (const listener of f.bus) {
    listener({ ticketId: ticket.ticketId, entry: { text: 'DEFERRED EVENT' } });
    listener({ ticketId: ticket.ticketId, entry: { text: 'QUEUED EVENT' } });
  }
  await checking; await f.change('alice', 'revoke'); release(ticket); await stream.ended;
  expect(stream.text()).not.toMatch(/DEFERRED EVENT|QUEUED EVENT/); expect(reads).toHaveBeenCalledTimes(1);
  expect(f.bus.size).toBe(0);
});

it('withholds protected work output and foreign child-unit work from a readable parent', async () => {
  const parent = await f.ticket(); const foreign = await f.ticket('bob', { unitId: 'foreign-unit' });
  await f.ctx.ticketService.updateTicket(foreign.ticketId, { parentTicketId: parent.ticketId });
  const workItemRepository = { findByExternalIdAnyProvider: vi.fn(async (id: string) => id === parent.ticketId ? [
    { workItemId: 'protected-work', externalId: parent.ticketId, assignedAgentId: RESULT_AGENT,
      status: 'completed', title: 'PROTECTED WORK TITLE', executionOutput: { text: 'PROTECTED WORK RESULT' } },
    { workItemId: 'foreign-work', externalId: parent.ticketId, unitId: 'foreign-unit',
      status: 'completed', title: 'FOREIGN WORK TITLE', executionOutput: { text: 'FOREIGN WORK RESULT' } },
    { workItemId: 'protected-nested', externalId: parent.ticketId, assignedAgentId: 'legacy-bot',
      status: 'completed', title: 'PROTECTED NESTED TITLE', executionOutput: { output: { agentId: RESULT_AGENT, text: 'PROTECTED NESTED RESULT' } } },
    { workItemId: 'forged-execution', externalId: parent.ticketId, assignedAgentId: 'legacy-bot',
      status: 'completed', title: 'FORGED EXECUTION', executionOutput: { applicationExecutionId: 'missing-execution', text: 'FORGED RESULT' } },
    { workItemId: 'own-work', externalId: parent.ticketId, assignedAgentId: 'legacy-bot',
      status: 'completed', title: 'OWN WORK TITLE', executionOutput: { text: 'OWN WORK RESULT' } },
  ] : []) };
  Object.assign(f.ctx, { swarm: { workItemRepository } });
  const response = await f.call(`/api/v1/tickets/${parent.ticketId}/activity`);
  expect(response.status).toBe(200); const text = await response.text();
  expect(text).toContain('OWN WORK TITLE'); expect(text).not.toMatch(/PROTECTED WORK|FOREIGN WORK|PROTECTED NESTED|FORGED/);
});

it.each(['foreign', 'protected'])('does not inherit a %s parent workspace ID or path', async reason => {
  const parent = await f.ticket(reason === 'foreign' ? 'bob' : 'alice'); const child = await f.ticket();
  if (reason === 'protected') { await f.seed(parent.ticketId); await f.change('alice', 'revoke'); }
  await f.ctx.ticketService.updateTicket(child.ticketId, { parentTicketId: parent.ticketId });
  const workspaceId = randomUUID(); await f.ctx.ticketService.linkWorkspace(parent.ticketId, workspaceId);
  const links = vi.spyOn(f.ctx.ticketService, 'getWorkspacesForTicket');
  const getWorkspace = vi.fn(async () => ({ path: '/FOREIGN/SECRET/PATH' }));
  Object.assign(f.ctx.workspaceService, { getWorkspace });
  const response = await f.call(`/api/v1/tickets/${child.ticketId}/activity`);
  expect(response.status).toBe(200); const body = await response.json();
  expect(body.ticket.workspaceTaskId).toBe(child.ticketId);
  expect(JSON.stringify(body)).not.toContain(workspaceId); expect(JSON.stringify(body)).not.toContain('/FOREIGN/SECRET/PATH');
  expect(links).not.toHaveBeenCalledWith(parent.ticketId); expect(getWorkspace).not.toHaveBeenCalled();
});

it('preserves admitted parent workspaces and protected work output', async () => {
  const parent = await f.ticket(); const child = await f.ticket();
  await f.ctx.ticketService.updateTicket(child.ticketId, { parentTicketId: parent.ticketId });
  const workspaceId = randomUUID(); await f.ctx.ticketService.linkWorkspace(parent.ticketId, workspaceId);
  const getWorkspace = vi.fn(async () => ({ path: '/app/workspace/OWN' }));
  Object.assign(f.ctx.workspaceService, { getWorkspace });
  const childResponse = await (await f.call(`/api/v1/tickets/${child.ticketId}/activity`)).json();
  expect(childResponse.ticket.workspaceTaskId).toBe(parent.ticketId);
  expect(childResponse.ticket.workspacePath).toBe('/app/workspace/OWN'); expect(getWorkspace).toHaveBeenCalledWith(workspaceId);
  const executionId = await f.seed(parent.ticketId); await f.messages.deleteByTask(parent.ticketId);
  Object.assign(f.ctx, { swarm: { workItemRepository: { findByExternalIdAnyProvider: vi.fn(async (id: string) =>
    id === parent.ticketId ? [{ workItemId: 'admitted-work', externalId: parent.ticketId, assignedAgentId: RESULT_AGENT,
      status: 'completed', title: 'ADMITTED PROTECTED WORK', executionOutput: { applicationExecutionId: executionId, text: 'ADMITTED PROTECTED RESULT' } }] : []) } } });
  const text = await (await f.call(`/api/v1/tickets/${parent.ticketId}/activity`)).text();
  expect(text).toContain('ADMITTED PROTECTED WORK'); expect(text).toContain('ADMITTED PROTECTED RESULT');
});
