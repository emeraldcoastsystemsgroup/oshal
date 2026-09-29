/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a shared Redis SET-NX replay ledger for single-use HTTP delegation tokens with an injectable fail-closed store contract.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A caller that arrives while the first connect is in flight now waits for it. ensureConnected() waited only while the client status was wait, and the client leaves wait the moment connect() is called, so the second of two concurrent first delegations skipped the wait, issued SET before the client was ready and was refused by the client (offline queue off). The store failed closed on a valid request and the bot answered 503. The in-flight connect is now checked before the status. Nothing else changes: no queue, no retry, the same single SET NX EX, and a failed connect still rejects every caller with the unavailable error.
 */

import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'delegation-replay-store' });
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_KEY_PREFIX = 'oshal:delegation:used';
const MAX_REPLAY_TTL_SECONDS = 5_700;

interface ReplayRedisClient {
  status?: string;
  connect?: () => Promise<void>;
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  quit?: () => Promise<unknown>;
  disconnect?: () => void;
}

/** @description One signed nonce and its replay-retention boundary. */
export interface DelegationReplayReceipt {
  /** Controller token issuer; principal issuer is deliberately not part of nonce identity. */
  issuer: string;
  /** Signed per-issue nonce. */
  jti: string;
  /** Epoch second through which the nonce must remain consumed, including allowed clock skew. */
  retainUntilEpochSeconds: number;
}

/** @description Atomic, shared single-use ledger consumed after signature and binding verification. */
export interface DelegationReplayStore {
  /**
   * @description Atomically consumes one signed nonce. Infrastructure errors must reject rather
   * than look like a first use, because an unavailable replay ledger cannot authorize execution.
   * @param receipt - Signed issuer/nonce identity and bounded retention deadline.
   * @returns True only for the first consumer; false for every replay.
   */
  consume(receipt: DelegationReplayReceipt): Promise<boolean>;
  /** @description Releases store resources during graceful shutdown. */
  close?(): Promise<void>;
}

/** @description Sanitized error used to map replay-ledger outages to HTTP 503. */
export class DelegationReplayStoreUnavailableError extends Error {
  /** @description Creates a non-secret replay infrastructure failure. */
  constructor() {
    super('Delegation replay protection is unavailable');
    this.name = 'DelegationReplayStoreUnavailableError';
  }
}

/** @description Construction boundaries for the production Redis replay ledger. */
export interface RedisDelegationReplayStoreOptions {
  /** Shared Redis endpoint; defaults to REDIS_URL and then the local development endpoint. */
  redisUrl?: string;
  /** Injectable Redis-shaped client used by focused tests without a live Redis dependency. */
  client?: ReplayRedisClient;
  /** Key namespace override for isolated deployments and tests. */
  keyPrefix?: string;
  /** Epoch clock seam used to derive the bounded Redis expiry. */
  nowEpochSeconds?: () => number;
}

/** @description Redis-backed, cross-process single-use ledger using one atomic SET NX EX. */
export class RedisDelegationReplayStore implements DelegationReplayStore {
  private readonly client: ReplayRedisClient;
  private readonly keyPrefix: string;
  private readonly nowEpochSeconds: () => number;
  private connectPromise: Promise<void> | null = null;

  /**
   * @description Creates a lazy Redis ledger; Redis is contacted only by a verified request.
   * @param options - Redis connection, client, namespace, and clock boundaries.
   */
  constructor(options: RedisDelegationReplayStoreOptions = {}) {
    this.client = options.client ?? new Redis(
      options.redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
      { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false },
    );
    this.keyPrefix = normalizePrefix(options.keyPrefix ?? DEFAULT_KEY_PREFIX);
    this.nowEpochSeconds = options.nowEpochSeconds ?? systemEpochSeconds;
  }

  /** @inheritdoc */
  async consume(receipt: DelegationReplayReceipt): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const normalized = normalizeReceipt(receipt, this.nowEpochSeconds());
      await this.ensureConnected();
      const result = await this.client.set(
        replayKey(this.keyPrefix, normalized.issuer, normalized.jti),
        '1',
        'EX',
        normalized.ttlSeconds,
        'NX',
      );
      if (result !== 'OK' && result !== null) throw new Error('Unexpected Redis SET response');
      logger.debug({ accepted: result === 'OK', durationMs: Date.now() - startedAt }, 'Delegation replay receipt consumed');
      return result === 'OK';
    } catch (error) {
      if (error instanceof DelegationReplayStoreUnavailableError) throw error;
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Delegation replay receipt failed closed');
      throw new DelegationReplayStoreUnavailableError();
    }
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        this.client.disconnect?.();
        return;
      }
      if (this.client.quit) await this.client.quit();
      else this.client.disconnect?.();
    } catch (error) {
      logger.error({ err: error }, 'Delegation replay Redis shutdown failed');
      this.client.disconnect?.();
    }
  }

  /**
   * Waits for the lazy client's first connection. A caller that arrives while another caller's
   * connect is still in flight joins that connect: by then the status has left `wait`, and with the
   * offline queue off a SET issued before the status is `ready` is refused. A failed connect
   * rejects every caller that joined it, and consume() maps each to the unavailable error.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (!this.client.connect || this.client.status !== 'wait') return;
    this.connectPromise = this.client.connect().finally(() => { this.connectPromise = null; });
    await this.connectPromise;
  }
}

function systemEpochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function normalizePrefix(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(normalized)) {
    throw new DelegationReplayStoreUnavailableError();
  }
  return normalized;
}

function normalizeReceipt(
  receipt: DelegationReplayReceipt,
  now: number,
): DelegationReplayReceipt & { ttlSeconds: number } {
  if (!receipt || typeof receipt.issuer !== 'string' || typeof receipt.jti !== 'string') {
    throw new DelegationReplayStoreUnavailableError();
  }
  const remaining = receipt.retainUntilEpochSeconds - now;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new DelegationReplayStoreUnavailableError();
  }
  return {
    ...receipt,
    ttlSeconds: Math.min(remaining, MAX_REPLAY_TTL_SECONDS),
  };
}

function replayKey(prefix: string, issuer: string, jti: string): string {
  const digest = createHash('sha256').update(issuer, 'utf8').update('\0').update(jti, 'utf8').digest('hex');
  return `${prefix}:${digest}`;
}
