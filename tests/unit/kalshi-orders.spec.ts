/**
 * Kalshi order guardrails (ADR-094 Phase 2).
 *
 * These guards are the only thing between a UI bug (or a stray script) and a real bet, so every
 * refusal path is pinned. The live-exchange gate itself is enforced in the route off the key's
 * DETECTED env — never a client-supplied flag — and is covered by the e2e pass.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — validateOrderRequest (confirm-required, limit bounds, integer/size/cost caps) + kalshiLiveOrdersEnabled default-off.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { kalshiLiveOrdersEnabled, validateOrderRequest } from '../../src/features/prediction-markets';

const VALID = { ticker: 'KXTEST-26JUL13-X', side: 'yes', action: 'buy', count: 5, priceCents: 60, confirm: true } as const;

describe('validateOrderRequest', () => {
  it('accepts a well-formed, explicitly confirmed limit order', () => {
    expect(validateOrderRequest({ ...VALID })).toBeNull();
  });

  it('REFUSES an unconfirmed order — confirm must be exactly true, not truthy', () => {
    expect(validateOrderRequest({ ...VALID, confirm: false })).toMatch(/not confirmed/);
    expect(validateOrderRequest({ ...VALID, confirm: undefined })).toMatch(/not confirmed/);
    // A truthy-but-not-true value (e.g. a stray string from a form) must NOT pass.
    expect(validateOrderRequest({ ...VALID, confirm: 'yes' as unknown as boolean })).toMatch(/not confirmed/);
  });

  it('rejects prices outside the 1..99¢ limit band (no market orders, no free/certain contracts)', () => {
    expect(validateOrderRequest({ ...VALID, priceCents: 0 })).toMatch(/priceCents/);
    expect(validateOrderRequest({ ...VALID, priceCents: 100 })).toMatch(/priceCents/);
    expect(validateOrderRequest({ ...VALID, priceCents: 45.5 })).toMatch(/priceCents/);
  });

  it('rejects non-positive, fractional, or oversized contract counts', () => {
    expect(validateOrderRequest({ ...VALID, count: 0 })).toMatch(/positive integer/);
    expect(validateOrderRequest({ ...VALID, count: -3 })).toMatch(/positive integer/);
    expect(validateOrderRequest({ ...VALID, count: 2.5 })).toMatch(/positive integer/);
    expect(validateOrderRequest({ ...VALID, count: 10_000 })).toMatch(/cap/);
  });

  it('caps total order cost, not just contract count — 99 contracts at 99¢ is $98', () => {
    // Under the 100-contract cap but far over the $50 default cost cap.
    const refusal = validateOrderRequest({ ...VALID, count: 99, priceCents: 99 });
    expect(refusal).toMatch(/cost/);
  });

  it('rejects malformed side/action/ticker', () => {
    expect(validateOrderRequest({ ...VALID, side: 'maybe' as unknown as 'yes' })).toMatch(/side/);
    expect(validateOrderRequest({ ...VALID, action: 'hedge' as unknown as 'buy' })).toMatch(/action/);
    expect(validateOrderRequest({ ...VALID, ticker: '' })).toMatch(/ticker/);
  });
});

describe('kalshiLiveOrdersEnabled', () => {
  const original = process.env.KALSHI_LIVE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.KALSHI_LIVE_ENABLED;
    else process.env.KALSHI_LIVE_ENABLED = original;
  });

  it('is OFF by default — real money requires an explicit opt-in', () => {
    delete process.env.KALSHI_LIVE_ENABLED;
    expect(kalshiLiveOrdersEnabled()).toBe(false);
  });

  it('only the exact string "true" enables it (not "1", not "yes")', () => {
    process.env.KALSHI_LIVE_ENABLED = '1';
    expect(kalshiLiveOrdersEnabled()).toBe(false);
    process.env.KALSHI_LIVE_ENABLED = 'yes';
    expect(kalshiLiveOrdersEnabled()).toBe(false);
    process.env.KALSHI_LIVE_ENABLED = 'true';
    expect(kalshiLiveOrdersEnabled()).toBe(true);
  });
});
