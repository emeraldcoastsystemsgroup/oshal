/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual empty-thread reads with real stores and current policy while preserving issuer, ownership, lineage and delayed-read refusals.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove pending inline destination lineage blocks an empty read using the real store's result selection semantics.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { configureProtectedResultAccess, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { createProtectedResultFixture, RESULT_AGENT, RESULT_ISSUER } from '../fixtures/protected-results';

vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>;
beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'admin');
  fixture = await createProtectedResultFixture();
  configureApplicationRemoteExecutionAuthority(fixture.authority);
});
afterEach(async () => {
  await fixture?.close(); configureApplicationRemoteExecutionAuthority(undefined);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

/** Create a thread through the product route so its owner issuer is server stamped. */
async function createEmptyThread(): Promise<string> {
  const response = await fixture.call('/api/tasks', 'alice', { title: 'New protected concierge', agentId: RESULT_AGENT });
  expect(response.status).toBe(201);
  const task = await response.json();
  expect(task.metadata[OWNER_PRINCIPAL_ISSUER_METADATA_KEY]).toBe(RESULT_ISSUER);
  return task.taskId;
}

/** Exercise both shipped read surfaces and ensure denied responses release no thread title or content. */
async function expectRead(taskId: string, status: number, user = 'alice'): Promise<void> {
  for (const path of ['/api/tasks/' + taskId, '/api/' + taskId + '/messages']) {
    const response = await fixture.call(path, user);
    expect(response.status).toBe(status);
    if (status !== 200) expect(await response.text()).not.toContain('New protected concierge');
  }
}

it('allows the exact owner to load an empty protected thread without creating execution provenance', async () => {
  const taskId = await createEmptyThread();
  await expectRead(taskId, 200);
  const history = await (await fixture.call('/api/' + taskId + '/messages')).json();
  expect(history).toEqual({ messages: [], count: 0 });
  const list = await (await fixture.call('/api/tasks')).json();
  expect(list.tasks.map((task: { taskId: string }) => task.taskId)).toContain(taskId);
  expect(await fixture.records.byTask(taskId)).toEqual([]);
  expect((await fixture.tasks.get(taskId))!.metadata).not.toHaveProperty(PROTECTED_RESULT_EXECUTIONS);
});

it('refuses foreign users, an issuer twin and an administrator despite their independently held application role', async () => {
  const taskId = await createEmptyThread();
  await fixture.change('twin'); await fixture.change('admin');
  for (const user of ['bob', 'twin', 'admin']) await expectRead(taskId, 404, user);
});

it('requires a stamped actual task and rejects malformed execution metadata even when the stores are empty', async () => {
  const taskId = await createEmptyThread(), task = (await fixture.tasks.get(taskId))!;
  await fixture.tasks.replace({ ...task, metadata: {} });
  await expectRead(taskId, 404);
  await fixture.tasks.replace({ ...task, metadata: { ...task.metadata, [PROTECTED_RESULT_EXECUTIONS]: [] } });
  await expectRead(taskId, 404);
  await fixture.tasks.delete(taskId);
  await expectRead(taskId, 404);
});

it.each(['user', 'assistant'] as const)('keeps untracked nonempty %s history unreadable despite a stale zero task counter', async role => {
  const taskId = await createEmptyThread();
  await fixture.messages.save({ taskId, role, type: 'say', text: 'UNTRACKED PRIVATE OUTPUT', contentBlocks: [], metadata: {} });
  expect((await fixture.tasks.get(taskId))!.messageCount).toBe(0);
  await expectRead(taskId, 404);
  expect(await (await fixture.call('/api/' + taskId + '/messages')).text()).not.toContain('UNTRACKED PRIVATE OUTPUT');
});

it('rechecks current application rights and account activity for an empty thread', async () => {
  const taskId = await createEmptyThread();
  await fixture.change('alice', 'revoke'); await expectRead(taskId, 404);
  await fixture.change(); await expectRead(taskId, 200);
  fixture.actors.alice.isActive = false; await expectRead(taskId, 404);
});

it('refuses a pending inline execution even without messages or execution metadata', async () => {
  const taskId = await createEmptyThread();
  const started = await fixture.authority.startInline(fixture.actors.alice, { agentId: RESULT_AGENT, taskId, workspaceId: taskId });
  expect(started).not.toBeNull();
  expect(await fixture.records.byTask(taskId)).toHaveLength(1);
  await expectRead(taskId, 404);
});

it('keeps absent authority and actual message count faults fail-closed', async () => {
  const taskId = await createEmptyThread();
  configureApplicationRemoteExecutionAuthority(undefined); await expectRead(taskId, 404);
  configureApplicationRemoteExecutionAuthority(fixture.authority);
  vi.spyOn(fixture.messages, 'count').mockRejectedValue(new Error('count unavailable'));
  await expectRead(taskId, 404);
});

it('refuses loss of configured result authority during an actual empty-count read', async () => {
  const taskId = await createEmptyThread(), original = fixture.messages.count.bind(fixture.messages);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.messages, 'count').mockImplementationOnce(async id => {
    const count = await original(id); started(); await waiting; return count;
  });
  const pending = fixture.call('/api/tasks/' + taskId);
  await entered;
  try { configureProtectedResultAccess(undefined); }
  finally { release(); }
  expect((await pending).status).toBe(404);
});

it('rechecks policy after a delayed second count so revocation cannot authorize an empty read', async () => {
  const taskId = await createEmptyThread(), original = fixture.messages.count.bind(fixture.messages);
  let started!: () => void, release!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.messages, 'count').mockImplementation(async id => {
    const count = await original(id);
    if (++calls === 2) { started(); await waiting; }
    return count;
  });
  const pending = fixture.call('/api/' + taskId + '/messages');
  await entered;
  try { await fixture.change('alice', 'revoke'); }
  finally { release(); }
  const response = await pending;
  expect(response.status).toBe(404); expect(await response.text()).not.toContain('New protected concierge');
});

it('refuses authority replacement while a confirmed empty-count read is delayed', async () => {
  const taskId = await createEmptyThread(), original = fixture.messages.count.bind(fixture.messages);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.messages, 'count').mockImplementationOnce(async id => {
    const count = await original(id); started(); await waiting; return count;
  });
  const pending = fixture.call('/api/tasks/' + taskId);
  await entered;
  try { configureApplicationRemoteExecutionAuthority(undefined); }
  finally { release(); }
  expect((await pending).status).toBe(404);
});

it('rereads the actual stamped owner after the count instead of retaining an earlier task snapshot', async () => {
  const taskId = await createEmptyThread(), original = fixture.messages.count.bind(fixture.messages);
  const task = (await fixture.tasks.get(taskId))!;
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.messages, 'count').mockImplementationOnce(async id => {
    const count = await original(id); started(); await waiting; return count;
  });
  const pending = fixture.call('/api/tasks/' + taskId);
  await entered;
  try { await fixture.tasks.replace({ ...task, metadata: { ...task.metadata, [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://other.fixture.test' } }); }
  finally { release(); }
  expect((await pending).status).toBe(404);
});
