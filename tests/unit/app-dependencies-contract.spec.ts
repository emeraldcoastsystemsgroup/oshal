/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Dependency tiers: the shared CLI/runtime contract (required vs optional, the legacy flat form as all-required, every refusal), the real loader failing closed on a malformed block, group members as required apps, optional tools never failing a load, and the real SwarmAppService blocking an uninstall only on REQUIRED dependents while reporting optional ones and deriving the connector allow-list from both tiers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Keep the surfaced group fixture valid under P8's enforce-by-default concierge contract so this suite continues to isolate required-versus-optional membership validation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectorAllowList, inspectAppDependencies, optionalAppDependencies, readAppDependencies,
  requiredAppDependencies, requiredToolDependencies,
} from '@/shared/app-dependencies';
import { isKernelSkillId } from '@/shared/kernel-skills';
import { SwarmAppService, readManifest, type SwarmAppManifest } from '@/features/swarm-apps';
import { assertToolDependenciesResolvable } from '@/features/swarm-apps/services/tool-ownership';

const contract = require('../../scripts/oshal-app-dependencies') as { readAppDependencies(m: unknown): unknown };

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function writeManifest(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-deps-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'oshal-app.yaml'), body, 'utf8');
  return join(dir, 'oshal-app.yaml');
}
const tiered = (name: string, dependencies: unknown) => ({ name, uses: ['app-dependencies'], dependencies });

describe('the dependency-tier contract', () => {
  it('reads the legacy flat form as all required, keeping its connector allow-list semantics', () => {
    const deps = readAppDependencies({ name: 'kids', dependencies: { apps: ['presentations-surface'], tools: ['trading_scan'], connectors: [] } });
    expect(deps).toMatchObject({ tiered: false, required: { apps: ['presentations-surface'], tools: ['trading_scan'], connectors: [] } });
    expect(deps.optional).toEqual({ apps: [], tools: [], connectors: [] });
    expect(connectorAllowList({ dependencies: { apps: [], connectors: [] } })).toEqual([]);
    expect(connectorAllowList({ dependencies: { apps: [] } })).toBeUndefined();
    expect(connectorAllowList({})).toBeUndefined();
  });

  it('splits the tiered form and unions both tiers into the connector allow-list', () => {
    const manifest = tiered('scan-to-print', {
      required: { apps: ['spaces'], connectors: ['google-drive'] },
      optional: { apps: ['cad-studio'], tools: ['slice_model'], connectors: ['dropbox'] },
    });
    expect(requiredAppDependencies(manifest)).toEqual(['spaces']);
    expect(optionalAppDependencies(manifest)).toEqual(['cad-studio']);
    expect(requiredToolDependencies(manifest)).toEqual([]);
    expect(connectorAllowList(manifest)).toEqual(['google-drive', 'dropbox']);
    expect(connectorAllowList(tiered('x', { required: { apps: [] } }))).toBeUndefined();
  });

  it('is the same contract the CLI loads (one module, two callers)', () => {
    const manifest = tiered('a', { optional: { apps: ['beta'] } });
    expect(contract.readAppDependencies(manifest)).toEqual(readAppDependencies(manifest));
  });

  it.each([
    ['mixing the two forms', { name: 'a', uses: ['app-dependencies'], dependencies: { apps: [], required: { apps: [] } } }, /mixes the flat/],
    ['an unknown top-level key', { name: 'a', dependencies: { apps: [], skills: [] } }, /unknown key\(s\): skills/],
    ['a misspelt tier', tiered('a', { required: {}, optinal: { apps: ['beta'] } }), /unknown key\(s\): optinal/],
    ['an unknown key inside a tier', tiered('a', { optional: { packages: ['beta'] } }), /dependencies\.optional has unknown key "packages"/],
    ['a list that is not a list', tiered('a', { required: { apps: 'beta' } }), /dependencies\.required\.apps must be a list/],
    ['an empty YAML list value', { name: 'a', dependencies: { apps: null } }, /dependencies\.apps must be a list/],
    ['a name that is not installable', tiered('a', { required: { apps: ['world@^1.2'] } }), /"world@\^1\.2" is not a valid package name/],
    ['a repeated name', { name: 'a', dependencies: { apps: ['beta', 'beta'] } }, /repeats "beta"/],
    ['one app in both tiers', tiered('a', { required: { apps: ['beta'] }, optional: { apps: ['beta'] } }), /"beta" as both required and optional apps/],
    ['a self-dependency', { name: 'alpha', dependencies: { apps: ['alpha'] } }, /names the package itself/],
    ['the tiered form without its floor', { name: 'a', dependencies: { optional: { apps: ['beta'] } } }, /needs uses: \[app-dependencies\]/],
    ['a block that is not a mapping', { name: 'a', dependencies: ['beta'] }, /dependencies must be a mapping/],
  ])('refuses %s', (_label, manifest, message) => {
    expect(() => readAppDependencies(manifest)).toThrow(message);
    expect(inspectAppDependencies(manifest).problems.length).toBeGreaterThan(0);
  });

  it('lets a group use the tiered form without the floor (groups may not declare uses:)', () => {
    expect(readAppDependencies({ name: 'g', kind: 'group', dependencies: { required: { apps: ['m1'] } } }).required.apps).toEqual(['m1']);
  });

  it('registers app-dependencies as a kernel skill so a manifest may declare it', () => {
    expect(isKernelSkillId('app-dependencies')).toBe(true);
  });
});

describe('the loader and the runtime consumers', () => {
  it('fails a malformed block at load, naming the manifest', () => {
    const file = writeManifest('name: a\ndisplayName: A\ndependencies:\n  optional:\n    apps: [beta]\n');
    expect(() => readManifest(file)).toThrow(new RegExp(`Manifest .*oshal-app\\.yaml: .*needs uses: \\[app-dependencies\\]`));
  });

  it('loads the tiered form when the floor is declared', () => {
    const file = writeManifest('name: a\ndisplayName: A\nuses: [app-dependencies]\ndependencies:\n  required:\n    apps: [beta]\n  optional:\n    apps: [gamma]\n');
    expect(requiredAppDependencies(readManifest(file))).toEqual(['beta']);
  });

  it('takes a group\'s members from its REQUIRED apps; an optional app is not a member', () => {
    const base = 'name: g\ndisplayName: G\nkind: group\nchatBot: m1-concierge\ndependencies:\n  required:\n    apps: [m1]\n  optional:\n    apps: [m2]\n';
    expect(readManifest(writeManifest(`${base}toolbar:\n  - { app: m1, surface: m1-home }\n`)).kind).toBe('group');
    expect(() => readManifest(writeManifest(`${base}toolbar:\n  - { app: m2, surface: m2-home }\n`)))
      .toThrow(/toolbar\[0\]\.app "m2" is not a member \(required apps: m1\)/);
  });

  it('fails a load only on a REQUIRED tool nothing provides', () => {
    const optionalTool = tiered('a', { optional: { tools: ['ghost'] } }) as unknown as SwarmAppManifest;
    expect(() => assertToolDependenciesResolvable(optionalTool, new Set())).not.toThrow();
    const requiredTool = tiered('a', { required: { tools: ['ghost'] } }) as unknown as SwarmAppManifest;
    expect(() => assertToolDependenciesResolvable(requiredTool, new Set())).toThrow(/required tool dependency names unknown tool\(s\): ghost/);
  });
});

// ── the real service over a doubled repository (the group spec's pattern) ────────────────────────
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
const app = (name: string, extra = '') => writeManifest(`name: ${name}\ndisplayName: ${name}\nsuite: ai-engineering\n${extra}`);

describe('SwarmAppService — only a REQUIRED dependent blocks an uninstall', () => {
  it('reports optional dependents without blocking, and blocks on a required one', async () => {
    const repo = new FakeRepo();
    const svc = service(repo);
    await svc.loadApp(app('cad-studio'));
    await svc.loadApp(app('scan-to-print', 'uses: [app-dependencies]\ndependencies:\n  optional:\n    apps: [cad-studio]\n'));
    const optionalOnly = await svc.uninstallImpact('cad-studio');
    expect(optionalOnly).toMatchObject({ dependents: [], optionalDependents: ['scan-to-print'] });
    await svc.loadApp(app('print-farm', 'dependencies:\n  apps: [cad-studio]\n'));
    const required = await svc.uninstallImpact('cad-studio');
    expect(required).toMatchObject({ dependents: ['print-farm'], optionalDependents: ['scan-to-print'] });
    expect(await svc.unloadApp('cad-studio')).toMatchObject({ removed: false, blocked: true, dependents: ['print-farm'] });
  });

  it('offers only REQUIRED dependencies as orphans and forwards both tiers\' connectors as the allow-list', async () => {
    const repo = new FakeRepo();
    const svc = service(repo);
    await svc.loadApp(app('spaces'));
    await svc.loadApp(app('cad-studio'));
    await svc.loadApp(app('scan-to-print', [
      'uses: [app-dependencies]', 'dependencies:',
      '  required:\n    apps: [spaces]\n    connectors: [google-drive]',
      '  optional:\n    apps: [cad-studio]\n    connectors: [dropbox]', '',
    ].join('\n')));
    expect((await svc.uninstallImpact('scan-to-print')).orphanCandidates).toEqual(['spaces']);
    expect((await svc.synthesiseProfile('scan-to-print'))?.connectors).toEqual(['google-drive', 'dropbox']);
  });
});
