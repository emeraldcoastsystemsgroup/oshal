/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis-free guards for atomic SET-NX replay consumption, hashed key privacy, bounded expiry, replay rejection, and infrastructure fail-closed behavior.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the first connect under concurrent callers. The only lazy-connect case made one serial consume(), so nothing covered two delegations reaching a store whose client had never connected: the second caller found the status already past wait, skipped the wait and issued SET on a stream that was not writable, and the store failed closed on a request that was valid. The stand-in client here behaves as the real one does at that boundary (connect moves the status to connecting at once and settles later, a second connect is refused, SET is refused until the status is ready), and the cases cover a caller arriving while connecting, a caller arriving while the socket is up but not ready, a failed connect reaching every waiter with nothing recorded, the store accepting again only once the client is ready, and a replay of one jti across the race. The real client and server are covered by tests/unit/delegation-replay-store-redis.spec.ts.
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

const UNWRITABLE = "Stream isn't writeable and enableOfflineQueue options is false";

/** One receipt per nonce, all inside the retention window of the fixed clock. */
function receiptFor(jti: string): typeof RECEIPT {
  return { ...RECEIPT, jti };
}

/** Lets every caller that can run without the connection run. */
function turn(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

/**
 * A lazy client with the offline queue off, as the store builds it: connect() moves the status to
 * connecting before it returns and settles later, a second connect() is refused, and SET is
 * refused until the status is ready. The test decides when the connection settles.
 */
function lazyClient() {
  const keys = new Set<string>();
  let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const client = {
    status: 'wait',
    connect: vi.fn((): Promise<void> => {
      if (client.status !== 'wait') return Promise.reject(new Error('Redis is already connecting/connected'));
      client.status = 'connecting';
      return new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    }),
    set: vi.fn(async (key: string): Promise<'OK' | null> => {
      if (client.status !== 'ready') throw new Error(UNWRITABLE);
      if (keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    }),
  };
  return {
    client,
    keys,
    socketUp(): void { client.status = 'connect'; },
    ready(): void { client.status = 'ready'; settle?.resolve(); },
    refuse(): void { client.status = 'reconnecting'; settle?.reject(new Error('Connection is closed.')); },
    reconnected(): void { client.status = 'ready'; },
  };
}

function storeOver(fake: ReturnType<typeof lazyClient>): RedisDelegationReplayStore {
  return new RedisDelegationReplayStore({
    client: fake.client,
    keyPrefix: 'test:delegation',
    nowEpochSeconds: () => 1_000,
  });
}

describe('RedisDelegationReplayStore first connect under concurrent callers', () => {
  it('makes a caller that arrives while the client is connecting wait for the same connection', async () => {
    const fake = lazyClient();
    const store = storeOver(fake);

    const settled = Promise.allSettled([
      store.consume(receiptFor('nonce-first')),
      store.consume(receiptFor('nonce-second')),
    ]);
    await turn();
    const statusWhileWaiting = fake.client.status;
    const setCallsWhileWaiting = fake.client.set.mock.calls.length;
    fake.ready();

    expect(await settled).toEqual([
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: true },
    ]);
    expect(statusWhileWaiting).toBe('connecting');
    expect(setCallsWhileWaiting).toBe(0);
    expect(fake.client.connect).toHaveBeenCalledTimes(1);
    expect(fake.keys.size).toBe(2);
  });

  it('makes a caller that arrives while the socket is up but not ready wait as well', async () => {
    const fake = lazyClient();
    const store = storeOver(fake);

    const first = store.consume(receiptFor('nonce-first'));
    await turn();
    fake.socketUp();
    const settled = Promise.allSettled([first, store.consume(receiptFor('nonce-second'))]);
    await turn();
    const setCallsWhileWaiting = fake.client.set.mock.calls.length;
    fake.ready();

    expect(await settled).toEqual([
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: true },
    ]);
    expect(setCallsWhileWaiting).toBe(0);
    expect(fake.client.connect).toHaveBeenCalledTimes(1);
    expect(fake.keys.size).toBe(2);
  });

  it('rejects every waiter when the connect fails and records nothing', async () => {
    const fake = lazyClient();
    const store = storeOver(fake);

    const settled = Promise.allSettled([
      store.consume(receiptFor('nonce-first')),
      store.consume(receiptFor('nonce-second')),
    ]);
    await turn();
    fake.refuse();
    const results = await settled;

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(DelegationReplayStoreUnavailableError);
    }
    expect(fake.client.connect).toHaveBeenCalledTimes(1);
    expect(fake.client.set).not.toHaveBeenCalled();
    expect(fake.keys.size).toBe(0);
  });

  it('stays closed after a failed connect and accepts again only once the client is ready', async () => {
    const fake = lazyClient();
    const store = storeOver(fake);

    const first = Promise.allSettled([store.consume(receiptFor('nonce-first'))]);
    await turn();
    fake.refuse();
    expect((await first)[0].status).toBe('rejected');

    await expect(store.consume(receiptFor('nonce-second')))
      .rejects.toBeInstanceOf(DelegationReplayStoreUnavailableError);
    expect(fake.keys.size).toBe(0);

    fake.reconnected();
    await expect(store.consume(receiptFor('nonce-second'))).resolves.toBe(true);
    expect(fake.keys.size).toBe(1);
    expect(fake.client.connect).toHaveBeenCalledTimes(1);
  });

  it('still refuses a replay of one jti when both uses arrive during the first connect', async () => {
    const fake = lazyClient();
    const store = storeOver(fake);

    const settled = Promise.allSettled([
      store.consume(receiptFor('nonce-same')),
      store.consume(receiptFor('nonce-same')),
    ]);
    await turn();
    fake.ready();
    const results = await settled;

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const accepted = results.map((result) => (result as PromiseFulfilledResult<boolean>).value);
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(fake.keys.size).toBe(1);
    await expect(store.consume(receiptFor('nonce-same'))).resolves.toBe(false);
  });
});
