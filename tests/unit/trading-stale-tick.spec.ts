/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins the tick-freshness guard that ends the extended-hours cancel/re-place loop. Regression anchor for the 2026-07-07/08 incident: MRNA's protective sell re-placed 97 times at a frozen 79.54 limit (last IEX print 17.3h old) while the stock walked down to 74.61, so the exit never became marketable and never filled.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { isTickStale, maxTickAgeSec } from '../../src/features/trading/services/market-data';
import type { TradeTick } from '../../src/features/trading/services/market-data';

/** A trade print `ageSec` seconds before `now`. */
const tickAged = (ageSec: number, price = 79.78, now = Date.now()): TradeTick =>
  ({ price, asOf: new Date(now - ageSec * 1000) });

describe('trade-tick freshness guard', () => {
  beforeEach(() => { delete process.env.TRADING_EXT_QUOTE_MAX_AGE_SEC; });
  afterEach(() => { delete process.env.TRADING_EXT_QUOTE_MAX_AGE_SEC; });

  it('defaults to a 120s ceiling', () => {
    expect(maxTickAgeSec()).toBe(120);
  });

  it('treats a missing tick as stale — an undateable price must never set a limit', () => {
    expect(isTickStale(null)).toBe(true);
  });

  it('accepts a print from within the ceiling', () => {
    expect(isTickStale(tickAged(5))).toBe(false);
    expect(isTickStale(tickAged(119))).toBe(false);
  });

  it('rejects a print past the ceiling', () => {
    expect(isTickStale(tickAged(121))).toBe(true);
  });

  it('rejects the MRNA print that drove the 97-order loop (17.3h old)', () => {
    // The exact incident shape: IEX had not printed MRNA since the prior regular close, so every
    // 5-min fire re-priced the "protective" sell to the same 79.54 while the market was at 74.61.
    const frozen = tickAged(17.3 * 3600, 79.78);
    expect(isTickStale(frozen)).toBe(true);
  });

  it('honours the TRADING_EXT_QUOTE_MAX_AGE_SEC override', () => {
    process.env.TRADING_EXT_QUOTE_MAX_AGE_SEC = '600';
    expect(maxTickAgeSec()).toBe(600);
    expect(isTickStale(tickAged(300))).toBe(false);
    expect(isTickStale(tickAged(601))).toBe(true);
  });

  it('falls back to the default on a garbage or non-positive override', () => {
    for (const bad of ['abc', '0', '-30', '']) {
      process.env.TRADING_EXT_QUOTE_MAX_AGE_SEC = bad;
      expect(maxTickAgeSec()).toBe(120);
    }
  });

  it('is evaluated against the injected clock, not wall time', () => {
    const now = Date.UTC(2026, 6, 8, 13, 25, 0);
    // The 07-08 09:25 ET fire, pricing off the 07-07 16:05 ET close.
    expect(isTickStale({ price: 79.78, asOf: new Date(Date.UTC(2026, 6, 7, 20, 5, 0)) }, now)).toBe(true);
    // Same fire, but the venue actually printed 30s ago.
    expect(isTickStale({ price: 74.61, asOf: new Date(now - 30_000) }, now)).toBe(false);
  });
});
