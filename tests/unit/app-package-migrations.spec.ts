/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 P2 migration runner verification: a package's own migrations apply in order inside a single-client transaction, are tracked per (app,file) and never re-applied, path-escapes are skipped, and the APP_PACKAGE_MIGRATIONS flag (default off) makes the whole thing a no-op.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085 packaged-bot registrar + ragCollections data gate: activate hands manifest bots to the injected registrar and deactivate retracts them; uninstallImpact expands ragCollections globs against live collections; unloadApp deletes them ONLY under dropData and reports what it dropped.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmAppService } from '../../src/features/swarm-apps';

// ── Fakes ────────────────────────────────────────────────────────────────────
/** Fake pg client: records queries issued inside the migration transaction. */
function makeFakeClient(log: string[]) {
  return {
    query: async (sql: string) => { log.push(`client:${sql.split('\n')[0].trim().slice(0, 60)}`); return { rows: [], rowCount: 0 }; },
    release: () => { log.push('client:RELEASE'); },
  };
}

/** Fake pool: `applied` drives the already-applied check; `log` records everything. */
function makeFakePool(log: string[], applied: Set<string>) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const head = sql.split('\n')[0].trim().slice(0, 60);
      log.push(`pool:${head}`);
      if (sql.includes('FROM app_package_migrations')) {
        const key = `${params?.[0]}::${params?.[1]}`;
        return { rows: applied.has(key) ? [{ one: 1 }] : [], rowCount: applied.has(key) ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => makeFakeClient(log),
  };
}

const fakeRepo = (record: Record<string, unknown>) => ({
  upsert: async () => record,
  list: async () => [],
  findByName: async () => record,
  updateStatus: async () => record,
  delete: async () => true,
});
const fakeAgentRepo = { updateAgentStatus: async () => undefined };

// ── Fixture package on disk ──────────────────────────────────────────────────
let pkgDir: string;

function writeManifest(migrations: string[]): string {
  const manifestPath = join(pkgDir, 'oshal-app.yaml');
  writeFileSync(manifestPath, [
    'name: mig-test-app',
    'displayName: Migration Test App',
    'migrations:',
    ...migrations.map((m) => `  - ${m}`),
  ].join('\n'));
  return manifestPath;
}

function makeService(log: string[], applied: Set<string>, manifestPath: string) {
  const record = {
    appId: 'x', name: 'mig-test-app', displayName: 'Migration Test App', description: '',
    version: '1.0.0', status: 'active', manifestPath, agentIds: [], toolNames: [],
    manifest: { name: 'mig-test-app', displayName: 'Migration Test App', migrations: undefined as unknown },
    scope: 'public', ownerSub: null, tenantId: null, loadedAt: new Date(), updatedAt: new Date(),
  };
  // The service re-reads the manifest itself via readManifest(manifestPath) in loadApp;
  // activate() uses record.manifest — mirror the on-disk migrations list into the record.
  const yaml = require('js-yaml');
  const fs = require('fs');
  record.manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  return new SwarmAppService(
    makeFakePool(log, applied) as never,
    fakeRepo(record) as never,
    fakeAgentRepo as never,
  );
}

beforeAll(() => {
  pkgDir = mkdtempSync(join(tmpdir(), 'oshal-mig-'));
  mkdirSync(join(pkgDir, 'migrations'), { recursive: true });
  writeFileSync(join(pkgDir, 'migrations', '001-first.sql'), 'CREATE TABLE IF NOT EXISTS mig_test_one (id INT);');
  writeFileSync(join(pkgDir, 'migrations', '002-second.sql'), 'CREATE TABLE IF NOT EXISTS mig_test_two (id INT);');
});

afterAll(() => {
  rmSync(pkgDir, { recursive: true, force: true });
  delete process.env.APP_PACKAGE_MIGRATIONS;
});

beforeEach(() => {
  process.env.APP_PACKAGE_MIGRATIONS = '1';
});

describe('ADR-085 P2 — package migration runner', () => {
  it('applies declared migrations in order, each in a single-client transaction, and records them', async () => {
    const log: string[] = [];
    const manifestPath = writeManifest(['migrations/001-first.sql', 'migrations/002-second.sql']);
    const svc = makeService(log, new Set(), manifestPath);
    await svc.loadApp(manifestPath);

    const clientOps = log.filter((l) => l.startsWith('client:'));
    // Two migrations → two BEGIN/sql/INSERT/COMMIT/RELEASE cycles, in declared order.
    expect(clientOps).toEqual([
      'client:BEGIN', 'client:CREATE TABLE IF NOT EXISTS mig_test_one (id INT);',
      'client:INSERT INTO app_package_migrations (app_name, file_name) VAL', 'client:COMMIT', 'client:RELEASE',
      'client:BEGIN', 'client:CREATE TABLE IF NOT EXISTS mig_test_two (id INT);',
      'client:INSERT INTO app_package_migrations (app_name, file_name) VAL', 'client:COMMIT', 'client:RELEASE',
    ]);
    // The tracking table is ensured up front.
    expect(log.some((l) => l.includes('CREATE TABLE IF NOT EXISTS app_package_migrations'))).toBe(true);
  });

  it('never re-applies a recorded migration (idempotent per app+file)', async () => {
    const log: string[] = [];
    const manifestPath = writeManifest(['migrations/001-first.sql']);
    const applied = new Set(['mig-test-app::migrations/001-first.sql']);
    const svc = makeService(log, applied, manifestPath);
    await svc.loadApp(manifestPath);
    expect(log.filter((l) => l.startsWith('client:'))).toEqual([]); // no transaction ran
  });

  it('skips path escapes (absolute / ..) — self-containment is enforced', async () => {
    const log: string[] = [];
    const manifestPath = writeManifest(['../outside.sql', '/etc/evil.sql']);
    const svc = makeService(log, new Set(), manifestPath);
    await svc.loadApp(manifestPath);
    expect(log.filter((l) => l.startsWith('client:'))).toEqual([]);
  });

  it('is a byte-for-byte no-op when APP_PACKAGE_MIGRATIONS is off (the default)', async () => {
    delete process.env.APP_PACKAGE_MIGRATIONS;
    const log: string[] = [];
    const manifestPath = writeManifest(['migrations/001-first.sql']);
    const svc = makeService(log, new Set(), manifestPath);
    await svc.loadApp(manifestPath);
    expect(log.some((l) => l.includes('app_package_migrations'))).toBe(false);
    expect(log.filter((l) => l.startsWith('client:'))).toEqual([]);
  });
});

describe('ADR-085 §5 — dependency-aware uninstall', () => {
  function serviceWithApps(apps: Array<{ name: string; deps?: string[] }>, spyLog: string[]) {
    const recs = apps.map((a) => ({
      appId: a.name, name: a.name, displayName: a.name, description: '', version: '1',
      status: 'active', manifestPath: `/x/${a.name}.yaml`, agentIds: [], toolNames: [],
      manifest: { name: a.name, displayName: a.name, dependencies: a.deps ? { apps: a.deps } : undefined },
      scope: 'public', ownerSub: null, tenantId: null, loadedAt: new Date(), updatedAt: new Date(),
    }));
    const repo = {
      list: async () => recs,
      findByName: async (n: string) => recs.find((r) => r.name === n) ?? null,
      delete: async (n: string) => { spyLog.push(`delete:${n}`); return true; },
      updateStatus: async () => recs[0],
      upsert: async () => recs[0],
    };
    return new SwarmAppService(makeFakePool([], new Set()) as never, repo as never, fakeAgentRepo as never);
  }

  it('blocks removal while an active app depends on it (nothing deleted), and reports orphans', async () => {
    const log: string[] = [];
    // trading depends on world — the operator's canonical example.
    const svc = serviceWithApps([{ name: 'world' }, { name: 'trading', deps: ['world'] }], log);
    const impact = await svc.uninstallImpact('world');
    // toMatchObject, not toEqual: uninstallImpact grew toolsProvided/toolDependents in ADR-085 D11,
    // and this assertion is about the APP-level dependency graph.
    expect(impact).toMatchObject({ exists: true, dependents: ['trading'], orphanCandidates: [], ragCollections: [] });
    const res = await svc.unloadApp('world');
    expect(res.blocked).toBe(true);
    expect(res.dependents).toEqual(['trading']);
    expect(log).toEqual([]); // NOTHING was deleted
  });

  it('removes cleanly when nothing depends on it, reporting would-be orphans without cascading', async () => {
    const log: string[] = [];
    const svc = serviceWithApps([{ name: 'world' }, { name: 'trading', deps: ['world'] }], log);
    const res = await svc.unloadApp('trading');
    expect(res.removed).toBe(true);
    expect(res.orphanCandidates).toEqual(['world']); // reported — NOT deleted
    expect(log).toEqual(['delete:trading']); // only trading itself
  });

  it('force overrides the block (caller has seen the impact)', async () => {
    const log: string[] = [];
    const svc = serviceWithApps([{ name: 'world' }, { name: 'trading', deps: ['world'] }], log);
    const res = await svc.unloadApp('world', { force: true });
    expect(res.removed).toBe(true);
    expect(log).toEqual(['delete:world']);
  });
});

describe('ADR-085 — packaged-bot registrar + ragCollections data gate', () => {
  function recordWith(manifest: Record<string, unknown>, status = 'active') {
    return {
      appId: 'x', name: String(manifest.name), displayName: String(manifest.name), description: '',
      version: '1.0.0', status, manifestPath: join(pkgDir, 'oshal-app.yaml'), agentIds: [], toolNames: [],
      manifest, scope: 'public', ownerSub: null, tenantId: null, loadedAt: new Date(), updatedAt: new Date(),
    };
  }
  const args = (record: Record<string, unknown>) => [
    makeFakePool([], new Set()) as never,
    fakeRepo(record) as never,
    fakeAgentRepo as never,
    undefined, undefined, undefined, undefined, undefined,
  ] as const;

  it('activate hands manifest bots to the registrar; deactivate retracts them', async () => {
    const calls: string[] = [];
    const record = recordWith({
      name: 'bot-app', displayName: 'bot-app',
      bots: [{ agentId: 'ed000000-0000-0000-0000-000000000001', name: 'tutor', persona: 'personas/tutor.yaml' }],
    }, 'inactive');
    const svc = new SwarmAppService(
      ...args(record),
      { register: (app, bots) => calls.push(`register:${app}:${bots.length}`), unregister: (app) => calls.push(`unregister:${app}`) },
    );
    await svc.toggleApp('bot-app', true);
    expect(calls).toContain('register:bot-app:1');
    await svc.toggleApp('bot-app', false);
    expect(calls[calls.length - 1]).toBe('unregister:bot-app');
  });

  it('uninstallImpact expands ragCollections globs against LIVE collections only', async () => {
    const record = recordWith({ name: 'rag-app', displayName: 'rag-app', ragCollections: ['rag-app-*', 'exact-name'] });
    const svc = new SwarmAppService(
      ...args(record),
      undefined,
      { list: async () => ['rag-app-notes', 'rag-app-books', 'other-app-x', 'exact-name'], deleteCollection: async () => {} },
    );
    const impact = await svc.uninstallImpact('rag-app');
    expect(impact.ragCollections.sort()).toEqual(['exact-name', 'rag-app-books', 'rag-app-notes']);
  });

  it('unloadApp deletes matched collections ONLY under dropData, non-fatally, and reports them', async () => {
    const deleted: string[] = [];
    const teardown = {
      list: async () => ['rag-app-notes', 'rag-app-poison', 'other-app-x'],
      deleteCollection: async (n: string) => {
        if (n === 'rag-app-poison') throw new Error('engine hiccup');
        deleted.push(n);
      },
    };
    const record = recordWith({ name: 'rag-app', displayName: 'rag-app', ragCollections: ['rag-app-*'] });
    const svc = new SwarmAppService(...args(record), undefined, teardown);

    const keep = await svc.unloadApp('rag-app');
    expect(keep.removed).toBe(true);
    expect(deleted).toEqual([]); // no dropData → data preserved
    expect(keep.droppedRagCollections).toEqual([]);

    const drop = await svc.unloadApp('rag-app', { dropData: true });
    expect(drop.removed).toBe(true); // the failing collection did NOT abort the uninstall
    expect(deleted).toEqual(['rag-app-notes']);
    expect(drop.droppedRagCollections).toEqual(['rag-app-notes']);
  });
});

describe('ADR-085 P0 — schedule teardown on deactivate', () => {
  it('toggling an app off hands every declared schedule id to the deregistrar', async () => {
    const calls: Array<{ appName: string; scheduleIds: string[] }> = [];
    const manifestPath = join(pkgDir, 'oshal-app.yaml');
    writeFileSync(manifestPath, [
      'name: mig-test-app',
      'displayName: Migration Test App',
      'schedules:',
      '  - { id: ticker-pulse, cron: "*/5 * * * *", prompt: poll }',
      '  - { id: nightly, cron: "0 4 * * *", prompt: sweep, scope: per-user }',
    ].join('\n'));
    const yaml = require('js-yaml');
    const fs = require('fs');
    const record = {
      appId: 'x', name: 'mig-test-app', displayName: 'Migration Test App', description: '',
      version: '1.0.0', status: 'active', manifestPath, agentIds: [], toolNames: [],
      manifest: yaml.load(fs.readFileSync(manifestPath, 'utf8')),
      scope: 'public', ownerSub: null, tenantId: null, loadedAt: new Date(), updatedAt: new Date(),
    };
    const svc = new SwarmAppService(
      makeFakePool([], new Set()) as never,
      fakeRepo(record) as never,
      fakeAgentRepo as never,
      undefined, undefined, undefined, undefined,
      async (input) => { calls.push(input); },
    );
    await svc.toggleApp('mig-test-app', false);
    // BOTH scopes tear down — per-user instances are children of the declared id.
    expect(calls).toEqual([{ appName: 'mig-test-app', scheduleIds: ['ticker-pulse', 'nightly'] }]);
  });
});
