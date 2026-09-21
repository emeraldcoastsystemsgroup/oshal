/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Real-boundary guard for the data-model explorer's catalog read: a DISPOSABLE PostgreSQL 16 container (loopback-only, tmpfs, removed afterwards; deployment databases are never used) holding a FK, a UNIQUE, FORCE RLS with the canonical owner-or-operator policy, an undeclared table and a view. readCatalog must fold what Postgres actually reports, the classifier must read the policy Postgres re-renders, and ownership must flag the undeclared table instead of guessing. Fails loudly when Docker is unavailable - a skipped guard is no guard.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The schema-docs generator no longer carries its own catalog SQL, RLS classifier or DDL parser; it loads the explorer's through scripts/schema-docs/kernel.js. That seam is now crossed here against the SAME real database: the generator's own transport reads this container and must fold to exactly what readCatalog folds, and the markdown it writes into the committed pages must carry the row scope the classifier read from the policy Postgres re-rendered. Mutate the slice's classifier and this case - not just the explorer's - goes red, which is the whole point of there being one implementation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CORE_OWNER, attributeOwnership, readCatalog, scanText, summarizeRowAccess, type CatalogSnapshot } from '@/features/data-model';

// The schema-docs generator, loaded as CommonJS exactly as `node scripts/generate-schema-docs.js`
// loads it - not through vitest's module graph - so this exercises the real path into the slice.
/* eslint-disable @typescript-eslint/no-require-imports */
const genIntrospect = require('../../scripts/schema-docs/introspect.js');
const genRender = require('../../scripts/schema-docs/render.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const MIGRATION = `
CREATE TABLE owners (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_sub text NOT NULL);
COMMENT ON TABLE owners IS 'people who own rows';
CREATE TABLE child (id serial PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), code text UNIQUE);
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners FORCE ROW LEVEL SECURITY;
CREATE POLICY owners_owner_or_operator ON owners
  USING (user_sub = current_setting('oshal.current_sub', true) OR current_setting('oshal.is_operator', true) = 'on');
CREATE VIEW owner_counts AS SELECT owner_id, count(*) AS n FROM child GROUP BY owner_id;
`;

const container = `oshal-data-model-fixture-${randomUUID()}`;
let pool: Pool | undefined;
let started = false;
let catalog: CatalogSnapshot;
/** Connection URL for the disposable fixture. Carries the generated password, so it is never logged. */
let fixtureUrl = '';

/** Docker with fixed arguments; generated fixture credentials are never echoed on failure. */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
}

beforeAll(async () => {
  const password = randomUUID();
  try {
    docker(['run', '--detach', '--rm', '--name', container, '--label', 'oshal.test-fixture=data-model-postgres', '--publish', '127.0.0.1::5432',
      '--tmpfs', '/var/lib/postgresql/data', '--memory', '256m', '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=data_model_fixture', 'postgres:16-alpine']);
    started = true;
    const port = Number(/:(\d+)$/.exec(docker(['port', container, '5432/tcp']))?.[1]);
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'data_model_fixture', max: 2, connectionTimeoutMillis: 1000 });
    fixtureUrl = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/data_model_fixture`;
    for (let attempt = 0; attempt < 300; attempt += 1) { // up to 60 s: a loaded Docker VM starts slowly
      try { await pool.query('SELECT 1'); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    await pool.query(MIGRATION);
    await pool.query('CREATE TABLE stray (id int)');
    catalog = await readCatalog(pool, 'data_model_fixture');
  } catch (error) {
    // The fixture password is redacted from the cause (Docker echoes argv on failure).
    const cause = (error instanceof Error ? error.message : String(error)).split(password).join('<redacted>').slice(0, 400);
    throw new Error(`Disposable PostgreSQL fixture failed: ${cause}. Docker with postgres:16-alpine is required; deployment databases are never used.`);
  }
}, 180_000);

afterAll(async () => {
  try { await pool?.end(); } finally { if (started) docker(['rm', '--force', container]); }
});

describe('data-model catalog against a real PostgreSQL', () => {
  it('reports tables and views as Postgres holds them', () => {
    expect(catalog.tables.map((t) => t.name)).toEqual(['child', 'owners', 'stray']);
    expect(catalog.views.map((v) => v.name)).toEqual(['owner_counts']);
    expect(catalog.views[0].columns.map((c) => c.name)).toEqual(['owner_id', 'n']);
  });

  it('folds keys, defaults and comments from the real catalog', () => {
    const child = catalog.tables.find((t) => t.name === 'child')!;
    expect(child.primaryKey).toEqual(['id']);
    expect(child.foreignKeys).toMatchObject([{ columns: ['owner_id'], refTable: 'owners', refColumns: ['id'] }]);
    expect(child.uniques).toEqual([['code']]);
    expect(child.columns.find((c) => c.name === 'id')!.default).toContain('nextval');
    expect(catalog.tables.find((t) => t.name === 'owners')!.comment).toBe('people who own rows');
  });

  it('classifies the policy exactly as Postgres re-renders it', () => {
    const owners = catalog.tables.find((t) => t.name === 'owners')!;
    expect(summarizeRowAccess(owners)).toEqual({ state: 'forced', scopes: ['owner `user_sub`'], ownerColumns: ['user_sub'] });
    expect(summarizeRowAccess(catalog.tables.find((t) => t.name === 'child')!).state).toBe('off');
  });

  it('attributes declared relations and reports the undeclared one', () => {
    const own = attributeOwnership([catalog], scanText(MIGRATION, 'migrations/001.sql', CORE_OWNER));
    expect(own.tables.find((t) => t.name === 'child')!.owners).toEqual([CORE_OWNER]);
    expect(own.views[0].owners).toEqual([CORE_OWNER]);
    expect(own.unowned).toEqual(['data_model_fixture.stray']);
  });
});

describe('the schema-docs generator reads the same database through the same implementation', () => {
  /**
   * @description The generator's own read of the fixture, over its connection-URL transport. The
   * URL carries the generated password, so a failure is re-thrown with it removed.
   * @returns the generator's by-name relation maps
   */
  async function generatorRead(): Promise<{ tables: Map<string, any>; views: Map<string, any> }> {
    try {
      return await genIntrospect.introspectDatabase({ url: fixtureUrl, database: 'data_model_fixture' });
    } catch (error) {
      const cause = (error instanceof Error ? error.message : String(error)).split(fixtureUrl).join('<redacted>').slice(0, 400);
      throw new Error(`The schema-docs generator could not read the disposable fixture: ${cause}`);
    }
  }

  it('folds the live catalog into exactly the relations the explorer folds', async () => {
    const generated = await generatorRead();
    expect([...generated.tables.keys()]).toEqual(catalog.tables.map((t) => t.name));
    expect([...generated.views.keys()]).toEqual(catalog.views.map((v) => v.name));
    for (const rel of [...catalog.tables, ...catalog.views]) {
      expect(generated.tables.get(rel.name) ?? generated.views.get(rel.name), rel.name).toEqual(rel);
    }
  });

  it('writes the row scope the classifier read from the policy Postgres re-rendered', async () => {
    const generated = await generatorRead();
    const ctx = { linkFor: (t: string, c: string) => `${t}.${c}`, definersOf: () => [], noteFor: null };
    const owners = genRender.tableSection(generated.tables.get('owners'), ctx) as string;
    expect(owners).toContain('RLS **forced** - owner `user_sub`');
    expect(summarizeRowAccess(generated.tables.get('owners')).ownerColumns).toEqual(['user_sub']);
    expect(genRender.tableSection(generated.tables.get('child'), ctx) as string).toContain('RLS **off**');
  });
});
