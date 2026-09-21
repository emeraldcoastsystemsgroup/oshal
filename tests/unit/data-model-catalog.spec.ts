/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Data-model explorer catalog guards: the fold (tables vs views, constraints only on tables, policies, hypertables) and PARITY with the schema-docs generator - identical catalog SQL, identical folded relations, identical RLS row-scope answers, identical parsed DDL - so the explorer and the generated docs can never describe the same database differently.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Parity is the wrong shape once there is nothing to compare: the generator's CommonJS copies of the catalog SQL, the RLS classifier and the DDL parser are gone and it loads the slice through scripts/schema-docs/kernel.js. These cases now hold the seam that replaced them - each piece has exactly ONE definition site, no copy may reappear under scripts/schema-docs/, every consumer reaches the bridge, and the bridge resolves to this slice - and keep asserting the generator's answers, which is now a statement about the shape adapter rather than a second implementation.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { CATALOG_SQL, HYPERTABLE_SQL, classifyPolicy, foldCatalog, parseCreateTable, summarizeRowAccess } from '@/features/data-model';

// Loaded exactly as the generator loads them - CommonJS, outside vitest's module graph - so these
// cases exercise the real path `node scripts/generate-schema-docs.js` takes into the slice.
/* eslint-disable @typescript-eslint/no-require-imports */
const genIntrospect = require('../../scripts/schema-docs/introspect.js');
const genKernel = require('../../scripts/schema-docs/kernel.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const RAW = {
  tables: [
    { name: 'owners', kind: 'r', comment: 'people', rls: true, forced: true },
    { name: 'child', kind: 'r', comment: null, rls: false, forced: false },
    { name: 'owner_counts', kind: 'v', comment: null, rls: false, forced: false },
    { name: 'metrics', kind: 'r', comment: null, rls: false, forced: false },
  ],
  columns: [
    { table: 'owners', name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', comment: null },
    { table: 'owners', name: 'user_sub', type: 'text', nullable: false, default: null, comment: 'the owner' },
    { table: 'child', name: 'id', type: 'integer', nullable: false, default: "nextval('child_id_seq'::regclass)", comment: null },
    { table: 'child', name: 'owner_id', type: 'uuid', nullable: false, default: null, comment: null },
    { table: 'owner_counts', name: 'n', type: 'bigint', nullable: true, default: null, comment: null },
    { table: 'metrics', name: 'ts', type: 'timestamp with time zone', nullable: false, default: null, comment: null },
  ],
  constraints: [
    { table: 'owners', type: 'p', name: 'owners_pkey', columns: ['id'], refTable: null, refColumns: null },
    { table: 'child', type: 'p', name: 'child_pkey', columns: ['id'], refTable: null, refColumns: null },
    { table: 'child', type: 'f', name: 'child_owner_fk', columns: ['owner_id'], refTable: 'owners', refColumns: ['id'] },
    { table: 'child', type: 'u', name: 'child_owner_key', columns: ['owner_id'], refTable: null, refColumns: null },
  ],
  policies: [
    { table: 'owners', name: 'owners_owner_or_operator', command: 'ALL', using: "((user_sub = current_setting('oshal.current_sub'::text, true)) OR (current_setting('oshal.is_operator'::text, true) = 'on'::text))", check: null },
  ],
  timescale: true,
};
const HYPER = [{ table: 'metrics', timeColumn: 'ts' }];
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('data-model catalog fold', () => {
  const cat = foldCatalog('fixture', RAW, HYPER);

  it('splits views from tables and sorts by name', () => {
    expect(cat.tables.map((t) => t.name)).toEqual(['child', 'metrics', 'owners']);
    expect(cat.views.map((v) => v.name)).toEqual(['owner_counts']);
    expect(cat.views[0].kind).toBe('view');
  });

  it('attaches keys, policies and hypertables to the right table', () => {
    const child = cat.tables.find((t) => t.name === 'child')!;
    expect(child.primaryKey).toEqual(['id']);
    expect(child.foreignKeys).toEqual([{ name: 'child_owner_fk', columns: ['owner_id'], refTable: 'owners', refColumns: ['id'] }]);
    expect(child.uniques).toEqual([['owner_id']]);
    expect(cat.tables.find((t) => t.name === 'owners')!.policies[0].name).toBe('owners_owner_or_operator');
    expect(cat.tables.find((t) => t.name === 'metrics')!.hypertable).toEqual({ timeColumn: 'ts' });
  });

  it('summarises RLS from the policy expression, not the column names', () => {
    const owners = cat.tables.find((t) => t.name === 'owners')!;
    expect(summarizeRowAccess(owners)).toEqual({ state: 'forced', scopes: ['owner `user_sub`'], ownerColumns: ['user_sub'] });
    expect(summarizeRowAccess(cat.tables.find((t) => t.name === 'child')!).state).toBe('off');
  });
});

describe('one implementation behind the docs generator and the surface', () => {
  const REPO = resolve(__dirname, '../..');
  const SCOPE = ['scripts/schema-docs', 'src/features/data-model'];

  /**
   * @description Every source file the generator or the slice is allowed to keep one of these
   * pieces in. Walked rather than globbed so a file added in a new subdirectory is still seen.
   * @param dir - directory to walk, relative to the repo root
   * @returns repo-relative paths of its .js/.ts files
   */
  const filesUnder = (dir: string): string[] => readdirSync(resolve(REPO, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(`${dir}/${e.name}`) : /\.(ts|js|cjs|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : []));

  const scoped = SCOPE.flatMap(filesUnder);
  const holders = (marker: string) => scoped.filter((f) => readFileSync(resolve(REPO, f), 'utf8').includes(marker));

  it.each([
    ['the catalog SQL', 'timescaledb_information', 'src/features/data-model/services/catalog-reader.ts'],
    ['the catalog SQL', 'relrowsecurity', 'src/features/data-model/services/catalog-reader.ts'],
    ['the RLS row-scope classifier', 'OPERATOR_ONLY_RE', 'src/features/data-model/services/row-access.ts'],
    ['the RLS row-scope classifier', 'OWNER_RE', 'src/features/data-model/services/row-access.ts'],
    ['the RLS row-scope classifier', 'HELPER_RE', 'src/features/data-model/services/row-access.ts'],
    ['the static DDL parser', 'COLUMN_STOP', 'src/features/data-model/services/ddl-parser.ts'],
  ])('keeps %s in one file only (%s)', (_piece, marker, owner) => {
    expect(holders(marker)).toEqual([owner]);
  });

  it('leaves no CommonJS copy of any piece under scripts/schema-docs', () => {
    for (const gone of ['scripts/schema-docs/row-access.js', 'scripts/schema-docs/ddl-parse.js']) {
      expect(existsSync(resolve(REPO, gone)), gone).toBe(false);
    }
    const bridge = scoped.filter((f) => f.startsWith('scripts/schema-docs/') && /require\('\.\/(row-access|ddl-parse)'\)/.test(readFileSync(resolve(REPO, f), 'utf8')));
    expect(bridge).toEqual([]);
  });

  it('reaches the slice through the one bridge, and the bridge loads the slice itself', () => {
    for (const consumer of ['introspect.js', 'model.js', 'pages.js', 'render.js']) {
      const text = readFileSync(resolve(REPO, 'scripts/schema-docs', consumer), 'utf8');
      expect(text, consumer).toContain("require('./kernel')");
    }
    expect(resolve(genKernel.SLICE_PATH)).toBe(resolve(REPO, 'src/features/data-model/index.ts'));
  });

  it('issues byte-for-byte the same catalog and hypertable SQL the generator sends', () => {
    expect(norm(CATALOG_SQL)).toBe(norm(genKernel.CATALOG_SQL));
    expect(norm(HYPERTABLE_SQL)).toBe(norm(genKernel.HYPERTABLE_SQL));
    expect(norm(genIntrospect.CATALOG_SQL)).toBe(norm(CATALOG_SQL));
  });

  it('folds the same raw catalog into the same relations, keyed by name for the generator', () => {
    const mine = foldCatalog('fixture', RAW, HYPER);
    const theirs = genIntrospect.foldCatalog(RAW, HYPER);
    for (const t of [...mine.tables, ...mine.views]) {
      const g = theirs.tables.get(t.name) || theirs.views.get(t.name);
      expect(g, t.name).toBeTruthy();
      const pick = (r: any) => ({ columns: r.columns, primaryKey: r.primaryKey, foreignKeys: r.foreignKeys, uniques: r.uniques, rls: r.rls, forced: r.forced, hypertable: r.hypertable, policies: r.policies });
      expect(pick(t)).toEqual(pick(g));
    }
    expect([...theirs.tables.keys()]).toEqual(mine.tables.map((t) => t.name));
    expect([...theirs.views.keys()]).toEqual(mine.views.map((v) => v.name));
  });

  it('classifies every policy shape exactly as the generator does', () => {
    const shapes = [
      "((user_sub = current_setting('oshal.current_sub'::text, true)) OR (current_setting('oshal.is_operator'::text, true) = 'on'::text))",
      "((current_setting('oshal.is_operator'::text, true) = 'on'::text) OR (owner_sub = NULLIF(current_setting('oshal.current_sub'::text, true), ''::text)))",
      "((current_setting('oshal.is_operator'::text, true) = 'on'::text) OR oshal_owns_task(task_id))",
      "((current_setting('oshal.is_operator'::text, true) = 'on'::text) OR (EXISTS ( SELECT 1 FROM dnd_campaigns c WHERE (c.campaign_id = x.campaign_id))))",
      'true',
      "(current_setting('oshal.is_operator'::text, true) = 'on'::text)",
      "(tenant_id = 'x')",
    ];
    for (const using of shapes) {
      const policy = { name: 'p', command: 'SELECT', using, check: null };
      expect(classifyPolicy(policy), using).toEqual(genKernel.classifyPolicy(policy));
    }
  });

  it('parses DDL exactly as the generator does, including an apostrophe in a comment', () => {
    const statements = [
      "CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_sub TEXT NOT NULL, book_id UUID REFERENCES books(book_id), status TEXT DEFAULT 'open', code TEXT, UNIQUE (code), CONSTRAINT f FOREIGN KEY (user_sub) REFERENCES accounts (sub))",
      "CREATE TABLE gap_themes (\n key TEXT PRIMARY KEY,\n response TEXT, -- the user's words\n n INTEGER DEFAULT 0\n)",
      'CREATE TABLE t (a INTEGER, b TEXT, PRIMARY KEY (a, b))',
    ];
    for (const ddl of statements) {
      const mine = parseCreateTable('x', ddl)!;
      const theirs = genKernel.parseCreateTable('x', ddl);
      expect({ columns: mine.columns, primaryKey: mine.primaryKey, foreignKeys: mine.foreignKeys, uniques: mine.uniques })
        .toEqual({ columns: theirs.columns, primaryKey: theirs.primaryKey, foreignKeys: theirs.foreignKeys, uniques: theirs.uniques });
    }
  });
});
