/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime/migrator schema bootstrap policy so hosted app roles can validate
 *                     |               | schema readiness without doing DDL.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped runRuntimeSchemaBootstrap in runWithSystemIdentity. Boot/schema DDL + validation queries run with no request in scope; under OSHAL_DB_GUC_STRICT=deny an identity-less connection is stamped anonymous (RLS zero-rows), which would make validation spuriously report the schema "missing" and could starve any seed reads. The positive SYSTEM sentinel stamps this trusted-operator on purpose (guc warn-audit site 1).
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { applyLockedSchema } from './schema-lock';
import { runWithSystemIdentity } from './request-identity';

const logger = createChildLogger({ module: 'schema-bootstrap-policy' });

const VALIDATE_ONLY_VALUES = new Set([
  'off',
  'false',
  '0',
  'no',
  'disabled',
  'validate',
  'validate-only',
  'validation',
]);

export interface SchemaRequirement {
  table: string;
  columns?: string[];
}

export interface RuntimeSchemaBootstrapOptions {
  pool: Pool;
  moduleName: string;
  statements: string[];
  requirements: SchemaRequirement[];
  lockKey?: number;
}

export type RuntimeSchemaBootstrapResult = 'applied' | 'validated';

const DDL_PATTERN = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(?:--[^\n\r]*(?:\r?\n|$)\s*)*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT)\b/i;

/**
 * @description Returns true when runtime code may perform idempotent schema DDL.
 * Default stays permissive for local/dev. Hosted enterprise runtimes should set
 * OSHAL_SCHEMA_BOOTSTRAP=validate-only and run migrations/bootstrap separately.
 */
export function runtimeSchemaBootstrapEnabled(): boolean {
  const raw = (process.env.OSHAL_SCHEMA_BOOTSTRAP || '').trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return !VALIDATE_ONLY_VALUES.has(raw);
}

/**
 * @description True when a query text is schema/privilege DDL that should not
 * execute from a hosted app runtime role.
 */
export function isRuntimeDdlStatement(query: unknown): boolean {
  const text = queryText(query);
  return Boolean(text && DDL_PATTERN.test(text));
}

/**
 * @description Wrap a pool so hosted validate-only runtime profiles cannot
 * silently perform schema DDL through shared or route-specific self-heal code.
 */
export function wrapPoolWithRuntimeDdlGuard(pool: Pool): Pool {
  if (runtimeSchemaBootstrapEnabled()) {
    return pool;
  }

  logger.info('Runtime schema DDL guard enabled (OSHAL_SCHEMA_BOOTSTRAP=validate-only)');
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          assertRuntimeDdlAllowed(args[0]);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (prop === 'connect') {
        return async (cb?: unknown) => {
          if (typeof cb === 'function') {
            return (target.connect as (...a: unknown[]) => unknown)(cb);
          }
          const client = await target.connect();
          return wrapClientWithRuntimeDdlGuard(client);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * @description Apply schema statements in local/dev mode, or validate required
 * tables/columns in hosted runtime mode.
 */
export async function runRuntimeSchemaBootstrap(
  options: RuntimeSchemaBootstrapOptions,
): Promise<RuntimeSchemaBootstrapResult> {
  // Trusted boot/system work with no request in scope. Mark it with the positive SYSTEM sentinel
  // so the GUC pool stamps operator on PURPOSE — under OSHAL_DB_GUC_STRICT=deny an identity-less
  // connection is scoped anonymous (RLS zero-rows), which would make validation spuriously report
  // the schema "missing" and starve any seed reads. (guc warn-audit site 1.)
  return runWithSystemIdentity(async () => {
    if (!runtimeSchemaBootstrapEnabled()) {
      await assertSchemaReady(options.pool, options.moduleName, options.requirements);
      logger.info(
        { moduleName: options.moduleName, requirementCount: options.requirements.length },
        'Runtime schema bootstrap is validate-only; schema requirements are present',
      );
      return 'validated';
    }

    if (options.lockKey !== undefined) {
      await applyLockedSchema(options.pool, options.lockKey, options.statements);
    } else {
      for (const statement of options.statements) {
        await options.pool.query(statement);
      }
    }
    return 'applied';
  });
}

/**
 * @description Validate that the runtime app role can see the schema it needs,
 * without requiring CREATE/ALTER privileges.
 */
export async function assertSchemaReady(
  pool: Pool,
  moduleName: string,
  requirements: SchemaRequirement[],
): Promise<void> {
  const missing: string[] = [];

  for (const requirement of requirements) {
    const tableExists = await hasTable(pool, requirement.table);
    if (!tableExists) {
      missing.push(`${requirement.table} table`);
      continue;
    }

    for (const column of requirement.columns || []) {
      const columnExists = await hasColumn(pool, requirement.table, column);
      if (!columnExists) {
        missing.push(`${requirement.table}.${column}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `${moduleName} schema is not ready for the runtime DB role: missing ${missing.join(', ')}. ` +
      'Run migrations/schema bootstrap as the owner role before starting with OSHAL_SCHEMA_BOOTSTRAP=validate-only.',
    );
  }
}

function wrapClientWithRuntimeDdlGuard(client: PoolClient): PoolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          assertRuntimeDdlAllowed(args[0]);
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function assertRuntimeDdlAllowed(query: unknown): void {
  if (!isRuntimeDdlStatement(query)) {
    return;
  }
  throw new Error(
    'Runtime schema DDL is disabled by OSHAL_SCHEMA_BOOTSTRAP=validate-only. ' +
    'Run migrations/schema bootstrap with the owner role instead of the request runtime role.',
  );
}

function queryText(query: unknown): string {
  if (typeof query === 'string') {
    return query;
  }
  if (query && typeof query === 'object' && typeof (query as { text?: unknown }).text === 'string') {
    return (query as { text: string }).text;
  }
  return '';
}

async function hasTable(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [toRegclassName(table)],
  );
  return Boolean(result.rows[0]?.exists);
}

async function hasColumn(pool: Pool, table: string, column: string): Promise<boolean> {
  const name = splitTableName(table);
  const result = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND column_name = $3
      LIMIT 1
    `,
    [name.schemaName, name.tableName, column],
  );
  return Boolean(result.rows[0]);
}

function toRegclassName(table: string): string {
  return table.includes('.') ? table : `public.${table}`;
}

function splitTableName(table: string): { schemaName: string; tableName: string } {
  const parts = table.split('.');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { schemaName: parts[0], tableName: parts[1] };
  }
  return { schemaName: 'public', tableName: table };
}
