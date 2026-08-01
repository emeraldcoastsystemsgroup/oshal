/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — hand-pinned guards for the Globex session + holiday calendar: the 115-hour trading week, the 17:00 maintenance-halt exclusion, evening-segment ownership by the NEXT day, holiday closures (incl. Good Friday via Easter math and weekend observance shifts), 13:00 early closes, trading-day counts, and the mock/expected consistency this calendar underwrites. Every pin is computed BY HAND from the published Globex schedule, never from the module under test — a broken calendar cannot certify itself.
 */
import { describe, it, expect } from 'vitest';
import {
  easterSunday, usFuturesHolidays, sessionDayKind, isSessionBucket, countSessionBuckets,
  tradingDaysBetween,
} from '../../src/features/trading';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Epoch-ms for a wall-clock instant carried in UTC fields (the Kibot convention). */
function wall(iso: string): number {
  return Date.parse(iso);
}

describe('easterSunday — the Good Friday anchor', () => {
  it('pins known Easter dates across the Kibot data range', () => {
    // Published Gregorian Easter dates — hand-checked, not derived from the module.
    expect(easterSunday(2021).toISOString().slice(0, 10)).toBe('2021-04-04');
    expect(easterSunday(2024).toISOString().slice(0, 10)).toBe('2024-03-31');
    expect(easterSunday(2025).toISOString().slice(0, 10)).toBe('2025-04-20');
    expect(easterSunday(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
  });
});

describe('usFuturesHolidays — the rule-computed schedule', () => {
  it('computes the 2024 closures and early closes on their observed dates', () => {
    const map = new Map(usFuturesHolidays(2024).map((h) => [h.name, h]));
    expect(map.get("New Year's Day")).toMatchObject({ dateIso: '2024-01-01', kind: 'closed' });
    expect(map.get('Martin Luther King Jr. Day')).toMatchObject({ dateIso: '2024-01-15', kind: 'early-close' });
    expect(map.get('Good Friday')).toMatchObject({ dateIso: '2024-03-29', kind: 'closed' });
    expect(map.get('Memorial Day')).toMatchObject({ dateIso: '2024-05-27', kind: 'early-close' });
    expect(map.get('Juneteenth')).toMatchObject({ dateIso: '2024-06-19', kind: 'early-close' });
    expect(map.get('Independence Day')).toMatchObject({ dateIso: '2024-07-04', kind: 'early-close' });
    expect(map.get('Labor Day')).toMatchObject({ dateIso: '2024-09-02', kind: 'early-close' });
    expect(map.get('Thanksgiving Day')).toMatchObject({ dateIso: '2024-11-28', kind: 'early-close' });
    expect(map.get('Christmas Day')).toMatchObject({ dateIso: '2024-12-25', kind: 'closed' });
  });

  it('shifts weekend holidays to their observed weekday (July 4 2026 = Saturday → Friday July 3)', () => {
    const found = usFuturesHolidays(2026).find((h) => h.name === 'Independence Day');
    expect(found).toMatchObject({ dateIso: '2026-07-03', kind: 'early-close' });
  });

  it('a New Year observed in the PRIOR December lists under the prior year (2022 → Fri 2021-12-31)', () => {
    // Jan 1 2022 is a Saturday; federal observance is Friday 2021-12-31.
    expect(usFuturesHolidays(2021).some((h) => h.name === "New Year's Day" && h.dateIso === '2021-12-31')).toBe(true);
    expect(usFuturesHolidays(2022).some((h) => h.name === "New Year's Day")).toBe(false);
  });

  it('does not fabricate Juneteenth before CME observed it (2022)', () => {
    expect(usFuturesHolidays(2021).some((h) => h.name === 'Juneteenth')).toBe(false);
    expect(usFuturesHolidays(2022).some((h) => h.name === 'Juneteenth')).toBe(true);
  });

  it('sessionDayKind reads open / early-close / closed off the map', () => {
    expect(sessionDayKind(wall('2024-03-29T10:00:00Z'))).toBe('closed');       // Good Friday
    expect(sessionDayKind(wall('2024-11-28T10:00:00Z'))).toBe('early-close');  // Thanksgiving
    expect(sessionDayKind(wall('2024-11-27T10:00:00Z'))).toBe('open');         // the Wednesday before
  });
});

describe('isSessionBucket — the Globex week, hour by hour', () => {
  // 2026-01-05 is a plain Monday; 2026-01-04 the Sunday before; 2026-01-09 the Friday after.
  it('a plain weekday trades 00:00–16:59 and 18:00–23:59, never the 17:00 maintenance hour', () => {
    expect(isSessionBucket(wall('2026-01-05T10:00:00Z'), HOUR)).toBe(true);
    expect(isSessionBucket(wall('2026-01-05T16:00:00Z'), HOUR)).toBe(true);
    expect(isSessionBucket(wall('2026-01-05T17:00:00Z'), HOUR)).toBe(false); // the halt
    expect(isSessionBucket(wall('2026-01-05T18:00:00Z'), HOUR)).toBe(true);  // next session opens
    expect(isSessionBucket(wall('2026-01-05T23:00:00Z'), HOUR)).toBe(true);
  });

  it('the weekend: Friday evening, Saturday, and Sunday before 18:00 are closed; Sunday 18:00 opens', () => {
    expect(isSessionBucket(wall('2026-01-09T16:00:00Z'), HOUR)).toBe(true);   // Friday day session
    expect(isSessionBucket(wall('2026-01-09T18:00:00Z'), HOUR)).toBe(false);  // Friday evening
    expect(isSessionBucket(wall('2026-01-10T12:00:00Z'), HOUR)).toBe(false);  // Saturday
    expect(isSessionBucket(wall('2026-01-04T12:00:00Z'), HOUR)).toBe(false);  // Sunday day
    expect(isSessionBucket(wall('2026-01-04T18:00:00Z'), HOUR)).toBe(true);   // Sunday open
  });

  it('a fully closed holiday has no day session AND suppresses the prior evening segment', () => {
    // Christmas 2025 falls on a Thursday.
    expect(isSessionBucket(wall('2025-12-25T10:00:00Z'), HOUR)).toBe(false);  // the closed day
    expect(isSessionBucket(wall('2025-12-24T18:00:00Z'), HOUR)).toBe(false);  // Wed evening would open it
    expect(isSessionBucket(wall('2025-12-24T10:00:00Z'), HOUR)).toBe(true);   // Wed day session trades
  });

  it('an early-close day halts at 13:00 and reopens 18:00 as usual', () => {
    // Thanksgiving 2024, Thursday Nov 28.
    expect(isSessionBucket(wall('2024-11-28T10:00:00Z'), HOUR)).toBe(true);
    expect(isSessionBucket(wall('2024-11-28T12:00:00Z'), HOUR)).toBe(true);
    expect(isSessionBucket(wall('2024-11-28T13:00:00Z'), HOUR)).toBe(false); // early close
    expect(isSessionBucket(wall('2024-11-28T16:00:00Z'), HOUR)).toBe(false);
    expect(isSessionBucket(wall('2024-11-28T18:00:00Z'), HOUR)).toBe(true);  // evening reopen
  });

  it('daily buckets are trading-day tests: weekends and closures out, early closes still in', () => {
    expect(isSessionBucket(wall('2024-11-28T00:00:00Z'), DAY)).toBe(true);   // Thanksgiving prints a daily bar
    expect(isSessionBucket(wall('2024-03-29T00:00:00Z'), DAY)).toBe(false);  // Good Friday does not
    expect(isSessionBucket(wall('2024-03-30T00:00:00Z'), DAY)).toBe(false);  // Saturday
  });
});

describe('countSessionBuckets + tradingDaysBetween — the expected-bar arithmetic', () => {
  it('a plain full week holds exactly 115 hourly buckets (the ~23h Globex week)', () => {
    // Sun 2026-01-04 00:00 → Sun 2026-01-11 00:00 — no holidays. Sun 6 + Mon–Thu 4×23 + Fri 17.
    expect(countSessionBuckets(wall('2026-01-04T00:00:00Z'), wall('2026-01-11T00:00:00Z'), HOUR)).toBe(115);
  });

  it('one trading day of 5-minute buckets is 23 hours × 12', () => {
    // Monday 2026-01-05 00:00 → Tuesday 00:00: day 17h + evening 6h = 23h in session.
    expect(countSessionBuckets(wall('2026-01-05T00:00:00Z'), wall('2026-01-06T00:00:00Z'), 5 * 60_000)).toBe(23 * 12);
  });

  it('a week containing a full closure loses the whole day AND its opening evening (Christmas 2025)', () => {
    // Sun 2025-12-21 → Sun 2025-12-28: Christmas Thursday closed. A plain week is 115; the closure
    // removes Thu's 17 day-hours and Wed's 6 evening-hours, and Fri's own day session survives.
    expect(countSessionBuckets(wall('2025-12-21T00:00:00Z'), wall('2025-12-28T00:00:00Z'), HOUR)).toBe(115 - 17 - 6);
  });

  it('an early close trims exactly the 13:00–17:00 hours (Thanksgiving week 2024)', () => {
    // Sun 2024-11-24 → Sun 2024-12-01: Thanksgiving Thursday early-close = −4 hours.
    expect(countSessionBuckets(wall('2024-11-24T00:00:00Z'), wall('2024-12-01T00:00:00Z'), HOUR)).toBe(115 - 4);
  });

  it('tradingDaysBetween drops closures but keeps early closes (Thanksgiving week = 5, Good Friday week = 4)', () => {
    expect(tradingDaysBetween(new Date('2024-11-24T00:00:00Z'), new Date('2024-12-01T00:00:00Z'))).toBe(5);
    expect(tradingDaysBetween(new Date('2024-03-24T00:00:00Z'), new Date('2024-03-31T00:00:00Z'))).toBe(4);
  });
});
