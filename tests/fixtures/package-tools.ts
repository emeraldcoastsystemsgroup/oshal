/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Isolate actual package mounting, current policy and server tool execution without provider or deployment data.
 */
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import yaml from 'js-yaml';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange } from '@/shared/application-authorization';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import type { AppContext } from '@/app/composition/app-context';
import type { SwarmApplicationRecord, SwarmAppManifest } from '@/features/swarm-apps';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';
import { DynamicToolExecutorRegistry } from '@/features/tool-registry';
import { ToolExecutorService } from '@/features/chat-orchestration/services/tool-executor-service';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { PackageToolRegistry, configurePackageToolRegistry } from '@/shared/package-tools';

export const TOOL_TENANT = '11111111-1111-4111-8111-111111111111';
export const toolAlice: AuthorizationActor = { sub: 'alice', issuer: 'https://identity.example.test', isActive: true, isSwarmAdmin: false, tenantIds: [TOOL_TENANT] };
export const toolAdmin: AuthorizationActor = { ...toolAlice, sub: 'admin', isSwarmAdmin: true };
export const TOOL_FACTORY = `exports.create = function(ctx) {
  ctx.authorization.registerResource('records', { authorize: async function(input) { return ctx.fixtureAdapter(input); } });
  ctx.tools.register('package_read', async function(input) {
    await ctx.fixtureWait();
    const decision = await ctx.authorization.authorize({ permission: 'records.read', tenantId: input.tenantId });
    if (!decision.allowed) throw new Error('domain_denied');
    return ctx.fixtureResult(input);
  });
  return function(req,res) { res.json(ctx.fixtureResult({})); };
};`;
const CATALOG: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own', 'tenant'] } },
  permissions: { 'records.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'own' }] },
    tenant_reader: { tier: 'viewer', grants: [{ permission: 'records.read', scope: 'tenant' }] } },
  bindings: { tools: [{ id: 'package_read', allOf: ['records.read'] }, { id: 'package_second', allOf: ['records.read'] }],
    http: [{ id: 'read', method: 'GET', path: '/', allOf: ['records.read'] }] },
};

/** @description Compose the real policy, mounting and executor with isolated package files.
 * @returns Disposable fixture; initialize before executing and close after each case.
 */
export class PackageToolsFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'oshal-package-tools-'));
  readonly store = new MemoryAuthorizationStore();
  actor = structuredClone(toolAlice);
  readonly policy = new ApplicationAuthorizationService(this.store, { refreshActor: async actor => actor.sub === toolAlice.sub && actor.issuer === toolAlice.issuer ? { ...actor, tenantIds: this.actor.tenantIds, isActive: this.actor.isActive } : actor });
  readonly runtime = new ApplicationAuthorizationRuntime(this.policy, async req => {
    if (req.get('x-fixture-user') !== 'alice') throw Object.assign(new Error('fixture_identity_required'), { status: 401 });
    return structuredClone(this.actor);
  });
  readonly registry = new PackageToolRegistry(this.runtime, { reservedNames: ['read_file'] });
  readonly descriptors = new DynamicToolExecutorRegistry();
  readonly executor = new ToolExecutorService({ streamManager: { broadcastToolExecution: () => {} } as never, dynamicToolExecutorRegistry: this.descriptors });
  readonly app = express();
  readonly mounter: ManifestRouteMounterImpl;
  manifest: SwarmAppManifest;
  server?: Server;
  base = '';
  wait: () => Promise<void> = async () => {};
  results = 0;
  source = TOOL_FACTORY;
  readonly observations: unknown[] = [];
  constructor() {
    this.manifest = { name: 'package-fixture', displayName: 'Package fixture', version: '1.0.0', suite: 'ai-home', status: 'active',
      uses: ['application-authorization', 'package-tools'], authorization: { version: 1, catalog: 'authorization.yaml' },
      tools: [{ name: 'package_read', displayName: 'Read', description: 'Read fixture records', defaultAuthMode: 'auto', executor: { executorType: 'builtin', builtinKey: 'package' } }],
      routes: [{ module: 'routes.js', factory: 'create', mountPath: '/api/package-fixture', auth: 'public' }] };
    const ctx = { fixtureWait: () => this.wait(), fixtureResult: (input: unknown) => { this.results++; return { count: 3, input, identity: getRequestIdentity() }; },
      fixtureAdapter: (input: unknown) => { this.observations.push(input); return true; } } as unknown as AppContext;
    this.mounter = new ManifestRouteMounterImpl(this.app, (_req, _res, next) => next(), ctx, undefined, this.runtime, undefined, this.registry);
    configurePackageToolRegistry(this.registry); configureApplicationExecutionPolicy(this.runtime);
  }
  /** @description Mount actual factory files and publish only after successful activation.
   * @returns Nothing; throws on malformed or incomplete registration.
   */
  async mount(): Promise<void> {
    const catalog = structuredClone(CATALOG);
    catalog.bindings.tools = catalog.bindings.tools!.filter(binding => this.manifest.tools!.some(tool => tool.name === binding.id));
    writeFileSync(join(this.root, 'authorization.yaml'), yaml.dump(catalog));
    writeFileSync(join(this.root, 'routes.js'), this.source);
    writeFileSync(join(this.root, 'oshal-app.yaml'), yaml.dump(this.manifest));
    const manifest = readManifest(join(this.root, 'oshal-app.yaml'));
    const record = { name: manifest.name, manifest, manifestPath: join(this.root, 'oshal-app.yaml') } as SwarmApplicationRecord;
    await this.runtime.prepare(manifest, record.manifestPath); await this.runtime.start(record);
    try { await this.mounter.mount(manifest.name, this.root, manifest.routes ?? []); this.runtime.complete(record); }
    catch (error) { this.runtime.unregister(manifest.name); this.mounter.unmount(manifest.name); throw error; }
    for (const tool of manifest.tools ?? []) this.descriptors.register({ toolName: tool.name, executorType: 'builtin', builtinKey: 'package', runtimeRegistered: true, registeredAt: new Date().toISOString() });
  }
  /** @description Apply an audited fixture permission change through the real preview/save service.
   * @param input Optional action, role and tenant overrides. @returns Nothing after successful save.
   */
  async grant(input: Partial<AuthorizationChange> = {}): Promise<void> {
    const preview = await this.policy.previewChange(toolAdmin, { action: 'grant', app: this.manifest.name,
      targetSub: toolAlice.sub, targetIssuer: toolAlice.issuer, role: 'reader', reason: 'Isolated package tool proof',
      expectedRevision: (await this.store.read()).revision, ...input });
    await this.policy.applyChange(toolAdmin, { previewId: preview.previewId, idempotencyKey: crypto.randomUUID() });
  }
  /** @description Execute the actual server executor under an explicitly authenticated fixture actor.
   * @param input Domain input. @param actor Fixture principal. @param name Fixed declared tool. @returns Parsed tool result.
   */
  async execute(input: Record<string, unknown> = {}, actor = toolAlice, name = 'package_read'): Promise<any> {
    return runWithSystemIdentity(() => runWithApplicationAuthorizationActor(actor, async () => JSON.parse(await this.executor.executeTool('fixture-task', name, input, undefined, actor.sub))));
  }
  /** @description Start a loopback HTTP boundary for parity assertions. @returns Bound origin.
   */
  async listen(): Promise<string> {
    this.server = await new Promise<Server>(resolve => { const server = this.app.listen(0, '127.0.0.1', () => resolve(server)); });
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`; return this.base;
  }
  /** @description Dispose fixture registration, server and the verified temporary package path. @returns Nothing.
   */
  async close(): Promise<void> {
    this.mounter.unmount(this.manifest.name); this.runtime.unregister(this.manifest.name);
    configurePackageToolRegistry(undefined); configureApplicationExecutionPolicy(undefined);
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    rmSync(this.root, { recursive: true, force: true });
  }
}
