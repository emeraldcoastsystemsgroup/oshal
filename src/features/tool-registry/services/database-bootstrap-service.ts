/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of SQL migration bootstrap service for tool registry dependencies
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | TD-7: Add RUN_MIGRATIONS env guard to prevent race condition in multi-container deployments
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Wrap each migration + its app_migrations history INSERT in ONE transaction on ONE pooled client (BEGIN/COMMIT/ROLLBACK) so a crash or history-INSERT failure can no longer leave an applied-but-unrecorded migration that re-runs on next boot. Add the "-- oshal:no-transaction" pragma escape hatch (first 10 lines) for future CONCURRENTLY/VACUUM-class migrations, auto-detect files that self-manage transactions with top-level BEGIN;/COMMIT; (060/068/080/093) so the wrapper never double-wraps them, fail loud with the filename on any migration error, and accept an optional migrationsDir constructor override for testability.
 */

import fs from 'fs';
import path from 'path';
import { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runtimeSchemaBootstrapEnabled } from '@/shared/services/database';

const logger = createChildLogger({ module: 'database-bootstrap-service' });

/**
 * @description Pragma marking a migration as self-managed: the runner will NOT
 * wrap it in a transaction. Required for statements that cannot run inside a
 * transaction block (CREATE INDEX CONCURRENTLY, VACUUM, REINDEX, ...). Accepts
 * both the canonical "-- oshal:no-transaction" and the short "-- no-transaction".
 */
export const NO_TRANSACTION_PRAGMA = /^--\s*(?:oshal:)?no-transaction\b/;

/**
 * @description How many leading lines of a migration file are scanned for the
 * no-transaction pragma.
 */
export const PRAGMA_SCAN_LINES = 10;

/**
 * @description Detects top-level transaction control (BEGIN; / COMMIT; at line
 * start) in a migration file. Deliberately requires the trailing semicolon so
 * plpgsql `BEGIN ... END` blocks inside DO $$ bodies never match.
 */
export const TOP_LEVEL_TXN_CONTROL = /^\s*(?:BEGIN|COMMIT)\s*;/im;

const HISTORY_INSERT_SQL =
  'INSERT INTO app_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING';

/**
 * @description Applies checked-in SQL migrations needed by the tool registry stack.
 * Each migration and its app_migrations history row commit atomically on one
 * pooled client unless the file opts out (pragma or self-managed BEGIN;/COMMIT;).
 */
export class DatabaseBootstrapService {
  private readonly pool: Pool;
  private readonly migrationsDirOverride?: string;

  /**
   * @description Create the bootstrap service.
   *
   * @param pool - Postgres pool used for migration execution and history bookkeeping
   * @param migrationsDir - Optional explicit migrations directory (tests / non-standard layouts); defaults to the repository scripts/migrations tree
   */
  constructor(pool: Pool, migrationsDir?: string) {
    this.pool = pool;
    this.migrationsDirOverride = migrationsDir;
  }

  /**
   * @description Run all SQL migrations from the repository migrations directory.
   * Stops at the first failure (the failed file's transaction is rolled back and
   * no history row is written for it), so partial state cannot be recorded.
   *
   * @returns Ordered list of migration filenames that were executed
   */
  async applyMigrations(): Promise<string[]> {
    if (process.env.RUN_MIGRATIONS !== 'true') {
      logger.info('RUN_MIGRATIONS is not "true" — skipping SQL migrations for this container');
      return [];
    }

    if (!runtimeSchemaBootstrapEnabled()) {
      logger.info('OSHAL_SCHEMA_BOOTSTRAP is validate-only; skipping SQL migrations for this app-role runtime');
      return [];
    }

    const migrationsDir = this.resolveMigrationsDir();
    const filenames = fs.readdirSync(migrationsDir)
      .filter((entry) => entry.endsWith('.sql'))
      .sort();
    const applied: string[] = [];

    await this.pool.query('SELECT 1');
    await this.ensureMigrationTable();

    for (const filename of filenames) {
      if (await this.isMigrationApplied(filename)) {
        logger.debug({ filename }, 'Skipping previously applied SQL migration');
        continue;
      }

      const absolutePath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(absolutePath, 'utf8');
      logger.info({ filename, absolutePath }, 'Applying SQL migration');

      if (this.isSelfManaged(sql, filename)) {
        await this.applySelfManaged(filename, sql);
      } else {
        await this.applyTransactional(filename, sql);
      }
      applied.push(filename);
    }

    logger.info({ count: applied.length, migrationsDir }, 'SQL migrations applied successfully');
    return applied;
  }

  /**
   * @description True when the migration must NOT be wrapped in a runner-owned
   * transaction: either it carries the no-transaction pragma in its first
   * {@link PRAGMA_SCAN_LINES} lines, or it self-manages transactions with
   * top-level BEGIN;/COMMIT; (an outer wrapper would be silently terminated by
   * the file's own COMMIT, breaking atomicity without any error).
   *
   * @param sql - Full migration file content
   * @param filename - Migration filename, for logging only
   * @returns Whether the runner should skip its own BEGIN/COMMIT for this file
   */
  private isSelfManaged(sql: string, filename: string): boolean {
    const leadingLines = sql.split(/\r?\n/, PRAGMA_SCAN_LINES);
    if (leadingLines.some((line) => NO_TRANSACTION_PRAGMA.test(line))) {
      logger.info({ filename }, 'Migration carries the no-transaction pragma — running without a runner-owned transaction');
      return true;
    }
    if (TOP_LEVEL_TXN_CONTROL.test(sql)) {
      logger.warn(
        { filename },
        'Migration self-manages transactions (top-level BEGIN;/COMMIT;) — running without a runner-owned transaction. Prefer the "-- oshal:no-transaction" pragma to make this explicit.',
      );
      return true;
    }
    return false;
  }

  /**
   * @description Apply one migration atomically: BEGIN, the migration SQL, the
   * app_migrations history INSERT, COMMIT — all on ONE pooled client. On any
   * failure the transaction is rolled back (no partial schema, no history row)
   * and the error is rethrown with the filename in the message.
   *
   * @param filename - Migration filename (history key + error context)
   * @param sql - Full migration file content
   */
  private async applyTransactional(filename: string, sql: string): Promise<void> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(HISTORY_INSERT_SQL, [filename]);
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr, filename }, 'ROLLBACK failed after migration error');
      }
      throw this.migrationFailure(filename, err, 'rolled back');
    } finally {
      client.release();
    }
  }

  /**
   * @description Apply a self-managed / no-transaction migration exactly as the
   * legacy runner did: execute the file, then record history, without a
   * runner-owned transaction (required for CONCURRENTLY/VACUUM-class statements
   * and files that BEGIN;/COMMIT; themselves). Failures still stop the run loud
   * with the filename in the message.
   *
   * @param filename - Migration filename (history key + error context)
   * @param sql - Full migration file content
   */
  private async applySelfManaged(filename: string, sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
      await this.pool.query(HISTORY_INSERT_SQL, [filename]);
    } catch (err) {
      throw this.migrationFailure(filename, err, 'NOT wrapped in a runner transaction — inspect for partial state');
    }
  }

  /**
   * @description Build the loud, filename-bearing error for a failed migration,
   * logging it at ERROR with the original cause attached.
   *
   * @param filename - The migration file that failed
   * @param err - The underlying error
   * @param disposition - Human-readable note on the transaction outcome
   * @returns The error to throw (original error preserved on `cause`)
   */
  private migrationFailure(filename: string, err: unknown, disposition: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, filename }, `SQL migration failed (${disposition}): ${filename}`);
    return new Error(`SQL migration "${filename}" failed (${disposition}): ${message}`, { cause: err });
  }

  /**
   * @description Resolve the migration directory in both source and built layouts.
   */
  private resolveMigrationsDir(): string {
    const candidates = this.migrationsDirOverride
      ? [this.migrationsDirOverride]
      : [
        path.resolve(process.cwd(), 'scripts/migrations'),
        path.resolve(__dirname, '../../../../scripts/migrations'),
      ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(`SQL migrations directory not found. Checked: ${candidates.join(', ')}`);
  }

  /**
   * @description Ensure the migration history table exists.
   */
  private async ensureMigrationTable(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  /**
   * @description Check whether a migration filename has already been applied.
   */
  private async isMigrationApplied(filename: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM app_migrations WHERE filename = $1 LIMIT 1',
      [filename],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
