/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove signing-independent inline provenance, exact identity, original grant ceilings and remote transport refusal.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteExecutionFixture } from '../fixtures/application-remote-execution';
import { ApplicationRemoteExecutionService } from '@/features/application-remote-execution';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';

const input = { agentId: 'fixture-bot', taskId: 'inline-task', workspaceId: 'inline-workspace' };
let fixture: RemoteExecutionFixture;
beforeEach(async () => { fixture = await new RemoteExecutionFixture().start(); });
afterEach(() => { vi.restoreAllMocks(); });

async function start(actor = fixture.actor) {
  const execution = await fixture.authority.startInline(actor, input);
  if (!execution) throw new Error('Fixture must start protected inline work');
  return execution;
}

it('starts restricted durable inline work without issuing or verifying any worker token', async () => {
  const issue = vi.fn(() => { throw new Error('Signing unavailable'); });
  const verify = vi.fn(() => { throw new Error('Verifier unavailable'); });
  const authority = new ApplicationRemoteExecutionService(fixture.store, {
    issuer: { issue }, verifier: { verify }, tokenIssuer: 'urn:fixture:controller', dispatchAudience: 'urn:fixture:worker',
    now: () => fixture.now, owner: async (_kind, id) => id === input.agentId ? { app: 'fixture-app', protected: true } : undefined,
    snapshot: () => fixture.snapshot, refreshActor: async actor => ({ ...actor, isActive: true }),
    authorize: (actor, operation) => fixture.policy.authorize(actor, operation),
    effective: (actor, app, tenantId) => fixture.policy.effective(actor, { app, tenantId }),
  });
  const execution = (await authority.startInline({ ...fixture.actor, isSwarmAdmin: true }, input))!;
  expect(execution).toMatchObject({ binding: { ...input, app: 'fixture-app', sub: fixture.actor.sub, issuer: fixture.actor.issuer },
    actor: { sub: fixture.actor.sub, issuer: fixture.actor.issuer, isSwarmAdmin: false, allowedPermissions: ['fixture-app:bot.execute'] } });
  expect(Date.parse(execution.expiresAt) - fixture.now).toBe(5_400_000);
  expect(await fixture.store.read(execution.executionId)).toMatchObject({ transport: 'inline', status: 'started',
    permissionGrants: [{ permission: 'bot.execute', scope: 'own' }], startedAt: new Date(fixture.now).toISOString() });
  await authority.completeInline(execution.executionId, execution.actor);
  await authority.assertResultAccess(execution.executionId, fixture.actor, { taskId: input.taskId });
  expect(issue).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
});

it('does not manufacture provenance for a confirmed unprotected inline bot', async () => {
  const insert = vi.spyOn(fixture.store, 'insert');
  expect(await fixture.authority.startInline(fixture.actor, { ...input, agentId: 'confirmed-kernel-bot' })).toBeNull();
  expect(insert).not.toHaveBeenCalled();
});

it('validates a newly discovered protected destination as its restricted actor before any durable insertion', async () => {
  const insert = vi.spyOn(fixture.store, 'insert');
  await expect(fixture.authority.startInline({ ...fixture.actor, isSwarmAdmin: true }, input, async actor => {
    expect(actor).toMatchObject({ sub: fixture.actor.sub, issuer: fixture.actor.issuer,
      isSwarmAdmin: false, allowedPermissions: ['fixture-app:bot.execute'] });
    throw new Error('foreign hidden destination');
  })).rejects.toThrow('foreign hidden destination');
  expect(insert).not.toHaveBeenCalled(); expect(await fixture.authority.hasTaskResults(input.taskId)).toBe(false);
});

it.each(['foreign-issuer', 'foreign-subject', 'inactive', 'admin-only', 'empty-ceiling'])(
  'refuses %s authority before storing or starting protected inline work', async evidence => {
    const actors: Record<string, AuthorizationActor> = { 'foreign-issuer': { ...fixture.actor, issuer: 'https://other.example.test' },
      'foreign-subject': { ...fixture.actor, sub: 'other-user' }, inactive: { ...fixture.actor, isActive: false },
      'admin-only': fixture.admin, 'empty-ceiling': { ...fixture.actor, allowedPermissions: [] } };
    const insert = vi.spyOn(fixture.store, 'insert');
    await expect(start(actors[evidence])).rejects.toThrow(); expect(insert).not.toHaveBeenCalled();
  },
);

it('rejects caller authority fields and execution references in inline preparation', async () => {
  for (const extra of [{ executionId: randomUUID() }, { transport: 'inline' }, { actor: fixture.admin }, { app: 'other' }]) {
    await expect(fixture.authority.startInline(fixture.actor, { ...input, ...extra } as never)).rejects.toMatchObject({ status: 400 });
  }
});

it('keeps in-progress inline work unavailable and completes once before durable result linkage', async () => {
  const execution = await start();
  expect(await fixture.authority.hasTaskResults(input.taskId)).toBe(true);
  await expect(fixture.authority.assertTaskResultAccess(input.taskId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  await expect(fixture.authority.assertResultAccess(execution.executionId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  await expect(fixture.authority.linkResult(execution.executionId, 'parent', fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  const completions = await Promise.allSettled([fixture.authority.completeInline(execution.executionId, fixture.actor),
    fixture.authority.completeInline(execution.executionId, fixture.actor)]);
  expect(completions.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await fixture.store.read(execution.executionId)).toMatchObject({ status: 'completed', completedAt: new Date(fixture.now).toISOString() });
  await fixture.authority.linkResult(execution.executionId, 'parent', fixture.actor);
  expect(await fixture.authority.hasTaskResults('parent')).toBe(true);
  await fixture.authority.assertTaskResultAccess('parent', fixture.actor);
  await expect(fixture.authority.assertResultAccess(execution.executionId, fixture.actor, { taskId: 'unrelated' })).rejects.toThrow('remote_execution_result_binding_mismatch');
});

it.each(['foreign-issuer', 'foreign-subject', 'inactive'])(
  'withholds completion from a %s principal without changing started provenance', async evidence => {
    const execution = await start();
    const actor = { ...fixture.actor, ...(evidence === 'foreign-issuer' ? { issuer: 'https://other.example.test' }
      : evidence === 'foreign-subject' ? { sub: 'other-user' } : { isActive: false }) };
    await expect(fixture.authority.completeInline(execution.executionId, actor)).rejects.toThrow();
    expect((await fixture.store.read(execution.executionId))!.status).toBe('started');
  },
);

it.each(['revoked', 'denied', 'disabled', 'removed', 'generation', 'expanded', 'expired'])(
  'withholds inline completion and persisted result release after %s state', async state => {
    const execution = await start();
    if (state === 'revoked') await fixture.change({ action: 'revoke' });
    if (state === 'denied') await fixture.change({ action: 'deny', role: undefined });
    if (state === 'disabled') fixture.active = false;
    if (state === 'removed') fixture.available = false;
    if (state === 'generation') fixture.snapshot = { ...fixture.snapshot, generation: randomUUID() };
    if (state === 'expanded') await fixture.change({ role: 'reader' });
    if (state === 'expired') fixture.now += 5_400_001;
    await expect(fixture.authority.completeInline(execution.executionId, fixture.actor)).rejects.toThrow();
    expect((await fixture.store.read(execution.executionId))!.status).toBe('started');
    await expect(fixture.authority.assertResultAccess(execution.executionId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  },
);

it('withholds output containing original read context when that read grant is removed', async () => {
  await fixture.change({ role: 'reader' }); const execution = await start();
  await fixture.change({ action: 'revoke', role: 'reader' });
  expect((await fixture.policy.authorize(fixture.actor, { app: 'fixture-app', kind: 'bots', operation: input.agentId })).allowed).toBe(true);
  await expect(fixture.authority.completeInline(execution.executionId, fixture.actor)).rejects.toThrow('remote_execution_original_grant_revoked');
});

it('rechecks current rights and exact issuer whenever completed inline output is reopened', async () => {
  const execution = await start(); await fixture.authority.completeInline(execution.executionId, fixture.actor);
  await expect(fixture.authority.assertResultAccess(execution.executionId, { ...fixture.actor, issuer: 'https://other.example.test' }))
    .rejects.toThrow('remote_execution_result_owner_mismatch');
  await fixture.change({ action: 'revoke' });
  await expect(fixture.authority.assertTaskResultAccess(input.taskId, fixture.actor)).rejects.toThrow();
  await fixture.change(); await fixture.authority.assertTaskResultAccess(input.taskId, fixture.actor);
});

it('never binds or revalidates controller inline provenance through the signed worker protocol', async () => {
  const remote = await fixture.dispatch(); const execution = await start();
  await expect(fixture.authority.bind(execution.executionId, remote.receipt,
    { ...remote.body, applicationExecutionId: execution.executionId })).rejects.toThrow('remote_execution_transport_refused');
  for (const phase of ['start', 'work', 'complete'] as const) {
    await expect(fixture.authority.revalidate({ executionId: execution.executionId, token: remote.token, phase, nonce: randomUUID() }))
      .rejects.toThrow('remote_execution_transport_refused');
  }
  expect((await fixture.store.read(execution.executionId))!.status).toBe('started');
});

it.each([false, true])('never completes a %s legacy remote record through controller inline authority', async legacy => {
  const remote = await fixture.dispatch(); await fixture.check(remote, 'start');
  if (legacy) await fixture.store.update(remote.executionId, async record => { delete record.transport; });
  await expect(fixture.authority.completeInline(remote.executionId, fixture.actor)).rejects.toThrow('inline_execution_phase_refused');
  await fixture.check(remote, 'complete'); await fixture.authority.assertResultAccess(remote.executionId, fixture.actor);
});

it('retains the existing remote preparation lifetime and signed worker lifecycle', async () => {
  const prepared = (await fixture.authority.prepare(fixture.actor, input))!;
  expect(Date.parse(prepared.expiresAt) - fixture.now).toBe(300_000);
  expect(await fixture.store.read(prepared.executionId)).toMatchObject({ status: 'prepared', transport: 'remote' });
  const remote = await fixture.dispatch(); await fixture.check(remote, 'start'); await fixture.check(remote, 'complete');
  await fixture.authority.assertResultAccess(remote.executionId, fixture.actor);
});

it('rejects package replacement during an awaited inline completion without committing completion', async () => {
  const execution = await start();
  fixture.beforeAuthorize = async () => { fixture.snapshot = { ...fixture.snapshot, generation: randomUUID() }; };
  await expect(fixture.authority.completeInline(execution.executionId, fixture.actor)).rejects.toThrow('remote_execution_generation_changed');
  expect((await fixture.store.read(execution.executionId))!.status).toBe('started');
});

it('checks empty-thread bot policy as the restricted exact principal without creating provenance', async () => {
  const insert = vi.spyOn(fixture.store, 'insert'); let observed = 0;
  fixture.adapter = { authorize: async ({ actor }) => {
    expect(actor.isSwarmAdmin).toBe(false);
    expect(getApplicationAuthorizationActor()).toMatchObject({ sub: fixture.actor.sub, issuer: fixture.actor.issuer, isSwarmAdmin: false });
    expect(getRequestIdentity()).toMatchObject({ sub: fixture.actor.sub, principalIssuer: fixture.actor.issuer, isOperator: false });
    observed++; return true;
  } };
  await runWithSystemIdentity(() => fixture.authority.assertEmptyTaskAccess(input.agentId, { ...fixture.actor, isSwarmAdmin: true }));
  expect(observed).toBeGreaterThan(0); expect(insert).not.toHaveBeenCalled();
  expect(await fixture.authority.hasTaskResults(input.taskId)).toBe(false);
});

it.each(['revoked', 'denied', 'disabled', 'disabled-during-check', 'removed', 'generation', 'unprotected', 'foreign-issuer', 'invalid-agent'])(
  'refuses an empty protected thread under %s current bot policy', async state => {
    if (state === 'revoked') await fixture.change({ action: 'revoke' });
    if (state === 'denied') await fixture.change({ action: 'deny', role: undefined });
    if (state === 'disabled') fixture.active = false;
    if (state === 'disabled-during-check') fixture.beforeAuthorize = async () => { fixture.active = false; };
    if (state === 'removed') fixture.available = false;
    if (state === 'generation') fixture.beforeAuthorize = async () => { fixture.snapshot = { ...fixture.snapshot, generation: randomUUID() }; };
    const agent = state === 'unprotected' ? 'confirmed-kernel-bot' : state === 'invalid-agent' ? '\u0000' : input.agentId;
    const actor = state === 'foreign-issuer' ? { ...fixture.actor, issuer: 'https://other.example.test' } : fixture.actor;
    await expect(fixture.authority.assertEmptyTaskAccess(agent, actor)).rejects.toThrow();
  },
);

it('permits exact owned pending inline controls without making any output readable', async () => {
  const execution = await start();
  await fixture.authority.assertTaskControlAccess(input.taskId, fixture.actor);
  await expect(fixture.authority.assertTaskResultAccess(input.taskId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  await expect(fixture.authority.assertResultAccess(execution.executionId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  await fixture.authority.completeInline(execution.executionId, fixture.actor);
  await fixture.authority.assertTaskControlAccess(input.taskId, fixture.actor);
});

it.each(['foreign-subject', 'foreign-issuer', 'inactive', 'expired', 'revoked-record', 'denied', 'grant-revoked',
  'grant-expanded', 'context-revoked', 'removed', 'generation', 'remote', 'workspace', 'aggregate', 'unknown'])(
  'refuses pending inline controls under %s evidence without releasing results', async state => {
    if (state === 'context-revoked') await fixture.change({ role: 'reader' });
    const execution = await start();
    let actor = fixture.actor, taskId = input.taskId;
    if (state === 'foreign-subject') actor = { ...actor, sub: 'other-user' };
    if (state === 'foreign-issuer') actor = { ...actor, issuer: 'https://other.example.test' };
    if (state === 'inactive') actor = { ...actor, isActive: false };
    if (state === 'expired') fixture.now += 5_400_001;
    if (state === 'revoked-record') await fixture.store.update(execution.executionId, async record => { record.status = 'revoked'; });
    if (state === 'denied') await fixture.change({ action: 'deny', role: undefined });
    if (state === 'grant-revoked') await fixture.change({ action: 'revoke' });
    if (state === 'grant-expanded') await fixture.change({ role: 'reader' });
    if (state === 'context-revoked') await fixture.change({ action: 'revoke', role: 'reader' });
    if (state === 'removed') fixture.available = false;
    if (state === 'generation') fixture.snapshot = { ...fixture.snapshot, generation: randomUUID() };
    if (state === 'remote') await fixture.store.update(execution.executionId, async record => { record.transport = 'remote'; });
    if (state === 'workspace') taskId = input.workspaceId;
    if (state === 'aggregate') {
      taskId = 'pending-aggregate';
      await fixture.store.update(execution.executionId, async record => { record.resultTaskIds!.push(taskId); });
    }
    if (state === 'unknown') taskId = 'unknown-task';
    await expect(fixture.authority.assertTaskControlAccess(taskId, actor)).rejects.toThrow();
    await expect(fixture.authority.assertResultAccess(execution.executionId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  },
);

it('checks every completed and pending record before allowing current task control', async () => {
  const first = await start(); await fixture.authority.completeInline(first.executionId, fixture.actor);
  const second = await start(); await fixture.authority.assertTaskControlAccess(input.taskId, fixture.actor);
  await fixture.store.update(first.executionId, async record => { record.status = 'revoked'; });
  await expect(fixture.authority.assertTaskControlAccess(input.taskId, fixture.actor)).rejects.toThrow('remote_execution_control_unavailable');
  expect((await fixture.store.read(second.executionId))!.status).toBe('started');
});
