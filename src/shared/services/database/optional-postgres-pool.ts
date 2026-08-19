/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of optional Postgres pool factory for persistence-capable stores
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Share the bounded pool-size parser, add application_name observability, and let direct URLs own their TLS object so verify-full/sslrootcert cannot be overridden by a synthesized boolean.
 */

import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { gucEnabled, wrapPoolWithGuc } from './guc-pool';
import { wrapPoolWithRuntimeDdlGuard } from './schema-bootstrap-policy';
import { postgresApplicationName, resolvePoolMax } from './pool-sizing';

const logger = createChildLogger({ module: 'optional-postgres-pool' });

/**
 * @description Creates a Postgres connection pool when runtime configuration exists.
 * Returns null when no Postgres configuration is present so callers can use fallback storage.
 *
 * @param owner - Logical owner/module using the pool for log context
 * @returns Postgres pool when configured; otherwise null
 */
export function createOptionalPostgresPool(owner: string): Pool | null {
  if (!hasPostgresConfiguration()) {
    logger.info({ owner }, 'Postgres configuration not found; using fallback storage');
    return null;
  }

  const poolConfig = buildPoolConfig(owner);
  logger.info(
    { owner, hasConnectionString: Boolean(poolConfig.connectionString), gucEnabled: gucEnabled() },
    'Creating Postgres pool',
  );
  const pool = new Pool(poolConfig);
  const scopedPool = gucEnabled() ? wrapPoolWithGuc(pool) : pool;
  return wrapPoolWithRuntimeDdlGuard(scopedPool);
}

/**
 * @description Detect whether environment variables include enough Postgres config to attempt a connection.
 *
 * @returns True when Postgres connection details are available
 */
/**
 * @description Resolve the connection-pool ceiling. This is the application's request queue —
 * beyond it, callers wait. Override with PGPOOL_MAX when a deployment is unusually concurrent
 * or is sharing one Postgres between many services.
 * @returns Pool size, bounded to a sane range.
 */
function poolMax(): number {
  return resolvePoolMax(process.env.PGPOOL_MAX, 20, 2);
}

export function hasPostgresConfiguration(): boolean {
  const directUrl = process.env.DATABASE_URL;
  if (typeof directUrl === 'string' && directUrl.trim().length > 0) {
    return true;
  }

  const host = process.env.PGHOST || process.env.POSTGRES_HOST;
  return typeof host === 'string' && host.trim().length > 0;
}

/**
 * @description Build pg.Pool constructor configuration from environment variables.
 *
 * @returns Pool configuration object
 */
function buildPoolConfig(owner: string): {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
  statement_timeout?: number;
  query_timeout?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  application_name?: string;
} {
  // Bound every connection so a hung query/connect can't pin a pool client indefinitely. statement_/
  // query_timeout cap a single statement; idleTimeoutMillis reaps idle clients; connectionTimeoutMillis
  // fails fast when Postgres is unreachable. Role-level statement_timeout is applied separately.
  const timeouts = {
    statement_timeout: 30000,
    query_timeout: 30000,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // The pool IS the request queue: past `max`, callers wait for a client rather than opening
    // another connection. node-postgres defaults to 10, which was never a decision anyone made —
    // and with more concurrent users than that, some are always waiting.
    // MEASURED (15 concurrent writers, 4-statement transactions, Postgres 16):
    //   max 10 -> 716 tx/sec, p95 34 ms
    //   max 25 -> 928 tx/sec, p95 25 ms   (+30% throughput, ~27% lower p95)
    // 20 is a deliberate middle: comfortably above a typical user count, and far below the
    // server's max_connections (200) so several services can share one Postgres safely.
    max: poolMax(),
  };

  const directUrl = process.env.DATABASE_URL;
  if (typeof directUrl === 'string' && directUrl.trim().length > 0) {
    return {
      connectionString: directUrl.trim(),
      application_name: postgresApplicationName(
        process.env.PGAPPNAME,
        `oshal-api-${owner}`,
      ),
      ...timeouts,
    };
  }

  return {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
    port: parsePort(process.env.PGPORT || process.env.POSTGRES_PORT),
    user: process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'postgres',
    ssl: parseSslFlag(),
    application_name: postgresApplicationName(
      process.env.PGAPPNAME,
      `oshal-api-${owner}`,
    ),
    ...timeouts,
  };
}

/**
 * @description Parse SSL flag from environment variables.
 *
 * @returns True when SSL should be enabled
 */
function parseSslFlag(): boolean {
  const value = (process.env.PGSSLMODE || process.env.POSTGRES_SSL || '').toLowerCase();
  return value === 'true' || value === 'require' || value === '1';
}

/**
 * @description Parse and normalize Postgres port value.
 *
 * @param value - Raw environment value
 * @returns Normalized port number
 */
function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5432;
}
