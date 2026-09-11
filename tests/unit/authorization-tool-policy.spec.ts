/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove typed authorization tools use the actual policy and exact-preview transaction semantics.
 */
import { describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { DynamicToolExecutorRegistry } from '@/features/tool-registry';
import { ToolExecutorService, type ToolExecutorServiceDeps } from '@/features/chat-orchestration';
import { AuthorizationToolRuntime } from '@/app/composition/authorization-tool';
import type { AuthorizationActor, AuthorizationChange, AuthorizationPreview, AuthorizationReceipt } from '@/shared/application-authorization';
import { AUTHORIZATION_TOOL, type AuthorizationToolInvocation } from '@/shared/security/authorization-tool-contract';

const admin: AuthorizationActor = { sub: 'admin', issuer: 'urn:fixture', isActive: true, isSwarmAdmin: true };
const member: AuthorizationActor = { sub: 'member', issuer: 'urn:fixture', isActive: true, isSwarmAdmin: false };
const change: AuthorizationChange = { action: 'grant', app: 'fixture-app', targetSub: member.sub, targetIssuer: member.issuer,
  role: '@app-admin', reason: 'Fixture grant request', expectedRevision: 0 };

/** Actual policy/store transaction semantics with a disposable in-memory persistence adapter. No PostgreSQL claim. */
async function setup() {
  let now = Date.parse('2026-09-10T10:00:00Z');
  const store = new MemoryAuthorizationStore();
  const service = new ApplicationAuthorizationService(store, { now: () => now,
    resolveActor: async (sub, issuer) => [admin, member].find((actor) => actor.sub === sub && actor.issuer === issuer) ?? null });
  await service.registerApp({ app: 'fixture-app', source: 'fixture:trusted', version: '1', catalog: null, mode: 'enforce' });
  const runtime = new AuthorizationToolRuntime(service);
  const descriptors = new DynamicToolExecutorRegistry(); descriptors.registerAuthorizationDescriptors();
  const executor = new ToolExecutorService({ streamManager: { broadcastToolExecution: vi.fn() },
    dynamicToolExecutorRegistry: descriptors, authorizationToolExecutor: runtime } as unknown as ToolExecutorServiceDeps);
  let actor = admin;
  const invocation: AuthorizationToolInvocation = { resolveActor: async () => actor, allowChanges: true };
  const execute = async <T>(input: Record<string, unknown>): Promise<T> => JSON.parse(await executor.executeTool('fixture-task', AUTHORIZATION_TOOL, input, 'fixture-agent', undefined, invocation));
  const preview = (proposed = change) => execute<AuthorizationPreview>({ operation: 'preview_change', change: proposed });
  const apply = (previewId: string, idempotencyKey = 'fixture-request-0001') => execute<AuthorizationReceipt>({ operation: 'apply_change', preview: { previewId, idempotencyKey } });
  return { store, service, runtime, execute, preview, apply, actor: (value: AuthorizationActor) => { actor = value; }, advance: (ms: number) => { now += ms; } };
}

describe('authorization tool and actual management service parity', () => {
  it('applies an exact fallback grant with one audit receipt; an identical retry is idempotent and another key cannot replay it', async () => {
    const f = await setup();
    const preview = await f.preview();
    expect((await f.service.effective(admin, { app: change.app, targetSub: member.sub, targetIssuer: member.issuer })).tier).toBe('deny');
    const receipt = await f.apply(preview.previewId);
    expect(await f.apply(preview.previewId)).toEqual(receipt);
    expect(f.store.auditEvents).toHaveLength(1);
    expect(f.store.auditEvents[0].change).toEqual(change);
    expect((await f.service.effective(admin, { app: change.app, targetSub: member.sub, targetIssuer: member.issuer })).roles).toEqual(['@app-admin']);
    await expect(f.apply(preview.previewId, 'different-request')).rejects.toThrow(/consumed/);
    expect((await f.service.authorize(admin, { app: change.app })).allowed).toBe(false);
  });

  it('refuses to mutate through ordinary user identity and allows only that user own-access inspection', async () => {
    const f = await setup(); f.actor(member);
    await expect(f.preview()).rejects.toThrow(/management_denied/);
    expect(await f.execute({ operation: 'effective', target: { app: change.app } })).toMatchObject({ targetSub: member.sub, tier: 'deny' });
    await expect(f.execute({ operation: 'effective', target: { app: change.app, targetSub: admin.sub, targetIssuer: admin.issuer } }))
      .rejects.toThrow(/management_denied/);
    expect((await f.store.read()).assignments).toEqual([]);
  });

  it('binds preview to both initiating subject and issuer, including another fully privileged caller', async () => {
    const f = await setup(); const preview = await f.preview();
    f.actor({ ...admin, sub: 'another-admin' });
    await expect(f.apply(preview.previewId)).rejects.toThrow(/preview_not_found/);
    f.actor({ ...admin, issuer: 'urn:other-issuer' });
    await expect(f.apply(preview.previewId)).rejects.toThrow(/preview_not_found/);
    expect(f.store.auditEvents).toEqual([]);
  });

  it('rechecks current assignment authority on apply after successful preview', async () => {
    const f = await setup(); const preview = await f.preview();
    f.actor({ ...admin, isSwarmAdmin: false, managementScopes: [{ app: change.app, permissions: ['read'] }] });
    await expect(f.apply(preview.previewId)).rejects.toThrow(/management_denied/);
    expect((await f.store.read()).assignments).toEqual([]);
  });

  it('refuses parameter tampering, expired previews and intervening policy changes', async () => {
    const f = await setup(); const first = await f.preview(); const second = await f.preview();
    await expect(f.execute({ operation: 'apply_change', preview: { previewId: first.previewId, idempotencyKey: 'request-0001',
      targetSub: admin.sub } })).rejects.toThrow();
    await f.apply(first.previewId);
    await expect(f.apply(second.previewId, 'request-0002')).rejects.toThrow(/revision_conflict/);
    const latest = await f.preview({ ...change, expectedRevision: 1 });
    f.advance(600001);
    await expect(f.apply(latest.previewId, 'request-0003')).rejects.toThrow(/preview_expired/);
    expect(f.store.auditEvents).toHaveLength(1);
  });

  it('refuses a preview after installed app source identity changes', async () => {
    const f = await setup(); const preview = await f.preview();
    await f.service.registerApp({ app: change.app, source: 'fixture:replacement', version: '2', catalog: null, mode: 'enforce' });
    await expect(f.apply(preview.previewId)).rejects.toThrow(/revision_conflict/);
    expect(f.store.auditEvents).toEqual([]);
  });

  it('attenuates a delegated admin to read operations in both discovery and invocation', async () => {
    const f = await setup();
    const delegated = { ...admin, allowedPermissions: ['platform:authorization.read'] };
    const discovered = await f.runtime.discover(delegated, true);
    expect(discovered.map((tool) => tool.name)).toEqual(['swarm_authorization_read']);
    expect(discovered.flatMap((tool) => tool.operations)).not.toContain('apply_change');
    f.actor(delegated); await expect(f.preview()).rejects.toThrow(/management_denied/);
    expect(await f.runtime.discover({ ...admin, allowedPermissions: [] }, true)).toEqual([]);
  });

  it('advertises an ordinary user own granted app without administrative inventory or write operations', async () => {
    const f = await setup(); const preview = await f.preview(); await f.apply(preview.previewId);
    const tools = await f.runtime.discover(member, true);
    expect(tools.map((tool) => tool.name)).toEqual(['swarm_authorization_read']);
    expect(tools[0].targets.map((target) => target.app)).toEqual([change.app]);
    f.actor(member);
    const catalog = await f.execute<{ users: unknown[]; groups: unknown[]; assignments: unknown[] }>({ operation: 'catalog' });
    expect(catalog.users).toEqual([]); expect(catalog.groups).toEqual([]); expect(catalog.assignments).toEqual([]);
  });
});
