/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — pins the NYSE full-closure table (2026 + 2027, as the exchange publishes them: New Year's Day on a Saturday is NOT observed on the Friday, Christmas on a Saturday IS), the additive TRADING_MARKET_HOLIDAYS override (bare date + named entry, malformed ignored), the open-day null, and the REFRESH GUARD: this spec goes red once today is within NYSE_TABLE_REFRESH_LEAD_DAYS of NYSE_TABLE_HORIZON, so the static table is refreshed on purpose and never silently stale.
 */
import { describe, it, expect } from 'vitest';
import {
  NYSE_FULL_CLOSURES, NYSE_TABLE_HORIZON, NYSE_TABLE_REFRESH_LEAD_DAYS, MARKET_HOLIDAYS_ENV,
  nyseHolidays, nyseHolidayOn, operatorMarketHolidays, nyseTableDaysRemaining,
} from '../../src/features/trading';

describe('NYSE full closures — the published calendar, pinned', () => {
  it('2026: the ten full closures the exchange publishes (Independence Day observed Fri Jul 3)', () => {
    expect(nyseHolidays(2026).map((h) => h.dateIso)).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    ]);
    expect(nyseHolidayOn('2026-11-26')?.name).toBe('Thanksgiving Day');
    expect(nyseHolidayOn('2026-07-03')?.name).toMatch(/Independence Day/);
    expect(nyseHolidayOn('2026-09-07')?.name).toBe('Labor Day');
  });
  it('2027: Juneteenth observed Fri Jun 18, Independence Day observed Mon Jul 5, Christmas observed Fri Dec 24', () => {
    expect(nyseHolidays(2027).map((h) => h.dateIso)).toEqual([
      '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    ]);
  });
  it('every row is a weekday (the NYSE never lists a weekend closure) and the table is date-ascending with no duplicates', () => {
    const dates = NYSE_FULL_CLOSURES.map((h) => h.dateIso);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
    for (const d of dates) expect([0, 6]).not.toContain(new Date(`${d}T00:00:00Z`).getUTCDay());
  });
  it('early-close days and ordinary trading days are OPEN here (the runtime session check owns early closes)', () => {
    expect(nyseHolidayOn('2026-11-27')).toBeNull();   // day after Thanksgiving, 13:00 close
    expect(nyseHolidayOn('2026-12-24')).toBeNull();   // Christmas Eve, 13:00 close
    expect(nyseHolidayOn('2026-09-09')).toBeNull();
    expect(nyseHolidayOn('2027-12-31')).toBeNull();   // New Year's Day 2028 falls on a Saturday: NOT observed on the Friday
  });
});

describe(`${MARKET_HOLIDAYS_ENV} — operator-declared one-off closures are additive`, () => {
  it('a bare date and a named date are both closures; malformed entries are ignored, never a refusal on a typo', () => {
    const raw = ' 2026-09-09 , 2026-09-10=National Day of Mourning, not-a-date, 2026-9-1=bad ';
    expect(operatorMarketHolidays(raw)).toEqual([
      { dateIso: '2026-09-09', name: 'market holiday declared by the operator' },
      { dateIso: '2026-09-10', name: 'National Day of Mourning' },
    ]);
    expect(nyseHolidayOn('2026-09-10', raw)?.name).toBe('National Day of Mourning');
    expect(nyseHolidayOn('2026-09-11', raw)).toBeNull();
    expect(operatorMarketHolidays(undefined)).toEqual([]);
    expect(operatorMarketHolidays('')).toEqual([]);
  });
  it('the static table wins the name when both list a date', () => {
    expect(nyseHolidayOn('2026-11-26', '2026-11-26=Turkey Day')?.name).toBe('Thanksgiving Day');
  });
});

describe('refresh guard — the table must never go stale silently', () => {
  it(`horizon ${NYSE_TABLE_HORIZON} is the end of the last pinned year and the table reaches it`, () => {
    const lastYear = Math.max(...NYSE_FULL_CLOSURES.map((h) => Number(h.dateIso.slice(0, 4))));
    expect(NYSE_TABLE_HORIZON).toBe(`${lastYear}-12-31`);
    expect(nyseHolidays(lastYear).length).toBe(10);
  });
  it('days remaining is computed from the clock (a spec-injected clock 61 days out passes, 59 fails the threshold)', () => {
    const horizon = Date.parse(`${NYSE_TABLE_HORIZON}T00:00:00Z`);
    expect(nyseTableDaysRemaining(new Date(horizon - 61 * 86_400_000))).toBe(61);
    expect(nyseTableDaysRemaining(new Date(horizon - 59 * 86_400_000))).toBe(59);
    expect(nyseTableDaysRemaining(new Date(horizon + 86_400_000))).toBe(-1);
  });
  it(`RED when today is within ${NYSE_TABLE_REFRESH_LEAD_DAYS} days of the horizon: add next year's NYSE closures to nyse-holidays.ts and move NYSE_TABLE_HORIZON`, () => {
    const left = nyseTableDaysRemaining(new Date());
    expect(left, `NYSE holiday table expires ${NYSE_TABLE_HORIZON} (${left} days) — pin the next year's published closures and re-verify the rows`).toBeGreaterThan(NYSE_TABLE_REFRESH_LEAD_DAYS);
  });
});
