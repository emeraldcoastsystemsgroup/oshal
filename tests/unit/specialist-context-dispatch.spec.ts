/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real installed-package lifecycle, named policy, signed HTTP dispatch and fail-closed specialist reads.
 */
import express from 'express';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
import { assertBotNodeApplicationTransport } from '@/app/bot-node-application-authorization';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import type { AppContext } from '@/app/composition/app-context';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { SwarmAppService, type SwarmAppManifest, type SwarmApplicationRecord } from '@/features/swarm-apps';
import { BotNodeClient, type BotNodeRequest } from '@/features/agent-management';
import { SpecialistContextRegistry, configureSpecialistContextRegistry } from '@/shared/specialist-context';
import { configureApplicationExecutionPolicy } from '@/shared/application-authorization-execution';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { createDelegationTokenIssuer, createDelegationTokenVerifier } from '@/shared/security/delegation-token';
import { DELEGATION_HTTP_HEADER } from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const ISSUER = 'https://specialist.fixture.test', APP = 'board-fixture', AGENT = 'board-specialist', TOOL = 'read-board-counts';
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const bob: AuthorizationActor = { ...alice, sub: 'bob' }, admin: AuthorizationActor = { ...alice, sub: 'admin', isSwarmAdmin: true };
const key = generateKeyPairSync('ed25519'), now = 1_800_000_000;
const catalog: AuthorizationCatalog = {
  version: 1, resources: { board: { scopes: ['own'] } },
  permissions: { 'board.read': { resource: 'board', effect: 'read', minimumTier: 'viewer' },
    'board.ask': { resource: 'board', effect: 'execute', minimumTier: 'editor' } },
  roles: { reader: { tier: 'editor', grants: [{ permission: 'board.read', scope: 'own' }, { permission: 'board.ask', scope: 'own' }] },
    'read-only': { tier: 'viewer', grants: [{ permission: 'board.read', scope: 'own' }] },
    dispatcher: { tier: 'editor', grants: [{ permission: 'board.ask', scope: 'own' }] } },
  bindings: { tools: [{ id: TOOL, allOf: ['board.read'] }], bots: [{ id: AGENT, allOf: ['board.ask'] }],
    http: [{ id: 'board-status', method: 'GET', path: '/status', allOf: ['board.read'] }] },
};
const FACTORY = `exports.createRoutes = function(ctx) {
  ctx.authorization.registerResource('board', { authorize: async function(input) {
    ctx.fixtureObserve('adapter'); return input.grant.scope === 'own';
  }});
  ctx.specialistContext.register({ agentId: '${AGENT}', toolName: '${TOOL}', facts: ['documents.out', 'records.total'],
    read: async function(input) { return ctx.fixtureReadBoard(input); }
  });
  return function(req, res) { res.json({ ok: true }); };
};`;
let directory: string, apps: SwarmAppService, registry: SpecialistContextRegistry, runtime: ApplicationAuthorizationRuntime;
let policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore, client: BotNodeClient, server: Server;
let captured: Array<{ body: Record<string, unknown>; headers: IncomingHttpHeaders }>;
let observations: Array<{ phase: string; identity: ReturnType<typeof getRequestIdentity>; actor: ReturnType<typeof getApplicationAuthorizationActor> }>;
let reader: (input: { sub: string; issuer: string; signal: AbortSignal }) => Promise<Record<string, number>>;
let reads: number;

function manifest(overrides: Partial<SwarmAppManifest> = {}): SwarmAppManifest {
  return { name: APP, displayName: 'Board fixture', version: '1.0.0', status: 'active', suite: 'ai-home',
    uses: ['application-authorization', 'specialist-context'], authorization: { version: 1, catalog: 'authorization.yaml' },
    bots: [{ name: 'Board specialist', agentId: AGENT, role: 'specialist' }],
    tools: [{ name: TOOL, description: 'Read caller-owned board counts', executor: { executorType: 'api', apiEndpoint: '/api/board-fixture/status' } }],
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: '/api/board-fixture', auth: 'oidc' }], ...overrides };
}
function writePackage(overrides: Partial<SwarmAppManifest> = {}) {
  writeFileSync(join(directory, 'authorization.yaml'), yaml.dump(catalog)); writeFileSync(join(directory, 'routes.js'), FACTORY);
  const file = join(directory, 'oshal-app.yaml'); writeFileSync(file, yaml.dump(manifest(overrides))); return file;
}
function repository() {
  const records = new Map<string, SwarmApplicationRecord>();
  return {
    findByName: async (name: string) => records.get(name) ?? null, list: async () => [...records.values()],
    upsert: async (loaded: SwarmAppManifest, file: string) => {
      const record: SwarmApplicationRecord = { appId: loaded.name, name: loaded.name, displayName: loaded.displayName, description: '',
        version: loaded.version || '1.0.0', status: loaded.status || 'active', manifestPath: file, agentIds: (loaded.bots ?? []).map(bot => bot.agentId!),
        toolNames: (loaded.tools ?? []).map(tool => tool.name), manifest: loaded, scope: 'public', ownerSub: null, tenantId: null,
        guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
      records.set(record.name, record); return record;
    },
    updateStatus: async (name: string, status: 'active' | 'inactive') => { const row = records.get(name); if (!row) return null;
      const updated = { ...row, status }; records.set(name, updated); return updated; },
    delete: async (name: string) => records.delete(name),
  };
}
async function grant(target = alice, role = 'reader', action: 'grant' | 'revoke' = 'grant') {
  const preview = await policy.previewChange(admin, { action, app: APP, targetSub: target.sub, targetIssuer: target.issuer,
    role, reason: 'Isolated specialist context proof', expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}
function dispatch(actor = alice, overrides: Partial<BotNodeRequest> = {}) {
  return runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: true },
    () => client.execute(AGENT, { text: 'How many documents are out?', taskId: 'fixture-task', workspaceFolderId: 'fixture-task',
      agentId: AGENT, agenticMode: true, userSub: actor.sub, principalIssuer: actor.issuer, ...overrides })));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function createCaptureServer() {
  server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      captured.push({ body: JSON.parse(body), headers: req.headers }); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, response: 'fixture response', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2,
        cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0, model: 'fixture', provider: 'noop', durationMs: 1 }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  client = new BotNodeClient(() => `http://127.0.0.1:${address.port}`, 1000, { env: {}, delegationIssuer: createDelegationTokenIssuer({
    env: { OSHAL_DELEGATION_SIGNING_KID: 'fixture', OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
    nowEpochSeconds: () => now, generateJti: randomUUID,
  }) });
}

beforeEach(async () => {
  vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true'); vi.stubEnv('APP_PACKAGE_MIGRATIONS', 'false');
  directory = mkdtempSync(join(tmpdir(), 'oshal-specialist-')); captured = []; observations = []; reads = 0;
  const records = [{ owner: 'alice', stage: 'out' }, { owner: 'alice', stage: 'out' }, { owner: 'alice', stage: 'draft' },
    ...Array.from({ length: 9 }, () => ({ owner: 'bob', stage: 'out' }))];
  reader = async input => { const own = records.filter(row => input.issuer === ISSUER && row.owner === input.sub);
    return { 'documents.out': own.filter(row => row.stage === 'out').length, 'records.total': own.length }; };
  store = new MemoryAuthorizationStore(); policy = new ApplicationAuthorizationService(store);
  const repo = repository(), pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  runtime = new ApplicationAuthorizationRuntime(policy, async () => alice, {}, repo.findByName);
  registry = new SpecialistContextRegistry(runtime, { timeoutMs: 100 }); configureSpecialistContextRegistry(registry); configureApplicationExecutionPolicy(runtime);
  const observe = (phase: string) => observations.push({ phase, identity: getRequestIdentity(), actor: getApplicationAuthorizationActor() });
  const context = { pool, fixtureObserve: observe, fixtureReadBoard: async (input: Parameters<typeof reader>[0]) => {
    reads++; observe('reader'); return reader(input);
  } } as unknown as AppContext;
  const mounter = new ManifestRouteMounterImpl(express(), (_req, _res, next) => next(), context, undefined, runtime, registry);
  apps = new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, mounter, undefined, undefined, undefined, undefined, runtime);
  await createCaptureServer(); await apps.loadApp(writePackage());
});
afterEach(async () => {
  configureSpecialistContextRegistry(undefined); configureApplicationExecutionPolicy(undefined);
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  const withinTemp = relative(resolve(tmpdir()), resolve(directory)); if (!withinTemp || withinTemp.startsWith('..')) throw new Error('Unsafe fixture cleanup');
  rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs();
});

it('reads exact caller-owned counts under named grants and signs the enriched HTTP body', async () => {
  await grant(); await grant(bob); await dispatch(); await dispatch(bob);
  expect(captured[0].body.text).toContain('{"documents.out":2,"records.total":3}');
  expect(captured[1].body.text).toContain('{"documents.out":9,"records.total":9}'); expect(reads).toBe(2);
  expect(observations.filter(row => row.phase === 'reader').map(row => row.identity))
    .toEqual([alice, bob].map(actor => ({ sub: actor.sub, principalIssuer: ISSUER, isOperator: false })));
  expect(observations.every(row => row.identity?.isOperator === false)).toBe(true);
  const first = captured[0], token = String(first.headers[DELEGATION_HTTP_HEADER]);
  const verify = createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({
    fixture: key.publicKey.export({ format: 'pem', type: 'spki' }).toString() }) }, nowEpochSeconds: () => now });
  const expected = { iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', sub: alice.sub, principal_iss: ISSUER, azp: AGENT,
    task_id: 'fixture-task', method: 'POST', path: '/api/swarm-execute', scope: ['swarm:execute'], body_sha256: delegationRequestBodySha256(first.body) };
  expect(verify.verify(token, expected).sub).toBe(alice.sub);
  expect(() => verify.verify(token, { ...expected, body_sha256: delegationRequestBodySha256({ ...first.body, text: 'changed facts' }) })).toThrow();
});

it('requires the named read grant separately from permission to dispatch and refuses platform-admin bypass', async () => {
  await grant(alice, 'dispatcher'); await expect(dispatch()).rejects.toThrow('specialist_context_permission_denied');
  await expect(dispatch(admin)).rejects.toThrow(); expect(reads).toBe(0); expect(captured).toHaveLength(0);
  await grant(); await dispatch(); expect(reads).toBe(1);
});

it('rejects missing, forged and mismatched caller/target identity before reading or sending', async () => {
  await grant();
  await expect(client.execute(AGENT, { text: '', taskId: 't', workspaceFolderId: 't', agentId: AGENT, agenticMode: true })).rejects.toThrow('identity_required');
  await expect(dispatch(alice, { userSub: bob.sub })).rejects.toThrow('identity_required');
  await expect(dispatch(alice, { principalIssuer: 'https://forged.test' })).rejects.toThrow('does not match');
  await expect(dispatch(alice, { agentId: 'other-specialist' })).rejects.toThrow('trusted dispatch target');
  expect(reads).toBe(0); expect(captured).toHaveLength(0);
});

it('reconciles reload, disable/reactivate and removing all routes without a stale data reader', async () => {
  await grant(); await dispatch(); await apps.loadApp(writePackage()); await dispatch(); expect(reads).toBe(2);
  await apps.toggleApp(APP, false); await expect(dispatch()).rejects.toThrow(); expect(reads).toBe(2);
  await apps.toggleApp(APP, true); await dispatch(); expect(reads).toBe(3);
  await apps.loadApp(writePackage({ routes: [] })); await expect(dispatch()).rejects.toThrow('authorization_resource_adapter_unavailable');
  await expect(runWithApplicationAuthorizationActor(alice, () => runWithRequestIdentity({ sub: alice.sub, principalIssuer: ISSUER, isOperator: false },
    () => registry.append(AGENT, '', { sub: alice.sub, issuer: ISSUER })))).rejects.toThrow('specialist_context_unavailable');
  expect(captured).toHaveLength(3); expect(registry.requires(AGENT)).toBe(true);
});

it('retracts staged readers when an update factory fails and reactivates cleanly after repair', async () => {
  await grant(); const path = join(directory, 'oshal-app.yaml');
  writeFileSync(join(directory, 'routes.js'), FACTORY.replace('return function(req, res)', "throw new Error('fixture factory failure'); return function(req, res)"));
  await expect(apps.loadApp(path)).rejects.toThrow('Activation failed closed'); await expect(dispatch()).rejects.toThrow();
  expect(reads).toBe(0); expect(captured).toHaveLength(0);
  await apps.loadApp(writePackage()); await dispatch(); expect(reads).toBe(1);
});

it('retires the registered reader on uninstall and refuses later dispatch', async () => {
  await grant(); await dispatch(); expect(await apps.unloadApp(APP)).toMatchObject({ removed: true });
  await expect(dispatch()).rejects.toThrow(); expect(reads).toBe(1); expect(captured).toHaveLength(1);
  expect(registry.requires(AGENT)).toBe(true);
});

it('drops facts if named permission is revoked while the reader is running', async () => {
  await grant(); const started = deferred<void>(), finish = deferred<Record<string, number>>();
  reader = async () => { started.resolve(); return finish.promise; }; const pending = dispatch(); await started.promise;
  await grant(alice, 'reader', 'revoke'); finish.resolve({ 'documents.out': 2, 'records.total': 3 });
  await expect(pending).rejects.toThrow('specialist_context_permission_denied'); expect(captured).toHaveLength(0);
});

it('rechecks bot permission after the read even when the caller retains the named read grant', async () => {
  await grant(alice, 'read-only'); await grant(alice, 'dispatcher');
  const started = deferred<void>(), finish = deferred<Record<string, number>>();
  reader = async () => { started.resolve(); return finish.promise; }; const pending = dispatch(); await started.promise;
  await grant(alice, 'dispatcher', 'revoke'); finish.resolve({ 'documents.out': 2, 'records.total': 3 });
  await expect(pending).rejects.toThrow(); expect(captured).toHaveLength(0);
  expect((await runtime.authorize(alice, { app: APP, kind: 'tools', operation: TOOL })).allowed).toBe(true);
});

it('refuses delivery if the reader retires during the final bot policy check', async () => {
  await grant(); const started = deferred<void>(), finish = deferred<void>(), original = runtime.authorize.bind(runtime);
  let botChecks = 0;
  const spy = vi.spyOn(runtime, 'authorize').mockImplementation(async (actor, operation) => {
    const decision = await original(actor, operation);
    if (operation.kind === 'bots' && ++botChecks === 2) { started.resolve(); await finish.promise; }
    return decision;
  });
  const pending = dispatch(); await started.promise; registry.unregister(APP); finish.resolve();
  await expect(pending).rejects.toThrow('specialist_context_changed'); expect(captured).toHaveLength(0); spy.mockRestore();
});

it('drops an in-flight result when the package unloads', async () => {
  await grant(); const started = deferred<void>(), finish = deferred<Record<string, number>>();
  reader = async () => { started.resolve(); return finish.promise; }; const pending = dispatch(); await started.promise;
  await apps.toggleApp(APP, false); finish.resolve({ 'documents.out': 2, 'records.total': 3 });
  await expect(pending).rejects.toThrow('specialist_context_changed'); expect(captured).toHaveLength(0);
});

it('sends no HTTP request when the registered read fails, times out or returns text', async () => {
  await grant(); reader = async () => { throw new Error('fixture secret detail'); };
  await expect(dispatch()).rejects.toThrow(/^specialist_context_read_failed$/);
  reader = async () => ({ 'documents.out': 'private-token', 'records.total': 3 }) as never;
  await expect(dispatch()).rejects.toThrow('specialist_context_result_invalid');
  reader = async () => new Promise(() => undefined); await expect(dispatch()).rejects.toThrow('specialist_context_timeout');
  expect(captured).toHaveLength(0);
});

it('keeps protected node transport unavailable even when the controller has authorized context', async () => {
  await grant(); await dispatch();
  const posture = { query: async () => ({ rows: [{ app: APP, protected: true }] }) };
  await expect(assertBotNodeApplicationTransport(posture as never, AGENT, AGENT)).rejects.toMatchObject({
    status: 503, code: 'authorization_bot_transport_unavailable',
  });
});

it('refuses active and retired specialists on the unsupported inline branch before any model turn', async () => {
  const processMessage = vi.fn(), local = { hasEndpoint: () => false } as unknown as BotNodeClient;
  const context = { orchestrator: { processMessage } } as unknown as AppContext;
  const request = { text: 'fixture', taskId: 'fixture-inline', workspaceFolderId: 'fixture-inline', agentId: AGENT, agenticMode: true, userSub: alice.sub };
  await expect(executeBotOrInline(context, local, AGENT, request)).rejects.toThrow('specialist_context_requires_bot_node');
  registry.unregister(APP);
  await expect(executeBotOrInline(context, local, AGENT, request)).rejects.toThrow('specialist_context_requires_bot_node');
  expect(processMessage).not.toHaveBeenCalled();
});
