/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis-free guards for atomic SET-NX replay consumption, hashed key privacy, bounded expiry, replay rejection, and infrastructure fail-closed behavior.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DelegationReplayStoreUnavailableError,
  RedisDelegationReplayStore,
} from '@/shared/security/delegation-replay-store';

const RECEIPT = {
  issuer: 'urn:oshal:controller',
  jti: 'nonce-private-001',
  retainUntilEpochSeconds: 1_300,
};

function expectedDigest(): string {
  return createHash('sha256')
    .update(RECEIPT.issuer, 'utf8')
    .update('\0')
    .update(RECEIPT.jti, 'utf8')
    .digest('hex');
}

describe('RedisDelegationReplayStore', () => {
  it('atomically consumes a hashed receipt with bounded expiry', async () => {
    const set = vi.fn(async () => 'OK' as const);
    const store = new RedisDelegationReplayStore({
      client: { status: 'ready', set },
      keyPrefix: 'test:delegation',
      nowEpochSeconds: () => 1_000,
    });

    await expect(store.consume(RECEIPT)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(
      `test:delegation:${expectedDigest()}`,
      '1',
      'EX',
      300,
      'NX',
    );
    expect(JSON.stringify(set.mock.calls)).not.toContain(RECEIPT.issuer);
    expect(JSON.stringify(set.mock.calls)).not.toContain(RECEIPT.jti);
  });

  it('returns false when the shared atomic key already exists', async () => {
    const store = new RedisDelegationReplayStore({
      client: { status: 'ready', set: vi.fn(async () => null) },
      nowEpochSeconds: () => 1_000,
    });

    await expect(store.consume(RECEIPT)).resolves.toBe(false);
  });

  it('maps Redis and invalid-retention failures to one fail-closed error', async () => {
    const down = new RedisDelegationReplayStore({
      client: { status: 'ready', set: vi.fn(async () => { throw new Error('redis detail'); }) },
      nowEpochSeconds: () => 1_000,
    });
    const expired = new RedisDelegationReplayStore({
      client: { status: 'ready', set: vi.fn(async () => 'OK' as const) },
      nowEpochSeconds: () => 1_301,
    });

    await expect(down.consume(RECEIPT)).rejects.toBeInstanceOf(DelegationReplayStoreUnavailableError);
    await expect(expired.consume(RECEIPT)).rejects.toBeInstanceOf(DelegationReplayStoreUnavailableError);
  });

  it('connects a lazy client once before SET and closes it cleanly', async () => {
    const connect = vi.fn(async () => undefined);
    const quit = vi.fn(async () => 'OK');
    const client = {
      status: 'wait',
      connect: async () => { await connect(); client.status = 'ready'; },
      set: vi.fn(async () => 'OK' as const),
      quit,
    };
    const store = new RedisDelegationReplayStore({ client, nowEpochSeconds: () => 1_000 });

    await store.consume(RECEIPT);
    await store.close();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
