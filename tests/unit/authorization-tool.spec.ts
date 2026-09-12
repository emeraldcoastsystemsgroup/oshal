/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exercise registered typed invocation, consent boundaries, reserved ownership and caller-scoped discovery.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded, redacted applied authorization history under current application and tenant authority.
 */
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { ToolRepository, CreateToolInput } from '@/entities/tool';
import type { Tool } from '@/shared/types/tool';
import type { AuthorizationActor, ApplicationAuthorizationManagementService } from '@/shared/application-authorization';
import { DynamicToolExecutorRegistry, ToolRegistryService, RuntimeToolRegistrationService } from '@/features/tool-registry';
import { ToolExecutorService, type ToolExecutorServiceDeps } from '@/features/chat-orchestration';
import { registerAuthorizationTools, AuthorizationToolRuntime } from '@/app/composition/authorization-tool';
import { createInternalToolBridgeRoutes } from '@/app/routes/internal-tool-bridge-routes';
import { buildToolsBlock, parseToolCatalog } from '@/app/routes/jarvis-tool-catalog';
import type { AppContext } from '@/app/composition/app-context';
import { AUTHORIZATION_TOOL, AUTHORIZATION_READ_TOOL, type AuthorizationToolInvocation } from '@/shared/security/authorization-tool-contract';

const admin: AuthorizationActor = { sub: 'admin', issuer: 'urn:fixture', isActive: true, isSwarmAdmin: true };
const user: AuthorizationActor = { sub: 'user', issuer: 'urn:fixture', isActive: true, isSwarmAdmin: false };
const change = { action: 'grant', app: 'fixture-app', targetSub: 'user', targetIssuer: 'urn:fixture',
  role: '@app-admin', reason: 'Fixture access request', expectedRevision: 0 };
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

/** Repository fixture persists metadata across simulated process restarts; no operator database is used. */
function catalogRepository() {
  const rows = new Map<string, Tool>();
  const repo = {
    getToolByName: vi.fn(async (name: string) => rows.get(name) ?? null),
    getToolById: vi.fn(async (id: string) => [...rows.values()].find((row) => row.toolId === id) ?? null),
    createTool: vi.fn(async (input: CreateToolInput) => {
      const tool = { ...input, toolId: `id-${input.name}`, createdAt: new Date(), updatedAt: new Date(), registeredAt: new Date() } as Tool;
      rows.set(input.name, tool); return tool;
    }),
    updateTool: vi.fn(async (id: string, input: Partial<Tool>) => {
      const current = [...rows.values()].find((row) => row.toolId === id);
      if (!current) return null;
      const updated = { ...current, ...input }; rows.set(updated.name, updated); return updated;
    }),
    deleteTool: vi.fn(),
  };
  return { rows, repo, registry: new ToolRegistryService(repo as unknown as ToolRepository, logger) };
}

/** Only policy is doubled in adapter tests below; actual policy parity is covered in the companion integration suite. */
function serviceFixture() {
  const service: ApplicationAuthorizationManagementService = {
    auditHistory: vi.fn(async () => ({ entries: [], snapshotRevision: 0, nextCursor: null })),
    catalog: vi.fn(async (actor) => {
      if (!actor.isSwarmAdmin && !actor.managementScopes?.length) throw Object.assign(new Error('authorization_management_denied'), { code: 'authorization_management_denied' });
      return { revision: 0, users: [], groups: [], assignments: [], apps: [{ app: 'fixture-app', source: 'fixture:one', version: '1',
      catalogRevision: 'revision-one', mode: 'enforce', status: 'admin-required', catalog: null, missingAdapters: [],
      managementScopes: actor.isSwarmAdmin ? [{ app: 'fixture-app', permissions: ['read', 'assign', 'directory'] }] : actor.managementScopes }] };
    }),
    ownCatalog: vi.fn(async () => ({ revision: 0, users: [], groups: [], assignments: [], apps: [] })),
    effective: vi.fn(async (actor, target) => ({ app: target.app, targetSub: actor.sub, targetIssuer: actor.issuer,
      revision: 0, catalogRevision: 'revision-one', tier: 'deny', roles: [], denied: true, permissions: [], status: 'admin-required' })),
    explain: vi.fn(async (_actor, input) => ({ app: input.app, allowed: false, reason: 'fixture-denied', decisionId: 'decision', revision: 0, grants: [] })),
    previewChange: vi.fn(async (_actor, input) => ({ previewId: 'fixture-preview', expiresAt: new Date(Date.now() + 60000).toISOString(),
      revision: 0, catalogRevision: 'revision-one', change: input, requiresApproval: false })),
    applyChange: vi.fn(async (_actor, input) => ({ previewId: input.previewId, revision: 1, auditId: 'audit', applied: true })),
  };
  return service;
}
async function fixture(service = serviceFixture()) {
  const catalog = catalogRepository();
  const descriptors = new DynamicToolExecutorRegistry();
  const runtime = await registerAuthorizationTools(catalog.registry, descriptors, service);
  const executor = new ToolExecutorService({ streamManager: { broadcastToolExecution: vi.fn() },
    dynamicToolExecutorRegistry: descriptors, authorizationToolExecutor: runtime } as unknown as ToolExecutorServiceDeps);
  return { ...catalog, descriptors, runtime, executor, service };
}
const invocation = (actor = admin, allowChanges = true): AuthorizationToolInvocation => ({ resolveActor: async () => actor, allowChanges });

describe('registered authorization tool invocation', () => {
  it('crosses the real registry/executor to the shared service, preserving an exact target and trusted caller', async () => {
    const f = await fixture();
    const result = JSON.parse(await f.executor.executeTool('task', AUTHORIZATION_TOOL,
      { operation: 'preview_change', change }, 'agent', 'ignored-asserted-sub', invocation()));
    expect(result.change).toEqual(change);
    expect(f.service.previewChange).toHaveBeenCalledWith(admin, change);
    const receipt = JSON.parse(await f.executor.executeTool('task', AUTHORIZATION_TOOL,
      { operation: 'apply_change', preview: { previewId: result.previewId, idempotencyKey: 'request-0001' } }, 'agent', undefined, invocation()));
    expect(receipt.applied).toBe(true);
    expect(f.rows.get(AUTHORIZATION_TOOL)?.defaultAuthMode).toBe('ask');
    expect(f.rows.get(AUTHORIZATION_READ_TOOL)?.defaultAuthMode).toBe('auto');
  });

  it('fails closed without trusted invocation identity, despite a claimed executor user', async () => {
    const f = await fixture();
    await expect(f.executor.executeTool('task', AUTHORIZATION_TOOL, { operation: 'catalog' }, 'agent', admin.sub))
      .rejects.toThrow(/Verified authorization caller/);
    await expect(f.runtime.execute(AUTHORIZATION_READ_TOOL, { operation: 'catalog' }, invocation({ ...admin, issuer: '' })))
      .rejects.toThrow(/Active verified/);
    expect(f.service.catalog).not.toHaveBeenCalled();
  });

  it.each([
    { operation: 'catalog', actor: admin }, { operation: 'catalog', userSub: admin.sub },
    { operation: 'catalog', url: 'https://attacker.test' }, { operation: 'catalog', sql: 'SELECT 1' },
    { operation: 'catalog', command: 'whoami' }, { operation: 'catalog', confirmed: true },
    { operation: 'effective', target: { app: 'fixture-app', actor: admin } },
    { operation: 'apply_change', preview: { previewId: 'fixture-preview', idempotencyKey: 'request-0001', approved: true } },
    { operation: 'preview_change', change: { ...change, group: { issuer: 'issuer', tenantId: 'tenant', id: 'group', member: true } } },
    { operation: 'arbitrary_operation' },
  ])('rejects untrusted or unknown input fields: %j', async (input) => {
    const f = await fixture();
    await expect(f.runtime.execute(AUTHORIZATION_TOOL, input, invocation())).rejects.toThrow();
    expect(f.service.catalog).not.toHaveBeenCalled();
    expect(f.service.applyChange).not.toHaveBeenCalled();
    expect(f.service.previewChange).not.toHaveBeenCalled();
  });

  it('does not allow preview/apply through the read alias or an unattended full invocation', async () => {
    const f = await fixture();
    for (const name of [AUTHORIZATION_TOOL, AUTHORIZATION_READ_TOOL]) {
      await expect(f.runtime.execute(name, { operation: 'preview_change', change }, invocation(admin, false)))
        .rejects.toThrow(/interactive/);
      await expect(f.runtime.execute(name, { operation: 'apply_change', preview: { previewId: 'fixture-preview', idempotencyKey: 'request-0001' } }, invocation(admin, false)))
        .rejects.toThrow(/interactive/);
    }
    await expect(f.runtime.execute(AUTHORIZATION_READ_TOOL, { operation: 'preview_change', change }, invocation()))
      .rejects.toThrow(/interactive/);
    expect(f.service.previewChange).not.toHaveBeenCalled();
    expect(f.service.applyChange).not.toHaveBeenCalled();
  });

  it('re-resolves the caller before each call and refuses an account disabled since preview', async () => {
    const f = await fixture();
    const context = { resolveActor: vi.fn().mockResolvedValueOnce(admin).mockResolvedValueOnce({ ...admin, isActive: false }), allowChanges: true };
    await f.runtime.execute(AUTHORIZATION_TOOL, { operation: 'preview_change', change }, context);
    await expect(f.runtime.execute(AUTHORIZATION_TOOL, { operation: 'apply_change', preview: { previewId: 'fixture-preview', idempotencyKey: 'request-0001' } }, context))
      .rejects.toThrow(/Active verified/);
    expect(f.service.applyChange).not.toHaveBeenCalled();
  });
});

describe('code-owned tool registration', () => {
  it('is idempotent and restores executors after restart without changing ASK to AUTO', async () => {
    const f = await fixture();
    const original = f.descriptors.resolve(AUTHORIZATION_TOOL);
    await registerAuthorizationTools(f.registry, f.descriptors, f.service);
    expect(f.descriptors.resolve(AUTHORIZATION_TOOL)).toBe(original);
    const restarted = new DynamicToolExecutorRegistry();
    await registerAuthorizationTools(f.registry, restarted, f.service);
    expect(f.rows.size).toBe(2);
    expect(f.repo.createTool).toHaveBeenCalledTimes(2);
    expect(restarted.resolve(AUTHORIZATION_TOOL)).toMatchObject({ builtinKey: AUTHORIZATION_TOOL, runtimeRegistered: false });
    expect(f.rows.get(AUTHORIZATION_TOOL)?.defaultAuthMode).toBe('ask');
  });

  it('refuses runtime/package replacement, generic builtin aliases, deletion and metadata edits', async () => {
    const f = await fixture();
    const tool = f.rows.get(AUTHORIZATION_TOOL)!;
    await expect(f.registry.registerTool(tool)).rejects.toThrow(/reserved/);
    await expect(f.registry.registerOrUpdateTool(tool)).rejects.toThrow(/reserved/);
    await expect(f.registry.updateTool(tool.toolId, { defaultAuthMode: 'auto' as never })).rejects.toThrow(/code-owned/);
    await expect(f.registry.deleteTool(tool.toolId)).rejects.toThrow(/code-owned/);
    expect(() => f.descriptors.register({ toolName: AUTHORIZATION_TOOL, executorType: 'api', apiEndpoint: '/evil',
      runtimeRegistered: true, registeredAt: '' })).toThrow(/reserved/);
    expect(() => f.descriptors.register({ toolName: 'evil-alias', executorType: 'builtin', builtinKey: AUTHORIZATION_TOOL,
      runtimeRegistered: true, registeredAt: '' })).toThrow(/reserved/);
    expect(f.descriptors.deregister(AUTHORIZATION_TOOL)).toBe(false);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const runtimeRegistry = new RuntimeToolRegistrationService({ query } as unknown as Pool, f.registry, f.descriptors);
    await expect(runtimeRegistry.registerRuntimeTool(tool, { toolName: AUTHORIZATION_TOOL, executorType: 'api', apiEndpoint: '/evil' }))
      .rejects.toThrow(/code-owned/);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not publish an executor if persistence is unavailable or the name belonged to another registrant', async () => {
    const f = catalogRepository();
    f.repo.createTool.mockRejectedValueOnce(new Error('fixture database unavailable'));
    const descriptors = new DynamicToolExecutorRegistry();
    await expect(registerAuthorizationTools(f.registry, descriptors, serviceFixture())).rejects.toThrow(/unavailable/);
    expect(descriptors.resolve(AUTHORIZATION_TOOL)).toBeUndefined();
    f.rows.set(AUTHORIZATION_TOOL, { name: AUTHORIZATION_TOOL, toolId: 'poison', registeredBy: 'package:evil' } as Tool);
    await expect(registerAuthorizationTools(f.registry, descriptors, serviceFixture())).rejects.toThrow(/different registrant/);
    expect(descriptors.resolve(AUTHORIZATION_TOOL)).toBeUndefined();
  });
});

describe('caller-scoped Jarvis typed feed', () => {
  it('loads typed YAML hints only when a trusted current feed supplies operations and targets', async () => {
    const runtime = new AuthorizationToolRuntime(serviceFixture());
    expect(buildToolsBlock()).not.toContain(AUTHORIZATION_TOOL);
    expect(await runtime.discover(user, true)).toEqual([]);
    const reader: AuthorizationActor = { ...user, managementScopes: [{ app: 'fixture-app', permissions: ['read'] }] };
    const ordinary = buildToolsBlock({ authorizationTools: await runtime.discover(reader, true) });
    expect(ordinary).toContain(AUTHORIZATION_READ_TOOL);
    expect(ordinary).not.toContain('operations=["catalog","effective","explain","preview_change"');
    const managed = buildToolsBlock({ authorizationTools: await runtime.discover(admin, true) });
    expect(managed).toContain('directory mapping');
    expect(managed).toContain('fixture-app');
    expect(managed).toContain('preview_change');
    expect(managed).not.toContain(`node /app/scripts/${AUTHORIZATION_TOOL}`);
    expect(await runtime.discover({ ...admin, isActive: false }, true)).toEqual([]);
  });

  it('does not allow YAML to invent a typed executor or change its execution kind', () => {
    const source = readFileSync(resolve('src/app/routes/jarvis-tools.yaml'), 'utf8');
    for (const patch of [{ name: 'evil' }, { kind: 'shell' }, { endpoint: '/api/raw-sql' }, { operations: ['apply_change'] }]) {
      const parsed = yaml.load(source) as { typedTools: Record<string, unknown>[] };
      Object.assign(parsed.typedTools[0], patch);
      expect(() => parseToolCatalog(yaml.dump(parsed))).toThrow(/Invalid Jarvis/);
    }
  });
});

describe('real HTTP internal authorization bridge', () => {
  let server: http.Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>((done) => server!.close(() => done())); server = undefined; });
  async function boot(authMode: 'auto' | 'ask' = 'auto') {
    const f = await fixture();
    const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: /FROM tools t/i.test(sql)
      ? [...f.rows.values()].filter(() => (params[1] as string[]).includes(authMode)).map((row) => ({
        tool_id: row.toolId, name: row.name, registered_by: row.registeredBy, enabled: true, input_schema: row.inputSchema,
      })) : [] }));
    const ctx = { pool: { query }, streamManager: { broadcastToolExecution: vi.fn() }, dynamicToolExecutorRegistry: f.descriptors } as unknown as AppContext;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: user.sub } } }); next(); });
    const reader: AuthorizationActor = { ...user, managementScopes: [{ app: 'fixture-app', permissions: ['read'] }] };
    app.use('/api/tools', createInternalToolBridgeRoutes(ctx, { authorizationTool: f.runtime, resolveActor: async () => reader }));
    server = http.createServer(app);
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tools`;
    const post = (toolName: string, input: unknown, extra = {}) => fetch(`${base}/execute`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'fixture-agent', toolName, input, ...extra }) });
    return { ...f, base, post };
  }

  it('executes an AUTO read through the real router/executor using the injected caller, never body userSub', async () => {
    const f = await boot();
    const result = await f.post(AUTHORIZATION_READ_TOOL, { operation: 'effective', target: { app: 'fixture-app' } }, { userSub: admin.sub });
    expect(result.status).toBe(200);
    expect(JSON.parse((await result.json() as { output: string }).output).targetSub).toBe(user.sub);
    expect(f.service.effective).toHaveBeenCalledWith(expect.objectContaining({ sub: user.sub, issuer: user.issuer }), { app: 'fixture-app' });
    const listed = await (await fetch(`${f.base}/for-agent/fixture-agent`)).json() as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toEqual([AUTHORIZATION_READ_TOOL]);
  });

  it('refuses full-family operations even when incorrectly granted AUTO and client asserts approval', async () => {
    const f = await boot();
    const result = await f.post(AUTHORIZATION_TOOL, { operation: 'preview_change', change }, { approved: true });
    expect(result.status).toBe(403);
    expect(f.service.previewChange).not.toHaveBeenCalled();
  });

  it('keeps ASK grants unavailable to unattended bridge execution and listing', async () => {
    const f = await boot('ask');
    expect((await f.post(AUTHORIZATION_READ_TOOL, { operation: 'catalog' }, { approved: true })).status).toBe(403);
    const listed = await (await fetch(`${f.base}/for-agent/fixture-agent`)).json() as { tools: unknown[] };
    expect(listed.tools).toEqual([]);
    expect(f.service.effective).not.toHaveBeenCalled();
  });
});
