/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-141 application groups — the guards. readManifest fails closed on a group that carries code, borrows from a non-member, or names a fix that is not on its toolbar, and on a readiness block that is off-mount, behind a service-only route, or has a bad pointer. The resolvers borrow a member surface by REFERENCE (label/icon/iframeUrl come from the member) and name the member + surface when one is missing. The REAL SwarmAppService (repository doubled) fail-closes activation of a group whose member is inactive, renders a group as dashboard-tile-first + borrowed tiles, and hands the dashboard route a plan whose unavailable steps are never done. The smoke verifier verifies a group through its members and fails it by name without a resolver.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SwarmAppService,
  readManifest,
  resolveGroupToolbar,
  resolveGroupSetup,
  assertGroupResolvable,
  orderGroupsLast,
  verifyAppSmokes,
  type SwarmAppManifest,
} from '@/features/swarm-apps';

const tempDirs: string[] = [];
function writeManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-group-'));
  tempDirs.push(dir);
  const file = join(dir, 'oshal-app.yaml');
  writeFileSync(file, body, 'utf8');
  return file;
}
afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GROUP_YAML = [
  'name: g',
  'displayName: G',
  'kind: group',
  'suite: ai-knowledge',
  'dependencies:',
  '  apps: [m1, m2]',
  'toolbar:',
  '  - { app: m1, surface: m1-home }',
  '  - { app: m2, surface: m2-inbox, group: Documents, section: bottom }',
  'setup:',
  '  - { label: Do the thing, app: m1, readiness: thing, fix: m1-home }',
  '  - { label: Get mail, app: m2, readiness: mail, fix: m2-inbox }',
  '',
].join('\n');

const MEMBER_YAML = (name: string, surface: string, readiness: string, auth = 'oidc') => [
  `name: ${name}`,
  `displayName: ${name.toUpperCase()}`,
  'suite: ai-knowledge',
  'ui:',
  '  static:',
  `    - { toolName: ${surface}, label: Home of ${name}, icon: codicon codicon-home, iframeUrl: /api/${name}/home, section: top }`,
  'routes:',
  `  - { module: routes/x.js, factory: createX, mountPath: /api/${name}, auth: ${auth} }`,
  'readiness:',
  `  - { name: ${readiness}, path: /api/${name}/state, readyPointer: /ready, detailPointer: /summary }`,
  '',
].join('\n');

const group = () => readManifest(writeManifest(GROUP_YAML));
const member = (name: string, surface: string, readiness: string) => readManifest(writeManifest(MEMBER_YAML(name, surface, readiness)));

describe('readManifest — kind: group fails closed', () => {
  it('accepts the reference group (sanity)', () => {
    const m = group();
    expect(m.kind).toBe('group');
    expect(m.toolbar).toHaveLength(2);
  });

  it('rejects an unknown kind', () => {
    expect(() => readManifest(writeManifest('name: g\ndisplayName: G\nkind: bundle\n'))).toThrow(/kind must be one of app, group/);
  });

  it('rejects a group that carries code (routes, bots, smoke, ui …)', () => {
    expect(() => readManifest(writeManifest(GROUP_YAML + 'routes:\n  - { module: routes/x.js, factory: f, mountPath: /api/g, auth: oidc }\n')))
      .toThrow(/a group carries no code — remove routes/);
    expect(() => readManifest(writeManifest(GROUP_YAML + 'ui:\n  static:\n    - { toolName: own, label: Own, icon: i, iframeUrl: /x }\n')))
      .toThrow(/remove ui/);
  });

  it('rejects a toolbar that borrows from a non-member, and a fix that is not a toolbar surface', () => {
    expect(() => readManifest(writeManifest(GROUP_YAML.replace('{ app: m1, surface: m1-home }', '{ app: stranger, surface: s }'))))
      .toThrow(/toolbar\[0\]\.app "stranger" is not a member/);
    expect(() => readManifest(writeManifest(GROUP_YAML.replace('fix: m2-inbox', 'fix: nowhere'))))
      .toThrow(/setup\[1\]\.fix "nowhere" must name a toolbar surface/);
  });

  it('rejects a copied tile — label/icon/iframeUrl on a toolbar entry are not allowed', () => {
    expect(() => readManifest(writeManifest(GROUP_YAML.replace('{ app: m1, surface: m1-home }', '{ app: m1, surface: m1-home, iframeUrl: /copied }'))))
      .toThrow(/unknown field\(s\): iframeUrl/);
  });

  it('rejects group-only keys on an ordinary app', () => {
    expect(() => readManifest(writeManifest('name: a\ndisplayName: A\ntoolbar:\n  - { app: x, surface: y }\n')))
      .toThrow(/toolbar are group-only keys/);
  });
});

describe('readManifest — readiness: fails closed like smoke:', () => {
  it('accepts a readiness below the package\'s own session-admitting route (sanity)', () => {
    expect(member('m1', 'm1-home', 'thing').readiness?.[0].path).toBe('/api/m1/state');
  });

  it('rejects a path not owned by the package\'s own routes', () => {
    expect(() => readManifest(writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing').replace('/api/m1/state', '/api/other/state'))))
      .toThrow(/not owned by a declared routes\[\]\.mountPath/);
  });

  it('rejects a probe behind a service-only route — readiness runs as the signed-in user', () => {
    expect(() => readManifest(writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing', 'service'))))
      .toThrow(/must admit a browser session/);
  });

  it('rejects a bad pointer', () => {
    expect(() => readManifest(writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing').replace('readyPointer: /ready', 'readyPointer: ready'))))
      .toThrow(/readyPointer must be a non-empty RFC 6901 pointer/);
  });
});

// The guest-seed contract mirrors readiness, but INVERTED on auth: core calls the seed with the
// service secret (never a session), so its owning route must admit SERVICE auth. A seed behind a
// session-only route would be uncallable by the orchestrator — so that is a load error, not a
// silent miss.
describe('readManifest — guestSeed: fails closed (mirror of readiness, service-admitting)', () => {
  const SEED_YAML = (auth: string, seedPath = '/api/s1/guest-seed') => [
    'name: s1',
    'displayName: S1',
    'suite: ai-knowledge',
    'routes:',
    `  - { module: routes/x.js, factory: createX, mountPath: /api/s1, auth: ${auth} }`,
    `guestSeed: { path: ${seedPath} }`,
    '',
  ].join('\n');

  it('accepts a guest seed below the package\'s own service-admitting route (sanity)', () => {
    expect(readManifest(writeManifest(SEED_YAML('service-or-oidc'))).guestSeed?.path).toBe('/api/s1/guest-seed');
    expect(readManifest(writeManifest(SEED_YAML('service'))).guestSeed?.path).toBe('/api/s1/guest-seed');
  });

  it('rejects a seed behind a session-only route — core calls it with the service secret', () => {
    expect(() => readManifest(writeManifest(SEED_YAML('oidc'))))
      .toThrow(/must admit service auth/);
  });

  it('rejects a seed path not owned by the package\'s own routes', () => {
    expect(() => readManifest(writeManifest(SEED_YAML('service', '/api/other/guest-seed'))))
      .toThrow(/not owned by a declared routes\[\]\.mountPath/);
  });

  it('rejects a non-canonical seed path and an unknown field', () => {
    expect(() => readManifest(writeManifest(SEED_YAML('service', '/api/s1/../escape'))))
      .toThrow(/must be a concrete canonical root-relative path/);
    expect(() => readManifest(writeManifest(SEED_YAML('service').replace('{ path: /api/s1/guest-seed }', '{ path: /api/s1/guest-seed, when: nightly }'))))
      .toThrow(/unknown field\(s\): when/);
  });
});

describe('resolvers — borrow by reference, name what is missing', () => {
  it('copies label/icon/iframeUrl from the member and applies the group band/section', () => {
    const members = new Map([['m1', member('m1', 'm1-home', 'thing')], ['m2', member('m2', 'm2-inbox', 'mail')]]);
    const { tiles, missing } = resolveGroupToolbar(group(), members);
    expect(missing).toEqual([]);
    expect(tiles).toEqual([
      { toolName: 'm1-home', label: 'Home of m1', icon: 'codicon codicon-home', iframeUrl: '/api/m1/home', section: 'top' },
      { toolName: 'm2-inbox', label: 'Home of m2', icon: 'codicon codicon-home', iframeUrl: '/api/m2/home', section: 'bottom', group: 'Documents' },
    ]);
  });

  it('names the member and surface when a reference does not resolve', () => {
    const members = new Map([['m1', member('m1', 'm1-elsewhere', 'thing')]]);
    const { tiles, missing } = resolveGroupToolbar(group(), members);
    expect(tiles).toEqual([]);
    expect(missing.map((m) => m.reason)).toEqual([
      'member "m1" declares no surface "m1-home" (it has: m1-elsewhere)',
      'member app "m2" is not installed and active',
    ]);
    expect(() => assertGroupResolvable(group(), members)).toThrow(/Group "g" cannot activate: toolbar m1\/m1-home/);
  });

  it('resolves setup steps to the member probe, and marks the rest unavailable (never done)', () => {
    const members = new Map([['m1', member('m1', 'm1-home', 'thing')]]);
    const steps = resolveGroupSetup(group(), members);
    expect(steps[0]).toEqual({
      label: 'Do the thing', app: 'm1', appDisplayName: 'M1', readiness: 'thing', fix: 'm1-home',
      probe: { path: '/api/m1/state', readyPointer: '/ready', detailPointer: '/summary' },
    });
    expect(steps[1].probe).toBeUndefined();
    expect(steps[1].unavailable).toMatch(/member app "m2" is not installed and active/);
  });
});

describe('orderGroupsLast — boot order never decides whether a group fail-closes', () => {
  it('moves every group after every app, keeps relative order, and leaves unparsable files in place', () => {
    const g = writeManifest(GROUP_YAML);
    const a = writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing'));
    const bad = writeManifest('name: [');
    const b = writeManifest(MEMBER_YAML('m2', 'm2-inbox', 'mail'));
    expect(orderGroupsLast([g, a, bad, b])).toEqual([a, bad, b, g]);
  });
});

// ── the real service over a doubled repository ────────────────────────────────

type Rec = { name: string; status: 'active' | 'inactive'; manifest: SwarmAppManifest; manifestPath: string; agentIds: string[]; toolNames: string[] };
class FakeRepo {
  records = new Map<string, Rec>();
  async upsert(manifest: SwarmAppManifest, manifestPath: string, toolNames: string[]) {
    const rec: Rec = { name: manifest.name, status: manifest.status ?? 'active', manifest, manifestPath, agentIds: [], toolNames };
    this.records.set(manifest.name, rec);
    return { ...rec, appId: manifest.name, displayName: manifest.displayName, description: '', version: '1', scope: 'public', ownerSub: null, tenantId: null, guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
  }
  async list(status?: 'active' | 'inactive') { const all = [...this.records.values()]; return status ? all.filter((r) => r.status === status) : all; }
  async findByName(name: string) { return this.records.get(name) ?? null; }
  async updateStatus(name: string, status: 'active' | 'inactive') { const r = this.records.get(name); if (!r) return null; r.status = status; return r; }
  async delete(name: string) { return this.records.delete(name); }
}
const fakePool = { query: async () => ({ rows: [] as unknown[], rowCount: 0 }) };
const service = (repo: FakeRepo) => new SwarmAppService(fakePool as never, repo as never, { updateAgentStatus: async () => undefined } as never);

describe('SwarmAppService — a group activates only when its members resolve', () => {
  it('fail-closes to inactive when a member is not active, and activates once it is', async () => {
    const repo = new FakeRepo();
    const svc = service(repo);
    await svc.loadApp(writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing')));
    // m2 is missing → the group must not activate: loadApp fail-closes the record to inactive and
    // surfaces the failure (autoLoadAll isolates it under failed[]) with the member named.
    await expect(svc.loadApp(writeManifest(GROUP_YAML))).rejects.toThrow(/member app "m2" is not installed and active/);
    expect((await repo.findByName('g'))?.status).toBe('inactive');

    await svc.loadApp(writeManifest(MEMBER_YAML('m2', 'm2-inbox', 'mail')));
    const again = await svc.loadApp(writeManifest(GROUP_YAML));
    expect(again.status).toBe('active');
  });

  it('renders the group as its setup-dashboard tile first, then the borrowed member surfaces', async () => {
    const repo = new FakeRepo();
    const svc = service(repo);
    await svc.loadApp(writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing')));
    await svc.loadApp(writeManifest(MEMBER_YAML('m2', 'm2-inbox', 'mail')));
    await svc.loadApp(writeManifest(GROUP_YAML));
    const profile = await svc.synthesiseProfile('g');
    const items = (profile?.ribbon.items ?? []).filter((i): i is Exclude<typeof i, string> => typeof i !== 'string');
    expect(items.map((i) => i.id)).toEqual(['tool-g-setup', 'tool-m1-home', 'tool-m2-inbox']);
    expect(items[0].toolUi.iframeUrl).toBe('/api/swarm/apps/g/setup-dashboard?group=g');
    expect(items[1].toolUi.iframeUrl).toBe('/api/m1/home'); // borrowed, not copied
    expect(items[2].group).toBe('Documents');
    expect(profile?.defaultView).toBe('tool-g-setup');
  });

  it('hands the dashboard a plan whose unavailable steps carry no probe once a member is toggled off', async () => {
    const repo = new FakeRepo();
    const svc = service(repo);
    await svc.loadApp(writeManifest(MEMBER_YAML('m1', 'm1-home', 'thing')));
    await svc.loadApp(writeManifest(MEMBER_YAML('m2', 'm2-inbox', 'mail')));
    await svc.loadApp(writeManifest(GROUP_YAML));
    await svc.toggleApp('m2', false);
    const plan = await svc.getGroupSetupPlan('g');
    expect(plan?.members).toEqual(['m1']);
    expect(plan?.firstSurface).toBe('m1-home');
    expect(plan?.steps[0].probe?.path).toBe('/api/m1/state');
    expect(plan?.steps[1].probe).toBeUndefined();
    expect(plan?.steps[1].unavailable).toMatch(/m2/);
    // An ordinary app has no plan — the route answers 404, never an empty checklist.
    expect(await svc.getGroupSetupPlan('m1')).toBeNull();
  });
});

describe('verifyAppSmokes — a group is verified through its members', () => {
  const smokeMember = (name: string): Rec => ({
    name, status: 'active', manifestPath: `/pkgs/${name}/oshal-app.yaml`, agentIds: [], toolNames: [],
    manifest: {
      name, displayName: name,
      routes: [{ module: 'routes/x.js', factory: 'f', mountPath: `/api/${name}`, auth: 'service' }],
      smoke: [{ name: 'package-readiness', method: 'GET', path: `/api/${name}/_smoke`, auth: 'service', expect: { status: 200 } }],
    } as SwarmAppManifest,
  });
  const groupRec: Rec = { name: 'g', status: 'active', manifestPath: '/pkgs/g/oshal-app.yaml', agentIds: [], toolNames: [], manifest: { name: 'g', displayName: 'G', kind: 'group', dependencies: { apps: ['m1', 'm2'] } } as SwarmAppManifest };
  const fetchOk = async () => ({ status: 200, text: async () => '{}' });

  it('passes when every member is active and its smokes pass, naming the member on each smoke', async () => {
    const members: Record<string, Rec> = { m1: smokeMember('m1'), m2: smokeMember('m2') };
    const result = await verifyAppSmokes([{ requestedName: 'g', record: groupRec as never }], {
      apiBaseUrl: 'http://127.0.0.1:1', serviceSecret: 'test-secret', fetchImpl: fetchOk as never, resolveMember: async (n) => (members[n] as never) ?? null,
    });
    expect(result.success).toBe(true);
    expect(result.apps[0].smokes.map((s) => s.name)).toEqual(['m1/package-readiness', 'm2/package-readiness']);
  });

  it('fails by name when a member is missing, and when no resolver is supplied', async () => {
    const only = { m1: smokeMember('m1') } as Record<string, Rec>;
    const missing = await verifyAppSmokes([{ requestedName: 'g', record: groupRec as never }], {
      apiBaseUrl: 'http://127.0.0.1:1', serviceSecret: 'test-secret', fetchImpl: fetchOk as never, resolveMember: async (n) => (only[n] as never) ?? null,
    });
    expect(missing.failedApps).toEqual(['g']);
    expect(missing.apps[0].error).toMatch(/member m2 is not installed/);
    const unresolved = await verifyAppSmokes([{ requestedName: 'g', record: groupRec as never }], { apiBaseUrl: 'http://127.0.0.1:1', serviceSecret: 'test-secret', fetchImpl: fetchOk as never });
    expect(unresolved.failedApps).toEqual(['g']);
  });
});
