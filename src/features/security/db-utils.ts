/**
 * Security Center — DB helpers (ADR-055).
 *
 * The runtime/ledger/audit detectors read tables owned by OTHER apps (chat_tasks, the trading
 * ledger, the shop history, the routing audit log). Those tables only exist if the owning app
 * has been initialized, so every detector guards on existence first and degrades to an honest
 * "unavailable" note rather than throwing — coverage is never silently dropped.
 *
 * @module features/security/db-utils
 */

import type { Pool } from 'pg';

/** True if a public-schema table exists. Cheap; safe to call before every detector query. */
export async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const r = await pool.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
  return r.rows[0]?.reg != null;
}
