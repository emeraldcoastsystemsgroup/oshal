/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins the short-signal primitives: bear gate fails CLOSED on short history, Donchian breakdown/cover exclude today from the channel, trendBroken needs price below both SMAs with 20<50, relativeReturn is name-minus-market. These feed the bear-regime short strategy, so the edge cases (exact-equality, insufficient data) are the tests.
 */

import { describe, expect, it } from 'vitest';
import { sma, marketBearGate, donchianBreakdown, donchianCover, trendBroken, relativeReturn, shortEntrySignal } from '../../src/features/trading/services/short-signals';

/** Linear series helper: `len` closes from `from` to `to` inclusive. */
const ramp = (from: number, to: number, len: number): number[] =>
  Array.from({ length: len }, (_, i) => from + ((to - from) * i) / (len - 1));

describe('short-signal primitives', () => {
  it('sma: exact window average, null when short', () => {
    expect(sma([1, 2, 3, 4], 4)).toBe(2.5);
    expect(sma([1, 2, 3], 4)).toBeNull();
    expect(sma([10, 10, 40], 2)).toBe(25); // uses the LAST n
  });

  it('marketBearGate fails CLOSED without 200 sessions of history', () => {
    expect(marketBearGate(ramp(100, 50, 199))).toBe(false); // crashing, but unknowable regime → no shorts
  });

  it('marketBearGate opens below the 200-SMA and closes above it', () => {
    const flat = Array(200).fill(100);
    expect(marketBearGate([...flat, 90].slice(-200))).toBe(true);   // last close 90 < SMA≈100
    expect(marketBearGate([...flat, 110].slice(-200))).toBe(false); // last close 110 > SMA≈100
  });

  it('donchianBreakdown: strict new low vs the PRIOR n sessions (today excluded from the channel)', () => {
    const base = Array(55).fill(100);
    expect(donchianBreakdown([...base, 99.9], 55)).toBe(true);   // below every prior close
    expect(donchianBreakdown([...base, 100], 55)).toBe(false);   // equal is not a breakdown
    expect(donchianBreakdown([...base, 100.1], 55)).toBe(false);
    expect(donchianBreakdown(Array(55).fill(100), 55)).toBe(false); // n+1 bars required
  });

  it('donchianCover: strict new high vs the PRIOR n sessions', () => {
    const base = Array(20).fill(100);
    expect(donchianCover([...base, 100.1], 20)).toBe(true);
    expect(donchianCover([...base, 100], 20)).toBe(false);
  });

  it('trendBroken: down-trending series yes, up-trending series no', () => {
    expect(trendBroken(ramp(200, 100, 60))).toBe(true);   // falling: px < SMA20 < SMA50
    expect(trendBroken(ramp(100, 200, 60))).toBe(false);  // rising
    expect(trendBroken(ramp(200, 100, 49))).toBe(false);  // not enough for SMA50
  });

  it('relativeReturn: name return minus market return over n sessions', () => {
    const name = ramp(100, 90, 64);   // -10%
    const mkt = ramp(100, 100, 64);   // flat
    expect(relativeReturn(name, mkt, 63)).toBeCloseTo(-0.1, 10);
    expect(relativeReturn(name.slice(0, 63), mkt, 63)).toBeNull();
  });

  it('shortEntrySignal composes trend-break AND fresh breakdown', () => {
    // Downtrend that keeps printing new lows: both conditions true.
    expect(shortEntrySignal(ramp(200, 100, 120))).toBe(true);
    // Downtrend that just bounced above its recent lows: breakdown false.
    const bounced = [...ramp(200, 100, 120), 130];
    expect(shortEntrySignal(bounced)).toBe(false);
    // Fresh low inside an intact UPtrend (one bad day): trend not broken.
    const oneBadDay = [...ramp(100, 200, 120), 99];
    expect(donchianBreakdown(oneBadDay)).toBe(true);
    expect(shortEntrySignal(oneBadDay)).toBe(false);
  });
});
