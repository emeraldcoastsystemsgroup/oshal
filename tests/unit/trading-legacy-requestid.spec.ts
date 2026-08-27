/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-134 PR1 flag-off byte-parity guards, no DB needed: legacy-book requestId text equals the pre-ADR `auto-paper-…`/`auto-live-…` format exactly; a BINDING passed while TRADING_MULTI_ACCOUNT is off is ignored by the factory (today's adapter path, no resolver-capability throw), while flag ON enforces the connectionKey-capable-resolver fail-closed rule; and source guards pin the dispatch's fail-closed breaker shape (an evaluateEquityGuard error must read as HALTED, never as null→not-halted).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { legacyBook } from '../../src/app/trading-books-store';
import { registerSchwabTokenResolver, getBrokerReader } from '../../src/features/trading/services/broker-provider';

const SUB = 'sub-parity';

beforeEach(() => { delete process.env.TRADING_MULTI_ACCOUNT; process.env.BROKER_PROVIDER_LIVE = 'schwab'; });
afterEach(() => { delete process.env.TRADING_MULTI_ACCOUNT; delete process.env.BROKER_PROVIDER_LIVE; });

describe('legacy id text is byte-identical to the pre-ADR format', () => {
  it('requestId built from a legacy book equals the historical auto-<mode>-<minute>-<SYM>-<side> string', () => {
    const minute = new Date().toISOString().slice(0, 16);
    for (const kind of ['paper', 'live'] as const) {
      const book = legacyBook(SUB, kind);
      const fromBook = `auto-${book.ref}-${minute}-NVDA-buy`;
      const historical = `auto-${kind}-${minute}-NVDA-buy`;
      expect(fromBook).toBe(historical);
    }
  });
});

describe('flag-off adapter byte-parity (the ADR-134 D3.2 rule)', () => {
  const binding = { accountNumber: '99912345', connectionKey: 'second-login' };

  it('flag OFF: a binding is IGNORED — even a 2-arg (pre-ADR) resolver constructs without a throw', () => {
    registerSchwabTokenResolver(async (_mode, _sub) => null); // the deployed store twin's shape
    expect(() => getBrokerReader('live', SUB, binding)).not.toThrow();
  });

  it('flag ON: a connectionKey-bound book REFUSES a resolver that cannot select connections (fail-closed)', () => {
    process.env.TRADING_MULTI_ACCOUNT = 'true';
    registerSchwabTokenResolver(async (_mode, _sub) => null);
    expect(() => getBrokerReader('live', SUB, binding)).toThrow(/cannot select connections/);
  });

  it('flag ON: a connectionKey-capable resolver constructs the bound adapter', () => {
    process.env.TRADING_MULTI_ACCOUNT = 'true';
    registerSchwabTokenResolver(async (_mode, _sub, _connectionKey) => null);
    expect(() => getBrokerReader('live', SUB, binding)).not.toThrow();
  });
});

describe('source guards — the fail-closed breaker shape in dispatch', () => {
  const src = readFileSync('src/app/trading-schedule-dispatch.ts', 'utf8');

  it('no evaluateEquityGuard call may fail OPEN via .catch(() => null)', () => {
    const failOpen = /evaluateEquityGuard[\s\S]{0,120}?\.catch\(\(\)\s*=>\s*null\)/;
    expect(failOpen.test(src), 'an evaluateEquityGuard error must halt new risk, never read as not-halted').toBe(false);
  });

  it('both breaker call sites return halted:true from their catch handlers', () => {
    const matches = src.match(/evaluateEquityGuard[\s\S]{0,400}?halted:\s*true/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
