/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proved cross-process-style ambient audio/erasure lock ordering and fail-fast admission.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AmbientOwnerLockBusyError,
  withAmbientOwnerLock,
} from '../../src/shared/services/database/ambient-owner-lock';

describe('ambient owner lifecycle lock', () => {
  it('fails a second audio admission while the same owner is processing', async () => {
    const fixture = fakeAdvisoryPool();
    let releaseWork!: () => void;
    const first = withAmbientOwnerLock(fixture.pool, 'owner-a', () => new Promise<void>((resolve) => {
      releaseWork = resolve;
    }));
    await fixture.acquired();

    await expect(withAmbientOwnerLock(fixture.pool, 'owner-a', async () => undefined))
      .rejects.toBeInstanceOf(AmbientOwnerLockBusyError);

    releaseWork();
    await first;
    expect(fixture.locked()).toBe(false);
  });

  it('makes erasure wait until audio settles, then prevents post-return mutation', async () => {
    const fixture = fakeAdvisoryPool();
    const order: string[] = [];
    let releaseAudio!: () => void;
    const audio = withAmbientOwnerLock(fixture.pool, 'owner-a', () => new Promise<void>((resolve) => {
      order.push('audio-start');
      releaseAudio = () => { order.push('audio-complete'); resolve(); };
    }));
    await fixture.acquired();
    const erase = withAmbientOwnerLock(fixture.pool, 'owner-a', async () => {
      order.push('erase');
    }, true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['audio-start']);
    releaseAudio();
    await Promise.all([audio, erase]);

    expect(order).toEqual(['audio-start', 'audio-complete', 'erase']);
    expect(fixture.locked()).toBe(false);
  });

  it('destroys a client when advisory acquisition fails', async () => {
    const release = vi.fn();
    const pool = {
      connect: async () => ({
        query: async () => { throw new Error('database unavailable'); },
        release,
      }),
    };

    await expect(withAmbientOwnerLock(pool as never, 'owner-a', async () => undefined))
      .rejects.toThrow('database unavailable');
    expect(release).toHaveBeenCalledWith(true);
  });
});

function fakeAdvisoryPool() {
  let ownerLocked = false;
  let firstAcquireResolve!: () => void;
  const firstAcquire = new Promise<void>((resolve) => { firstAcquireResolve = resolve; });
  let acquireCount = 0;
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          acquireCount += 1;
          if (ownerLocked) return { rows: [{ locked: false }] };
          ownerLocked = true;
          firstAcquireResolve();
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          ownerLocked = false;
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      release: vi.fn(),
    }),
  };
  return {
    pool: pool as never,
    acquired: () => firstAcquire,
    locked: () => ownerLocked,
    acquireCount: () => acquireCount,
  };
}
