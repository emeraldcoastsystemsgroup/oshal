/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins the paper/live execution boundary. The paper book must be UNABLE to reach the real Schwab account, no matter how the broker env is set: Schwab is the live rail only, and paper always resolves to Alpaca's paper endpoint. Written after the 2026-07-08 order-ledger collision, where a paper order and a live order shared a client_order_id and overwrote each other's rows. Execution never crossed (this boundary held) but the LEDGER did, so these tests exist to keep the boundary honest while the ledger fix (book-scoped idempotency, migration 065) covers the recording side.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { getBrokerAdapter, getBrokerReader, brokerProviderFor } from '../../src/features/trading/services/broker-provider';

const BROKER_ENV = ['BROKER_PROVIDER', 'BROKER_PROVIDER_PAPER', 'BROKER_PROVIDER_LIVE', 'TRADING_LIVE_ENABLED'] as const;
const SUB = 'test-sub';

describe('paper/live execution isolation', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(BROKER_ENV.map((k) => [k, process.env[k]]));
    for (const k of BROKER_ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of BROKER_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults the paper book to alpaca', () => {
    expect(brokerProviderFor('paper')).toBe('alpaca');
    const paper = getBrokerReader('paper', SUB);
    expect(paper.provider).toBe('alpaca');
    expect(paper.mode()).toBe('paper');
  });

  it('REFUSES a paper Schwab adapter even when BROKER_PROVIDER_PAPER says schwab', () => {
    process.env.BROKER_PROVIDER_PAPER = 'schwab';
    expect(() => getBrokerReader('paper', SUB)).toThrow(/no paper account/i);
  });

  it('REFUSES a paper Schwab adapter even when the GLOBAL default is schwab', () => {
    process.env.BROKER_PROVIDER = 'schwab';
    expect(() => getBrokerReader('paper', SUB)).toThrow(/no paper account/i);
  });

  it('refuses a paper Schwab adapter on the gated placement path too, not just reads', () => {
    process.env.BROKER_PROVIDER_PAPER = 'schwab';
    expect(() => getBrokerAdapter('paper', SUB)).toThrow(/no paper account/i);
  });

  it('routes the live book to schwab and stamps it live', () => {
    process.env.BROKER_PROVIDER_LIVE = 'schwab';
    const live = getBrokerReader('live', SUB);
    expect(live.provider).toBe('schwab');
    expect(live.mode()).toBe('live');
  });

  it('blocks live PLACEMENT unless TRADING_LIVE_ENABLED is exactly "true"', () => {
    process.env.BROKER_PROVIDER_LIVE = 'schwab';
    for (const v of [undefined, 'false', 'TRUE', '1', 'yes']) {
      if (v === undefined) delete process.env.TRADING_LIVE_ENABLED;
      else process.env.TRADING_LIVE_ENABLED = v;
      expect(() => getBrokerAdapter('live', SUB)).toThrow(/Live trading is disabled/i);
    }
    process.env.TRADING_LIVE_ENABLED = 'true';
    expect(getBrokerAdapter('live', SUB).provider).toBe('schwab');
  });

  it('keeps live READS available while live placement is disabled', () => {
    process.env.BROKER_PROVIDER_LIVE = 'schwab';
    delete process.env.TRADING_LIVE_ENABLED;
    // The reconciler depends on this: the ledger must keep syncing when trading is halted.
    expect(getBrokerReader('live', SUB).provider).toBe('schwab');
  });

  it('never lets an adapter misreport which book it belongs to', () => {
    process.env.BROKER_PROVIDER_LIVE = 'schwab';
    expect(getBrokerReader('paper', SUB).mode()).toBe('paper');
    expect(getBrokerReader('live', SUB).mode()).toBe('live');
  });
});
