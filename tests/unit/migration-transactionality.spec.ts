/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for migration transactionality: each migration + its app_migrations history INSERT must run BEGIN/sql/INSERT/COMMIT on ONE client; a mid-sql failure must ROLLBACK and record NO history row and stop the run with the filename in the error; the no-transaction pragma and self-managed BEGIN;/COMMIT; files must skip the runner-owned transaction; already-applied files must be skipped. Plus a static gate over the real scripts/migrations tree: non-transaction-safe statements require the pragma, and only the four known legacy files may self-manage transactions without it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DatabaseBootstrapService,
  NO_TRANSACTION_PRAGMA,
  PRAGMA_SCAN_LINES,
  TOP_LEVEL_TXN_CONTROL,
} from '../../src/features/tool-registry/services/database-bootstrap-service';

interface RecordedQuery {
  source: string;
  text: string;
  params?: unknown[];
}

class FakeClient {
  released = false;

  constructor(
    private readonly log: RecordedQuery[],
    readonly id: string,
    private readonly failOn?: (text: string) => boolean,
  ) {}

  async query(text: string, params?: unknown[]) {
    this.log.push({ source: this.id, text, params });
    if (this.failOn?.(text)) {
      throw new Error('boom: relation "nope" does not exist');
    }
    return { rowCount: 0, rows: [] };
  }

  release() {
    this.released = true;
  }
}

class FakePool {
  log: RecordedQuery[] = [];
  clients: FakeClient[] = [];
  appliedFilenames = new Set<string>();
  failClientOn?: (text: string) => boolean;

  async connect() {
    const client = new FakeClient(this.log, `client-${this.clients.length}`, this.failClientOn);
    this.clients.push(client);
    return client;
  }

  async query(text: string, params?: unknown[]) {
    this.log.push({ source: 'pool', text, params });
    if (text.startsWith('SELECT 1 FROM app_migrations')) {
      const filename = params?.[0] as string;
      return { rowCount: this.appliedFilenames.has(filename) ? 1 : 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}

function makeMigrationsDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-migration-txn-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  savedEnv.RUN_MIGRATIONS = process.env.RUN_MIGRATIONS;
  savedEnv.OSHAL_SCHEMA_BOOTSTRAP = process.env.OSHAL_SCHEMA_BOOTSTRAP;
  process.env.RUN_MIGRATIONS = 'true';
  delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
});

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function trackedDir(files: Record<string, string>): string {
  const dir = makeMigrationsDir(files);
  tempDirs.push(dir);
  return dir;
}

describe('DatabaseBootstrapService migration transactionality', () => {
  it('runs BEGIN, the migration SQL, the history INSERT, and COMMIT in order on the SAME client', async () => {
    const dir = trackedDir({ '001-a.sql': 'CREATE TABLE txn_guard_a (id INT);' });
    const pool = new FakePool();

    const applied = await new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations();

    expect(applied).toEqual(['001-a.sql']);
    expect(pool.clients).toHaveLength(1);
    const clientQueries = pool.log.filter((q) => q.source === 'client-0').map((q) => q.text);
    expect(clientQueries).toEqual([
      'BEGIN',
      'CREATE TABLE txn_guard_a (id INT);',
      'INSERT INTO app_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      'COMMIT',
    ]);
    expect(pool.clients[0].released).toBe(true);
    // The history INSERT must never run pool-level (a different connection breaks atomicity).
    const poolInserts = pool.log.filter((q) => q.source === 'pool' && q.text.includes('INSERT INTO app_migrations'));
    expect(poolInserts).toHaveLength(0);
  });

  it('on mid-sql failure: ROLLBACK on the same client, NO history row, loud filename error, later files not attempted', async () => {
    const dir = trackedDir({
      '001-bad.sql': 'CREATE TABLE txn_guard_bad (id INT);',
      '002-later.sql': 'CREATE TABLE txn_guard_later (id INT);',
    });
    const pool = new FakePool();
    pool.failClientOn = (text) => text.includes('txn_guard_bad');

    await expect(new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations())
      .rejects.toThrow(/001-bad\.sql/);

    const clientQueries = pool.log.filter((q) => q.source === 'client-0').map((q) => q.text);
    expect(clientQueries).toEqual(['BEGIN', 'CREATE TABLE txn_guard_bad (id INT);', 'ROLLBACK']);
    expect(clientQueries).not.toContain('COMMIT');
    const historyInserts = pool.log.filter((q) => q.text.includes('INSERT INTO app_migrations'));
    expect(historyInserts).toHaveLength(0);
    const laterAttempts = pool.log.filter((q) => q.text.includes('txn_guard_later'));
    expect(laterAttempts).toHaveLength(0);
    expect(pool.clients[0].released).toBe(true);
  });

  it('the "-- oshal:no-transaction" pragma skips the runner-owned transaction but still records history', async () => {
    const dir = trackedDir({
      '001-conc.sql': '-- oshal:no-transaction — CREATE INDEX CONCURRENTLY cannot run in a txn block\nCREATE INDEX CONCURRENTLY txn_guard_idx ON txn_guard_a (id);',
    });
    const pool = new FakePool();

    const applied = await new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations();

    expect(applied).toEqual(['001-conc.sql']);
    expect(pool.clients).toHaveLength(0);
    const allTexts = pool.log.map((q) => q.text);
    expect(allTexts).not.toContain('BEGIN');
    expect(allTexts).not.toContain('COMMIT');
    expect(allTexts.some((t) => t.includes('CREATE INDEX CONCURRENTLY'))).toBe(true);
    expect(allTexts.some((t) => t.includes('INSERT INTO app_migrations'))).toBe(true);
  });

  it('accepts the short "-- no-transaction" pragma spelling within the first lines', async () => {
    const dir = trackedDir({
      '001-short.sql': '-- header comment\n-- no-transaction\nVACUUM;',
    });
    const pool = new FakePool();

    const applied = await new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations();

    expect(applied).toEqual(['001-short.sql']);
    expect(pool.clients).toHaveLength(0);
  });

  it('auto-detects self-managed migrations (top-level BEGIN;/COMMIT;) and does not double-wrap them', async () => {
    const dir = trackedDir({
      '001-self.sql': '-- legacy self-wrapping migration\nBEGIN;\nCREATE TABLE txn_guard_self (id INT);\nCOMMIT;\n',
    });
    const pool = new FakePool();

    const applied = await new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations();

    expect(applied).toEqual(['001-self.sql']);
    // No runner-owned client transaction: the file's own BEGIN;/COMMIT; governs.
    expect(pool.clients).toHaveLength(0);
    const bareBegin = pool.log.filter((q) => q.text === 'BEGIN');
    expect(bareBegin).toHaveLength(0);
  });

  it('does NOT mistake plpgsql BEGIN inside DO $$ blocks for transaction control — the file stays wrapped', async () => {
    const sql = 'DO $$\nBEGIN\n  IF NOT EXISTS (SELECT 1) THEN\n    RAISE NOTICE \'x\';\n  END IF;\nEND $$;';
    const dir = trackedDir({ '001-plpgsql.sql': sql });
    const pool = new FakePool();

    const applied = await new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations();

    expect(applied).toEqual(['001-plpgsql.sql']);
    expect(pool.clients).toHaveLength(1);
    const clientQueries = pool.log.filter((q) => q.source === 'client-0').map((q) => q.text);
    expect(clientQueries[0]).toBe('BEGIN');
    expect(clientQueries[clientQueries.length - 1]).toBe('COMMIT');
  });

  it('skips already-applied migrations without executing their SQL', async () => {
    const dir = trackedDir({ '001-done.sql': 'CREATE TABLE txn_guard_done (id INT);' });
    const pool = new FakePool();
    pool.appliedFilenames.add('001-done.sql');

    const applied = await new DatabaseBootstrapService(pool.asPool(), dir).applyMigrations();

    expect(applied).toEqual([]);
    expect(pool.clients).toHaveLength(0);
    const executed = pool.log.filter((q) => q.text.includes('txn_guard_done'));
    expect(executed).toHaveLength(0);
  });
});

describe('scripts/migrations static transaction-safety gate', () => {
  const migrationsDir = path.resolve(__dirname, '../../scripts/migrations');
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  /** Files that historically self-manage transactions with top-level BEGIN;/COMMIT;. */
  const KNOWN_SELF_MANAGED = new Set([
    '060-platform-rls-tenancy.sql',
    '068-visual-response-artifacts.sql',
    '080-data-lifecycle.sql',
    '093-spatial-scans.sql',
  ]);

  const NON_TXN_SAFE = /CREATE\s+INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE|^\s*VACUUM\b|^\s*REINDEX\b|CREATE\s+DATABASE\b|CREATE\s+TABLESPACE\b|ALTER\s+SYSTEM\b/im;

  function hasPragma(sql: string): boolean {
    return sql.split(/\r?\n/, PRAGMA_SCAN_LINES).some((line) => NO_TRANSACTION_PRAGMA.test(line));
  }

  it('finds the migrations tree with at least the known migrations', () => {
    expect(sqlFiles.length).toBeGreaterThanOrEqual(76);
  });

  it('every migration containing a statement that cannot run in a transaction carries the no-transaction pragma', () => {
    const offenders = sqlFiles.filter((file) => {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      return NON_TXN_SAFE.test(sql) && !hasPragma(sql);
    });
    expect(offenders, `Migrations with non-transaction-safe statements MUST carry "-- oshal:no-transaction" in their first ${PRAGMA_SCAN_LINES} lines: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no NEW migration self-manages transactions (top-level BEGIN;/COMMIT;) without the explicit pragma', () => {
    const offenders = sqlFiles.filter((file) => {
      if (KNOWN_SELF_MANAGED.has(file)) {
        return false;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      return TOP_LEVEL_TXN_CONTROL.test(sql) && !hasPragma(sql);
    });
    expect(offenders, `New self-wrapping migrations must declare "-- oshal:no-transaction" instead of relying on auto-detection: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the four known legacy self-managed files still trip auto-detection (so they are never double-wrapped)', () => {
    for (const file of KNOWN_SELF_MANAGED) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      expect(TOP_LEVEL_TXN_CONTROL.test(sql) || hasPragma(sql), `${file} must be detected as self-managed`).toBe(true);
    }
  });
});
