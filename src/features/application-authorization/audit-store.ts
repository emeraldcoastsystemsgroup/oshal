/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Query scoped authorization history without writer locks or loading the entire audit ledger.
 */
import type { Pool } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { createChildLogger } from '@/shared/logger';
import type { AuthorizationAudit, AuthorizationAuditQuery } from './types';
const logger = createChildLogger({ module: 'authorization-audit-store' });

/** @description Read a bounded audit page under a consistent revision snapshot; caller must authorize all filters.
 * @param pool Control-plane pool. @param input Service-authorized filters and continuation. @returns Matching events only.
 */
export async function readPostgresAudit(pool: Pool, input: AuthorizationAuditQuery): Promise<{ events: AuthorizationAudit[]; snapshotRevision: number }> {
  return runWithSystemIdentity(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = await client.query('SELECT revision FROM oshal_authorization_state WHERE singleton=TRUE');
      const current = Number(state.rows[0]?.revision);
      if (!Number.isSafeInteger(current) || current < 0) throw new Error('Authorization audit revision unavailable');
      const snapshotRevision = input.snapshotRevision === undefined ? current : Math.min(input.snapshotRevision, current);
      const query = buildQuery(input, snapshotRevision);
      const result = await client.query(query.sql, query.values);
      await client.query('COMMIT');
      return { events: result.rows.map(row => ({ ...row.payload, id: row.id, revision: Number(row.revision) })), snapshotRevision };
    } catch (error) { logger.error({ err: error }, 'Authorization audit read failed'); await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
}

function buildQuery(input: AuthorizationAuditQuery, snapshotRevision: number) {
  const values: unknown[] = [snapshotRevision]; const clauses = ['revision <= $1'];
  if (input.app !== undefined) { values.push(input.app); clauses.push(`payload #>> '{change,app}' = $${values.length}`); }
  if (input.tenantId !== undefined) { values.push(input.tenantId); clauses.push(`payload #>> '{change,tenantId}' = $${values.length}`); }
  if (input.before) {
    values.push(input.before.revision, input.before.id); clauses.push(`(revision,id) < ($${values.length - 1}::bigint,$${values.length}::text)`);
  }
  values.push(input.limit);
  return { sql: `SELECT id,revision,payload FROM oshal_authorization_audit WHERE ${clauses.join(' AND ')} ORDER BY revision DESC,id DESC LIMIT $${values.length}`, values };
}
