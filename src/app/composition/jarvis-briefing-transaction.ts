/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reserve pool capacity for current-rights reads and bound failed authority refreshes before rolling back briefing writes.
 */
import type { Pool, PoolClient } from 'pg';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';

const transactions = new WeakMap<Pool, Promise<void>>();
const AUTHORITY_TIMEOUT_MS = 2_000;
const ADMISSION_TIMEOUT_MS = 5_000;

async function deadline<T>(operation: () => Promise<T>, message: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { status: 503 })), milliseconds);
    });
    return await Promise.race([Promise.resolve().then(operation), expired]);
  } finally { clearTimeout(timer); }
}

/**
 * @description Bound a trusted read-only authority refresh; late completion cannot resume its awaiting transaction.
 * @param read - Identity or current-rights read without mutation or a borrowed transaction client.
 * @returns Current authority evidence, or rejection before any dependent service write proceeds.
 */
export function readBriefingAuthority<T>(read: () => Promise<T>): Promise<T> {
  return deadline(read, 'briefing_authority_timeout', AUTHORITY_TIMEOUT_MS);
}

/**
 * @description Run control-table work without delaying source registration or retirement behind an authority read.
 * @param pool - Runtime database pool with the existing identity wrapper.
 * @param operation - Transactional control-table operation.
 * @returns Committed result, or rejection after rollback and connection release.
 */
export function runBriefingControlTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  return runWithSystemIdentity(async () => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });
}

/**
 * @description Admit one authority-dependent briefing transaction per pool, leaving capacity for its independent rights reads.
 * @param pool - Shared runtime pool; production supports at least two connections.
 * @param operation - Control-table operation, including fresh checks after lock waits.
 * @returns Committed operation result; failures roll back and release admission.
 */
export async function runBriefingTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const previous = transactions.get(pool) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>(done => { release = done; });
  const queued = previous.then(() => turn);
  transactions.set(pool, queued);
  void queued.then(() => { if (transactions.get(pool) === queued) transactions.delete(pool); });
  try {
    await deadline(() => previous, 'briefing_transaction_busy', ADMISSION_TIMEOUT_MS);
    return await runBriefingControlTransaction(pool, operation);
  } finally { release(); }
}
