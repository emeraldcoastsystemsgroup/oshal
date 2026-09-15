/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | BACKLOG "One slow boot drops the task, message and memory stores to in-memory for the life of the process": share the one shape a store's Postgres activation may be asked for again, so a transient boot failure degrades the next operation rather than the whole process lifetime.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Own the kept pool's idle-client errors. Keeping the pool is what makes a retry possible, and it also means this module is now the holder of a long-lived pg Pool: with no 'error' listener, an idle client whose connection dies is rethrown by EventEmitter as an uncaught exception and takes the api process down. Surfaced by the recovery guard, which raised two 'Connection terminated unexpectedly' exceptions when the fixture database went away under a recovered pool.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { recordPersistenceMode } from '@/shared/observability';
import { createRetryableReady } from './retryable-ready';

const logger = createChildLogger({ module: 'persistence-activation' });

/**
 * Minimum gap between activation attempts after one fails. Without it, a store whose
 * database is genuinely down pays a full connect timeout on EVERY call; with it, the cost
 * of a down database is one timeout per window and every other call answers from memory
 * immediately. 30s is a deliberate middle: far longer than the boot migration burst that
 * caused the observed failure, far shorter than the container lifetime the old code made
 * an operator wait for.
 */
const DEFAULT_RETRY_COOLDOWN_MS = 30_000;

/**
 * @description Resolve the post-failure retry cooldown from the environment.
 * Read per activation so a deployment (and a guard) can set it without a rebuild.
 * @returns Cooldown in milliseconds; the default when unset or not a non-negative integer.
 */
export function persistenceRetryCooldownMs(): number {
  const raw = process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_RETRY_COOLDOWN_MS;
  }
  return parsed;
}

/** @description What one store needs to declare to get a re-attemptable Postgres activation. */
export interface PersistenceActivationOptions {
  /** Store identity for the persistence-mode registry and the log context, e.g. `task-store`. */
  store: string;
  /** The store's pool; null when this deployment has no Postgres configured at all. */
  pool: Pool | null;
  /**
   * The store's idempotent schema bootstrap. MUST reject when the database is unreachable -
   * a resolved activation is memoized and never re-attempted.
   */
  activate: (pool: Pool) => Promise<void>;
  /** Override the post-failure cooldown. Defaults to `persistenceRetryCooldownMs()`. */
  retryCooldownMs?: number;
}

/** @description A store's re-attemptable Postgres activation. */
export interface PersistenceActivation {
  /**
   * Resolve whether the store is persistent RIGHT NOW, re-attempting activation when the
   * last attempt failed and the cooldown has elapsed. Never rejects: a store that cannot
   * reach Postgres serves from memory, it does not refuse the caller.
   */
  ready(): Promise<boolean>;
  /** The last known mode, without triggering an attempt. */
  persistent(): boolean;
}

/**
 * @description Give a fallback-capable store an activation it can be asked for again.
 *
 * The defect this exists for: every such store built ONE eagerly created init promise in its
 * constructor, awaited it before each operation, and on failure set `persistentMode = false`,
 * ended the pool and nulled it. One lost pool acquire during the api's own boot migration burst
 * therefore made that store non-persistent for the life of the process, and the only tell was a
 * single ERROR line. Three stores lost that race on the 2026-09-15 00:25:11Z boot at once.
 *
 * Three deliberate properties:
 *  - **The attempt is memoized and the memo is dropped on failure** (`createRetryableReady`),
 *    so concurrent callers share one in-flight bootstrap and the next caller after a failure
 *    starts a fresh one. This is the shape the authorization wiring and the Entra bridge use.
 *  - **The pool is kept, never ended and never nulled.** Ending it is exactly what made recovery
 *    impossible: an ended pool rejects every later acquire, and a nulled one leaves the retry
 *    nothing to retry with. A `pg.Pool` opens no connection until one is acquired and reaps idle
 *    clients on its own, so an unused pool costs an object - the old `end()` was closing a leak
 *    that only existed because nothing would ever use the pool again.
 *  - **The degrade survives.** Failure is never propagated to the caller: the store answers from
 *    memory so the process still comes up when Postgres is genuinely unavailable. What changes is
 *    that the fallback is now a state the next operation can leave, and one the persistence-mode
 *    registry (and therefore /api/readiness) can see.
 *
 * @param options - The store identity, its pool, and its idempotent schema bootstrap.
 * @returns An activation whose `ready()` reports the store's current mode and retries on demand.
 */
export function createPersistenceActivation(options: PersistenceActivationOptions): PersistenceActivation {
  const { store, pool, activate } = options;
  const cooldownMs = options.retryCooldownMs ?? persistenceRetryCooldownMs();

  if (!pool) {
    recordPersistenceMode({ store, mode: 'unconfigured', attempts: 0 });
    logger.info({ store }, 'Store persistence not configured; serving from memory by deployment shape');
    return { ready: async () => false, persistent: () => false };
  }

  // Keeping the pool means owning its idle-client errors. `pg` emits 'error' on the Pool when an
  // IDLE client's connection dies - a database restart, a network blip - after it has already
  // discarded that client; the next acquire opens a fresh connection. With no listener,
  // EventEmitter rethrows it as an uncaught exception and takes the process down, which is the
  // bill for keeping a pool alive rather than ending it.
  pool.on('error', error => {
    logger.error(
      { err: error, store },
      'Idle Postgres client for this store errored; the pool has discarded it and the next operation opens a fresh connection',
    );
  });

  let persistent = false;
  let attempts = 0;
  let reportedFailure = 0;
  let lastFailureAt = 0;
  recordPersistenceMode({ store, mode: 'memory', attempts: 0, detail: 'persistence not attempted yet' });

  const attempt = createRetryableReady(async () => {
    attempts += 1;
    const attemptNumber = attempts;
    await activate(pool);
    persistent = true;
    recordPersistenceMode({ store, mode: 'persistent', attempts: attemptNumber });
    logger.info(
      { store, attempts: attemptNumber },
      attemptNumber === 1
        ? 'Store persistence mode enabled (postgres)'
        : 'Store persistence RECOVERED; it had been serving from memory since an earlier failed attempt',
    );
  });

  const ready = async (): Promise<boolean> => {
    if (persistent) {
      return true;
    }
    if (lastFailureAt > 0 && Date.now() - lastFailureAt < cooldownMs) {
      return false;
    }
    try {
      await attempt();
      return persistent;
    } catch (error) {
      // One report per failed attempt, not one per caller sharing it. The memo is already
      // dropped by createRetryableReady, so the next call after the cooldown retries.
      if (reportedFailure !== attempts) {
        reportedFailure = attempts;
        lastFailureAt = Date.now();
        recordPersistenceMode({ store, mode: 'memory', attempts, detail: describe(error) });
        logger.error(
          { err: error, store, attempts, retryAfterMs: cooldownMs },
          'Store persistence activation failed; SERVING FROM MEMORY (writes are lost on restart) until a later operation re-attempts it',
        );
      }
      return false;
    }
  };

  return { ready, persistent: () => persistent };
}

/**
 * @description Reduce an unknown thrown value to one short line for the registry.
 * @param error - The thrown value.
 * @returns Its message, or its string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
