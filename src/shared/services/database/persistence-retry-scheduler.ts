/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Retry idle failed persistence activation on one unref Node-safe cooldown timer under the existing SYSTEM schema identity.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from './request-identity';

const logger = createChildLogger({ module: 'persistence-retry-scheduler' });
const MINIMUM_BACKGROUND_DELAY_MS = 1_000;
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

/** @description Timer lifecycle for a kept pool's failed activation, without keeping the process alive. */
export interface PersistenceRetryScheduler {
  /** @description Schedule at most one retry after the failed attempt's cooldown. @param failedAt Failure timestamp. @returns Nothing. */
  schedule(failedAt: number): void;
  /** @description Cancel the pending retry when activation succeeds. @returns Nothing. */
  cancel(): void;
}

/**
 * @description Give a failed idle store a bounded-rate retry using its original activation and pool.
 * @param pool Kept pool; closed pools are never retried.
 * @param store Static persistence registry identity for structured diagnostics.
 * @param cooldownMs Existing on-demand cooldown; automatic retries have a positive rate floor.
 * @param retry Original memoized readiness operation, not a second activation implementation.
 * @returns A one-timer scheduler with explicit cancellation on recovery.
 */
export function createPersistenceRetryScheduler(
  pool: Pool, store: string, cooldownMs: number, retry: () => Promise<boolean>,
): PersistenceRetryScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const onTimer = (): void => {
    timer = null;
    if (pool.ending || pool.ended) return;
    void runWithSystemIdentity(retry).catch(err => {
      logger.error({ err, store }, 'Automatic persistence retry failed unexpectedly');
    });
  };
  const schedule = (failedAt: number): void => {
    if (pool.ending || pool.ended) { cancel(); return; }
    if (timer) return;
    const delay = Math.min(MAXIMUM_TIMER_DELAY_MS,
      Math.max(MINIMUM_BACKGROUND_DELAY_MS, failedAt + cooldownMs - Date.now()));
    // Creation and execution establish SYSTEM explicitly; never retain a user's request scope.
    timer = runWithSystemIdentity(() => setTimeout(onTimer, delay));
    timer.unref();
  };
  return { schedule, cancel };
}
