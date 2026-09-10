/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guards for the schema-docs generator's pure logic: static DDL parsing (incl. an apostrophe inside a `--` comment, which once made two package tables unparseable), engine detection (a `.sql` migration naming a SQLite API once flipped three real Postgres tables to "undeclared"), RLS row-scope classification from real policy expressions, Mermaid-legal rendering, ownership attribution (a view-backed name is never "absent"; a core page never names a private package), and fail-loud README block replacement.
 */

import { describe, expect, it } from 'vitest';

// The generator is CommonJS so it runs with plain node; load it the same way other specs do.
/* eslint-disable @typescript-eslint/no-require-imports */
const { parseCreateTable } = require('../../scripts/schema-docs/ddl-parse.js');
const { resolveTableName, detectEngine } = require('../../scripts/schema-docs/source-scan.js');
const { classifyPolicy, summarizeRowAccess } = require('../../scripts/schema-docs/row-access.js');
const { mermaidType, mermaidDiagram, replaceBlock, displayDefault } = require('../../scripts/schema-docs/render.js');
const { buildModel, coOwners } = require('../../scripts/schema-docs/model.js');
const { foldCatalog } = require('../../scripts/schema-docs/introspect.js');
/* eslint-enable @typescript-eslint/no-require-imports */

type Rec = Record<string, unknown>;

const table = (name: string, extra: Rec = {}) => ({
  name, comment: null, rls: false, forced: false, policies: [], columns: [{ name: 'id', type: 'uuid', nullable: false, default: null, comment: null }],
  primaryKey: ['id'], foreignKeys: [], uniques: [], hypertable: null, source: 'catalog', ...extra,
});

const site = (tbl: string, repo: string, pkg: string | null, extra: Rec = {}) => ({
  table: tbl, kind: 'table', file: `migrations/${tbl}.sql`, repo, pkg, engine: 'postgres', ddl: '', ...extra,
});

describe('schema-docs: static DDL parser', () => {
  it('reads columns, nullability, defaults, inline and table-level keys', () => {
    const ddl = `CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_sub TEXT NOT NULL,
      book_id UUID REFERENCES books(book_id),
      status TEXT DEFAULT 'open',
      code TEXT,
      UNIQUE (code),
      CONSTRAINT fk_acct FOREIGN KEY (user_sub) REFERENCES accounts (sub)
    )`;
    const t = parseCreateTable('orders', ddl);
    expect(t.columns.map((c: Rec) => c.name)).toEqual(['id', 'user_sub', 'book_id', 'status', 'code']);
    expect(t.primaryKey).toEqual(['id']);
    expect(t.columns.find((c: Rec) => c.name === 'user_sub').nullable).toBe(false);
    expect(t.columns.find((c: Rec) => c.name === 'status').default).toBe("'open'");
    expect(t.uniques).toEqual([['code']]);
    expect(t.foreignKeys).toEqual([
      { name: null, columns: ['book_id'], refTable: 'books', refColumns: ['book_id'] },
      { name: null, columns: ['user_sub'], refTable: 'accounts', refColumns: ['sub'] },
    ]);
    expect(t.source).toBe('parsed');
  });

  it('is not unbalanced by an apostrophe inside a -- comment', () => {
    const ddl = `CREATE TABLE gap_themes (
      key TEXT PRIMARY KEY,
      response TEXT,   -- the user's example, in their words
      status TEXT DEFAULT 'open'
    )`;
    const t = parseCreateTable('gap_themes', ddl);
    expect(t).not.toBeNull();
    expect(t.columns.map((c: Rec) => c.name)).toEqual(['key', 'response', 'status']);
  });

  it('returns null for a truncated statement instead of inventing columns', () => {
    expect(parseCreateTable('x', 'CREATE TABLE x (id int, name text')).toBeNull();
  });
});

describe('schema-docs: source scan', () => {
  it('resolves a ${CONST} table name from a same-file constant', () => {
    const src = "const BRIDGE_TABLE = 'oshal_external_identity_links';\nCREATE TABLE IF NOT EXISTS ${BRIDGE_TABLE} (";
    expect(resolveTableName('${BRIDGE_TABLE}', src)).toBe('oshal_external_identity_links');
    expect(resolveTableName('${MISSING}', src)).toBeNull();
  });

  it('treats a .sql migration as Postgres even when a comment names a SQLite API', () => {
    expect(detectEngine('/p/migrations/099-x.sql', '-- and calls conn.executescript() on first use')).toBe('postgres');
  });

  it('classifies SQLite by driver, and Python as SQLite unless it imports a Postgres driver', () => {
    expect(detectEngine('/p/a.js', "const Database = require('better-sqlite3');")).toBe('sqlite');
    expect(detectEngine('/p/a.ts', "import { Pool } from 'pg';")).toBe('postgres');
    expect(detectEngine('/p/gaps.py', 'from . import config, db\n')).toBe('sqlite');
    expect(detectEngine('/p/store.py', 'import psycopg2\n')).toBe('postgres');
  });
});

describe('schema-docs: RLS row scope comes from the policy expression', () => {
  const owner = "((user_sub = current_setting('oshal.current_sub'::text, true)) OR (current_setting('oshal.is_operator'::text, true) = 'on'::text))";
  it('finds the owner column in the canonical and NULLIF forms', () => {
    expect(classifyPolicy({ name: 'p', command: 'ALL', using: owner, check: null }).owners).toEqual(['user_sub']);
    const nullif = "((current_setting('oshal.is_operator'::text, true) = 'on'::text) OR (owner_sub = NULLIF(current_setting('oshal.current_sub'::text, true), ''::text)))";
    expect(classifyPolicy({ name: 'p', command: 'SELECT', using: nullif, check: null }).owners).toEqual(['owner_sub']);
  });

  it('names helper-function, parent-table, open and operator-only scopes', () => {
    const helper = "((current_setting('oshal.is_operator'::text, true) = 'on'::text) OR oshal_owns_task(task_id))";
    const parent = "((current_setting('oshal.is_operator'::text, true) = 'on'::text) OR (EXISTS ( SELECT 1 FROM dnd_campaigns c WHERE (c.campaign_id = x.campaign_id))))";
    expect(classifyPolicy({ name: 'p', command: 'ALL', using: helper, check: null }).scopes).toEqual(['`oshal_owns_task(task_id)`']);
    expect(classifyPolicy({ name: 'p', command: 'ALL', using: parent, check: null }).scopes).toEqual(['via parent `dnd_campaigns`']);
    expect(classifyPolicy({ name: 'p', command: 'SELECT', using: 'true', check: null }).scopes).toEqual(['SELECT: unrestricted']);
    expect(classifyPolicy({ name: 'p', command: 'ALL', using: "(current_setting('oshal.is_operator'::text, true) = 'on'::text)", check: null }).scopes)
      .toEqual(['all commands: operator only']);
  });

  it('reports forced / enabled / off from the table flags', () => {
    expect(summarizeRowAccess(table('a', { rls: true, forced: true })).state).toBe('forced');
    expect(summarizeRowAccess(table('a', { rls: true })).state).toBe('enabled');
    expect(summarizeRowAccess(table('a')).state).toBe('off');
    expect(summarizeRowAccess(table('a', { source: 'parsed' })).state).toBe('n/a');
  });
});

describe('schema-docs: rendering', () => {
  it('reduces multi-word and array types to Mermaid-legal tokens', () => {
    expect(mermaidType('timestamp with time zone')).toBe('timestamptz');
    expect(mermaidType('character varying(64)')).toBe('varchar');
    expect(mermaidType('text[]')).toBe('text_array');
    expect(mermaidType('numeric(18,6)')).toBe('numeric');
    expect(mermaidType('vector(384)')).toBe('vector');
  });

  it('draws key columns only, with FK cardinality from nullability', () => {
    const child = table('work_items', {
      columns: [
        { name: 'id', type: 'uuid', nullable: false, default: null, comment: null },
        { name: 'ticket_id', type: 'uuid', nullable: false, default: null, comment: null },
        { name: 'parent_id', type: 'uuid', nullable: true, default: null, comment: null },
        { name: 'title', type: 'text', nullable: true, default: null, comment: null },
      ],
      foreignKeys: [
        { name: 'a', columns: ['ticket_id'], refTable: 'tickets', refColumns: ['id'] },
        { name: 'b', columns: ['parent_id'], refTable: 'work_items', refColumns: ['id'] },
      ],
    });
    const out = mermaidDiagram([child]);
    expect(out).toContain('uuid ticket_id FK');
    expect(out).not.toContain('title');
    expect(out).toContain('tickets ||--o{ work_items : "ticket_id"');
    expect(out).toContain('work_items |o--o{ work_items : "parent_id"');
    for (const line of out.split('\n').filter((l) => /^ {4}\S/.test(l))) expect(line.trim().split(' ')[0]).toMatch(/^[A-Za-z0-9_]+$/);
  });

  it('tidies Postgres literal casts in defaults', () => {
    expect(displayDefault("'pending'::text")).toBe("'pending'");
    expect(displayDefault("nextval('t_id_seq'::regclass)")).toBe("nextval('t_id_seq')");
  });

  it('replaces a marked README block and fails loudly when its markers are gone', () => {
    const doc = 'intro\n<!-- schema-docs:begin:x -->\nold\n<!-- schema-docs:end:x -->\noutro';
    expect(replaceBlock(doc, 'x', 'new')).toBe('intro\n<!-- schema-docs:begin:x -->\nnew\n<!-- schema-docs:end:x -->\noutro');
    expect(() => replaceBlock('no markers', 'x', 'new')).toThrow(/markers not found/);
  });
});

describe('schema-docs: ownership model', () => {
  const databases = [{
    name: 'oshal',
    tables: new Map([['tickets', table('tickets')], ['kalshi_orders', table('kalshi_orders')], ['sales_reps', table('sales_reps')], ['stray', table('stray')]]),
    views: new Map([['postings', table('postings')]]),
  }];
  const model = buildModel({
    databases,
    coreSites: [site('tickets', 'core', null), site('kalshi_orders', 'core', null), site('local_users', 'core', null, { ddl: 'CREATE TABLE local_users (sub TEXT PRIMARY KEY)' })],
    storeScan: { packages: new Map([['kalshi', { migrations: [] }], ['career', { migrations: [] }]]), sites: [
      site('kalshi_orders', 'store', 'kalshi'),
      site('postings', 'store', 'career', { kind: 'view' }),
      site('postings', 'store', 'career', { ddl: 'CREATE TABLE postings (id INTEGER PRIMARY KEY)' }),
    ] },
    privateScan: { packages: new Map([['sales', { migrations: [] }]]), sites: [site('sales_reps', 'private', 'sales'), site('tickets', 'private', 'sales')] },
  });

  it('attributes live tables to whoever declares them, including shared ones', () => {
    expect(model.core.live.get('oshal').map((t: Rec) => t.name)).toEqual(['kalshi_orders', 'tickets']);
    const kalshi = model.packages.find((p: Rec) => p.dir === 'kalshi');
    expect(kalshi.view.live.get('oshal').map((t: Rec) => t.name)).toEqual(['kalshi_orders']);
  });

  it('parses declared-but-absent tables, and never calls a view-backed name absent', () => {
    expect(model.core.absent.map((t: Rec) => t.name)).toEqual(['local_users']);
    const career = model.packages.find((p: Rec) => p.dir === 'career');
    expect(career.view.absent).toEqual([]);
    expect(career.view.views.get('oshal').map((v: Rec) => v.name)).toEqual(['postings']);
  });

  it('reports a live table no source declares instead of guessing an owner', () => {
    expect(model.unowned).toEqual(['oshal.stray']);
  });

  it('never lets a core or store page name a private package', () => {
    expect(coOwners(model.byTable, 'tickets', { repo: 'core', pkg: null })).toEqual([]);
    expect(coOwners(model.byTable, 'tickets', { repo: 'private', pkg: 'other' }).map((o: Rec) => o.repo)).toEqual(['core', 'private']);
  });
});

describe('schema-docs: catalog folding', () => {
  it('splits views from tables and attaches keys and policies to the right table', () => {
    const { tables, views } = foldCatalog({
      tables: [{ name: 'a', kind: 'r', rls: true, forced: true }, { name: 'v', kind: 'v', rls: false, forced: false }],
      columns: [{ table: 'a', name: 'id', type: 'uuid', nullable: false }, { table: 'v', name: 'x', type: 'text', nullable: true }],
      constraints: [{ table: 'a', type: 'p', columns: ['id'] }, { table: 'a', type: 'f', name: 'fk', columns: ['id'], refTable: 'b', refColumns: ['id'] }],
      policies: [{ table: 'a', name: 'a_owner_or_operator', command: 'ALL', using: 'true', check: null }],
    });
    expect([...tables.keys()]).toEqual(['a']);
    expect([...views.keys()]).toEqual(['v']);
    expect(tables.get('a').primaryKey).toEqual(['id']);
    expect(tables.get('a').foreignKeys[0].refTable).toBe('b');
    expect(tables.get('a').policies[0].name).toBe('a_owner_or_operator');
    expect(views.get('v').columns[0].name).toBe('x');
  });
});
