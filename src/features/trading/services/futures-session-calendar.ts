/**
 * Exchange session + holiday calendar — the real CME Globex trading week (ADR-116).
 *
 * Replaces the continuous-24h-weekday approximation that made every real trading day look one bar
 * short (the 17:00 maintenance halt read as a missing bucket) and every exchange holiday look like
 * a broken download. The model is the Globex schedule shared by every root this stack trades
 * (CME/CBOT equity index, NYMEX energy):
 *
 *  - The trading WEEK runs Sunday 18:00 → Friday 17:00 (exchange-local wall time).
 *  - Each weekday has a maintenance halt 17:00–18:00; the evening segment (18:00–24:00) that
 *    follows belongs to the NEXT calendar day's session.
 *  - Holidays come in two kinds: 'closed' (no session at all — Good Friday, Christmas, New Year's
 *    Day) and 'early-close' (the day session halts at 13:00 — MLK, Presidents' Day, Memorial Day,
 *    Juneteenth, Independence Day, Labor Day, Thanksgiving). A 'closed' day also suppresses the
 *    prior evening's segment, because that segment would have opened the closed session.
 *
 * TIMESTAMP CONVENTION (load-bearing — read before doing any session math): every function here
 * reads a timestamp's UTC FIELDS as EXCHANGE-LOCAL WALL TIME. That is the Kibot convention — their
 * files stamp exchange-local wall clock into what parses as UTC — and it is what makes this module
 * DST-proof: the session boundaries are fixed wall-clock instants (17:00/18:00 ET year-round), so
 * no timezone database is needed. `MockFuturesDataSource` emits the same convention, so mock and
 * real bars finally mean the same wall-clock hours (see the timestamp-convention note in
 * docs/apps/trading/futures-backtester.md).
 *
 * Honest limits: the holiday table is the RECURRING federal-holiday schedule as CME observes it,
 * computed from rules (third-Monday math, Easter via Butcher's algorithm, weekend observance
 * shifts) — it does not carry per-year exchange notices (one-off closures, mourning days, the
 * occasional shortened Good Friday session). The completeness threshold absorbs that residue; a
 * per-notice table can layer on later without changing any caller.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — Globex ~23h session model (Sun 18:00 → Fri 17:00 wall, 17:00–18:00 maintenance halt), rule-computed US futures holiday calendar (closed vs 13:00 early-close, weekend observance, Easter math), session-bucket predicate + counters. Drives expectedBarCount, the completeness gap detector, and the mock source; closes the BACKLOG "Exchange session + holiday calendar" item.
 *
 * @module futures-session-calendar
 */

/** How a calendar day trades. */
export type SessionDayKind = 'open' | 'closed' | 'early-close';

/** One exchange holiday, on its OBSERVED date. */
export interface ExchangeHoliday {
  /** Observed date, `YYYY-MM-DD` (wall-clock calendar date). */
  dateIso: string;
  /** Human name, e.g. 'Good Friday'. */
  name: string;
  /** 'closed' = no session; 'early-close' = the day session halts at {@link EARLY_CLOSE_MINUTE}. */
  kind: 'closed' | 'early-close';
}

/** Wall-clock minute the day session ends (17:00). */
export const SESSION_CLOSE_MINUTE = 17 * 60;
/** Wall-clock minute the evening segment opens (18:00) — the next session's start. */
export const SESSION_OPEN_MINUTE = 18 * 60;
/** Wall-clock minute an early-close day's session halts (13:00). */
export const EARLY_CLOSE_MINUTE = 13 * 60;

const MS_PER_DAY = 86_400_000;

/**
 * @description Easter Sunday for a year (Gregorian), via Butcher's algorithm — the input to the
 * Good Friday closure, the one moving full-closure holiday on the futures calendar.
 * @param year - Four-digit year.
 * @returns Easter Sunday at UTC-field midnight.
 */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** The Nth weekday-of-month (n 1-based; dow 0=Sun..6=Sat), UTC-field midnight. */
function nthWeekday(year: number, month1: number, dow: number, n: number): Date {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const offset = (dow - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month1 - 1, 1 + offset + (n - 1) * 7));
}

/** The LAST weekday-of-month, UTC-field midnight. */
function lastWeekday(year: number, month1: number, dow: number): Date {
  const last = new Date(Date.UTC(year, month1, 0)); // day 0 of next month = last of this
  const back = (last.getUTCDay() - dow + 7) % 7;
  return new Date(last.getTime() - back * MS_PER_DAY);
}

/** Federal weekend observance: Saturday → the Friday before, Sunday → the Monday after. */
function observed(d: Date): Date {
  const dow = d.getUTCDay();
  if (dow === 6) return new Date(d.getTime() - MS_PER_DAY);
  if (dow === 0) return new Date(d.getTime() + MS_PER_DAY);
  return d;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Holidays whose RULE anchors in `year` (an observed date may spill into an adjacent year). */
function ruleHolidays(year: number): ExchangeHoliday[] {
  const out: ExchangeHoliday[] = [
    { dateIso: iso(observed(new Date(Date.UTC(year, 0, 1)))), name: "New Year's Day", kind: 'closed' },
    { dateIso: iso(nthWeekday(year, 1, 1, 3)), name: 'Martin Luther King Jr. Day', kind: 'early-close' },
    { dateIso: iso(nthWeekday(year, 2, 1, 3)), name: "Presidents' Day", kind: 'early-close' },
    { dateIso: iso(new Date(easterSunday(year).getTime() - 2 * MS_PER_DAY)), name: 'Good Friday', kind: 'closed' },
    { dateIso: iso(lastWeekday(year, 5, 1)), name: 'Memorial Day', kind: 'early-close' },
    { dateIso: iso(observed(new Date(Date.UTC(year, 6, 4)))), name: 'Independence Day', kind: 'early-close' },
    { dateIso: iso(nthWeekday(year, 9, 1, 1)), name: 'Labor Day', kind: 'early-close' },
    { dateIso: iso(nthWeekday(year, 11, 4, 4)), name: 'Thanksgiving Day', kind: 'early-close' },
    { dateIso: iso(observed(new Date(Date.UTC(year, 11, 25)))), name: 'Christmas Day', kind: 'closed' },
  ];
  if (year >= 2022) {
    // CME began observing Juneteenth in 2022; listing it earlier would fabricate closures.
    out.push({ dateIso: iso(observed(new Date(Date.UTC(year, 5, 19)))), name: 'Juneteenth', kind: 'early-close' });
  }
  return out;
}

/** date-iso → holiday, covering [year−1 .. year+1] rules so observance spill never drops one. */
const holidayCache = new Map<number, Map<string, ExchangeHoliday>>();

function holidayMap(year: number): Map<string, ExchangeHoliday> {
  const hit = holidayCache.get(year);
  if (hit) return hit;
  const map = new Map<string, ExchangeHoliday>();
  for (const y of [year - 1, year, year + 1]) {
    for (const h of ruleHolidays(y)) {
      if (h.dateIso.startsWith(String(year))) map.set(h.dateIso, h);
    }
  }
  holidayCache.set(year, map);
  return map;
}

/**
 * @description The observed US futures holidays for a calendar year, date-ascending.
 * @param year - Four-digit year.
 * @returns Holidays observed IN that year (a New Year observed Dec 31 lists under the prior year).
 */
export function usFuturesHolidays(year: number): ExchangeHoliday[] {
  return [...holidayMap(year).values()].sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

/**
 * @description How the calendar day containing `wallMs` trades. Weekends are NOT reported here —
 * this is the holiday axis only; combine with the day-of-week rules (or just use
 * {@link isSessionBucket}).
 * @param wallMs - Epoch-ms whose UTC fields carry exchange-local wall time.
 * @returns 'open' | 'closed' | 'early-close'.
 */
export function sessionDayKind(wallMs: number): SessionDayKind {
  const d = new Date(wallMs);
  const h = holidayMap(d.getUTCFullYear()).get(d.toISOString().slice(0, 10));
  return h ? h.kind : 'open';
}

/**
 * @description Whether a bar bucket starting at `bucketStartMs` lies inside the trading session.
 * Daily-or-coarser buckets are tested as trading DAYS (weekday, not fully closed); intraday
 * buckets get the full Globex shape — weekend close, 17:00–18:00 maintenance halt, evening
 * segment ownership by the NEXT day, holiday closures and 13:00 early closes.
 * @param bucketStartMs - Bucket start, epoch-ms, UTC fields = exchange-local wall time.
 * @param barMs - Bucket length in ms.
 * @returns True when the bucket should contain trading.
 */
export function isSessionBucket(bucketStartMs: number, barMs: number): boolean {
  const d = new Date(bucketStartMs);
  const dow = d.getUTCDay();
  if (barMs >= MS_PER_DAY) {
    return dow !== 0 && dow !== 6 && sessionDayKind(bucketStartMs) !== 'closed';
  }
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minute >= SESSION_OPEN_MINUTE) {
    // Evening segment — it opens the NEXT day's session. Friday and Saturday evenings never
    // trade; Sun–Thu evenings trade unless the day they open is fully closed.
    if (dow === 5 || dow === 6) return false;
    return sessionDayKind(bucketStartMs + MS_PER_DAY) !== 'closed';
  }
  if (minute >= SESSION_CLOSE_MINUTE) return false; // the 17:00 maintenance/close hour
  if (dow === 0 || dow === 6) return false; // Saturday, and Sunday before the 18:00 open
  const kind = sessionDayKind(bucketStartMs);
  if (kind === 'closed') return false;
  if (kind === 'early-close' && minute >= EARLY_CLOSE_MINUTE) return false;
  return true;
}

/**
 * @description Count bar buckets inside the trading session over [fromMs, toMs), on the epoch
 * bucket grid — the expected-bar denominator and the gap detector's "how many bars SHOULD sit
 * between these two present ones".
 * @param fromMs - Range start (inclusive), epoch-ms, wall-clock convention.
 * @param toMs - Range end (exclusive).
 * @param barMs - Bucket length in ms.
 * @returns Number of session buckets.
 */
export function countSessionBuckets(fromMs: number, toMs: number, barMs: number): number {
  let n = 0;
  for (let t = Math.ceil(fromMs / barMs) * barMs; t < toMs; t += barMs) {
    if (isSessionBucket(t, barMs)) n++;
  }
  return n;
}

/**
 * @description Count TRADING days (weekdays that are not fully closed) in [from, to) — the daily
 * expected-bar count. Early-close days still count: they print a daily bar.
 * @param from - Range start (inclusive).
 * @param to - Range end (exclusive).
 * @returns Number of trading days.
 */
export function tradingDaysBetween(from: Date, to: Date): number {
  let n = 0;
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let t = start; t < to.getTime(); t += MS_PER_DAY) {
    if (isSessionBucket(t, MS_PER_DAY)) n++;
  }
  return n;
}
