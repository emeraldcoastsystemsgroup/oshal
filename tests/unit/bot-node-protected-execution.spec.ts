/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise signed protected worker reasoning, current-rights refusal and exact issuer SQLite workspace isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { startProtectedWorkerFixture, remoteEnvelope, REMOTE_AGENT, REMOTE_APP, REMOTE_ISSUER, REMOTE_SUB } from '../fixtures/bot-node-protected-execution';
import { protectedBotWorkspaceId } from '@/app/bot-node-protected-workspace';

let fixture: Awaited<ReturnType<typeof startProtectedWorkerFixture>>;
beforeEach(async () => { fixture = await startProtectedWorkerFixture(); });
afterEach(async () => { await fixture?.close(); });

describe('protected worker HTTP execution', () => {
  it('runs the actual handler and direct TaskController under exact nonoperator identity with no tools', async () => {
    const request = fixture.issue();
    const response = await fixture.post(request);
    expect(await response.json()).toMatchObject({ success: true, response: 'Fixture protected answer',
      applicationExecutionId: request.body.applicationExecutionId, provider: 'fixture-hosted' });
    expect(response.status).toBe(200);
    expect(fixture.state.phases[0]).toBe('start');
    expect(fixture.state.phases.at(-1)).toBe('complete');
    expect(fixture.state.calls).toHaveLength(1);
    expect(fixture.state.calls[0]).toMatchObject({ identity: { sub: REMOTE_SUB, principalIssuer: REMOTE_ISSUER, isOperator: false },
      actor: { sub: REMOTE_SUB, issuer: REMOTE_ISSUER, isSwarmAdmin: false, tenantIds: ['fixture-tenant'], allowedPermissions: [`${REMOTE_APP}:read`] },
      options: { tools: [], authorizedScopes: [], enforceToolBoundary: true } });
    expect(fixture.store.listTasks()).toHaveLength(1);
    expect(fixture.store.listTasks()[0].id).toMatch(/^protected-[a-f0-9]{64}$/);
  });

  it('rejects forged and replayed dispatches before task acceptance or provider use', async () => {
    const request = fixture.issue();
    expect((await fixture.post({ ...request, body: { ...request.body, text: 'changed unsigned text' } })).status).toBe(401);
    expect((await fixture.post({ body: request.body })).status).toBe(401);
    expect((await fixture.post(request, 'wrong-machine')).status).toBe(401);
    expect(fixture.state.calls).toHaveLength(0);
    expect((await fixture.post(request)).status).toBe(200);
    expect((await fixture.post(request)).status).toBe(409);
    expect(fixture.state.calls).toHaveLength(1);
  });

  it('rejects raw and body-spoofed protected execution without trusted HTTP context', async () => {
    const request = fixture.issue({ actor: { isSwarmAdmin: true }, approved: true });
    await expect(fixture.handler(remoteEnvelope(request.body))).rejects.toThrow('authorization_remote_dispatch_required');
    expect(fixture.store.listTasks()).toHaveLength(0);
    expect(fixture.state.calls).toHaveLength(0);
  });
});

describe('protected supported mode and authority continuity', () => {
  it.each([
    { agenticMode: true }, { agenticMode: undefined }, { direct: false }, { byoLlmConnection: undefined },
    { creds: {} }, { providerIntent: {} }, { byoLlmConnection: { baseUrl: 'x', apiKey: '', model: 'x' } },
  ])('refuses unsupported mode %j before controller start or workspace creation', async override => {
    const request = fixture.issue(override);
    const response = await fixture.post(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
    expect(fixture.store.listTasks()).toEqual([]);
  });

  it('rejects a revoked request at start without accepting a task', async () => {
    fixture.state.allowed = false;
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    expect(fixture.store.listTasks()).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });

  it('rechecks after task lookup and prevents provider use after revocation', async () => {
    const original = fixture.controller.getTask.bind(fixture.controller);
    fixture.controller.getTask = async (id: string) => { const task = await original(id); fixture.state.allowed = false; return task; };
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    expect(fixture.state.calls).toEqual([]);
    expect(fixture.store.listTasks()).toEqual([]);
  });

  it('discards a provider response when access is revoked during inference', async () => {
    fixture.state.afterProvider = () => { fixture.state.allowed = false; };
    const response = await fixture.post(fixture.issue());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('Fixture protected answer');
    const tasks = fixture.store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(JSON.stringify(await fixture.messages.getMessages(tasks[0].id))).not.toContain('Fixture protected answer');
    expect(fixture.state.calls).toHaveLength(1);
  });
});

describe('protected completion and namespace isolation', () => {
  it('does not append another project\'s process-global context to protected inference', async () => {
    const runtimeGlobal = globalThis as typeof globalThis & { PLANE_CONTEXT?: string };
    const previous = runtimeGlobal.PLANE_CONTEXT;
    runtimeGlobal.PLANE_CONTEXT = 'Global confidential project';
    try {
      expect((await fixture.post(fixture.issue())).status).toBe(200);
      expect(JSON.stringify(fixture.state.calls[0])).not.toContain('Global confidential project');
    } finally { runtimeGlobal.PLANE_CONTEXT = previous; }
  });

  it('refuses output when completion is denied or durable ownership changes', async () => {
    fixture.state.denyPhase = 'complete';
    const denied = await fixture.post(fixture.issue());
    expect(denied.status).toBe(503);
    expect(JSON.stringify(await denied.json())).not.toContain('Fixture protected answer');
    fixture.state.denyPhase = undefined;
    fixture.state.mutatePermit = permit => { if (permit.phase === 'start') fixture.state.owner = 'new-owner'; };
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    expect(fixture.state.calls).toHaveLength(1);
  });

  it('isolates foreign issuers, legacy history and earlier same-user executions in SQLite', async () => {
    fixture.store.saveTask({ id: 'fixture-workspace', text: 'Legacy confidential', status: 'completed', userSub: REMOTE_SUB });
    await fixture.messages.saveMessage('fixture-workspace', { type: 'say', say: 'text', text: 'Legacy confidential answer', ts: Date.now() });
    const first = fixture.issue();
    expect((await fixture.post(first)).status).toBe(200);
    const second = fixture.issue({ principalIssuer: 'https://identity.fixture.test/two' });
    expect((await fixture.post(second)).status).toBe(200);
    expect(fixture.store.listTasks()).toHaveLength(3);
    expect(JSON.stringify(fixture.state.calls[0].messages)).not.toContain('Legacy confidential');
    expect(JSON.stringify(fixture.state.calls[1].messages)).not.toContain('Fixture protected answer');
    const same = fixture.issue();
    expect((await fixture.post(same)).status).toBe(200);
    expect(JSON.stringify(fixture.state.calls[2].messages)).not.toContain('Fixture protected answer');
    expect(fixture.store.listTasks()).toHaveLength(4);
  });

  it('derives portable opaque workspace names from all exact authority namespaces', () => {
    const binding = { principalIssuer: REMOTE_ISSUER, userSub: REMOTE_SUB, app: REMOTE_APP, agentId: REMOTE_AGENT,
      workspaceFolderId: 'logical', executionId: 'fixture-execution' };
    const original = protectedBotWorkspaceId(binding);
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      expect(protectedBotWorkspaceId({ ...binding, [key]: `${binding[key]}-other` })).not.toBe(original);
    }
    expect(original).not.toContain(REMOTE_SUB);
    expect(protectedBotWorkspaceId({ ...binding, tenantId: 'tenant-a' })).not.toBe(protectedBotWorkspaceId({ ...binding, tenantId: 'tenant-b' }));
  });
});

describe('protected permit races', () => {
  it('accepts one concurrent original dispatch and rejects both replay competitors', async () => {
    const request = fixture.issue();
    const responses = await Promise.all([fixture.post(request), fixture.post(request), fixture.post(request)]);
    expect(responses.map(response => response.status).sort()).toEqual([200,409,409]);
    expect(fixture.state.calls).toHaveLength(1);
  });

  it('does not use a permit that expires while durable ownership lookup waits', async () => {
    fixture.state.mutatePermit = permit => { permit.expiresAt = new Date(Date.now() + 60).toISOString(); };
    fixture.state.duringOwnership = async () => {
      if (fixture.state.phases.length) await new Promise(resolve => setTimeout(resolve, 100));
    };
    expect((await fixture.post(fixture.issue())).status).toBe(503);
    expect(fixture.store.listTasks()).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
  });
});

describe('protected production ingress wiring', () => {
  it('captures authority after replay consumption and keeps raw replay guarded', () => {
    const server = readFileSync('src/app/bot-node-server.ts', 'utf8').replace(/\r\n/g, '\n');
    const route = server.slice(server.indexOf("app.post(\n    '/api/swarm-execute'"));
    expect(route.indexOf('delegationRuntime.authorize')).toBeLessThan(route.indexOf('createProtectedBotDispatchContext()'));
    const replay = server.slice(server.indexOf("app.post('/api/token-chase/replay-call'"));
    expect(replay.indexOf('assertBotNodeApplicationTransport')).toBeGreaterThan(-1);
    expect(replay.indexOf('assertBotNodeApplicationTransport')).toBeLessThan(replay.indexOf('generateResponse'));
    expect(readFileSync('src/app/bot-node-runtime.ts', 'utf8')).toContain('runApplicationExecution: createProtectedBotExecutionBoundary(pool, agentId)');
  });
});
