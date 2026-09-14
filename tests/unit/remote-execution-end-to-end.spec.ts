/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove real client, policy service, controller permits, HTTP worker and SQLite reasoning enforce the original user's current rights.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotNodeClient } from '@/features/agent-management';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationRemoteExecutionService, MemoryRemoteExecutionStore } from '@/features/application-remote-execution';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { startProtectedWorkerFixture, REMOTE_AGENT, REMOTE_APP, REMOTE_ISSUER, REMOTE_SUB } from '../fixtures/bot-node-protected-execution';

const actor: AuthorizationActor = { sub: REMOTE_SUB, issuer: REMOTE_ISSUER, isActive: true, isSwarmAdmin: false };
const admin: AuthorizationActor = { ...actor, sub: 'fixture-admin', isSwarmAdmin: true };
const catalog: AuthorizationCatalog = { version: 1, resources: { work: { scopes: ['own'] } },
  permissions: { 'work.ask': { resource: 'work', effect: 'execute', minimumTier: 'editor' } },
  roles: { reader: { tier: 'editor', grants: [{ permission: 'work.ask', scope: 'own' }] } },
  bindings: { bots: [{ id: REMOTE_AGENT, allOf: ['work.ask'] }] } };
let fixture: Awaited<ReturnType<typeof startProtectedWorkerFixture>>, client: BotNodeClient;
let policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore, authority: ApplicationRemoteExecutionService;
let remoteStore: MemoryRemoteExecutionStore, active: boolean, generation: string;

async function change(action: 'grant' | 'revoke', target = actor) {
  const preview = await policy.previewChange(admin, { action, app: REMOTE_APP, targetSub: target.sub, targetIssuer: target.issuer,
    role: 'reader', reason: 'Isolated remote execution proof', expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}

async function createPolicy() {
  active = true; generation = randomUUID(); store = new MemoryAuthorizationStore(); remoteStore = new MemoryRemoteExecutionStore();
  policy = new ApplicationAuthorizationService(store);
  await policy.registerApp({ app: REMOTE_APP, source: 'fixture-package', version: '1', mode: 'enforce', catalog, agentIds: [REMOTE_AGENT] });
  policy.registerResourceAdapter(REMOTE_APP, 'work', { authorize: async input => input.grant.scope === 'own'
    && input.actor.sub === actor.sub && input.actor.issuer === actor.issuer });
  configureApplicationExecutionPolicy({ owner: () => REMOTE_APP, protectedApp: () => true,
    authorize: (candidate, operation) => policy.authorize(candidate, operation) });
  await change('grant');
}

function dispatch(candidate = actor, taskId = 'end-to-end-task') {
  return runWithApplicationAuthorizationActor(candidate, () => runWithRequestIdentity({ sub: candidate.sub,
    principalIssuer: candidate.issuer, isOperator: false }, () => client.execute(REMOTE_AGENT, {
    agentId: REMOTE_AGENT, text: 'Summarize only the supplied authorized work context.', taskId, workspaceFolderId: taskId,
    userSub: candidate.sub, principalIssuer: candidate.issuer, direct: true, agenticMode: false,
    byoLlmConnection: { baseUrl: 'https://unused.fixture.test/v1', apiKey: 'fixture-only', model: 'fixture-model' },
  })));
}

beforeEach(async () => {
  await createPolicy();
  fixture = await startProtectedWorkerFixture(signing => {
    authority = new ApplicationRemoteExecutionService(remoteStore, {
      owner: async () => ({ app: REMOTE_APP, protected: true }), snapshot: app => {
        const registered = policy.getApp(app); return registered ? { app, source: registered.source,
          catalogRevision: registered.catalogRevision, generation } : null;
      }, refreshActor: async candidate => ({ ...candidate, isActive: active }),
      authorize: (candidate, operation) => policy.authorize(candidate, operation),
      effective: (candidate, app, tenantId) => policy.effective(candidate, { app, tenantId }),
      issuer: signing.recordedIssuer, verifier: signing.verifier, tokenIssuer: 'urn:oshal:controller', dispatchAudience: 'urn:oshal:bot-node',
    }); return authority;
  });
  vi.stubEnv('SWARM_SERVICE_SECRET', fixture.env.SWARM_SERVICE_SECRET);
  client = new BotNodeClient(() => fixture.workerUrl, 4000, { env: {}, recordedDelegationIssuer: fixture.recordedIssuer,
    remoteExecutionAuthority: authority });
});
afterEach(async () => { configureApplicationExecutionPolicy(undefined); await fixture?.close(); vi.unstubAllEnvs(); });

describe('real current-policy protected remote execution', () => {
  it('reaches actual hosted reasoning and records a completed exact-principal execution', async () => {
    const result = await dispatch();
    expect(result).toMatchObject({ success: true, response: 'Fixture protected answer' });
    const record = await remoteStore.read(result.applicationExecutionId!);
    expect(record).toMatchObject({ status: 'completed', binding: { app: REMOTE_APP, agentId: REMOTE_AGENT,
      issuer: actor.issuer, sub: actor.sub, taskId: 'end-to-end-task' }, actor: { isSwarmAdmin: false,
      allowedPermissions: [`${REMOTE_APP}:work.ask`] } });
    expect(fixture.state.calls).toHaveLength(1);
    await expect(authority.assertResultAccess(result.applicationExecutionId!, actor)).resolves.toBeUndefined();
    await expect(authority.assertResultAccess(result.applicationExecutionId!, { ...actor, issuer: 'https://foreign.fixture.test' })).rejects.toThrow();
  });

  it('rejects a grant revoked after signing but before the worker start permit', async () => {
    fixture.state.beforeCheck = async input => { if (input.phase === 'start') await change('revoke'); };
    await expect(dispatch()).rejects.toThrow('authorization_remote_execution_failed');
    expect(fixture.state.phases).toEqual(['start']);
    expect(fixture.state.calls).toEqual([]);
    expect(fixture.store.listTasks()).toEqual([]);
  });

  it('does not persist or release a known provider answer after mid-inference revocation', async () => {
    fixture.state.afterProvider = () => change('revoke');
    await expect(dispatch()).rejects.toThrow('authorization_remote_execution_failed');
    expect(fixture.state.calls).toHaveLength(1);
    expect(fixture.state.phases).not.toContain('complete');
    const rows = fixture.store.listTasks(); expect(rows).toHaveLength(1);
    expect(JSON.stringify(await fixture.messages.getMessages(rows[0].id))).not.toContain('Fixture protected answer');
  });

  it('denies fresh dispatch and historical output after grant revocation without admin bypass', async () => {
    const result = await dispatch(); await change('revoke');
    await expect(dispatch()).rejects.toThrow();
    await expect(authority.assertResultAccess(result.applicationExecutionId!, actor)).rejects.toThrow();
    await expect(authority.assertResultAccess(result.applicationExecutionId!, { ...actor, isSwarmAdmin: true })).rejects.toThrow();
    expect(fixture.state.calls).toHaveLength(1);
  });
});

describe('real controller account and lifecycle changes', () => {
  it.each(['account', 'generation'])('refuses %s change between inference and output', async kind => {
    fixture.state.afterProvider = () => { if (kind === 'account') active = false; else generation = randomUUID(); };
    await expect(dispatch()).rejects.toThrow('authorization_remote_execution_failed');
    const rows = fixture.store.listTasks();
    expect(JSON.stringify(await fixture.messages.getMessages(rows[0].id))).not.toContain('Fixture protected answer');
  });
});
