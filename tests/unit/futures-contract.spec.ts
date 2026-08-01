/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the ADR-116 futures instrument model: month-code round trips, third-Friday/roll dates, symbol parse/format (incl. multi-char roots MES/MYM), contiguous contract enumeration over a range, expected-bar count, active-contract lookup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Energy-root guards: CL/MCL metadata, the WTI preceding-month expiry rule (CLZ25 → 2025-11-20, matching the real data file's final bar; weekend-25th step-back via CLF17; January's prior-year reach), monthly gap-free tiling, and ES unaffected.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | expectedBarCount guards rewritten for the session calendar: daily = trading days (closures out, early closes in), hourly = real session buckets — pinned against an independent hand-count of the ESM24 window, replacing the retired 24h-weekday placeholder assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  contractSymbol, parseFuturesSymbol, monthCode, monthNumFromCode, thirdFriday, rollDate,
  expiryDate, contractsForRange, activeContractAt, barMinutes, expectedBarCount, weekdaysBetween,
  tradingDaysBetween, countSessionBuckets, getFuturesRoot, FUTURES_ROOTS,
} from '../../src/features/trading';

describe('month codes', () => {
  it('round-trips December ↔ Z and June ↔ M', () => {
    expect(monthCode(12)).toBe('Z');
    expect(monthCode(6)).toBe('M');
    expect(monthNumFromCode('Z')).toBe(12);
    expect(monthNumFromCode('m')).toBe(6);
  });
  it('returns 0 for a non-code letter', () => {
    expect(monthNumFromCode('A')).toBe(0);
  });
});

describe('expiry + roll dates', () => {
  it('third Friday of March 2025 is 2025-03-21', () => {
    expect(thirdFriday(2025, 3).toISOString().slice(0, 10)).toBe('2025-03-21');
  });
  it('expiry uses the third-Friday rule for equity index', () => {
    const es = getFuturesRoot('ES')!;
    expect(expiryDate(es, 12, 2025).toISOString().slice(0, 10)).toBe('2025-12-19');
  });
  it('rolls the default 8 days before expiry', () => {
    const es = getFuturesRoot('ES')!;
    // Dec 2025 expiry 2025-12-19 → roll 2025-12-11.
    expect(rollDate(es, 12, 2025).toISOString().slice(0, 10)).toBe('2025-12-11');
  });
});

describe('symbol parse + format', () => {
  it('builds ESZ25 from (ES, 12, 2025)', () => {
    expect(contractSymbol('ES', 12, 2025)).toBe('ESZ25');
  });
  it('parses a single-char-root symbol ESZ25', () => {
    const p = parseFuturesSymbol('ESZ25')!;
    expect(p.root.root).toBe('ES');
    expect(p.monthNum).toBe(12);
    expect(p.year).toBe(2025);
  });
  it('parses multi-char roots unambiguously (MESM24, MYMZ25)', () => {
    expect(parseFuturesSymbol('MESM24')!.root.root).toBe('MES');
    expect(parseFuturesSymbol('MESM24')!.monthNum).toBe(6);
    expect(parseFuturesSymbol('MYMZ25')!.root.root).toBe('MYM');
  });
  it('rejects an unknown root or malformed symbol', () => {
    expect(parseFuturesSymbol('ZZZ99')).toBeNull();
    expect(parseFuturesSymbol('ES25')).toBeNull();
  });
});

describe('contract enumeration', () => {
  const start = new Date('2024-01-01T00:00:00Z');
  const end = new Date('2024-12-31T00:00:00Z');
  const contracts = contractsForRange('ES', start, end);

  it('covers all four 2024 quarterlies', () => {
    const syms = contracts.map((c) => c.symbol);
    for (const s of ['ESH24', 'ESM24', 'ESU24', 'ESZ24']) expect(syms).toContain(s);
  });
  it('tiles the range with no gap between contracts (one roll = next active start)', () => {
    const h = contracts.find((c) => c.symbol === 'ESH24')!;
    const m = contracts.find((c) => c.symbol === 'ESM24')!;
    expect(m.activeStart.getTime()).toBe(h.activeEnd.getTime());
  });
  it('is empty for an unknown root', () => {
    expect(contractsForRange('NOPE', start, end)).toEqual([]);
  });
});

describe('expected-bar count (session-calendar-driven)', () => {
  const c = contractsForRange('ES', new Date('2024-01-01T00:00:00Z'), new Date('2024-12-31T00:00:00Z'))
    .find((x) => x.symbol === 'ESM24')!;
  const es = getFuturesRoot('ES')!;

  it('daily count equals TRADING days: weekdays minus full closures (Good Friday sits in ESM24)', () => {
    // ESM24 active window: 2024-03-07 (ESH24 roll) → 2024-06-13 (own roll) — 14 exact weeks,
    // 70 weekdays, containing exactly ONE full closure (Good Friday 2024-03-29; Memorial Day
    // 05-27 is an early close and still prints a daily bar). Hand-count: 69.
    expect(expectedBarCount(c, '1Day', es)).toBe(69);
    expect(expectedBarCount(c, '1Day', es)).toBe(weekdaysBetween(c.activeStart, c.activeEnd) - 1);
    expect(expectedBarCount(c, '1Day', es)).toBe(tradingDaysBetween(c.activeStart, c.activeEnd));
  });

  it('hourly count is the hand-counted session-bucket total, NOT 24× weekdays', () => {
    // 14 plain weeks × 115 Globex hours = 1610, minus the Good Friday closure (17 day-hours + the
    // 6 evening hours that would have opened it) and the Memorial Day early close (13:00–17:00,
    // −4): 1583. The retired placeholder said 70 weekdays × 24 = 1680 — 97 phantom bars, which is
    // exactly the ~6% shortfall real Kibot data kept being graded incomplete by.
    const expected = expectedBarCount(c, '1Hour', es);
    expect(expected).toBe(1583);
    expect(expected).toBe(countSessionBuckets(c.activeStart.getTime(), c.activeEnd.getTime(), 3_600_000));
    expect(expected).toBeLessThan(weekdaysBetween(c.activeStart, c.activeEnd) * 24);
  });
});

describe('active contract + bar minutes', () => {
  it('the active contract at a date has not yet rolled', () => {
    const asOf = new Date('2024-05-15T00:00:00Z');
    const active = activeContractAt('ES', asOf)!;
    expect(asOf.getTime()).toBeLessThan(active.roll.getTime());
    expect(active.symbol).toBe('ESM24'); // mid-May sits inside the June contract's window
  });
  it('maps timeframes to minutes', () => {
    expect(barMinutes('5Min')).toBe(5);
    expect(barMinutes('1Hour')).toBe(60);
    expect(barMinutes('1Day')).toBe(1440);
  });
  it('ships the equity-index roots with sane multipliers', () => {
    expect(FUTURES_ROOTS.ES.multiplier).toBe(50);
    expect(FUTURES_ROOTS.MES.multiplier).toBe(5);
  });
});

describe('energy roots (CL/MCL) — the WTI expiry rule', () => {
  const cl = getFuturesRoot('CL')!;

  it('ships CL/MCL with NYMEX metadata and all 12 listed months', () => {
    expect(cl.multiplier).toBe(1000);
    expect(cl.tickValue).toBe(10);
    expect(cl.months).toHaveLength(12);
    expect(FUTURES_ROOTS.MCL.multiplier).toBe(100);
  });

  it('CLZ25 expires 2025-11-20 — the real Kibot CLZ25 file ends on exactly this day', () => {
    // Nov 25 2025 is a Tuesday; 3 business days back: 24(Mon), 21(Fri), 20(Thu).
    expect(expiryDate(cl, 12, 2025).toISOString().slice(0, 10)).toBe('2025-11-20');
  });

  it('steps to the prior business day first when the 25th is a weekend (CLF17)', () => {
    // Jan 2017 contract: preceding month Dec 2016; Dec 25 is a Sunday → count from Fri Dec 23;
    // 3 business days back: 22(Thu), 21(Wed), 20(Tue).
    expect(expiryDate(cl, 1, 2017).toISOString().slice(0, 10)).toBe('2016-12-20');
  });

  it('a January contract reaches back into the prior YEAR for its expiry month', () => {
    // Dec 25 2024 is a Wednesday; 3 business days back: 24(Tue), 23(Mon), 20(Fri).
    expect(expiryDate(cl, 1, 2025).toISOString().slice(0, 10)).toBe('2024-12-20');
  });

  it('tiles a year with ~12 monthly contracts, gap-free', () => {
    const contracts = contractsForRange('CL', new Date('2025-01-01T00:00:00Z'), new Date('2025-12-31T00:00:00Z'));
    expect(contracts.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < contracts.length; i++) {
      expect(contracts[i].activeStart.getTime()).toBe(contracts[i - 1].activeEnd.getTime());
    }
  });

  it('parses CL contract symbols (CLF17, CLZ25)', () => {
    expect(parseFuturesSymbol('CLF17')!.root.root).toBe('CL');
    expect(parseFuturesSymbol('CLF17')!.monthNum).toBe(1);
    expect(parseFuturesSymbol('CLZ25')!.year).toBe(2025);
  });

  it('equity-index roots are untouched by the new rule (ES still third-Friday)', () => {
    expect(expiryDate(getFuturesRoot('ES')!, 12, 2025).toISOString().slice(0, 10)).toBe('2025-12-19');
  });
});
