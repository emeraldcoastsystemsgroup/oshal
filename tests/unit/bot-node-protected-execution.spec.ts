/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise signed protected worker reasoning, current-rights refusal and exact issuer SQLite workspace isolation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Assert the normalized authorized-scope Set passed to the provider boundary instead of the pre-normalization array shape.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Pin the call-time framework-tool bridge to the verified execution, owner, bot and isolated workspace rather than request-controlled provider options.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Prove a signed fallbackOrder survives real HTTP provider-authority forwarding and malformed fallback chains are rejected before task/provider use.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Derive the protected single-shot marker only for direct requests whose server-resolved brokered tool set is empty; a protected request with an application tool keeps the existing bridge path and never receives the marker.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Follow the moved code. Token Chase replay left bot-node-server.ts for bot-node-token-chase-replay-route.ts (4b4a7f50), so slicing the server at its app.post found nothing (-1). The guard now reads the module itself. Inside the route, the protected-transport refusal precedes executeReplay. The module's only provider call sits inside executeReplay, above the route, so the model is reachable only after that refusal. The server registers the route behind authorizeBotNodeCall. No comparison can fall back to -1.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Verify the provider call is structurally inside executeReplay so an adjacent or top-level call cannot satisfy the replay transport regression.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Real-worker companion for protected node chat turns (message-routes seq 27). stampRemoteBrain's CLI branch and the queued CLI path send exactly providerId, model and providerConfigRequired:true, with no configVersion and no fallbackOrder, and nothing pinned that key set at the protected worker. The new case signs that exact stamp and requires 200, permits start through complete, and exactly that recorded provider authority. tests/unit/protected-node-chat-turn.spec.ts doubles this worker with a stub node; this case is its real boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { startProtectedWorkerFixture, remoteEnvelope, REMOTE_AGENT, REMOTE_APP, REMOTE_ISSUER, REMOTE_SUB } from '../fixtures/bot-node-protected-execution';
import { protectedBotWorkspaceId } from '@/app/bot-node-protected-workspace';

let fixture: Awaited<ReturnType<typeof startProtectedWorkerFixture>>;
beforeEach(async () => { fixture = await startProtectedWorkerFixture(); });
afterEach(async () => { await fixture?.close(); });

describe('protected worker HTTP execution', () => {
  it('runs the actual handler under exact nonoperator identity with no native registry tools and a bound call-time bridge', async () => {
    await fixture.close();
    const active = { provider: 'fixture-brokered-cli', model: 'fixture-model', apiProvider: null };
    fixture = await startProtectedWorkerFixture(undefined, {
      directProvider: {
        provider: active.provider, model: active.model, supportsFrameworkToolBridge: true,
      },
      brokeredTools: ['career_database'],
      dispatchConfigRuntime: {
        getActiveProvider: () => active,
        setActiveProvider: () => active,
      },
    });
    const request = fixture.issue({ byoLlmConnection: undefined, providerId: active.provider,
      model: active.model, providerConfigRequired: true, configVersion: 1,
      fallbackOrder: ['gemini', 'claude-code'] });
    const response = await fixture.post(request);
    const responseBody = await response.json();
    expect(responseBody, JSON.stringify(responseBody)).toMatchObject({ success: true, response: 'Fixture protected answer',
      applicationExecutionId: request.body.applicationExecutionId, provider: 'fixture-brokered-cli' });
    expect(response.status).toBe(200);
    expect(fixture.state.phases[0]).toBe('start');
    expect(fixture.state.phases.at(-1)).toBe('complete');
    expect(fixture.state.providerAuthorities).toEqual([{
      providerId: active.provider,
      model: active.model,
      configVersion: 1,
      providerConfigRequired: true,
      fallbackOrder: ['gemini', 'claude-code'],
    }]);
    expect(fixture.state.calls).toHaveLength(1);
    expect(fixture.state.calls[0]).toMatchObject({ identity: { sub: REMOTE_SUB, principalIssuer: REMOTE_ISSUER, isOperator: false },
      actor: { sub: REMOTE_SUB, issuer: REMOTE_ISSUER, isSwarmAdmin: false, tenantIds: ['fixture-tenant'], allowedPermissions: [`${REMOTE_APP}:read`] },
      options: { tools: [], authorizedScopes: new Set(['tool:career_database']), enforceToolBoundary: true } });
    expect(JSON.stringify(fixture.state.calls[0].messages)).toContain('career_database');
    expect(fixture.state.calls[0].options.systemPrompt).toContain('oshal-tools MCP server');
    expect(fixture.state.calls[0].options.toolBridge).toMatchObject({ agentId: REMOTE_AGENT, userSub: REMOTE_SUB,
      applicationExecutionId: request.body.applicationExecutionId, applicationExecutionToken: request.token,
      taskId: expect.stringMatching(/^protected-[a-f0-9]{64}$/) });
    expect(fixture.state.calls[0].options).not.toHaveProperty('singleShotToolless');
    expect(String(fixture.state.calls[0].options.workspaceDir).replace(/\\/g, '/'))
      .toMatch(/\/protected-[a-f0-9]{64}$/);
    expect(fixture.store.listTasks()).toHaveLength(1);
    expect(fixture.store.listTasks()[0].id).toMatch(/^protected-[a-f0-9]{64}$/);
  });

  it('marks a protected direct configured-provider call single-shot only when no brokered tools exist', async () => {
    const previousDemo = process.env.DEMO_MODE;
    delete process.env.DEMO_MODE;
    try {
      await fixture.close();
      const active = { provider: 'cline-cli', model: 'fixture-model', apiProvider: 'gemini' };
      fixture = await startProtectedWorkerFixture(undefined, {
        directProvider: { provider: active.provider, model: active.model },
        brokeredTools: [],
        dispatchConfigRuntime: {
          getActiveProvider: () => active,
          setActiveProvider: () => active,
        },
      });
      const response = await fixture.post(fixture.issue({
        byoLlmConnection: undefined,
        providerId: active.provider,
        model: active.model,
        providerConfigRequired: true,
        configVersion: 1,
      }));
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect(fixture.state.calls).toHaveLength(1);
      expect(fixture.state.calls[0].options).toMatchObject({
        singleShotToolless: true,
        protectedSingleShotVerified: true,
        source: 'swarm-dispatch',
        agentId: REMOTE_AGENT,
        tools: [],
        enforceToolBoundary: true,
      });
    } finally {
      if (previousDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = previousDemo;
    }
  });

  it('refuses configured Cline when protected authority contains a brokered tool', async () => {
    const previousDemo = process.env.DEMO_MODE;
    delete process.env.DEMO_MODE;
    try {
      await fixture.close();
      const active = { provider: 'cline-cli', model: 'fixture-model', apiProvider: 'gemini' };
      fixture = await startProtectedWorkerFixture(undefined, {
        directProvider: { provider: active.provider, model: active.model, supportsFrameworkToolBridge: true },
        brokeredTools: ['career_database'],
        dispatchConfigRuntime: {
          getActiveProvider: () => active,
          setActiveProvider: () => active,
        },
      });
      const response = await fixture.post(fixture.issue({
        byoLlmConnection: undefined,
        providerId: active.provider,
        model: active.model,
        providerConfigRequired: true,
        configVersion: 1,
      }));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ success: false });
      expect(fixture.state.calls).toHaveLength(0);
      expect(fixture.store.listTasks()).toHaveLength(0);
    } finally {
      if (previousDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = previousDemo;
    }
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
    { providerId: 'antigravity-cli', providerConfigRequired: true },
    { byoLlmConnection: undefined, providerId: 'antigravity-cli', providerConfigRequired: true, model: 42 },
    { byoLlmConnection: null, providerId: 'antigravity-cli', providerConfigRequired: true },
  ])('refuses unsupported mode %j before controller start or workspace creation', async override => {
    const request = fixture.issue(override);
    const response = await fixture.post(request);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(fixture.state.phases).toEqual([]);
    expect(fixture.state.calls).toEqual([]);
    expect(fixture.store.listTasks()).toEqual([]);
  });

  it('admits the exact CLI stamp a chat turn carries, with no configVersion or fallbackOrder', async () => {
    const previousDemo = process.env.DEMO_MODE;
    delete process.env.DEMO_MODE;
    try {
      await fixture.close();
      const active = { provider: 'cline-cli', model: 'fixture-model', apiProvider: 'gemini' };
      fixture = await startProtectedWorkerFixture(undefined, {
        directProvider: { provider: active.provider, model: active.model },
        brokeredTools: [],
        dispatchConfigRuntime: { getActiveProvider: () => active, setActiveProvider: () => active },
      });
      const response = await fixture.post(fixture.issue({
        byoLlmConnection: undefined, providerId: active.provider, model: active.model, providerConfigRequired: true,
      }));
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect(fixture.state.phases[0]).toBe('start');
      expect(fixture.state.phases.at(-1)).toBe('complete');
      expect(fixture.state.providerAuthorities).toStrictEqual([
        { providerId: active.provider, model: active.model, providerConfigRequired: true },
      ]);
    } finally {
      if (previousDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = previousDemo;
    }
  });

  it('rejects a malformed signed fallback chain at HTTP ingress', async () => {
    const request = fixture.issue({ fallbackOrder: ['gemini', '  '] });
    const response = await fixture.post(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: 'invalid_provider_authority',
    });
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
    // Token Chase replay lives in its own module (4b4a7f50), registered behind machine authentication.
    expect(server).toMatch(/registerBotNodeTokenChaseReplayRoute\(app, \{[^}]*authorize: authorizeBotNodeCall/);
    const replayModule = readFileSync('src/app/bot-node-token-chase-replay-route.ts', 'utf8').replace(/\r\n/g, '\n');
    const routeStart = replayModule.indexOf("app.post('/api/token-chase/replay-call'");
    expect(routeStart).toBeGreaterThan(-1);
    const replay = replayModule.slice(routeStart);
    const transport = replay.indexOf('assertBotNodeApplicationTransport');
    expect(transport).toBeGreaterThan(-1);
    expect(replay.indexOf('executeReplay(')).toBeGreaterThan(transport);
    assertReplayProviderContained(replayModule);
    expect(readFileSync('src/app/bot-node-runtime.ts', 'utf8')).toContain('runApplicationExecution: createProtectedBotExecutionBoundary(pool, agentId)');
  });
});

/**
 * @description Verify the sole provider call belongs to the replay helper body rather than an adjacent or top-level statement.
 * @param sourceText The replay module read as source data.
 * @returns Nothing when the model call is structurally contained; fails the case otherwise.
 */
function assertReplayProviderContained(sourceText: string): void {
  const parsed = ts.createSourceFile('replay-route.ts', sourceText, ts.ScriptTarget.Latest, true);
  const execute = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeReplay');
  if (!execute || !ts.isFunctionDeclaration(execute) || !execute.body) throw new Error('Replay helper body missing');
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'generateResponse') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  expect(calls).toHaveLength(1);
  expect(calls[0].getStart(parsed)).toBeGreaterThan(execute.body.getStart(parsed));
  expect(calls[0].getEnd()).toBeLessThan(execute.body.getEnd());
}
