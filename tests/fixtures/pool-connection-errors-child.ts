/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Child process for tests/unit/pool-connection-errors.spec.ts. Runs the REAL process-crash-guards and the REAL pg driver against a real PostgreSQL whose idle_in_transaction_session_timeout is set, holds a checked-out client inside BEGIN with nothing in flight, and reports what happened after the server terminated the session. With POOL_CHILD_OWN=0 this is the 2026-09-05 api crash in miniature (the process exits 1 from the crash guard); with POOL_CHILD_OWN=1 the fix under test keeps the process alive and the pool serving.
 */

import { Pool } from 'pg';
import { installProcessCrashGuards } from '@/shared/services/process-crash-guards';
import { ownPoolConnectionErrors } from '@/shared/services/database';

/** One JSON probe line per stage; the spec parses stdout for these. */
function probe(name: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ probe: name, ...detail })}\n`);
}

/** The exact production guards: an uncaught exception is `process.exit(1)` after a flush delay. */
installProcessCrashGuards('pool-connection-errors-child');

const connection = JSON.parse(process.env.POOL_CHILD_CONNECTION || '{}') as Record<string, unknown>;
const idleMs = Number(process.env.POOL_CHILD_IDLE_MS || '2000');
const own = process.env.POOL_CHILD_OWN === '1';

const pool = new Pool({ ...connection, max: 2, connectionTimeoutMillis: 5_000 });
if (own) {
  ownPoolConnectionErrors(pool, 'pool-connection-errors-child');
}

async function run(): Promise<void> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1');
  probe('in-transaction', { backendPid: (client as { processID?: number | null }).processID ?? null, own });

  // Nothing in flight on this connection: this is the shape of a transaction waiting on a starved
  // event loop. The server's idle-in-transaction timeout fires in here.
  await new Promise((resolve) => { setTimeout(resolve, idleMs); });

  let commit: 'ok' | 'rejected' = 'ok';
  let message: string | null = null;
  try {
    await client.query('COMMIT');
  } catch (error) {
    commit = 'rejected';
    message = error instanceof Error ? error.message : String(error);
  }
  probe('after-idle', { commit, message });
  client.release(commit === 'rejected' ? new Error('connection terminated') : undefined);

  // The pool must still answer after discarding the terminated client.
  const rows = await pool.query('SELECT 1 AS one');
  probe('pool-serves', { one: rows.rows[0]?.one ?? null });
  await pool.end();
}

run()
  .then(() => { process.exit(0); })
  .catch((error) => {
    probe('fatal', { message: error instanceof Error ? error.message : String(error) });
    process.exit(2);
  });
