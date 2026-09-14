/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Data-model explorer ownership guards over a REAL filesystem: the declaration scanner (owner per root, `${CONST}` names, .sql always Postgres, SQLite by driver, tests/node_modules skipped), scan roots (a store package's directory is scanned, a kernel swarm-apps manifest and a missing directory are not), attribution (shared, app-only, unowned, declared-but-absent, SQLite, views) and the database links between owners.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CORE_OWNER, attributeOwnership, databaseLinks, scanDeclarations, scanRoots, scanText,
  type AppRecordLite, type CatalogSnapshot, type RelationInfo,
} from '@/features/data-model';

let root: string;
const rel = (name: string, extra: Partial<RelationInfo> = {}): RelationInfo => ({
  name, kind: 'table', comment: null, rls: false, forced: false, policies: [], columns: [{ name: 'id', type: 'uuid', nullable: false, default: null, comment: null }],
  primaryKey: ['id'], foreignKeys: [], uniques: [], hypertable: null, materialized: false, source: 'catalog', ...extra,
});
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'data-model-own-'));
  write(join(root, 'core', 'scripts', 'migrations', '001-base.sql'), 'CREATE TABLE IF NOT EXISTS tickets (id uuid PRIMARY KEY);\nCREATE TABLE shared_orders (id uuid PRIMARY KEY);');
  write(join(root, 'core', 'src', 'store.ts'), "const T = 'lazy_table';\nawait pool.query(`CREATE TABLE IF NOT EXISTS ${T} (id uuid PRIMARY KEY, n int)`);\nawait pool.query(`CREATE OR REPLACE VIEW ticket_summary AS SELECT 1`);");
  write(join(root, 'core', 'src', 'vault.ts'), "import Database from 'better-sqlite3';\ndb.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL)`);");
  write(join(root, 'core', 'src', 'tests', 'fixture.ts'), 'CREATE TABLE should_not_count (id int);');
  write(join(root, 'core', 'src', 'store.spec.ts'), 'CREATE TABLE spec_only (id int);');
  write(join(root, 'pkgs', 'shop', 'oshal-app.yaml'), 'name: shop\n');
  write(join(root, 'pkgs', 'shop', 'migrations', '001.sql'), "-- calls conn.executescript() elsewhere\nCREATE TABLE shop_items (id uuid PRIMARY KEY, order_id uuid REFERENCES shared_orders(id));\nCREATE TABLE shared_orders (id uuid PRIMARY KEY);");
  write(join(root, 'pkgs', 'shop', 'node_modules', 'x', 'index.js'), 'CREATE TABLE vendored (id int);');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const apps: AppRecordLite[] = [];
const appRecord = (name: string, manifestPath: string): AppRecordLite => ({ name, displayName: name, version: '1.0.0', status: 'active', manifestPath, manifest: {} });

describe('declaration scanner and scan roots', () => {
  it('scans core source and each store package, skipping tests, specs and node_modules', async () => {
    apps.push(appRecord('shop', join(root, 'pkgs', 'shop', 'oshal-app.yaml')), appRecord('kernel-app', join(root, 'core', 'swarm-apps', 'kernel-app.yaml')), appRecord('gone', join(root, 'pkgs', 'gone', 'oshal-app.yaml')));
    const roots = await scanRoots(join(root, 'core'), apps);
    expect(roots.map((r) => r.owner)).toEqual([CORE_OWNER, CORE_OWNER, 'shop']);
    const { sites } = await scanDeclarations(roots);
    const names = sites.map((s) => `${s.owner}:${s.kind}:${s.engine}:${s.name}`).sort();
    expect(names).toEqual([
      `${CORE_OWNER}:table:postgres:lazy_table`, `${CORE_OWNER}:table:postgres:shared_orders`, `${CORE_OWNER}:table:postgres:tickets`,
      `${CORE_OWNER}:table:sqlite:entities`, `${CORE_OWNER}:view:postgres:ticket_summary`,
      'shop:table:postgres:shared_orders', 'shop:table:postgres:shop_items',
    ]);
    expect(sites.find((s) => s.name === 'tickets')!.file).toBe('scripts/migrations/001-base.sql');
  });

  it('keeps a .sql migration on Postgres even when its comment names a SQLite API', () => {
    expect(scanText('-- conn.executescript()\nCREATE TABLE x (id int)', 'm/1.sql', 'a')[0].engine).toBe('postgres');
  });
});

describe('ownership attribution and database links', () => {
  let own: ReturnType<typeof attributeOwnership>;
  beforeAll(async () => {
    const { sites } = await scanDeclarations(await scanRoots(join(root, 'core'), apps));
    const catalog: CatalogSnapshot = {
      database: 'oshal',
      tables: [rel('tickets'), rel('shared_orders'), rel('shop_items', { foreignKeys: [{ name: 'fk', columns: ['order_id'], refTable: 'tickets', refColumns: ['id'] }] }), rel('stray')],
      views: [rel('ticket_summary', { kind: 'view', primaryKey: [] })],
    };
    own = attributeOwnership([catalog], sites);
  });

  it('attributes shared, core-only and app-only tables and lists the unowned one', () => {
    const owners = Object.fromEntries(own.tables.map((t) => [t.name, t.owners]));
    expect(owners).toEqual({ tickets: [CORE_OWNER], shared_orders: [CORE_OWNER, 'shop'], shop_items: ['shop'], stray: [] });
    expect(own.unowned).toEqual(['oshal.stray']);
    expect(own.views[0].owners).toEqual([CORE_OWNER]);
    expect(own.tables.find((t) => t.name === 'shared_orders')!.definers).toEqual({ [CORE_OWNER]: ['scripts/migrations/001-base.sql'], shop: ['migrations/001.sql'] });
  });

  it('parses declared-but-absent and SQLite tables per owner', () => {
    expect(own.declaredAbsent.map((t) => `${t.owner}:${t.name}:${t.columns.map((c) => c.name).join(',')}`)).toEqual([`${CORE_OWNER}:lazy_table:id,n`]);
    expect(own.sqlite.map((t) => `${t.owner}:${t.name}:${t.engine}`)).toEqual([`${CORE_OWNER}:entities:sqlite`]);
  });

  it('links owners by shared tables and by foreign keys that cross an owner boundary', () => {
    expect(databaseLinks(own.tables)).toEqual([
      { from: CORE_OWNER, to: 'shop', kind: 'shared-table', label: 'shared_orders' },
      { from: 'shop', to: CORE_OWNER, kind: 'foreign-key', label: 'shop_items → tickets' },
    ]);
  });
});
