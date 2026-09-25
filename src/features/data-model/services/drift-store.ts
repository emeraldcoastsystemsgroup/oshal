/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Durable memory for the schema digest: read the latest digest for a database, record a new one, and read the recent history. Two things are deliberate. (1) The store answers `unavailable` rather than throwing when migration 139 has not been applied, because the explorer must keep rendering on a deployment that has not taken the table - a drift panel that 500s is worse than one that says why it is empty. (2) A recorded digest carries the migration count with it, so the differ can tell a migrated change from an unexplained one without re-reading the ledger.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Refresh the stored JSON and migration metadata together with capture time when acknowledging a previously seen shape.
 */

import { createChildLogger } from '@/shared/logger';
import type { SchemaDigest } from './schema-digest';

/**
 * The narrow database surface the digest store needs: parameterised statements. Kept separate
 * from CatalogQueryable because the catalog reader issues no parameters, and a store that writes
 * must never be handed something that silently ignores its bindings.
 */
export interface DigestQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const logger = createChildLogger({ module: 'data-model-drift-store' });

/** The table migration 139 creates. Named once, so the degraded message can quote it. */
export const DIGEST_TABLE = 'oshal_schema_digest';

/** PostgreSQL's `undefined_table`, the only error the store degrades on rather than raising. */
const UNDEFINED_TABLE = '42P01';

/** How many digests a history read returns by default - enough for a week of hourly captures. */
export const DEFAULT_HISTORY_LIMIT = 20;

/** What the store can do, so the service can be driven with a double in tests. */
export interface DriftStore {
  latest(database: string): Promise<SchemaDigest | null>;
  record(digest: SchemaDigest): Promise<void>;
  recent(database: string, limit?: number): Promise<SchemaDigest[]>;
  /** Null while the store works; a sentence naming the missing migration when it does not. */
  unavailableReason(): string | null;
}

/**
 * @description Whether an error is PostgreSQL telling us the digest table does not exist. Any
 * other failure is a real fault and is re-thrown: silently treating a permission error as
 * "no history" would make drift detection quietly stop working.
 * @param err - the caught error
 * @returns true for undefined_table
 */
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

/**
 * @description Turn a stored row into a digest, refusing anything that is not the shape this
 * build compares. A corrupt row must not become a baseline.
 * @param row - the row as pg returned it
 * @returns the digest, or null when the row is unusable
 */
function rowToDigest(row: Record<string, unknown>): SchemaDigest | null {
  const digest = row.digest as SchemaDigest | undefined;
  if (!digest || typeof digest !== 'object' || !Array.isArray(digest.relations)) {
    logger.error({ capturedAt: row.captured_at }, 'data-model drift: stored digest row has no relations[]; ignoring it');
    return null;
  }
  return digest;
}

/**
 * @description Create the digest store over the platform pool.
 * @param db - the platform pool or client (the caller has already scoped it)
 * @returns the store
 */
export function createDriftStore(db: DigestQueryable): DriftStore {
  let missing = false;

  /**
   * @description Run one statement, marking the store unavailable when the table is absent.
   * @param sql - the statement
   * @param params - bound parameters
   * @returns the rows, or null when the table does not exist
   */
  async function run(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>> | null> {
    try {
      const res = await db.query(sql, params);
      missing = false;
      return res.rows as Array<Record<string, unknown>>;
    } catch (err) {
      if (isMissingTable(err)) {
        missing = true;
        logger.error({ err, table: DIGEST_TABLE }, 'data-model drift: the digest table is absent; migration 139 has not been applied on this deployment');
        return null;
      }
      logger.error({ err, table: DIGEST_TABLE }, 'data-model drift: digest store query failed');
      throw err;
    }
  }

  return {
    unavailableReason: () => (missing ? `Schema-drift history needs migration 139 (${DIGEST_TABLE}); it has not been applied on this deployment.` : null),

    async latest(database: string): Promise<SchemaDigest | null> {
      const rows = await run(`SELECT captured_at, digest FROM ${DIGEST_TABLE} WHERE database = $1 ORDER BY captured_at DESC, id DESC LIMIT 1`, [database]);
      if (!rows || rows.length === 0) return null;
      return rowToDigest(rows[0]);
    },

    async record(digest: SchemaDigest): Promise<void> {
      await run(
        `INSERT INTO ${DIGEST_TABLE} (database, captured_at, digest_version, fingerprint, relation_count, migration_count, digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (database, fingerprint) DO UPDATE SET captured_at = EXCLUDED.captured_at,
           digest_version = EXCLUDED.digest_version, relation_count = EXCLUDED.relation_count,
           migration_count = EXCLUDED.migration_count, digest = EXCLUDED.digest`,
        [digest.database, digest.capturedAt, digest.digestVersion, digest.fingerprint, digest.relations.length, digest.migrationCount, JSON.stringify(digest)],
      );
      logger.info({ database: digest.database, fingerprint: digest.fingerprint.slice(0, 12), relations: digest.relations.length }, 'data-model drift: digest recorded');
    },

    async recent(database: string, limit = DEFAULT_HISTORY_LIMIT): Promise<SchemaDigest[]> {
      const rows = await run(`SELECT captured_at, digest FROM ${DIGEST_TABLE} WHERE database = $1 ORDER BY captured_at DESC, id DESC LIMIT $2`, [database, Math.max(1, Math.min(200, limit))]);
      if (!rows) return [];
      return rows.map(rowToDigest).filter((d): d is SchemaDigest => d !== null);
    },
  };
}
