import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSchemaReady,
  isRuntimeDdlStatement,
  runRuntimeSchemaBootstrap,
  runtimeSchemaBootstrapEnabled,
  wrapPoolWithRuntimeDdlGuard,
} from '../../src/shared/services/database/schema-bootstrap-policy';
import {
  getRequestIdentity,
  isSystemIdentity,
} from '../../src/shared/services/database/request-identity';

function makePoolForValidation(options: {
  tables?: Record<string, boolean>;
  columns?: Record<string, string[]>;
} = {}) {
  const tables = options.tables || {};
  const columns = options.columns || {};
  return {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      if (text.includes('to_regclass')) {
        const table = String(params?.[0] || '').replace(/^public\./, '');
        return { rows: [{ exists: Boolean(tables[table]) }], rowCount: 1 };
      }
      if (text.includes('information_schema.columns')) {
        const table = String(params?.[1] || '');
        const column = String(params?.[2] || '');
        const exists = (columns[table] || []).includes(column);
        return { rows: exists ? [{ column_name: column }] : [], rowCount: exists ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function withSchemaBootstrap(value: string | undefined, run: () => void | Promise<void>) {
  const previous = process.env.OSHAL_SCHEMA_BOOTSTRAP;
  if (value === undefined) {
    delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
  } else {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = value;
  }
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    else process.env.OSHAL_SCHEMA_BOOTSTRAP = previous;
  });
}

describe('schema bootstrap policy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps runtime schema bootstrap enabled by default for local/dev self-healing', async () => {
    await withSchemaBootstrap(undefined, () => {
      expect(runtimeSchemaBootstrapEnabled()).toBe(true);
    });
  });

  it('treats validate-only as a no-DDL runtime mode', async () => {
    await withSchemaBootstrap('validate-only', () => {
      expect(runtimeSchemaBootstrapEnabled()).toBe(false);
    });
  });

  it('applies statements when runtime bootstrap is enabled', async () => {
    await withSchemaBootstrap(undefined, async () => {
      const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };

      const result = await runRuntimeSchemaBootstrap({
        pool: pool as never,
        moduleName: 'demo',
        statements: ['CREATE TABLE IF NOT EXISTS demo (id TEXT PRIMARY KEY)'],
        requirements: [{ table: 'demo', columns: ['id'] }],
      });

      expect(result).toBe('applied');
      expect(pool.query).toHaveBeenCalledWith('CREATE TABLE IF NOT EXISTS demo (id TEXT PRIMARY KEY)');
    });
  });

  it('validates required tables and columns without applying DDL in validate-only mode', async () => {
    await withSchemaBootstrap('validate-only', async () => {
      const pool = makePoolForValidation({
        tables: { demo: true },
        columns: { demo: ['id', 'owner_sub'] },
      });

      const result = await runRuntimeSchemaBootstrap({
        pool: pool as never,
        moduleName: 'demo',
        statements: ['CREATE TABLE should_not_run'],
        requirements: [{ table: 'demo', columns: ['id', 'owner_sub'] }],
      });

      expect(result).toBe('validated');
      expect(pool.query).not.toHaveBeenCalledWith('CREATE TABLE should_not_run');
      expect(pool.query).toHaveBeenCalledTimes(3);
    });
  });

  it('reports missing schema requirements clearly for hosted app roles', async () => {
    const pool = makePoolForValidation({
      tables: { demo: true },
      columns: { demo: ['id'] },
    });

    await expect(
      assertSchemaReady(pool as never, 'demo', [
        { table: 'demo', columns: ['id', 'owner_sub'] },
        { table: 'missing_table', columns: ['id'] },
      ]),
    ).rejects.toThrow(
      'demo schema is not ready for the runtime DB role: missing demo.owner_sub, missing_table table',
    );
  });

  it('detects schema DDL statements, including commented SQL and query configs', () => {
    expect(isRuntimeDdlStatement('CREATE TABLE demo (id text)')).toBe(true);
    expect(isRuntimeDdlStatement(' /* boot */ ALTER TABLE demo ADD COLUMN owner_sub text')).toBe(true);
    expect(isRuntimeDdlStatement({ text: 'DROP VIEW demo_view' })).toBe(true);
    expect(isRuntimeDdlStatement('SELECT * FROM demo')).toBe(false);
  });

  it('blocks pool-level runtime DDL in validate-only mode while allowing reads', async () => {
    await withSchemaBootstrap('validate-only', async () => {
      const pool = {
        query: vi.fn(async () => ({ rows: [{ ok: true }], rowCount: 1 })),
      };
      const wrapped = wrapPoolWithRuntimeDdlGuard(pool as never);

      await expect((wrapped as { query: (sql: string) => Promise<unknown> }).query('SELECT 1')).resolves.toEqual({
        rows: [{ ok: true }],
        rowCount: 1,
      });
      expect(() =>
        (wrapped as { query: (sql: string) => unknown }).query('CREATE TABLE runtime_leak (id text)'),
      ).toThrow('Runtime schema DDL is disabled by OSHAL_SCHEMA_BOOTSTRAP=validate-only');
    });
  });

  // GUARD (guc deny-by-default, warn-audit site 1): schema/boot DDL runs with no request in
  // scope. It MUST execute under the SYSTEM sentinel so the GUC pool stamps it operator — under
  // OSHAL_DB_GUC_STRICT=deny an identity-less connection is scoped anonymous (RLS zero-rows),
  // which would make validation spuriously report the schema "missing" and starve seed reads.
  // If someone unwraps runRuntimeSchemaBootstrap from runWithSystemIdentity, this goes red.
  it('runs bootstrap under the SYSTEM identity sentinel (deny-safe apply path)', async () => {
    await withSchemaBootstrap(undefined, async () => {
      let seen: ReturnType<typeof getRequestIdentity> | 'never' = 'never';
      const pool = {
        query: vi.fn(async () => {
          seen = getRequestIdentity();
          return { rows: [], rowCount: 0 };
        }),
      };

      await runRuntimeSchemaBootstrap({
        pool: pool as never,
        moduleName: 'demo',
        statements: ['CREATE TABLE IF NOT EXISTS demo (id TEXT PRIMARY KEY)'],
        requirements: [{ table: 'demo', columns: ['id'] }],
      });

      expect(seen).not.toBe('never');
      expect(isSystemIdentity(seen as never)).toBe(true);
    });
  });

  it('runs bootstrap under the SYSTEM identity sentinel (validate-only path)', async () => {
    await withSchemaBootstrap('validate-only', async () => {
      const seen: Array<ReturnType<typeof getRequestIdentity>> = [];
      const pool = makePoolForValidation({ tables: { demo: true }, columns: { demo: ['id'] } });
      const original = pool.query;
      pool.query = vi.fn(async (text: string, params?: unknown[]) => {
        seen.push(getRequestIdentity());
        return original(text, params);
      });

      await runRuntimeSchemaBootstrap({
        pool: pool as never,
        moduleName: 'demo',
        statements: ['CREATE TABLE should_not_run'],
        requirements: [{ table: 'demo', columns: ['id'] }],
      });

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((id) => isSystemIdentity(id as never))).toBe(true);
    });
  });

  it('blocks checked-out client runtime DDL in validate-only mode', async () => {
    await withSchemaBootstrap('validate-only', async () => {
      const client = {
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
        release: vi.fn(),
      };
      const pool = {
        connect: vi.fn(async () => client),
        query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      };
      const wrapped = wrapPoolWithRuntimeDdlGuard(pool as never);
      const checkedOut = await (wrapped as { connect: () => Promise<{ query: (sql: string) => unknown }> }).connect();

      expect(() => checkedOut.query('ALTER TABLE demo ADD COLUMN leak text')).toThrow(
        'Runtime schema DDL is disabled by OSHAL_SCHEMA_BOOTSTRAP=validate-only',
      );
      await expect(Promise.resolve(checkedOut.query('SELECT 1'))).resolves.toEqual({ rows: [], rowCount: 0 });
    });
  });
});
