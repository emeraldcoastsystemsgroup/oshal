/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Prove live own-data route fixtures reached Postgres and remained owner-isolated under the application GUC identity.
 */

import { Pool } from 'pg';

export interface OwnDataDatabaseEvidence {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownerSub: string;
  tasks: Array<{ taskId: string; ownerSub: string }>;
  tickets: Array<{ ticketId: string; ownerSub: string }>;
}

interface OwnDataEvidenceIds {
  taskIds: string[];
  ticketIds?: string[];
}

/**
 * @description Reads exact live-proof rows through the configured application role after stamping
 * the same transaction-local caller GUCs used by request middleware. The helper is deliberately
 * inert in ordinary Playwright runs; the nightly evidence generator opts in so an in-memory store
 * fallback cannot be mistaken for database-backed acceptance evidence.
 */
export async function readOwnDataDatabaseEvidence(
  ownerSub: string,
  ids: OwnDataEvidenceIds,
): Promise<OwnDataDatabaseEvidence | null> {
  if (process.env.OSHAL_OWN_DATA_DATABASE_EVIDENCE !== 'true') return null;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('OSHAL_OWN_DATA_DATABASE_EVIDENCE=true requires DATABASE_URL');
  }

  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('oshal.current_sub', $1, true),
              set_config('oshal.is_operator', 'false', true)`,
      [ownerSub],
    );
    const posture = await client.query<{
      role: string;
      superuser: boolean;
      bypass_rls: boolean;
    }>(`SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
        FROM pg_roles r WHERE r.rolname = current_user`);
    const tasks = ids.taskIds.length === 0
      ? { rows: [] as Array<{ taskId: string; ownerSub: string }> }
      : await client.query<{ taskId: string; ownerSub: string }>(
        `SELECT task_id AS "taskId", owner_sub AS "ownerSub"
         FROM chat_tasks WHERE task_id = ANY($1::text[]) ORDER BY task_id`,
        [ids.taskIds],
      );
    const ticketIds = ids.ticketIds ?? [];
    const tickets = ticketIds.length === 0
      ? { rows: [] as Array<{ ticketId: string; ownerSub: string }> }
      : await client.query<{ ticketId: string; ownerSub: string }>(
        `SELECT ticket_id::text AS "ticketId", owner_sub AS "ownerSub"
         FROM tickets WHERE ticket_id::text = ANY($1::text[]) ORDER BY ticket_id`,
        [ticketIds],
      );
    const row = posture.rows[0];
    if (!row) throw new Error('Could not read current Postgres role posture');

    return {
      role: row.role,
      superuser: row.superuser,
      bypassRls: row.bypass_rls,
      ownerSub,
      tasks: tasks.rows,
      tickets: tickets.rows,
    };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
  }
}
