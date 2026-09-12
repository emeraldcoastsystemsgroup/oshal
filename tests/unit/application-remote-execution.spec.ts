/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove current application authority, exact signed bindings, replay refusal and result lineage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Reject newly broadened context-read grants before binding an already prepared execution.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { RemoteExecutionFixture, REMOTE_FIXTURE_CATALOG } from '../fixtures/application-remote-execution';
import { REMOTE_EXECUTION_PATH, REMOTE_PERMIT_AUDIENCE, REMOTE_PERMIT_SCOPE } from '@/shared/application-remote-execution';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { getRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';

let fixture: RemoteExecutionFixture;
beforeEach(async () => { fixture = await new RemoteExecutionFixture().start(); });

it('signs a current short permit with separate audience, exact original tuple and current ceiling', async () => {
  const dispatch = await fixture.dispatch(); const signed = await fixture.check(dispatch, 'start');
  expect(signed.permit).toMatchObject({ phase: 'start', executionId: dispatch.executionId, app: 'fixture-app',
    sub: fixture.actor.sub, issuer: fixture.actor.issuer, dispatchJti: dispatch.receipt.claims.jti,
    allowedPermissions: ['fixture-app:bot.execute'] });
  expect(Date.parse(signed.permit.expiresAt) - fixture.now).toBeLessThanOrEqual(15_000);
  expect(fixture.verifier.verify(signed.token, { iss: 'urn:oshal:controller', aud: REMOTE_PERMIT_AUDIENCE,
    azp: 'fixture-bot', task_id: 'fixture-task', sub: fixture.actor.sub, principal_iss: fixture.actor.issuer,
    scope: REMOTE_PERMIT_SCOPE, method: 'POST', path: REMOTE_EXECUTION_PATH, body_sha256: delegationRequestBodySha256(signed.permit) }).jti).toBeTruthy();
  await expect(fixture.check({ ...dispatch, token: signed.token }, 'work')).rejects.toThrow('remote_execution_token_mismatch');
});

it('requires exact active account and explicit application grants without any global administrator bypass', async () => {
  for (const actor of [{ ...fixture.actor, issuer: 'https://login.microsoftonline.com/tenant/v2.0' }, fixture.admin,
    { ...fixture.actor, isActive: false }, { ...fixture.actor, allowedPermissions: [] }]) {
    await expect(fixture.dispatch(actor)).rejects.toThrow();
  }
  await fixture.change({ action: 'revoke' });
  await expect(fixture.dispatch({ ...fixture.actor, isSwarmAdmin: true })).rejects.toThrow();
  expect(await fixture.authority.prepare(fixture.actor, { agentId: 'confirmed-kernel-bot', taskId: 't', workspaceId: 'w' })).toBeNull();
});

it('rejects mutated task, subject, issuer, reference, request bytes and receipt claims before binding', async () => {
  for (const extra of [{ taskId: 'other' }, { workspaceFolderId: 'other' }, { userSub: 'other' },
    { principalIssuer: 'other' }, { agentId: 'other' }, { applicationExecutionId: randomUUID() }]) {
    await expect(fixture.dispatch(fixture.actor, extra)).rejects.toThrow('remote_execution_binding_mismatch');
  }
  const prepared = (await fixture.authority.prepare(fixture.actor, { agentId: 'fixture-bot', taskId: 'fixture-task', workspaceId: 'fixture-workspace' }))!;
  const valid = await fixture.dispatch();
  await expect(fixture.authority.bind(prepared.executionId, valid.receipt, { ...valid.body, applicationExecutionId: prepared.executionId })).rejects.toThrow();
  await expect(fixture.authority.bind(valid.executionId, valid.receipt, valid.body)).rejects.toThrow('remote_execution_already_bound');
});

it('atomically accepts one start and never accepts reused challenges or phases after completion', async () => {
  const dispatch = await fixture.dispatch(); const nonce = randomUUID();
  const input = { executionId: dispatch.executionId, token: dispatch.token, phase: 'start' as const, nonce };
  const results = await Promise.allSettled([fixture.authority.revalidate(input), fixture.authority.revalidate(input)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  await expect(fixture.authority.revalidate({ ...input, phase: 'work' })).rejects.toThrow('remote_execution_challenge_replayed');
  await fixture.check(dispatch, 'work'); await fixture.check(dispatch, 'complete');
  for (const phase of ['start', 'work', 'complete'] as const) await expect(fixture.check(dispatch, phase)).rejects.toThrow('remote_execution_phase_refused');
});

it('revalidates revocation, current account status and policy lifecycle before every worker phase', async () => {
  const dispatch = await fixture.dispatch(); await fixture.check(dispatch, 'start');
  await fixture.change({ action: 'deny', role: undefined });
  await expect(fixture.check(dispatch, 'work')).rejects.toThrow();
  await expect(fixture.check(dispatch, 'complete')).rejects.toThrow();
  await fixture.change({ action: 'clear-deny', role: undefined });
  fixture.active = false; await expect(fixture.check(dispatch, 'work')).rejects.toThrow('remote_execution_identity_required');
  fixture.active = true; fixture.available = false;
  await expect(fixture.check(dispatch, 'work')).rejects.toThrow('remote_execution_generation_changed');
});

it('does not widen original tool permissions when a role is granted after dispatch', async () => {
  const dispatch = await fixture.dispatch(); await fixture.check(dispatch, 'start');
  await fixture.change({ role: 'reader' });
  const input = { ...dispatch, phase: 'action' as const, nonce: randomUUID(), action: { kind: 'tools' as const, operation: 'fixture-read' } };
  await expect(fixture.authority.revalidate({ executionId: input.executionId, token: input.token, phase: input.phase, nonce: input.nonce, action: input.action })).rejects.toThrow();
  const current = await fixture.dispatch(); await fixture.check(current, 'start');
  await expect(fixture.authority.revalidate({ executionId: current.executionId, token: current.token, phase: 'action', nonce: randomUUID(), action: input.action })).resolves.toMatchObject({ permit: { action: input.action } });
  await expect(fixture.authority.revalidate({ executionId: current.executionId, token: current.token, phase: 'action', nonce: randomUUID(), action: { kind: 'tools', operation: 'arbitrary-shell' } })).rejects.toThrow('remote_execution_action_unbound');
});

it('never evaluates a resource adapter as operator or with an unrelated application actor', async () => {
  let observed = 0;
  fixture.adapter = { authorize: async ({ actor }) => {
    expect(getRequestIdentity()).toMatchObject({ sub: fixture.actor.sub, principalIssuer: fixture.actor.issuer, isOperator: false });
    expect(getApplicationAuthorizationActor()).toMatchObject({ sub: fixture.actor.sub, issuer: fixture.actor.issuer, isSwarmAdmin: false });
    expect(actor.isSwarmAdmin).toBe(false); observed++; return true;
  } };
  const dispatch = await runWithSystemIdentity(() => fixture.dispatch());
  await runWithSystemIdentity(() => fixture.check(dispatch, 'start'));
  expect(observed).toBeGreaterThan(0);
});

it('rejects retirement during an awaited policy check and never commits its start', async () => {
  const dispatch = await fixture.dispatch();
  fixture.beforeAuthorize = async () => { fixture.snapshot = { ...fixture.snapshot, generation: randomUUID() }; };
  await expect(fixture.check(dispatch, 'start')).rejects.toThrow('remote_execution_generation_changed');
  expect((await fixture.store.read(dispatch.executionId))!.status).toBe('bound');
});

it('rejects expired originals and malformed or authority-bearing request envelopes', async () => {
  const dispatch = await fixture.dispatch();
  const input = { executionId: dispatch.executionId, token: dispatch.token, phase: 'start', nonce: randomUUID() };
  for (const extra of [{ actor: fixture.admin }, { app: 'other' }, { nonce: 'short' }, { phase: 'execute' }, { action: { kind: 'tools', operation: 'fixture-read' } }]) {
    await expect(fixture.authority.revalidate({ ...input, ...extra } as never)).rejects.toMatchObject({ status: 400 });
  }
  fixture.now += 300_001;
  await expect(fixture.check(dispatch, 'start')).rejects.toThrow('remote_execution_expired_or_revoked');
});

it('releases only completed results for the exact owner and trusted task binding under current policy', async () => {
  const dispatch = await fixture.dispatch();
  await expect(fixture.authority.assertResultAccess(dispatch.executionId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  await fixture.check(dispatch, 'start');
  await expect(fixture.authority.assertResultAccess(dispatch.executionId, fixture.actor)).rejects.toThrow('remote_execution_result_unavailable');
  await fixture.check(dispatch, 'complete');
  await fixture.authority.assertResultAccess(dispatch.executionId, fixture.actor, { taskId: 'fixture-task' });
  await expect(fixture.authority.assertResultAccess(dispatch.executionId, { ...fixture.actor, issuer: 'other' })).rejects.toThrow('remote_execution_result_owner_mismatch');
  await expect(fixture.authority.assertResultAccess(dispatch.executionId, fixture.actor, { taskId: 'unrelated-task' })).rejects.toThrow('remote_execution_result_binding_mismatch');
  await fixture.change({ action: 'revoke' });
  await expect(fixture.authority.assertResultAccess(dispatch.executionId, fixture.actor)).rejects.toThrow();
});

it('links aggregate results durably and requires all concurrent lineage even when markers disappear', async () => {
  const first = await fixture.dispatch(); const second = await fixture.dispatch();
  for (const dispatch of [first, second]) {
    await fixture.check(dispatch, 'start'); await fixture.check(dispatch, 'complete');
    await fixture.authority.linkResult(dispatch.executionId, 'jarvis-parent', fixture.actor);
  }
  expect(await fixture.authority.hasTaskResults('jarvis-parent')).toBe(true);
  await fixture.authority.assertTaskResultAccess('jarvis-parent', fixture.actor);
  await fixture.authority.assertResultAccess(first.executionId, fixture.actor, { taskId: 'jarvis-parent' });
  await fixture.store.update(second.executionId, async record => { record.status = 'revoked'; });
  await expect(fixture.authority.assertTaskResultAccess('jarvis-parent', fixture.actor)).rejects.toThrow();
  expect(await fixture.authority.hasTaskResults('not-a-result')).toBe(false);
});

it('preserves directory freshness rather than rejuvenating queued evidence', async () => {
  fixture.actor.directory = [{ issuer: 'https://login.microsoftonline.com/fixture/v2.0', tenantId: 'directory-tenant',
    groups: ['group-one'], complete: true, observedAt: new Date(fixture.now - 290_000).toISOString() }];
  await fixture.change({ action: 'revoke' });
  await fixture.change({ action: 'group-map', targetSub: undefined, targetIssuer: undefined,
    group: { issuer: fixture.actor.directory[0].issuer, tenantId: 'directory-tenant', id: 'group-one' } });
  const dispatch = await fixture.dispatch(); const original = structuredClone(fixture.actor.directory);
  fixture.now += 20_000;
  await expect(fixture.check(dispatch, 'start')).rejects.toThrow();
  expect((await fixture.store.read(dispatch.executionId))!.actor.directory).toEqual(original);
});

it('retains original field-set tuples when later grants reuse the same permission name', async () => {
  const catalog = structuredClone(REMOTE_FIXTURE_CATALOG);
  catalog.resources.records.fieldSets = { public: ['title'], confidential: ['title', 'salary'] };
  catalog.roles.runner.grants[0].fields = 'public';
  catalog.roles.reader.grants[0].fields = 'public';
  catalog.roles.expanded = { tier: 'editor', grants: [{ permission: 'bot.execute', scope: 'own', fields: 'confidential' }] };
  fixture = await new RemoteExecutionFixture().start(catalog);
  const dispatch = await fixture.dispatch(); await fixture.check(dispatch, 'start');
  await fixture.change({ role: 'expanded' });
  await expect(fixture.check(dispatch, 'work')).rejects.toThrow('remote_execution_grant_scope_expanded');
});

it('supports explicit application-admin fallback and refuses a delegated ceiling without that exact right', async () => {
  fixture = await new RemoteExecutionFixture().start(null, '@app-admin');
  const dispatch = await fixture.dispatch();
  expect((await fixture.check(dispatch, 'start')).permit.allowedPermissions).toEqual(['fixture-app:@app-admin']);
  await expect(fixture.dispatch({ ...fixture.actor, allowedPermissions: ['fixture-app:bot.execute'] })).rejects.toThrow();
  await fixture.change({ action: 'revoke', role: '@app-admin' });
  await expect(fixture.check(dispatch, 'work')).rejects.toThrow();
});

it('revokes output containing earlier context when its read grant is removed but bot execution remains', async () => {
  await fixture.change({ role: 'reader' });
  const dispatch = await fixture.dispatch(); await fixture.check(dispatch, 'start'); await fixture.check(dispatch, 'complete');
  await fixture.change({ role: 'reader', action: 'revoke' });
  expect((await fixture.policy.authorize(fixture.actor, { app: 'fixture-app', kind: 'bots', operation: 'fixture-bot' })).allowed).toBe(true);
  await expect(fixture.authority.assertResultAccess(dispatch.executionId, fixture.actor)).rejects.toThrow('remote_execution_original_grant_revoked');
  await fixture.change({ role: 'reader' });
  const running = await fixture.dispatch(); await fixture.check(running, 'start');
  await fixture.change({ role: 'reader', action: 'revoke' });
  await expect(fixture.check(running, 'work')).rejects.toThrow('remote_execution_original_grant_revoked');
});

it('refuses bind when a broader read scope is added while the original own grant and bot grant remain', async () => {
  const catalog = structuredClone(REMOTE_FIXTURE_CATALOG);
  catalog.resources.records.scopes.push('team');
  catalog.roles.broaderReader = { tier: 'viewer', grants: [{ permission: 'record.read', scope: 'team' }] };
  fixture = await new RemoteExecutionFixture().start(catalog); await fixture.change({ role: 'reader' });
  const prepared = (await fixture.authority.prepare(fixture.actor, { agentId: 'fixture-bot', taskId: 'fixture-task', workspaceId: 'fixture-workspace' }))!;
  await fixture.change({ role: 'broaderReader' });
  const current = await fixture.policy.effective(fixture.actor, { app: 'fixture-app' });
  expect(current.permissions).toEqual(expect.arrayContaining([{ permission: 'record.read', scope: 'own' }, { permission: 'record.read', scope: 'team' }]));
  expect((await fixture.policy.authorize(fixture.actor, { app: 'fixture-app', kind: 'bots', operation: 'fixture-bot' })).allowed).toBe(true);
  const body = { taskId: 'fixture-task', workspaceFolderId: 'fixture-workspace', userSub: fixture.actor.sub,
    principalIssuer: fixture.actor.issuer, applicationExecutionId: prepared.executionId };
  const receipt = fixture.issuer.issue({ iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', azp: 'fixture-bot', task_id: body.taskId,
    sub: fixture.actor.sub, principal_iss: fixture.actor.issuer, method: 'POST', path: '/api/swarm-execute', scope: ['swarm:execute'], body_sha256: delegationRequestBodySha256(body) });
  await expect(fixture.authority.bind(prepared.executionId, receipt, body)).rejects.toThrow('remote_execution_grant_scope_expanded');
  expect((await fixture.store.read(prepared.executionId))!.status).toBe('prepared');
});
