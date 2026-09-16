/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-149 rail discoverability guard. A launcher-shaped app declares tiles whose iframeUrl sits under ANOTHER package's mount; the manifest-static rail rendered them for a person who could not discover the target, and a click opened the kernel's role-guidance 403 inside the frame. These cases run the REAL profile route, the REAL SwarmAppService (repository doubled), the REAL ApplicationAuthorizationRuntime over MemoryAuthorizationStore and real package loading: a non-discoverable target comes back locked in place with the role-guidance link, a granted one keeps its tile, a tile under the app's OWN mount / an unowned path / a mount-prefix lookalike is never touched, a legacy-mode package is always discoverable, an ADR-141 group's borrowed tiles follow their member, no port means the declared rail, and no manifest changes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The LANDING half of the same rule. Locking the rail button left the synthesised defaultView alone, so an app whose ribbon.defaultView names a tile under another package's mount opened the cockpit straight onto that package's role-guidance 403 inside the frame — the rail showed the tile locked while the content area showed the dead frame. These cases run the same real route/service/runtime stack and assert the landing view: a declared default that is locked falls through to the first openable tile, every static tile locked lands on the first framework view, a grant restores the declared one, an app with no lock anywhere lands exactly where it did before, and an internal call with no port still gets the manifest-static default.
 */
/** Real Express, package loading, profile synthesis and authorization; only persistence and identity are isolated doubles. */
import express, { type Request, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationAuthorizationRuntime } from '@/app/composition/application-authorization-runtime';
import { createUiProfileRoutes } from '@/app/routes/ui-profile-routes';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { SwarmAppService, lockUndiscoverableTiles, mountOwner, type SwarmAppManifest, type SwarmApplicationRecord } from '@/features/swarm-apps';
import { UIProfileService } from '@/features/ui-profile';
import type { AuthorizationActor, AuthorizationCatalog } from '@/shared/application-authorization';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => log }));

const ISSUER = 'https://rail-identity.fixture.test';
const alice: AuthorizationActor = { sub: 'alice', issuer: ISSUER, isActive: true, isSwarmAdmin: false };
const admin: AuthorizationActor = { sub: 'administrator', issuer: ISSUER, isActive: true, isSwarmAdmin: true };
const catalog: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'app.open': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { opener: { tier: 'viewer', grants: [{ permission: 'app.open', scope: 'own' }] } },
  bindings: { http: [{ id: 'shell', method: 'GET', path: '/app', allOf: ['app.open'] }] },
};
const PACKAGE = 'exports.createRoutes = function() { return function(req, res) { res.json({ fixture: true }); }; };';

type Tile = { toolName: string; label: string; icon: string; iframeUrl: string };
const tile = (toolName: string, iframeUrl: string): Tile => ({ toolName, label: toolName, icon: 'codicon codicon-circle-outline', iframeUrl });

/** The launcher: one own tile, one enforce-mode target, one legacy-mode target, two paths no package owns. */
const LAUNCHER_TILES = [
  tile('launcher-home', '/api/launcher/home'),
  tile('studio-app', '/api/studio/app?starter=blank'),
  tile('legacy-ui', '/api/legacy-tool/ui'),
  tile('help', '/cockpit/tools/help.html'),
  tile('studio-lookalike', '/api/studio-notes/app'),
];

let root: string, server: Server, base: string;
let apps: SwarmAppService, runtime: ApplicationAuthorizationRuntime, policy: ApplicationAuthorizationService, store: MemoryAuthorizationStore;
let records: Map<string, SwarmApplicationRecord>;

function manifest(name: string, tiles: Tile[], protectedPackage: boolean, ribbon?: { defaultView: string }): SwarmAppManifest {
  return { name, displayName: `Fixture ${name}`, version: '1.0.0', status: 'active', suite: 'ai-creative',
    ...(ribbon ? { ribbon } : {}),
    ...(protectedPackage ? { uses: ['application-authorization'], authorization: { version: 1, catalog: 'authorization.yaml' } } : {}),
    access: { supported: ['deny', 'viewer', 'editor', 'admin'], defaultTier: 'admin' },
    routes: [{ module: 'routes.js', factory: 'createRoutes', mountPath: `/api/${name}`, auth: 'service-or-oidc' }],
    ui: { static: tiles } } as SwarmAppManifest;
}

/** A file named oshal-app.yaml is a store package (enforce mode); any other manifest file name is a legacy-mode manifest. */
async function install(input: SwarmAppManifest, file = 'oshal-app.yaml') {
  const directory = join(root, input.name); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'authorization.yaml'), yaml.dump(catalog));
  writeFileSync(join(directory, 'routes.js'), PACKAGE);
  const path = join(directory, file); writeFileSync(path, yaml.dump(input));
  await apps.loadApp(path); return records.get(input.name)!;
}

async function installFixture() {
  await install(manifest('launcher', LAUNCHER_TILES, true));
  await install(manifest('studio', [tile('studio-home', '/api/studio/app')], true));
  await install(manifest('legacy-tool', [tile('legacy-home', '/api/legacy-tool/ui')], false), 'legacy-tool.yaml');
  await install({ name: 'creative', displayName: 'Creative', kind: 'group', suite: 'ai-creative', status: 'active',
    dependencies: { apps: ['studio', 'legacy-tool'] },
    toolbar: [{ app: 'studio', surface: 'studio-home' }, { app: 'legacy-tool', surface: 'legacy-home' }] } as SwarmAppManifest);
}

async function grantOpener(app: string, target = alice) {
  const preview = await policy.previewChange(admin, { action: 'grant', app, targetSub: target.sub, targetIssuer: target.issuer,
    role: 'opener', reason: 'Isolated rail discoverability fixture', expectedRevision: (await store.read()).revision });
  await policy.applyChange(admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
}

async function resolveActor(req: Request): Promise<AuthorizationActor> {
  const name = req.get('x-fixture-user');
  if (name === 'alice') return structuredClone(alice);
  if (name === 'administrator') return structuredClone(admin);
  if (name === 'broken') throw new Error('Fixture identity provider unavailable');
  throw Object.assign(new Error('No verified fixture actor'), { status: 401 });
}

function memoryRepository() {
  return {
    findByName: async (name: string) => records.get(name) ?? null,
    list: async (status?: string) => [...records.values()].filter(row => !status || row.status === status),
    upsert: async (loaded: SwarmAppManifest, file: string) => {
      const record: SwarmApplicationRecord = { appId: loaded.name, name: loaded.name, displayName: loaded.displayName,
        description: '', version: loaded.version || '1.0.0', status: loaded.status || 'active', manifestPath: file,
        agentIds: [], toolNames: [], manifest: loaded, scope: 'public', ownerSub: null, tenantId: null,
        guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
      records.set(record.name, record); return record;
    },
    updateStatus: async (name: string, status: 'active' | 'inactive') => {
      const record = records.get(name); if (!record) return null;
      const updated = { ...record, status }; records.set(name, updated); return updated;
    },
    delete: async (name: string) => records.delete(name),
  };
}

beforeEach(async () => {
  vi.stubEnv('APP_ACCESS_ENFORCEMENT', 'enforce'); vi.stubEnv('APP_PACKAGE_MIGRATIONS', 'false');
  root = mkdtempSync(join(tmpdir(), 'oshal-rail-discoverability-'));
  records = new Map(); log.error.mockClear();
  const repo = memoryRepository(), pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  store = new MemoryAuthorizationStore();
  policy = new ApplicationAuthorizationService(store, { resolveTier: async () => ({ tier: 'admin', explicit: false }) });
  runtime = new ApplicationAuthorizationRuntime(policy, resolveActor, { OSHAL_APPLICATION_AUTHORIZATION_MODE: 'enforce' }, repo.findByName);
  apps = new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime);
  const app = express();
  const requiresAuth: RequestHandler = (req, res, next) => {
    if (req.get('x-fixture-user')) { next(); return; } res.status(401).json({ error: 'fixture_auth_required' });
  };
  app.use('/api/ui', requiresAuth, createUiProfileRoutes(new UIProfileService(), apps, { runtime, resolveActor }));
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  const withinTemp = relative(resolve(tmpdir()), resolve(root));
  if (!withinTemp || withinTemp.startsWith('..')) throw new Error('Invalid fixture cleanup path');
  rmSync(root, { recursive: true, force: true });
});

type Item = { id: string; toolUi?: { iframeUrl: string }; locked?: { app: string; reason: string; roleGuidanceUrl: string } };
async function rail(name: string, user = 'alice'): Promise<{ status: number; items: Item[]; source: string }> {
  const response = await fetch(`${base}/api/ui/profile?name=${name}`, { headers: { 'x-fixture-user': user } });
  const body = await response.json();
  const items = ((body.profile?.ribbon?.items ?? []) as Array<string | Item>).filter((item): item is Item => typeof item !== 'string');
  return { status: response.status, items, source: body.source };
}
const byId = (items: Item[], id: string) => items.find(item => item.id === id);

/** The view the cockpit opens on — the landing half of the same synthesised profile. */
async function landing(name: string, user = 'alice'): Promise<string | undefined> {
  const response = await fetch(`${base}/api/ui/profile?name=${name}`, { headers: { 'x-fixture-user': user } });
  return (await response.json()).profile?.defaultView;
}

describe('ADR-149 rail discoverability — the profile route, the real service and the real runtime', () => {
  it('locks a tile whose target this person cannot discover, in place and with the role-guidance link; a grant restores it', async () => {
    await installFixture();
    const before = await rail('launcher');
    expect(before.status).toBe(200); expect(before.source).toBe('swarm-app');
    expect(before.items.map(item => item.id).slice(0, 5)).toEqual(['tool-launcher-home', 'tool-studio-app', 'tool-legacy-ui', 'tool-help', 'tool-studio-lookalike']);
    const locked = byId(before.items, 'tool-studio-app')!;
    expect(locked.locked).toEqual({ app: 'studio', reason: 'application-role-required', roleGuidanceUrl: '/users' });
    expect(locked.toolUi?.iframeUrl).toBe('/api/studio/app?starter=blank');

    await grantOpener('studio');
    const after = await rail('launcher');
    expect(byId(after.items, 'tool-studio-app')?.locked).toBeUndefined();
    expect(byId(after.items, 'tool-studio-app')?.toolUi?.iframeUrl).toBe('/api/studio/app?starter=blank');
  });

  it('never touches a tile under the app\'s OWN mount, an unowned path, or a mount-prefix lookalike', async () => {
    await installFixture();
    expect(await runtime.canDiscover('launcher', alice)).toBe(false); // the launcher itself is not discoverable to alice
    const { items } = await rail('launcher');
    for (const id of ['tool-launcher-home', 'tool-help', 'tool-studio-lookalike']) {
      expect(byId(items, id), id).toBeDefined();
      expect(byId(items, id)?.locked, id).toBeUndefined();
    }
  });

  it('a legacy-mode package is always discoverable, so its tile is never locked', async () => {
    await installFixture();
    expect(await runtime.canDiscover('legacy-tool', alice)).toBe(true);
    expect(byId((await rail('launcher')).items, 'tool-legacy-ui')?.locked).toBeUndefined();
  });

  it('an ADR-141 group\'s borrowed tiles follow their member; the kernel setup tile is untouched', async () => {
    await installFixture();
    const before = await rail('creative');
    expect(before.items.map(item => item.id)).toEqual(expect.arrayContaining(['tool-creative-setup', 'tool-studio-home', 'tool-legacy-home']));
    expect(byId(before.items, 'tool-creative-setup')?.locked).toBeUndefined();
    expect(byId(before.items, 'tool-studio-home')?.locked).toEqual({ app: 'studio', reason: 'application-role-required', roleGuidanceUrl: '/users' });
    expect(byId(before.items, 'tool-legacy-home')?.locked).toBeUndefined();
    await grantOpener('studio');
    expect(byId((await rail('creative')).items, 'tool-studio-home')?.locked).toBeUndefined();
  });

  it('the role-guidance link follows the caller: application access review for a swarm admin', async () => {
    await installFixture();
    expect(byId((await rail('launcher', 'administrator')).items, 'tool-studio-app')?.locked?.roleGuidanceUrl).toBe('/access');
  });

  it('no port means the declared rail, and the manifest itself never changes', async () => {
    await installFixture();
    const declared = JSON.stringify(records.get('launcher')!.manifest);
    await rail('launcher');
    expect(JSON.stringify(records.get('launcher')!.manifest)).toBe(declared);
    const internal = await apps.synthesiseProfile('launcher');
    const items = (internal?.ribbon.items ?? []).filter((item): item is Exclude<typeof item, string> => typeof item !== 'string');
    expect(items.some(item => item.locked)).toBe(false);
    expect(items.map(item => item.id).slice(0, 2)).toEqual(['tool-launcher-home', 'tool-studio-app']);
  });

  it('an unresolvable caller is logged and served the declared rail, never a wider one', async () => {
    await installFixture();
    const { status, items } = await rail('launcher', 'broken');
    expect(status).toBe(200);
    expect(byId(items, 'tool-studio-app')?.locked).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/rail discoverability/));
  });
});

describe('ADR-149 landing view — the cockpit never opens on a locked tile', () => {
  /** A launcher that DECLARES its landing tile, which happens to belong to another package. */
  const frontDoor = (name: string, tiles: Tile[]) => manifest(name, tiles, true, { defaultView: 'studio-app' });

  it('falls through a locked declared default to the first openable tile, and restores it on a grant', async () => {
    await installFixture();
    await install(frontDoor('front-door', [tile('front-door-home', '/api/front-door/home'), tile('studio-app', '/api/studio/app')]));
    expect(byId((await rail('front-door')).items, 'tool-studio-app')?.locked?.app).toBe('studio');
    expect(await landing('front-door')).toBe('tool-front-door-home');
    await grantOpener('studio');
    expect(await landing('front-door')).toBe('tool-studio-app');
  });

  it('lands on the first framework view when every static tile is locked', async () => {
    await installFixture();
    await install(frontDoor('studio-launcher', [tile('studio-app', '/api/studio/app'), tile('studio-notes', '/api/studio/notes')]));
    expect(await landing('studio-launcher')).toBe('chat');
    await grantOpener('studio');
    expect(await landing('studio-launcher')).toBe('tool-studio-app');
  });

  it('leaves an app with nothing locked exactly where it landed before, port or no port', async () => {
    await installFixture();
    await install(frontDoor('front-door', [tile('front-door-home', '/api/front-door/home'), tile('studio-app', '/api/studio/app')]));
    expect(await landing('launcher')).toBe('tool-launcher-home'); // no declared default: the first tile, on its OWN mount
    expect(await landing('legacy-tool')).toBe('tool-legacy-home');
    expect((await apps.synthesiseProfile('front-door'))?.defaultView).toBe('tool-studio-app'); // no port = the manifest-static default
  });
});

describe('lockUndiscoverableTiles — the resolver on its own', () => {
  const owner = { name: 'launcher', manifest: { routes: [{ module: 'r.js', factory: 'f', mountPath: '/api/launcher/' }] } };
  const installed = [
    { name: 'studio', status: 'active' as const, manifest: { routes: [{ module: 'r.js', factory: 'f', mountPath: '/api/studio' }] } },
    { name: 'studio-notes', status: 'active' as const, manifest: { routes: [{ module: 'r.js', factory: 'f', mountPath: '/api/studio/notes' }] } },
    { name: 'retired', status: 'inactive' as const, manifest: { routes: [{ module: 'r.js', factory: 'f', mountPath: '/api/retired' }] } },
  ];
  const items = (...urls: string[]) => urls.map(url => ({ id: url, toolUi: { iframeUrl: url } }));

  it('resolves the longest mount, ignores inactive owners, and asks each target once', async () => {
    const owners = [{ name: 'studio', mounts: ['/api/studio'] }, { name: 'studio-notes', mounts: ['/api/studio/notes'] }];
    expect(mountOwner('/api/studio/notes/today', owners)).toBe('studio-notes');
    expect(mountOwner('/api/studio/app', owners)).toBe('studio');
    expect(mountOwner('/api/studios', owners)).toBeUndefined();
    const asked: string[] = [];
    const result = await lockUndiscoverableTiles(owner, items('/api/launcher/home', '/api/studio/app', '/api/studio/other', '/api/studio/notes/x', '/api/retired/ui', 'https://evil.example/', '//evil'), installed,
      { canDiscover: async app => { asked.push(app); return app === 'studio-notes'; }, roleGuidanceUrl: '/users' });
    expect(asked).toEqual(['studio', 'studio-notes']);
    expect(result.map(item => item.locked?.app ?? null)).toEqual([null, 'studio', 'studio', null, null, null, null]);
  });

  it('leaves a tile as declared when the port fails, and logs the failure', async () => {
    log.error.mockClear();
    const result = await lockUndiscoverableTiles(owner, items('/api/studio/app'), installed,
      { canDiscover: async () => { throw new Error('directory offline'); }, roleGuidanceUrl: '/users' });
    expect(result[0].locked).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ target: 'studio' }), expect.stringMatching(/discoverability check failed/));
  });
});
