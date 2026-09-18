/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Deploy — the api process exits during the bot-recreate storm": a server-side termination of a CHECKED-OUT pg connection killed the api. pg-pool owns a client's 'error' event only while the client is idle (it removes its listener at acquire and re-adds it at release), and pg's Client routes a server ErrorResponse with no active query straight to `emit('error')`. So a client sitting inside BEGIN with nothing in flight - the exact shape of a transaction that waits on a starved event loop - receives Postgres's `terminating connection due to idle-in-transaction timeout` (25P03) as an unowned 'error' event, EventEmitter rethrows it, and process-crash-guards exits the process. This owner attaches one 'error' listener to every physical client at pool 'connect' time, so the termination becomes an ERROR line naming the backend pid and the pool, the caller's next statement rejects (`Client has encountered a connection error and is not queryable`), the caller's own catch handles it, and the pool discards the client on release. Reproduced and proven against a real PostgreSQL in tests/unit/pool-connection-errors.spec.ts.
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'pool-connection-errors' });

/** Pools already owned, so wrapping a pool twice attaches nothing twice. */
const owned = new WeakSet<Pool>();

/** pg's Client exposes the backend pid; the type package does not declare it on PoolClient. */
interface ClientWithBackendPid {
  processID?: number | null;
}

/**
 * @description Own the 'error' events of every connection a pool hands out, checked-out or idle.
 *
 * Why this exists: `pg` emits 'error' on a Client when the SERVER ends the session while no query
 * is in flight - `idle_in_transaction_session_timeout`, `pg_terminate_backend`, a restart. pg-pool
 * listens for that only while the client is idle in the pool. A client checked out for a
 * transaction has no listener at all, so the event is an uncaught exception, and under
 * process-crash-guards an uncaught exception is `process.exit(1)`. The 2026-09-05 deploy hit
 * exactly that: the bot-recreate storm starved the api's event loop, a transaction idled past the
 * server's timeout, Postgres terminated it, and the whole api died mid-deploy.
 *
 * After this owner is attached the same termination is an ERROR line per pg error event (two for one termination: the server’s 25P03 and pg’s own connection-terminated event, milliseconds apart) and one rejected statement.
 * The transaction is still lost - the caller's next `query()` rejects and its own catch runs
 * ROLLBACK/release, which is the ordinary failed-transaction path every call site already has.
 * What changes is that one lost transaction no longer costs every in-flight request in the
 * process.
 *
 * The pool-level listener reports an IDLE client's death only when no other owner does
 * (`createPersistenceActivation` attaches its own for the stores it activates), so one event is one
 * line, not two.
 *
 * @param pool - The raw pg Pool, before any GUC or DDL-guard proxy wraps it.
 * @param owner - Which pool this is, for the log line - the same name the pool's application_name
 *                carries, so an ERROR here and a Postgres log line can be matched.
 * @returns The same pool, for construction-site chaining.
 */
export function ownPoolConnectionErrors(pool: Pool, owner: string): Pool {
  if (owned.has(pool)) {
    return pool;
  }
  owned.add(pool);

  pool.on('connect', (client: PoolClient) => {
    client.on('error', (error: Error) => {
      // While the client is idle pg-pool's own listener is also attached (listener count 2) and
      // reports through the pool 'error' event below; only a CHECKED-OUT client has this
      // listener alone, and that is the case that used to be fatal.
      if (client.listenerCount('error') > 1) {
        return;
      }
      logger.error(
        { err: error, owner, backendPid: (client as ClientWithBackendPid).processID ?? null },
        'A checked-out Postgres connection was terminated by the server; the transaction on it is lost, the caller\'s next statement rejects, and the process stays up',
      );
    });
  });

  pool.on('error', (error: Error) => {
    if (pool.listenerCount('error') > 1) {
      return;
    }
    logger.error(
      { err: error, owner },
      'Idle Postgres connection errored; the pool has discarded it and the next acquire opens a fresh one',
    );
  });

  return pool;
}
