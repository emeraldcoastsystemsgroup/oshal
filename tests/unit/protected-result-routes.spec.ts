/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove protected result persistence, exact identity, current rights and per-event SSE isolation through real HTTP routes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exercise current ordinary task ownership, mixed-transport precedence, deactivation and history/SSE rechecks through the shipped routers.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Match maintained fixture input and transport declarations without changing ownership, identity or boundary assertions.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createProtectedResultFixture, RESULT_AGENT } from '../fixtures/protected-results';
import { PROTECTED_RESULT_EXECUTIONS, appendProtectedResultExecution, configureProtectedResultAccess } from '@/shared/protected-results';
import { persistProtectedResultTask } from '@/app/routes/protected-result-persistence';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>;
beforeEach(async () => { vi.stubEnv('OSHAL_OPERATOR_SUBS', 'admin'); fixture = await createProtectedResultFixture(); });
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('persists real completed execution lineage before exposing result history and task metadata', async () => {
  const executionId = await fixture.seed();
  const task = await (await fixture.call('/api/tasks/protected-task')).json();
  expect(task.metadata[PROTECTED_RESULT_EXECUTIONS]).toEqual([executionId]);
  expect((await (await fixture.call('/api/protected-task/messages')).json()).messages[0].text).toBe('PRIVATE RESULT 42');
  expect((await (await fixture.call('/api/tasks')).json()).tasks.map((row: { taskId: string }) => row.taskId)).toEqual(['protected-task']);
});

it('refuses another subject, the same subject from another issuer and a platform administrator', async () => {
  await fixture.seed(); await fixture.change('twin'); await fixture.change('admin');
  for (const user of ['bob', 'twin', 'admin']) {
    expect((await fixture.call('/api/tasks/protected-task', user)).status).toBe(404);
    expect((await fixture.call('/api/protected-task/messages', user)).status).toBe(404);
    expect((await fixture.call('/api/stream/protected-task', user)).status).toBe(404);
    expect((await (await fixture.call('/api/tasks?scope=all', user)).json()).tasks).toEqual([]);
  }
});

it('rechecks application revocation and account disabling when completed results are reopened', async () => {
  await fixture.seed(); await fixture.change('alice', 'revoke');
  expect((await fixture.call('/api/protected-task/messages')).status).toBe(404);
  expect((await (await fixture.call('/api/tasks')).json()).tasks).toEqual([]);
  await fixture.change(); expect((await fixture.call('/api/protected-task/messages')).status).toBe(200);
  fixture.actors.alice.isActive = false;
  expect((await fixture.call('/api/tasks/protected-task')).status).toBe(404);
});

it('rejects transplanted, malformed and missing protected lineage without weakening ordinary history', async () => {
  const executionId = await fixture.seed();
  await fixture.tasks.create({ title: '', processingMode: 'agentic', taskId: 'transplanted', ownerSub: 'alice', agentId: RESULT_AGENT,
    metadata: appendProtectedResultExecution({}, executionId) });
  await fixture.tasks.create({ title: '', processingMode: 'agentic', taskId: 'malformed', ownerSub: 'alice', metadata: { [PROTECTED_RESULT_EXECUTIONS]: [] } });
  await fixture.tasks.create({ title: '', processingMode: 'agentic', metadata: {}, taskId: 'unqualified', ownerSub: 'alice', agentId: RESULT_AGENT });
  await fixture.tasks.create({ title: '', processingMode: 'agentic', metadata: {}, taskId: 'ordinary', ownerSub: 'alice', agentId: 'ordinary-bot' });
  for (const id of ['transplanted', 'malformed', 'unqualified']) expect((await fixture.call('/api/tasks/' + id)).status).toBe(404);
  expect((await fixture.call('/api/tasks/ordinary')).status).toBe(200);
  configureProtectedResultAccess(undefined);
  expect((await fixture.call('/api/tasks/protected-task')).status).toBe(404);
});

it('strips caller-provided execution metadata on task creation and applies visible limits after issuer filtering', async () => {
  const executionId = await fixture.seed(); await fixture.change('twin'); await fixture.seed('foreign-newer', 'twin');
  const response = await fixture.call('/api/tasks', 'alice', { title: 'Caller text', metadata: { retained: 1, [PROTECTED_RESULT_EXECUTIONS]: [executionId] } });
  expect(response.status).toBe(201); expect((await response.json()).metadata).toEqual({ retained: 1,
    [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: fixture.actors.alice.issuer });
  const rows = (await (await fixture.call('/api/tasks?agentId=' + RESULT_AGENT + '&limit=1')).json()).tasks;
  expect(rows.map((row: { taskId: string }) => row.taskId)).toEqual(['protected-task']);
});

it('closes an existing task stream on the next event after rights are revoked', async () => {
  await fixture.seed(); const stream = await fixture.openStream('/api/stream/protected-task');
  expect(stream.status).toBe(200);
  fixture.streams.broadcastMessage('protected-task', { text: 'VISIBLE BEFORE REVOCATION' });
  await vi.waitFor(() => expect(stream.text()).toContain('VISIBLE BEFORE REVOCATION'));
  await fixture.change('alice', 'revoke');
  fixture.streams.broadcastMessage('protected-task', { text: 'PRIVATE AFTER REVOCATION' });
  await vi.waitFor(() => expect(fixture.streams.getStats().clientCount).toBe(0));
  expect(stream.text()).not.toContain('PRIVATE AFTER REVOCATION');
});

it('filters global session streams per task while retaining the caller ordinary events', async () => {
  await fixture.seed(); const alice = await fixture.openStream('/api/stream'), bob = await fixture.openStream('/api/stream', 'bob');
  await fixture.tasks.create({ title: '', processingMode: 'agentic', metadata: {}, taskId: 'bob-ordinary', ownerSub: 'bob', agentId: 'ordinary-bot' });
  fixture.streams.associateTaskWithSession('protected-task'); fixture.streams.associateTaskWithSession('bob-ordinary');
  fixture.streams.broadcastMessage('protected-task', { text: 'PRIVATE ALICE EVENT' });
  fixture.streams.broadcastMessage('bob-ordinary', { text: 'BOB ORDINARY EVENT' });
  await vi.waitFor(() => expect(alice.text()).toContain('PRIVATE ALICE EVENT'));
  await vi.waitFor(() => expect(bob.text()).toContain('BOB ORDINARY EVENT'));
  expect(alice.text()).not.toContain('BOB ORDINARY EVENT'); expect(bob.text()).not.toContain('PRIVATE ALICE EVENT');
});

it('rechecks history authority after a delayed store read and withholds the loaded private text', async () => {
  await fixture.seed(); const original = fixture.messages.getByTask.bind(fixture.messages);
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(done => { started = done; }), waiting = new Promise<void>(done => { release = done; });
  vi.spyOn(fixture.messages, 'getByTask').mockImplementation(async taskId => { const rows = await original(taskId); started(); await waiting; return rows; });
  const pending = fixture.call('/api/protected-task/messages');
  try { await entered; await fixture.change('alice', 'revoke'); release();
    const response = await pending; expect(response.status).toBe(404); expect(await response.text()).not.toContain('PRIVATE RESULT');
  } finally { release(); await pending; }
});

it('requires all durable executions even if concurrent task metadata retained only one marker', async () => {
  const first = await fixture.seed(); const second = await fixture.seed();
  const task = (await fixture.tasks.get('protected-task'))!;
  await fixture.tasks.replace({ ...task, metadata: appendProtectedResultExecution({}, first) });
  await fixture.records.update(second, async record => { record.status = 'revoked'; });
  expect((await fixture.call('/api/protected-task/messages')).status).toBe(404);
});

it('rejects result persistence into a different destination before history or task creation', async () => {
  const executionId = await fixture.seed();
  await expect(persistProtectedResultTask(fixture.ctx, 'wrong-destination', RESULT_AGENT, executionId, fixture.actors.alice)).rejects.toThrow();
  expect(await fixture.tasks.get('wrong-destination')).toBeNull();
  expect(await fixture.messages.getByTask('wrong-destination')).toEqual([]);
});

it('uses durable lineage when an aggregate loses all metadata and has an ordinary parent agent', async () => {
  await fixture.seed(); const task = (await fixture.tasks.get('protected-task'))!;
  await fixture.tasks.replace({ ...task, agentId: 'jarvis', metadata: {} });
  await fixture.change('alice', 'revoke');
  expect((await fixture.call('/api/protected-task/messages')).status).toBe(404);
  expect((await fixture.call('/api/tasks/protected-task', 'twin')).status).toBe(404);
});

it('refuses legacy subject-only conversation adoption even after a legitimate result is linked', async () => {
  const executionId = await fixture.complete('new-child');
  await fixture.tasks.create({ title: '', processingMode: 'agentic', metadata: {}, taskId: 'legacy-parent', ownerSub: 'alice', agentId: 'jarvis' });
  await fixture.authority.linkResult(executionId, 'legacy-parent', fixture.actors.alice);
  await expect(persistProtectedResultTask(fixture.ctx, 'legacy-parent', 'jarvis', executionId, fixture.actors.alice))
    .rejects.toThrow('protected_result_owner_issuer_required');
  expect((await fixture.tasks.get('legacy-parent'))?.metadata).not.toHaveProperty(PROTECTED_RESULT_EXECUTIONS);
});

it('closes a stream after bounded authority timeout and discards its late successful check', async () => {
  await fixture.seed(); const stream = await fixture.openStream('/api/stream/protected-task');
  let release!: () => void;
  vi.spyOn(fixture.authority, 'assertResultAccess').mockImplementation(() => new Promise<void>(done => { release = done; }));
  fixture.streams.broadcastMessage('protected-task', { text: 'PRIVATE LATE RESULT' });
  await vi.waitFor(() => expect(fixture.streams.getStats().clientCount).toBe(0), { timeout: 3000 });
  release(); await new Promise(done => setTimeout(done, 10));
  expect(stream.text()).not.toContain('PRIVATE LATE RESULT');
});

it.each(['checkpoints', 'workspace/status'])('withholds delayed %s data when rights are revoked during retrieval', async path => {
  await fixture.seed();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(done => { started = done; }), waiting = new Promise<void>(done => { release = done; });
  const read = async () => { started(); await waiting; return [{ summary: 'PRIVATE CHECKPOINT' }]; };
  Object.assign(fixture.ctx, { memoryService: { listCheckpoints: read }, workspaceBootstrapService: { getTaskWorkspaceStatus: read } });
  const pending = fixture.call('/api/tasks/protected-task/' + path);
  try { await entered; await fixture.change('alice', 'revoke'); release();
    const response = await pending; expect(response.status).toBe(404); expect(await response.text()).not.toContain('PRIVATE');
  } finally { release(); await pending; }
});

async function ordinaryTask(taskId = 'ordinary-stamped', stamped = true): Promise<void> {
  await fixture.tasks.create({ taskId, title: taskId, processingMode: 'agentic', ownerSub: 'alice', agentId: 'ordinary-bot',
    metadata: stamped ? { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: fixture.actors.alice.issuer } : {} });
  await fixture.messages.save({ metadata: {}, contentBlocks: [], taskId, role: 'assistant', type: 'completion', text: 'ORDINARY PRIVATE CONTENT' });
}

it('applies exact current ownership to ordinary detail, history, list and subscriptions', async () => {
  await ordinaryTask();
  expect((await fixture.call('/api/tasks/ordinary-stamped')).status).toBe(200);
  expect((await fixture.call('/api/ordinary-stamped/messages')).status).toBe(200);
  for (const user of ['bob', 'twin']) {
    expect((await fixture.call('/api/tasks/ordinary-stamped', user)).status).toBe(404);
    expect((await fixture.call('/api/ordinary-stamped/messages', user)).status).toBe(404);
    expect((await fixture.call('/api/stream/ordinary-stamped', user)).status).toBe(404);
    expect((await (await fixture.call('/api/tasks', user)).json()).tasks).toEqual([]);
  }
  expect((await fixture.call('/api/tasks/ordinary-stamped', 'admin')).status).toBe(200);
  fixture.actors.alice.isActive = false;
  expect((await fixture.call('/api/tasks/ordinary-stamped')).status).toBe(404);
  expect((await fixture.call('/api/ordinary-stamped/messages')).status).toBe(404);
  fixture.actors.admin.isActive = false;
  expect((await fixture.call('/api/tasks/ordinary-stamped', 'admin')).status).toBe(404);
});

it('retains legacy active-owner access but refuses disabled and unresolved actors', async () => {
  await ordinaryTask('ordinary-legacy', false);
  expect((await fixture.call('/api/ordinary-legacy/messages')).status).toBe(200);
  fixture.actors.alice.isActive = false;
  expect((await fixture.call('/api/ordinary-legacy/messages')).status).toBe(404);
  fixture.actors.alice.isActive = true;
  vi.spyOn(fixture.ctx.applicationAuthorization!, 'resolveActor').mockRejectedValue(new Error('directory unavailable'));
  expect((await fixture.call('/api/tasks/ordinary-legacy')).status).toBe(404);
  expect((await fixture.call('/api/ordinary-legacy/messages')).status).toBe(404);
});

it('never lets conflicting valid service headers displace an authenticated ordinary principal', async () => {
  vi.stubEnv('SWARM_SERVICE_SECRET', 'ordinary-mixed-transport-fixture-sentinel');
  await ordinaryTask();
  const headers = { 'x-service-secret': 'ordinary-mixed-transport-fixture-sentinel', 'x-oshal-user-sub': 'bob' };
  expect((await fixture.call('/api/ordinary-stamped/messages', 'alice', undefined, headers)).status).toBe(200);
  headers['x-oshal-user-sub'] = 'alice';
  for (const user of ['bob', 'twin']) {
    expect((await fixture.call('/api/ordinary-stamped/messages', user, undefined, headers)).status).toBe(404);
    expect((await fixture.call('/api/tasks/ordinary-stamped', user, undefined, headers)).status).toBe(404);
  }
});

it('rechecks ordinary history after loading and drops a newly disabled caller', async () => {
  await ordinaryTask();
  const original = fixture.messages.getByTask.bind(fixture.messages);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(done => { entered = done; }), waiting = new Promise<void>(done => { release = done; });
  vi.spyOn(fixture.messages, 'getByTask').mockImplementation(async id => { const rows = await original(id); entered(); await waiting; return rows; });
  const pending = fixture.call('/api/ordinary-stamped/messages');
  try { await started; fixture.actors.alice.isActive = false; release();
    const response = await pending; expect(response.status).toBe(404); expect(await response.text()).not.toContain('ORDINARY PRIVATE');
  } finally { release(); await pending; }
});

it('drops queued ordinary task and session events after current actor deactivation', async () => {
  await ordinaryTask();
  const task = await fixture.openStream('/api/stream/ordinary-stamped'), session = await fixture.openStream('/api/stream');
  expect(task.status).toBe(200); expect(session.status).toBe(200);
  fixture.streams.associateTaskWithSession('ordinary-stamped');
  fixture.streams.broadcastMessage('ordinary-stamped', { text: 'VISIBLE ORDINARY EVENT' });
  await vi.waitFor(() => { expect(task.text()).toContain('VISIBLE ORDINARY EVENT'); expect(session.text()).toContain('VISIBLE ORDINARY EVENT'); });
  let release!: () => void;
  const waiting = new Promise<void>(done => { release = done; });
  const resolve = fixture.ctx.applicationAuthorization!.resolveActor.bind(fixture.ctx.applicationAuthorization);
  const currentChecks = vi.spyOn(fixture.ctx.applicationAuthorization!, 'resolveActor').mockImplementation(async req => {
    await waiting; return resolve(req);
  });
  fixture.streams.broadcastMessage('ordinary-stamped', { text: 'WITHHELD DISABLED EVENT' });
  try {
    await vi.waitFor(() => expect(currentChecks.mock.calls.length).toBeGreaterThanOrEqual(2));
    fixture.actors.alice.isActive = false; release();
    await vi.waitFor(() => expect(fixture.streams.getStats().clientCount).toBe(1));
  } finally { release(); }
  currentChecks.mockRestore();
  // A subsequent admitted event proves the global stream consumed its queue without disclosing the disabled row.
  fixture.actors.alice.isActive = true;
  await ordinaryTask('later-ordinary'); fixture.streams.associateTaskWithSession('later-ordinary');
  fixture.streams.broadcastMessage('later-ordinary', { text: 'LATER ADMITTED EVENT' });
  await vi.waitFor(() => expect(session.text()).toContain('LATER ADMITTED EVENT'));
  expect(task.text()).not.toContain('WITHHELD DISABLED EVENT'); expect(session.text()).not.toContain('WITHHELD DISABLED EVENT');
});
