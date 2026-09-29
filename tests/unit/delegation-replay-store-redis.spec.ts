/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The real-boundary companion of the first-connect guard in delegation-replay-store.spec.ts. The defect sat between the store and its Redis client: two delegations reached a bot whose replay client had never connected, the second found the client already connecting, skipped the wait and had its SET refused on a stream that was not writable, so a valid request failed closed. A stand-in client can only restate what the real one is believed to do, so this file builds the store the way a bot node does (its own lazy client, offline queue off, from a Redis address) and points it at a server this spec starts and removes. It issues the two concurrent first consume() calls, reads the receipts and the connection count back from the server, replays one jti across the race, and drives a failed first connect against a loopback listener that hangs up on every connection.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import {
  DelegationReplayStoreUnavailableError,
  RedisDelegationReplayStore,
} from '@/shared/security/delegation-replay-store';
import { DisposableRedis } from '../helpers/disposable-redis';

// A Redis this file owns: started here, removed in afterAll, and never an address read from the
// environment, so a run cannot reach a deployment's replay ledger.
const fixture = new DisposableRedis({ purpose: 'delegation-replay-race' });
const ISSUER = 'urn:oshal:controller';
const opened: RedisDelegationReplayStore[] = [];
const listeners: Server[] = [];
let admin: Redis;

/** A receipt that stays inside the retention window for the whole run. */
function receiptFor(jti: string): { issuer: string; jti: string; retainUntilEpochSeconds: number } {
  return { issuer: ISSUER, jti, retainUntilEpochSeconds: Math.floor(Date.now() / 1_000) + 300 };
}

/** A store built as a bot node builds it: only an address, so the client and its options are the store's own. */
function storeAt(redisUrl: string, keyPrefix: string): RedisDelegationReplayStore {
  const store = new RedisDelegationReplayStore({ redisUrl, keyPrefix });
  opened.push(store);
  return store;
}

/** A namespace no other case shares, so each case reads back only what it wrote. */
function ownPrefix(): string {
  return `test:replay-race:${randomUUID()}`;
}

/** How many connections to the server have SET as their last command: the store's, never the reader's. */
async function connectionsThatSet(): Promise<number> {
  const listing = String(await admin.call('CLIENT', 'LIST'));
  return listing.split(/\r?\n/).filter((line) => /\bcmd=set\b/.test(line)).length;
}

/** A loopback listener that accepts and hangs up, so a connect reaches a socket and never a server. */
async function hangUpListener(): Promise<string> {
  const server = createServer((socket) => { socket.destroy(); });
  listeners.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The hang-up listener has no port');
  return `redis://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  await fixture.start();
  admin = new Redis(fixture.url, { maxRetriesPerRequest: 1 });
  expect(await admin.ping()).toBe('PONG');
}, 120_000);

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
  while (listeners.length) {
    const server = listeners.pop()!;
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  }
});

afterAll(async () => {
  try {
    if (admin) await admin.quit();
  } finally {
    await fixture.stop();
  }
}, 120_000);

describe('RedisDelegationReplayStore first connect against a real Redis', () => {
  it('accepts two concurrent first receipts over one connection and records both', async () => {
    const prefix = ownPrefix();
    const store = storeAt(fixture.url, prefix);
    const before = await connectionsThatSet();

    const results = await Promise.allSettled([
      store.consume(receiptFor('nonce-first')),
      store.consume(receiptFor('nonce-second')),
    ]);

    expect(results).toEqual([
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: true },
    ]);
    expect(await admin.keys(`${prefix}:*`)).toHaveLength(2);
    expect(await connectionsThatSet() - before).toBe(1);
  }, 60_000);

  it('refuses a replay of a receipt that was accepted during the first connect', async () => {
    const prefix = ownPrefix();
    const store = storeAt(fixture.url, prefix);

    const first = await Promise.allSettled([
      store.consume(receiptFor('nonce-first')),
      store.consume(receiptFor('nonce-second')),
    ]);
    expect(first.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

    await expect(store.consume(receiptFor('nonce-first'))).resolves.toBe(false);
    await expect(store.consume(receiptFor('nonce-second'))).resolves.toBe(false);
    expect(await admin.keys(`${prefix}:*`)).toHaveLength(2);
  }, 60_000);

  it('accepts one use of a jti when both uses arrive during the first connect', async () => {
    const prefix = ownPrefix();
    const store = storeAt(fixture.url, prefix);

    const results = await Promise.allSettled([
      store.consume(receiptFor('nonce-same')),
      store.consume(receiptFor('nonce-same')),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    const accepted = results.map((result) => (result as PromiseFulfilledResult<boolean>).value);
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await admin.keys(`${prefix}:*`)).toHaveLength(1);
  }, 60_000);

  it('rejects every waiter when the first connect fails and accepts nothing', async () => {
    const store = storeAt(await hangUpListener(), ownPrefix());

    const results = await Promise.allSettled([
      store.consume(receiptFor('nonce-first')),
      store.consume(receiptFor('nonce-second')),
    ]);

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(DelegationReplayStoreUnavailableError);
    }
    await expect(store.consume(receiptFor('nonce-third')))
      .rejects.toBeInstanceOf(DelegationReplayStoreUnavailableError);
  }, 60_000);
});
