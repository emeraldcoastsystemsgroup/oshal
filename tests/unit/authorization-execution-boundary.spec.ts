/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Read the asked-about agent id out of the parameter position it is actually bound at. The ownership reader no longer sends an inline query whose first bind is the executable id; it calls oshal_application_execution_claims(kind, id, app, enforce) (migration 142), so call[1][0] became the literal 'bots' and this case asserted ['bots','bots'] against the two agent ids - red on the branch that made the change, and invisible in its verification list. The case now pins the kind and the id separately AND pins that the read goes through the derived helper, so a silent return to the inline query (which oshal_bot cannot run - BUG-25) is a failure here rather than a passing assertion about a different parameter.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A pool-less refusal is named database_pool_unavailable (same 503, same fail-closed throw) instead of borrowing the authorization code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApplicationExecutionPolicy, runWithApplicationExecution } from '../../src/shared/application-authorization-execution';
import { runWithApplicationAuthorizationActor } from '../../src/shared/application-authorization-context';
import { getRequestIdentity, runWithSystemIdentity } from '../../src/shared/services/database/request-identity';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '../../src/features/application-authorization';
import { BotNodeClient } from '../../src/features/agent-management/services/bot-node-client';
import { TaskOrchestrator } from '../../src/features/chat-orchestration/services/task-orchestrator';
import { ToolExecutorService } from '../../src/features/chat-orchestration/services/tool-executor-service';
import { StreamManager } from '../../src/features/streaming';
import { createBotNodeExecutionHandler } from '../../src/app/bot-node-execution-handler';
import { assertBotNodeApplicationTransport } from '../../src/app/bot-node-application-authorization';
import type { AuthorizationActor } from '../../src/shared/application-authorization';
import type { MeshEnvelope } from '../../src/features/agent-management';
import type { Pool } from 'pg';

const actor: AuthorizationActor = { sub: 'actor', issuer: 'fixture', isActive: true, isSwarmAdmin: true };
afterEach(() => configureApplicationExecutionPolicy(undefined));
async function configured() {
  const store = new MemoryAuthorizationStore(); const service = new ApplicationAuthorizationService(store);
  await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', catalog: null, mode: 'enforce', agentIds: ['protected-bot'] });
  configureApplicationExecutionPolicy({ owner: (_kind, name) => name.startsWith('protected-') ? 'fixture-app' : undefined,
    protectedApp: app => app === 'fixture-app', authorize: (user, operation) => service.authorize(user, operation) });
  return { service, store };
}
describe('protected application execution', () => {
  it('requires current actor and explicit authority even for an internal/system call', async () => {
    const { service } = await configured(); const invoked = vi.fn(async () => getRequestIdentity());
    await expect(runWithSystemIdentity(() => runWithApplicationExecution({ kind: 'tools', operation: 'protected-tool' }, invoked))).rejects.toMatchObject({ status: 403 });
    await expect(runWithApplicationAuthorizationActor(actor, () => runWithApplicationExecution({ kind: 'tools', operation: 'protected-tool' }, invoked))).rejects.toMatchObject({ code: 'authorization_app_admin_required' });
    const preview = await service.previewChange(actor, { action: 'grant', app: 'fixture-app', role: '@app-admin', targetSub: actor.sub, targetIssuer: actor.issuer, reason: 'Execution fixture', expectedRevision: 0 });
    await service.applyChange(actor, { previewId: preview.previewId, idempotencyKey: preview.previewId });
    const identity = await runWithSystemIdentity(() => runWithApplicationAuthorizationActor(actor,
      () => runWithApplicationExecution({ kind: 'tools', operation: 'protected-tool', userSub: actor.sub }, invoked)));
    expect(identity).toMatchObject({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false });
    await expect(runWithApplicationAuthorizationActor(actor, () => runWithApplicationExecution({ kind: 'tools', operation: 'protected-tool', userSub: 'other' }, invoked))).rejects.toMatchObject({ code: 'authorization_execution_identity_required' });
    expect(invoked).toHaveBeenCalledTimes(1);
  });
  it('guards actual remote, inline and tool entry points before endpoint/store/stream work', async () => {
    await configured(); const endpoint = vi.fn(() => null);
    const client = new BotNodeClient(endpoint, 1000, { env: {} });
    await expect(client.execute('protected-bot', { agentId: 'protected-bot', taskId: 'task', workspaceFolderId: 'task', text: 'run', direct: false, userSub: actor.sub })).rejects.toMatchObject({ status: 403 });
    expect(endpoint).not.toHaveBeenCalled();
    const orchestrator = new TaskOrchestrator({} as ConstructorParameters<typeof TaskOrchestrator>[0]);
    await expect(orchestrator.processMessage('task', 'run', { agentId: 'protected-bot', userSub: actor.sub, agenticMode: false, source: 'dashboard', autoApprove: false })).rejects.toMatchObject({ status: 403 });
    const stream = new StreamManager(); const emit = vi.spyOn(stream, 'broadcastToolExecution');
    const executor = new ToolExecutorService({ streamManager: stream });
    await expect(executor.executeTool('task', 'protected-tool', { arbitrary: 'payload' }, 'protected-bot', actor.sub)).rejects.toMatchObject({ status: 403 });
    expect(emit).not.toHaveBeenCalled();
  });
  it('checks code-owned scheduled jobs and revokes queued work before its operation', async () => {
    const { service } = await configured(); const execute = vi.fn(async () => true);
    const grant = await service.previewChange(actor, { action: 'grant', app: 'fixture-app', role: '@app-admin', targetSub: actor.sub, targetIssuer: actor.issuer, reason: 'Fixture', expectedRevision: 0 });
    await service.applyChange(actor, { previewId: grant.previewId, idempotencyKey: grant.previewId });
    await expect(runWithApplicationExecution({ app: 'fixture-app', kind: 'jobs', operation: 'tick' }, execute)).rejects.toMatchObject({ status: 403 });
    const deny = await service.previewChange(actor, { action: 'deny', app: 'fixture-app', targetSub: actor.sub, targetIssuer: actor.issuer, reason: 'Revoke queued authority', expectedRevision: 1 });
    await service.applyChange(actor, { previewId: deny.previewId, idempotencyKey: deny.previewId });
    await expect(runWithApplicationAuthorizationActor(actor, () => runWithApplicationExecution({ app: 'fixture-app', kind: 'jobs', operation: 'tick' }, execute))).rejects.toMatchObject({ code: 'authorization_explicit_deny' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps legacy targets available without fabricating an actor or changing system context', async () => {
    await configured();
    expect(await runWithSystemIdentity(() => runWithApplicationExecution({ kind: 'tools', operation: 'legacy-tool' }, async () => getRequestIdentity()?.system))).toBe(true);
  });
  it('runs authoritative resource adapters under the restricted caller identity', async () => {
    const service = new ApplicationAuthorizationService(new MemoryAuthorizationStore());
    await service.registerApp({ app: 'fixture-app', source: 'fixture', version: '1', mode: 'enforce', catalog: {
      version: 1, resources: { records: { scopes: ['own'] } },
      permissions: { read: { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
      roles: { reader: { tier: 'viewer', grants: [{ permission: 'read', scope: 'own' }] } },
      bindings: { tools: [{ id: 'protected-tool', allOf: ['read'] }] },
    } });
    const preview = await service.previewChange(actor, { action: 'grant', app: 'fixture-app', role: 'reader', targetSub: actor.sub,
      targetIssuer: actor.issuer, reason: 'Adapter identity regression', expectedRevision: 0 });
    await service.applyChange(actor, { previewId: preview.previewId, idempotencyKey: preview.previewId });
    const adapter = vi.fn(async () => {
      expect(getRequestIdentity()).toMatchObject({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false });
      expect(getRequestIdentity()?.system).not.toBe(true); return true;
    });
    service.registerResourceAdapter('fixture-app', 'records', { authorize: adapter });
    configureApplicationExecutionPolicy({ owner: () => 'fixture-app', protectedApp: () => true,
      authorize: (subject, operation) => service.authorize(subject, operation) });
    await runWithSystemIdentity(() => runWithApplicationAuthorizationActor(actor,
      () => runWithApplicationExecution({ kind: 'tools', operation: 'protected-tool' }, async () => true)));
    expect(adapter).toHaveBeenCalledTimes(1);
  });
  it('refuses raw node transports before task lookup, ignoring payload flags and subjects', async () => {
    const taskController = { getTask: vi.fn(), createTask: vi.fn(), processMessage: vi.fn() };
    const query = vi.fn(async () => ({ rows: [{ app: 'fixture-app', protected: true }] }));
    const handler = createBotNodeExecutionHandler({ providerName: 'fixture', modelName: 'fixture', anyBotTaskController: taskController,
      authorizeApplicationExecution: requested => assertBotNodeApplicationTransport({ query } as unknown as Pool, 'protected-bot', requested) });
    await expect(handler({ toAgentId: 'other-bot', payload: { direct: false, userSub: 'admin', app: 'legacy' } } as unknown as MeshEnvelope)).rejects.toMatchObject({ code: 'authorization_bot_transport_unavailable' });
    expect(taskController.getTask).not.toHaveBeenCalled();
    // kind, then the two agent ids the guard asked about, in order, before any task lookup.
    expect(query.mock.calls.map(call => call[1][0])).toEqual(['bots','bots']);
    expect(query.mock.calls.map(call => call[1][1])).toEqual(['protected-bot','other-bot']);
    // The bot role cannot read the ownership tables; it holds EXECUTE on the derived helper only.
    expect(query.mock.calls.every(call => /oshal_application_execution_claims\(/.test(String(call[0])))).toBe(true);
    await expect(assertBotNodeApplicationTransport(null, 'bot', 'bot')).rejects.toMatchObject({ code: 'database_pool_unavailable', status: 503 });
  });
});
