/**
 * NYSE full-closure calendar — the days a timed (dated) order must be REFUSED at scheduling time
 * (ADR-136 D4 follow-up). A STATIC table, deliberately: the exchange publishes its holiday calendar
 * two to three years ahead and the dates are facts, not rules — the rule-computed futures calendar
 * (futures-session-calendar.ts) approximates them but cannot carry the exchange's own choices (New
 * Year's Day on a Saturday is NOT observed on the Friday by the NYSE, one-off closures are announced
 * by notice). No external fetch: a refusal at scheduling must work offline and deterministically.
 *
 * The table's horizon is guarded: tests/unit/nyse-holidays.spec.ts goes red once today is within
 * {@link NYSE_TABLE_REFRESH_LEAD_DAYS} of {@link NYSE_TABLE_HORIZON}, so the table is refreshed on
 * purpose, never silently stale. One-off closures (a day of mourning) are added by the operator with
 * TRADING_MARKET_HOLIDAYS (comma-separated `YYYY-MM-DD` or `YYYY-MM-DD=Name`; additive). Early-close
 * days (13:00 ET) are NOT modelled here — the runtime session check owns them, and a fire time after
 * an early close is placed in the post session by the venue's own rules.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — static NYSE full-closure table for 2026 + 2027 (verified against the exchange's published hours-and-calendars page), the additive TRADING_MARKET_HOLIDAYS override, the horizon/refresh-lead constants the guard spec reads, and nyseHolidayOn() for validateFireAt's scheduling-time refusal.
 *
 * @module nyse-holidays
 */

/** One full-closure day on the equities calendar. */
export interface MarketHoliday {
  /** Observed date, `YYYY-MM-DD` (Eastern calendar date). */
  dateIso: string;
  /** Human name as the refusal message states it, e.g. 'Thanksgiving Day'. */
  name: string;
}

/**
 * The NYSE full closures the table carries, date-ascending. Source: NYSE "Holidays & Trading Hours"
 * (nyse.com/markets/hours-calendars). Add the next year's rows when the guard spec turns red.
 */
export const NYSE_FULL_CLOSURES: ReadonlyArray<MarketHoliday> = [
  { dateIso: '2026-01-01', name: "New Year's Day" },
  { dateIso: '2026-01-19', name: 'Martin Luther King Jr. Day' },
  { dateIso: '2026-02-16', name: "Presidents' Day (Washington's Birthday)" },
  { dateIso: '2026-04-03', name: 'Good Friday' },
  { dateIso: '2026-05-25', name: 'Memorial Day' },
  { dateIso: '2026-06-19', name: 'Juneteenth National Independence Day' },
  { dateIso: '2026-07-03', name: 'Independence Day (observed)' },
  { dateIso: '2026-09-07', name: 'Labor Day' },
  { dateIso: '2026-11-26', name: 'Thanksgiving Day' },
  { dateIso: '2026-12-25', name: 'Christmas Day' },
  { dateIso: '2027-01-01', name: "New Year's Day" },
  { dateIso: '2027-01-18', name: 'Martin Luther King Jr. Day' },
  { dateIso: '2027-02-15', name: "Presidents' Day (Washington's Birthday)" },
  { dateIso: '2027-03-26', name: 'Good Friday' },
  { dateIso: '2027-05-31', name: 'Memorial Day' },
  { dateIso: '2027-06-18', name: 'Juneteenth National Independence Day (observed)' },
  { dateIso: '2027-07-05', name: 'Independence Day (observed)' },
  { dateIso: '2027-09-06', name: 'Labor Day' },
  { dateIso: '2027-11-25', name: 'Thanksgiving Day' },
  { dateIso: '2027-12-24', name: 'Christmas Day (observed)' },
];

/** The last calendar date the static table is authoritative for (the end of its last pinned year). */
export const NYSE_TABLE_HORIZON = '2027-12-31';
/** How many days before the horizon the guard spec demands a refresh. */
export const NYSE_TABLE_REFRESH_LEAD_DAYS = 60;
/** Env var carrying operator-declared one-off closures (comma-separated `YYYY-MM-DD[=Name]`, additive). */
export const MARKET_HOLIDAYS_ENV = 'TRADING_MARKET_HOLIDAYS';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @description The full closures the table lists for one calendar year (empty for a year outside the
 * table — callers that need a year past {@link NYSE_TABLE_HORIZON} must refresh the table first).
 * @param year - Four-digit year.
 * @returns Closures observed in that year, date-ascending.
 */
export function nyseHolidays(year: number): MarketHoliday[] {
  return NYSE_FULL_CLOSURES.filter((h) => h.dateIso.startsWith(`${year}-`));
}

/**
 * @description Operator-declared extra closures from TRADING_MARKET_HOLIDAYS. Malformed entries are
 * ignored (never a refusal on a typo); a bare date gets a generic name so the refusal still says why.
 * @param raw - The env value (injected for specs; defaults to process.env).
 * @returns The extra closures.
 */
export function operatorMarketHolidays(raw: string | undefined = process.env[MARKET_HOLIDAYS_ENV]): MarketHoliday[] {
  if (!raw) return [];
  const out: MarketHoliday[] = [];
  for (const entry of raw.split(',')) {
    const [date, ...rest] = entry.trim().split('=');
    if (!ISO_DATE.test(date)) continue;
    const name = rest.join('=').trim();
    out.push({ dateIso: date, name: name || 'market holiday declared by the operator' });
  }
  return out;
}

/**
 * @description Whether the equities market is fully closed on an Eastern calendar date: the static
 * NYSE table first, then the operator's additive TRADING_MARKET_HOLIDAYS. Weekends are NOT reported
 * here (the caller's weekday rule owns them); early-close days are open here by design.
 * @param dateIso - Eastern calendar date, `YYYY-MM-DD`.
 * @param envRaw - Override for the env value (specs); defaults to process.env.
 * @returns The holiday, or null when the market is open that day.
 */
export function nyseHolidayOn(dateIso: string, envRaw: string | undefined = process.env[MARKET_HOLIDAYS_ENV]): MarketHoliday | null {
  return NYSE_FULL_CLOSURES.find((h) => h.dateIso === dateIso) ?? operatorMarketHolidays(envRaw).find((h) => h.dateIso === dateIso) ?? null;
}

/**
 * @description Days between a clock and the table's horizon — the guard spec's number. Negative once
 * the horizon has passed.
 * @param now - The clock (injected for specs).
 * @returns Whole days from `now` (UTC date) to {@link NYSE_TABLE_HORIZON}.
 */
export function nyseTableDaysRemaining(now: Date = new Date()): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((Date.parse(`${NYSE_TABLE_HORIZON}T00:00:00Z`) - today) / 86_400_000);
}
