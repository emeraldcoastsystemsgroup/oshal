/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added cross-process owner fencing for ambient audio and erasure lifecycle operations.
 */

import type { Pool, PoolClient } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'ambient-owner-lock' });
const ERASURE_LOCK_TIMEOUT_MS = 180_000;

/** @description Signals that another replica is processing audio for this owner. */
export class AmbientOwnerLockBusyError extends Error {
  constructor() {
    super('Ambient audio processing is already active for this owner');
    this.name = 'AmbientOwnerLockBusyError';
  }
}

/** @description One held PostgreSQL session advisory lock. */
export interface AmbientOwnerLockLease {
  release(): Promise<void>;
}

/**
 * @description Acquires one owner's cross-replica lifecycle lock without queueing audio.
 * @param pool - GUC-aware shared Postgres pool.
 * @param ownerSub - Authenticated ambient-data owner.
 * @param wait - Whether erasure should poll until bounded audio work settles.
 * @returns Idempotently releasable session-lock lease.
 */
export async function acquireAmbientOwnerLock(
  pool: Pool,
  ownerSub: string,
  wait = false,
): Promise<AmbientOwnerLockLease> {
  const deadline = Date.now() + ERASURE_LOCK_TIMEOUT_MS;
  while (true) {
    const client = await pool.connect();
    let locked = false;
    try {
      const result = await client.query(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [`speaker-audio-owner:${ownerSub}`],
      );
      locked = Boolean(result.rows[0]?.locked);
    } catch (error) {
      client.release(true);
      throw error;
    }
    if (locked) return lockedClientLease(client, ownerSub);
    client.release();
    if (!wait || Date.now() >= deadline) throw new AmbientOwnerLockBusyError();
    await shortBackoff();
  }
}

/**
 * @description Serializes one owner's audio mutations and erasure across API replicas.
 * @param pool - GUC-aware shared Postgres pool.
 * @param ownerSub - Authenticated ambient-data owner.
 * @param work - Bounded work performed while the session advisory lock is held.
 * @returns Result of the serialized work.
 */
export async function withAmbientOwnerLock<T>(
  pool: Pool,
  ownerSub: string,
  work: () => Promise<T>,
  wait = false,
): Promise<T> {
  const lease = await acquireAmbientOwnerLock(pool, ownerSub, wait);
  try {
    return await work();
  } finally {
    await lease.release();
  }
}

function lockedClientLease(
  client: PoolClient,
  ownerSub: string,
): AmbientOwnerLockLease {
  let releasePromise: Promise<void> | null = null;
  return {
    release() {
      releasePromise ??= releaseLockedClient(client, ownerSub);
      return releasePromise;
    },
  };
}

async function releaseLockedClient(
  client: PoolClient,
  ownerSub: string,
): Promise<void> {
  let reusable = true;
  try {
    const result = await client.query(
      'SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',
      [`speaker-audio-owner:${ownerSub}`],
    );
    reusable = Boolean(result.rows[0]?.unlocked ?? result.rows[0]?.pg_advisory_unlock);
    if (!reusable) logger.error('Ambient owner advisory lock was not held during release');
  } catch (error) {
    reusable = false;
    logger.error({ err: error }, 'Failed to release ambient owner advisory lock');
  } finally {
    client.release(reusable ? undefined : true);
  }
}

function shortBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}
