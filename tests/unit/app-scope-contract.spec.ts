/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the shared app-scope contract (scripts/oshal-app-scope.js). dev-workspace-index 0.2.0 declared `scope: deployment`, passed `oshal-app validate` and the store gate, and was refused by the swarm_applications CHECK mid-install on 2026-09-28. Pins: the vocabulary equals migration 064's CHECK and the SwarmAppScope type; the real `oshal-app validate` CLI exits non-zero naming unknown_app_scope for `scope: deployment` and passes `scope: operator`; the real readManifest refuses it with code unknown_app_scope; and the real SwarmAppService.loadApp refuses it before touching its pool or its repository (a recording double of each, so any read or write would be seen), while a known scope reaches the repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_SCOPES, UNKNOWN_APP_SCOPE, isAppScope, validateAppScope } from '@/shared/app-scope';
import { SwarmAppService, readManifest, type SwarmAppManifest } from '@/features/swarm-apps';

const ROOT = process.cwd();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A minimal package directory holding only an oshal-app.yaml. */
function writePackage(name: string, scopeLine: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'oshal-app-scope-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'oshal-app.yaml'), `name: ${name}\ndisplayName: ${name}\nsuite: ai-engineering\nversion: 0.0.1\n${scopeLine}\n`, 'utf8');
  return dir;
}

/** The quoted values of a `scope IN (...)` CHECK in a migration file. */
function checkValues(sql: string): string[] {
  const inList = /CHECK\s*\(\s*scope\s+IN\s*\(([^)]*)\)\s*\)/i.exec(sql);
  return inList ? [...inList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
}

describe('the app-scope vocabulary', () => {
  it('equals the swarm_applications CHECK (migration 064) and the SwarmAppScope type', () => {
    const migration = checkValues(readFileSync(path.join(ROOT, 'scripts/migrations/064-swarm-app-operator-scope.sql'), 'utf8'));
    expect(migration).toHaveLength(4);
    expect([...APP_SCOPES].sort()).toEqual([...migration].sort());
    const union = /export type SwarmAppScope = ([^;]+);/.exec(readFileSync(path.join(ROOT, 'src/features/swarm-apps/types.ts'), 'utf8'));
    expect([...(union?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()).toEqual([...APP_SCOPES].sort());
  });

  it('accepts an absent or known scope and refuses anything else by name', () => {
    expect(validateAppScope({ name: 'a' })).toBeUndefined();
    for (const scope of APP_SCOPES) expect(validateAppScope({ name: 'a', scope })).toBe(scope);
    for (const scope of ['deployment', 'Public', '', null, 42, ['operator']]) {
      expect(isAppScope(scope)).toBe(false);
      expect(() => validateAppScope({ name: 'a', scope }), String(scope)).toThrow(expect.objectContaining({ code: UNKNOWN_APP_SCOPE }));
    }
    expect(() => validateAppScope({ scope: 'deployment' })).toThrow('scope is not a known app scope: "deployment" (unknown_app_scope). Known scopes: person, tenant, public, operator.');
  });
});

describe('oshal-app validate', () => {
  const validate = (dir: string) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/oshal-app.js'), 'validate', dir], { encoding: 'utf8', timeout: 60_000 });

  it('fails a package declaring scope: deployment and passes one declaring scope: operator', () => {
    const bad = validate(writePackage('scope-fixture', 'scope: deployment'));
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toContain('scope is not a known app scope: "deployment" (unknown_app_scope)');
    const good = validate(writePackage('scope-fixture', 'scope: operator'));
    expect(`${good.stdout}${good.stderr}`).not.toContain(UNKNOWN_APP_SCOPE);
    expect(good.status).toBe(0);
  });
});

// ── the real loader and the real service over recording doubles of its only two ways to the database ──
class RecordingRepo {
  calls: string[] = [];
  async findByName(name: string) { this.calls.push(`findByName ${name}`); return null; }
  async upsert(manifest: SwarmAppManifest, manifestPath: string, toolNames: string[]) {
    this.calls.push(`upsert ${manifest.name}`);
    return { name: manifest.name, status: 'inactive', manifest, manifestPath, agentIds: [], toolNames, appId: manifest.name, displayName: manifest.displayName,
      description: '', version: '1', scope: manifest.scope ?? 'public', ownerSub: null, tenantId: null, guestTierApproved: null, loadedAt: new Date(), updatedAt: new Date() };
  }
  async list() { this.calls.push('list'); return []; }
}

describe('the loader refuses an unknown scope before any database call', () => {
  it('readManifest throws unknown_app_scope naming the file', () => {
    const file = path.join(writePackage('scope-fixture', 'scope: deployment'), 'oshal-app.yaml');
    expect(() => readManifest(file)).toThrow(expect.objectContaining({ code: UNKNOWN_APP_SCOPE }));
    expect(() => readManifest(file)).toThrow(`Manifest ${file}: scope is not a known app scope: "deployment"`);
    expect(readManifest(path.join(writePackage('scope-fixture', 'scope: operator'), 'oshal-app.yaml')).scope).toBe('operator');
  });

  it('SwarmAppService.loadApp touches neither pool nor repository for scope: deployment, and reaches the repository for scope: operator', async () => {
    const queries: string[] = [];
    const pool = { query: async (text: string) => { queries.push(text); return { rows: [], rowCount: 0 }; } };
    const repo = new RecordingRepo();
    const service = new SwarmAppService(pool as never, repo as never, { updateAgentStatus: async () => undefined } as never);
    const bad = path.join(writePackage('scope-fixture', 'scope: deployment'), 'oshal-app.yaml');
    await expect(service.loadApp(bad)).rejects.toMatchObject({ code: UNKNOWN_APP_SCOPE });
    expect(queries).toEqual([]);
    expect(repo.calls).toEqual([]);
    const good = path.join(writePackage('scope-fixture', 'scope: operator\nstatus: inactive'), 'oshal-app.yaml');
    const record = await service.loadApp(good);
    expect(record.scope).toBe('operator');
    expect(repo.calls).toEqual(expect.arrayContaining(['findByName scope-fixture', 'upsert scope-fixture']));
  });
});
