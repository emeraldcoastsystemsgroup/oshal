/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial workspace persistence schema for named persistent workspaces
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added owner_sub column + index for per-user workspace isolation (IDOR fix). Idempotent ADD COLUMN runs on every boot so existing DBs gain the column without a separate migration pass; see also scripts/migrations/052.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | A1.2: append owner-or-operator RLS policy statements so a fresh database enforces workspace isolation at table-create time (chokepoint fix; shapes mirror rls-policies-enforce.sql)
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';
import { buildOwnerRlsPolicyStatements } from './owner-rls-policy';

const logger = createChildLogger({ module: 'workspace-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the workspaces table exists before workspace store queries execute.
 * Uses a shared process-level promise so bootstrap runs once per process.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the workspace schema is ready
 */
export function ensureWorkspaceSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applyWorkspaceSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for workspace persistence.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when all schema statements have been applied
 */
async function applyWorkspaceSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring workspace persistence schema');
  const statements = buildSchemaStatements();
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'workspace',
    statements,
    requirements: [
      { table: 'workspaces', columns: ['workspace_id', 'name', 'path', 'owner_sub', 'metadata'] },
    ],
  });
  logger.info({ statementCount: statements.length }, 'Workspace persistence schema ready');
}

/**
 * @description Returns ordered SQL statements for the workspaces table.
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    /* ── workspaces table ─────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      project_name TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    /* ── per-user ownership (IDOR fix) ────────────────────────────── */
    `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_sub TEXT`,

    /* ── workspaces indexes ───────────────────────────────────────── */
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name)`,
    `CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_name) WHERE project_name IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_sub) WHERE owner_sub IS NOT NULL`,

    /* ── owner-scoped RLS (A1.2): applied at the lazy-DDL chokepoint so a
       fresh database enforces isolation the moment this table is created.
       Inert while the runtime connects as a superuser role. ─────────────── */
    ...buildOwnerRlsPolicyStatements('workspaces', 'owner_sub'),
  ];
}
