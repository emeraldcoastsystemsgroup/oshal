/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise exact-principal package tools through real policy, mounted factories and the server executor.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PackageToolsFixture, toolAlice, toolAdmin, TOOL_TENANT, TOOL_FACTORY } from '../fixtures/package-tools';
import { configurePackageToolRegistry, PackageToolRegistry, validatePackageTools } from '@/shared/package-tools';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { ManifestRouteMounterImpl } from '@/app/composition/manifest-route-mounter';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let fixture: PackageToolsFixture;
beforeEach(() => { vi.stubEnv('APP_PACKAGE_DYNAMIC_ROUTES', 'true'); fixture = new PackageToolsFixture(); });
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });

it('returns bounded package JSON under exact non-operator identity and refuses other principals', async () => {
  await fixture.mount(); await fixture.grant();
  expect(await fixture.execute()).toMatchObject({ count: 3, identity: { sub: toolAlice.sub, principalIssuer: toolAlice.issuer, isOperator: false } });
  await expect(fixture.execute({}, toolAdmin)).rejects.toThrow();
  await expect(fixture.execute({}, { ...toolAlice, issuer: 'https://other.example.test' })).rejects.toThrow();
  await expect(fixture.executor.executeTool('task', 'package_read', {})).rejects.toThrow();
  await expect(runWithApplicationAuthorizationActor(toolAlice, () => fixture.registry.execute('package_read', {}, 'other'))).rejects.toThrow();
  expect(fixture.results).toBe(1);
});

it('uses the same selected tenant for HTTP, named tool and domain checks and refreshes membership', async () => {
  await fixture.mount(); await fixture.grant({ role: 'tenant_reader', tenantId: TOOL_TENANT });
  const base = await fixture.listen();
  expect((await fetch(base + '/api/package-fixture', { headers: { 'x-fixture-user': 'alice', 'x-oshal-tenant-id': TOOL_TENANT } })).status).toBe(200);
  expect(await fixture.execute({ tenantId: TOOL_TENANT })).toMatchObject({ count: 3 });
  await expect(fixture.execute()).rejects.toThrow();
  await expect(fixture.execute({ tenantId: 'foreign' })).rejects.toThrow();
  fixture.actor.tenantIds = [];
  await expect(fixture.execute({ tenantId: TOOL_TENANT })).rejects.toThrow();
  expect((await fetch(base + '/api/package-fixture', { headers: { 'x-fixture-user': 'alice', 'x-oshal-tenant-id': TOOL_TENANT } })).status).toBe(403);
});

it('retracts retired tools before considering a replacement API descriptor', async () => {
  await fixture.mount(); await fixture.grant(); fixture.mounter.unmount(fixture.manifest.name);
  fixture.descriptors.register({ toolName: 'package_read', executorType: 'api', apiEndpoint: 'http://127.0.0.1:1/forbidden', runtimeRegistered: true, registeredAt: '' });
  await expect(fixture.execute()).rejects.toThrow('package_tool_unavailable'); expect(fixture.results).toBe(0);
});

it('requires the configured trusted registry and keeps disabled declarations unavailable', async () => {
  fixture.manifest.tools![0].defaultAuthMode = 'off'; await fixture.mount(); await fixture.grant();
  await expect(fixture.execute()).rejects.toThrow('package_tool_unavailable');
  configurePackageToolRegistry(undefined); await expect(fixture.execute()).rejects.toThrow('package_tool_registry_unavailable');
});

it('validates all factories together and preserves ASK metadata', async () => {
  fixture.manifest.tools!.push({ name: 'package_second', displayName: 'Second', description: 'Second fixture read', defaultAuthMode: 'ask', executor: { executorType: 'builtin', builtinKey: 'package' } });
  fixture.source += `\nexports.second = function(ctx) { ctx.tools.register('package_second', async function(input) { return { count: 9 }; }); return function(req,res,next) { next(); }; };`;
  fixture.manifest.routes!.push({ ...fixture.manifest.routes![0], factory: 'second' });
  await fixture.mount(); await fixture.grant();
  expect(await fixture.execute({}, toolAlice, 'package_second')).toEqual({ count: 9 });
  expect(fixture.manifest.tools![1].defaultAuthMode).toBe('ask');
});

it.each(['missing', 'duplicate', 'undeclared', 'factory-failure'])('rolls back %s registration without publishing a partial handler', async mode => {
  fixture.source = mode === 'missing' ? 'exports.create = function(ctx) { return function(req,res) { res.json({}); }; };'
    : TOOL_FACTORY.replace('return function(req,res)', `${mode === 'factory-failure' ? "throw new Error('fixture_factory_failed');" : `ctx.tools.register('${mode === 'duplicate' ? 'package_read' : 'foreign_tool'}', async function() { return {}; });`} return function(req,res)`);
  await expect(fixture.mount()).rejects.toThrow();
  expect(fixture.registry.requires('package_read')).toBe(true);
  await expect(fixture.execute()).rejects.toThrow(); expect(fixture.results).toBe(0);
});

it('refuses reserved core names and malformed declaration transports before publication', async () => {
  await fixture.mount();
  const reserved = new PackageToolRegistry(fixture.runtime, { reservedNames: ['package_read'] });
  expect(() => reserved.stage(fixture.manifest.name)).toThrow('package_tool_owner_conflict');
  const base = { uses: ['package-tools', 'application-authorization'], authorization: { version: 1 }, tools: [{ name: 'package_read', defaultAuthMode: 'auto', executor: { executorType: 'builtin', builtinKey: 'package' } }] };
  expect(() => validatePackageTools({ ...base, uses: ['application-authorization'] })).toThrow('capabilities');
  expect(() => validatePackageTools({ ...base, tools: [{ ...base.tools[0], executor: { ...base.tools[0].executor, apiEndpoint: '/x' } }] })).toThrow('exactly');
  expect(() => validatePackageTools({ ...base, tools: [base.tools[0], base.tools[0]] })).toThrow('Duplicate');
});

it.each(['revocation', 'unload', 'reload'])('refuses a delayed handler after %s before its domain commit', async change => {
  await fixture.mount(); await fixture.grant();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  fixture.wait = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); };
  const result = fixture.execute(); const refused = expect(result).rejects.toThrow(); await started;
  if (change === 'revocation') await fixture.grant({ action: 'revoke' });
  else if (change === 'unload') fixture.mounter.unmount(fixture.manifest.name);
  else await fixture.mount();
  release(); await refused; expect(fixture.results).toBe(0);
});

it('rechecks current tool permission after a read before releasing its result', async () => {
  fixture.source = TOOL_FACTORY.replace('return ctx.fixtureResult(input);', 'const result = ctx.fixtureResult(input); await ctx.fixtureWait(); return result;');
  await fixture.mount(); await fixture.grant();
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  fixture.wait = async () => { if (++calls === 2) { entered(); await new Promise<void>(resolve => { release = resolve; }); } };
  const result = fixture.execute(); const refused = expect(result).rejects.toThrow(); await started;
  await fixture.grant({ action: 'revoke' }); release(); await refused; expect(fixture.results).toBe(1);
});

it('fails a declared tool activation when its composition registry is absent', async () => {
  await fixture.mount(); await fixture.grant();
  const unconfigured = new ManifestRouteMounterImpl(fixture.app, (_req, _res, next) => next(), {} as never, undefined, fixture.runtime);
  await expect(unconfigured.mount(fixture.manifest.name, fixture.root, fixture.manifest.routes!)).rejects.toThrow('require a registry');
});
