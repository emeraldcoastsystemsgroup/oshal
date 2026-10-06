/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise mounted approval-control access against real stored tasks and inline execution policy while preserving pending history refusal and delayed identity/policy checks.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callerCanReadTaskControlEvent } from '@/app/routes/protected-task-control-access';
import { configureApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { createProtectedResultFixture, RESULT_AGENT } from '../fixtures/protected-results';

vi.mock('@/shared/services/database/optional-postgres-pool', () => ({ createOptionalPostgresPool: () => null }));
let fixture: Awaited<ReturnType<typeof createProtectedResultFixture>>, server: Server, base: string;
beforeEach(async () => {
  vi.stubEnv('OSHAL_OPERATOR_SUBS', 'admin');
  fixture = await createProtectedResultFixture();
  configureApplicationRemoteExecutionAuthority(fixture.authority);
  const app = express();
  app.use((req, _res, next) => {
    const actor = fixture.actors[String(req.get('x-fixture-user') || 'alice')];
    Object.assign(req, { oidc: { isAuthenticated: () => req.get('x-fixture-auth') !== 'anonymous',
      user: actor && { sub: actor.sub, iss: actor.issuer, is_guest: req.get('x-fixture-auth') === 'guest' } } });
    next();
  });
  app.get('/control/:taskId', async (req, res): Promise<void> => {
    res.sendStatus(await callerCanReadTaskControlEvent(fixture.ctx, req, String(req.params.taskId)) ? 204 : 404);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(done => server.close(() => done()));
  await fixture?.close(); configureApplicationRemoteExecutionAuthority(undefined);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

/** The mounted adapter exercises real authenticated HTTP requests against the production predicate. */
function control(taskId: string, user = 'alice', auth = 'authenticated'): Promise<Response> {
  return fetch(base + '/control/' + taskId, { headers: { 'x-fixture-user': user, 'x-fixture-auth': auth } });
}

/** Create a real stamped task through the product route, then start its real current-policy inline execution. */
async function pendingThread(): Promise<{ taskId: string; executionId: string }> {
  const created = await fixture.call('/api/tasks', 'alice', { title: 'Protected approval task', agentId: RESULT_AGENT });
  expect(created.status).toBe(201);
  const { taskId } = await created.json();
  const started = await fixture.authority.startInline(fixture.actors.alice, { agentId: RESULT_AGENT, taskId, workspaceId: taskId });
  if (!started) throw new Error('Fixture must start protected inline work');
  return { taskId, executionId: started.executionId };
}

it('admits pending inline approval controls without granting task or message history access', async () => {
  const { taskId } = await pendingThread();
  await fixture.messages.save({ taskId, role: 'assistant', type: 'say', text: 'UNRELEASED OUTPUT', contentBlocks: [], metadata: {} });
  expect((await control(taskId)).status).toBe(204);
  for (const path of ['/api/tasks/' + taskId, '/api/' + taskId + '/messages']) {
    const response = await fixture.call(path);
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('UNRELEASED OUTPUT');
  }
});

it('retains completed result policy when a task has both completed and current pending provenance', async () => {
  await fixture.seed('mixed-control-task');
  await fixture.authority.startInline(fixture.actors.alice,
    { agentId: RESULT_AGENT, taskId: 'mixed-control-task', workspaceId: 'mixed-control-task' });
  expect((await control('mixed-control-task')).status).toBe(204);
  await fixture.change('alice', 'revoke');
  expect((await control('mixed-control-task')).status).toBe(404);
});

it('refuses foreign, issuer-twin and administrator subscribers despite their independent application grants', async () => {
  const { taskId } = await pendingThread();
  await fixture.change('bob'); await fixture.change('twin'); await fixture.change('admin');
  for (const user of ['bob', 'twin', 'admin']) expect((await control(taskId, user)).status).toBe(404);
});

it.each(['guest', 'anonymous'])('refuses a %s transport even when the actor resolver could resolve the exact owner', async auth => {
  const { taskId } = await pendingThread();
  expect((await control(taskId, 'alice', auth)).status).toBe(404);
});

it('requires an actual creation-stamped task and refuses missing tasks', async () => {
  const { taskId } = await pendingThread(), task = await fixture.tasks.get(taskId);
  if (!task) throw new Error('Fixture task missing');
  await fixture.tasks.replace({ ...task, metadata: {} });
  expect((await control(taskId)).status).toBe(404);
  await fixture.tasks.delete(taskId);
  expect((await control(taskId)).status).toBe(404);
});

it('requires durable control provenance and the configured authority', async () => {
  const created = await fixture.call('/api/tasks', 'alice', { title: 'Empty approval task', agentId: RESULT_AGENT });
  const { taskId } = await created.json();
  expect((await control(taskId)).status).toBe(404);
  await fixture.authority.startInline(fixture.actors.alice, { agentId: RESULT_AGENT, taskId, workspaceId: taskId });
  configureApplicationRemoteExecutionAuthority(undefined);
  expect((await control(taskId)).status).toBe(404);
});

it('refuses expired and revoked pending execution provenance', async () => {
  const { taskId, executionId } = await pendingThread();
  await fixture.records.update(executionId, async record => { record.expiresAt = '1970-01-01T00:00:00.000Z'; });
  expect((await control(taskId)).status).toBe(404);
  await fixture.records.update(executionId, async record => { record.status = 'revoked'; });
  expect((await control(taskId)).status).toBe(404);
});

it('refuses current role revocation and account deactivation during pending work', async () => {
  const { taskId } = await pendingThread();
  await fixture.change('alice', 'revoke'); expect((await control(taskId)).status).toBe(404);
  await fixture.change(); expect((await control(taskId)).status).toBe(204);
  fixture.actors.alice.isActive = false; expect((await control(taskId)).status).toBe(404);
});

it('rereads the stamped destination instead of trusting the task seen before a delayed policy check', async () => {
  const { taskId } = await pendingThread(), task = await fixture.tasks.get(taskId);
  if (!task) throw new Error('Fixture task missing');
  const original = fixture.authority.assertTaskControlAccess.bind(fixture.authority);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.authority, 'assertTaskControlAccess').mockImplementationOnce(async (...args) => {
    await original(...args); entered(); await waiting;
  });
  const response = control(taskId); await started;
  try { await fixture.tasks.replace({ ...task, metadata: { ...task.metadata, [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: 'https://other.fixture.test' } }); }
  finally { release(); }
  expect((await response).status).toBe(404);
});

it('rechecks current policy after the second task read is delayed', async () => {
  const { taskId } = await pendingThread(), original = fixture.tasks.get.bind(fixture.tasks);
  let entered!: () => void, release!: () => void, reads = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.tasks, 'get').mockImplementation(async id => {
    const task = await original(id);
    if (++reads === 2) { entered(); await waiting; }
    return task;
  });
  const response = control(taskId); await started;
  try { await fixture.change('alice', 'revoke'); }
  finally { release(); }
  expect((await response).status).toBe(404);
});

it('checks configured authority identity after the final awaited control decision', async () => {
  const { taskId } = await pendingThread(), original = fixture.authority.assertTaskControlAccess.bind(fixture.authority);
  let entered!: () => void, release!: () => void, decisions = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(fixture.authority, 'assertTaskControlAccess').mockImplementation(async (...args) => {
    await original(...args);
    if (++decisions === 2) { entered(); await waiting; }
  });
  const response = control(taskId); await started;
  try { configureApplicationRemoteExecutionAuthority(undefined); }
  finally { release(); }
  expect((await response).status).toBe(404);
});

it('keeps actual task-store faults fail-closed', async () => {
  const { taskId } = await pendingThread();
  vi.spyOn(fixture.tasks, 'get').mockRejectedValue(new Error('Stored task unavailable'));
  expect((await control(taskId)).status).toBe(404);
});
