/**
 * Futures instrument model — the futures extension layer (ADR-116).
 *
 * The equities stack (ADR-052) has no concept of a contract that expires and hands off to the next
 * month. Futures do: an ES position is really a *sequence* of quarterly contracts (ESH → ESM → ESU →
 * ESZ), each active only between the prior contract's roll and its own. This module is the pure model
 * of that world — root metadata (multiplier, tick), month codes, expiry/roll math, contract
 * enumeration over a date range, and the *expected* bar count per contract that the completeness
 * validator (futures-completeness.ts) measures actual data against.
 *
 * This is where the friend's "how many hourly buckets must a whole contract have, given its rollover"
 * gap-checker concept lives — as a property of the instrument model, not a downstream patch step.
 *
 * Scope note: expected-bar math delegates to the Globex session + holiday calendar
 * (futures-session-calendar.ts) — the ~23h Sun-18:00→Fri-17:00 wall-clock week with the 17:00–18:00
 * maintenance halt and the rule-computed US holiday schedule. The EXPIRY/ROLL date math below still
 * approximates business days as weekdays (an expiry landing ON an exchange holiday is not shifted);
 * that residue is a different, far smaller item than the session shape. No I/O here; bar data
 * arrives from a FuturesDataSource and the store lives in the app layer.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — futures root registry (ES/MES/NQ/MNQ/YM/MYM/RTY/M2K), month codes, third-Friday expiry + configurable roll, contract enumeration over a range, active-contract lookup, weekday-approx expected-bar count. Foundation of the ADR-116 futures extension layer.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Energy roots: CL/MCL with all-12-month listing and the WTI expiry rule (3 business days before the 25th of the preceding month, per-root expiryRule field) — validated against the real CLZ25 file, whose last bar is the computed expiry day. Unblocks backtests on the crude minute data.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | expectedBarCount now counts REAL Globex session buckets (futures-session-calendar) instead of 24h weekdays — a five-year hourly ES contract set stops reading ~6% incomplete from phantom maintenance-halt/holiday buckets. Dropped the sessionHoursPerDay placeholder field the calendar supersedes; documented the wall-clock timestamp convention on FuturesBar.t.
 *
 * @module futures-contract
 */

import type { Timeframe, OhlcvBar } from './market-data';
import { countSessionBuckets, tradingDaysBetween } from './futures-session-calendar';

/** One OHLCV bar stamped with its bar-open instant — the intraday shape futures need. */
export interface FuturesBar extends OhlcvBar {
  /**
   * Bar-open timestamp, ISO-8601 (e.g. '2025-03-14T14:00:00.000Z'). CONVENTION: the UTC fields
   * carry EXCHANGE-LOCAL WALL TIME, not true UTC — Kibot stamps files that way, the mock source
   * emits the same shape, and every session-math consumer (entry windows, the session calendar)
   * reads it so. A 14:00 stamp means 2 p.m. on the exchange floor clock, year-round, DST-free.
   */
  t: string;
}

/** Static metadata for a futures root symbol. Multiplier/tick drive P&L and risk sizing. */
export interface FuturesRoot {
  /** Root ticker, e.g. 'ES'. */
  root: string;
  /** Human name, e.g. 'E-mini S&P 500'. */
  name: string;
  /** Listing exchange, e.g. 'CME' / 'CBOT'. */
  exchange: string;
  /** ISO-4217 currency the contract is denominated in. */
  currency: string;
  /** Dollar value of one full index/price point (ES = $50). marketValue = price × multiplier × qty. */
  multiplier: number;
  /** Minimum price increment (ES = 0.25). */
  tickSize: number;
  /** Dollar value of one tick (= multiplier × tickSize; ES = $12.50). */
  tickValue: number;
  /** Listed contract months as 1–12 numbers. Equity index = quarterly [3,6,9,12]; energy = all 12. */
  months: number[];
  /**
   * Which expiry-date rule applies. Default 'equity-index' (third Friday of the contract month).
   * 'cl-energy' is the WTI rule: 3 business days before the 25th calendar day of the month
   * PRECEDING the contract month (stepping to the prior business day first when the 25th is not
   * one). Weekday approximation, no holiday calendar — same scope note as the rest of the module.
   */
  expiryRule?: 'equity-index' | 'cl-energy';
}

/** A single dated futures contract: its symbol, key dates, and the window it is the active front month. */
export interface FuturesContract {
  /** Canonical symbol, e.g. 'ESZ25'. */
  symbol: string;
  /** The root, e.g. 'ES'. */
  root: string;
  /** Contract month, 1–12. */
  monthNum: number;
  /** Four-digit contract year. */
  year: number;
  /** Expiry / final-settlement date (equity index: the third Friday), UTC midnight. */
  expiry: Date;
  /** The roll date — when the market treats the NEXT contract as front (default: 8 days before expiry). */
  roll: Date;
  /** Start of this contract's active-front window (the PRIOR contract's roll date), UTC. */
  activeStart: Date;
  /** End of this contract's active-front window (this contract's roll date), UTC. */
  activeEnd: Date;
}

/** CME month codes, 1-indexed by calendar month. Index 0 is a placeholder so month N maps to MONTH_CODES[N]. */
const MONTH_CODES = ['', 'F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

/** Default calendar days before expiry that the front month rolls (equity index convention ≈ 8). */
export const DEFAULT_ROLL_DAYS_BEFORE_EXPIRY = 8;

const QUARTERLY = [3, 6, 9, 12];
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MS_PER_DAY = 86_400_000;

/** The built-in futures roots. Equity-index minis + micros; extend by appending a row. */
export const FUTURES_ROOTS: Readonly<Record<string, FuturesRoot>> = Object.freeze({
  ES:  { root: 'ES',  name: 'E-mini S&P 500',      exchange: 'CME',  currency: 'USD', multiplier: 50,  tickSize: 0.25, tickValue: 12.5,  months: QUARTERLY },
  MES: { root: 'MES', name: 'Micro E-mini S&P 500', exchange: 'CME',  currency: 'USD', multiplier: 5,   tickSize: 0.25, tickValue: 1.25,  months: QUARTERLY },
  NQ:  { root: 'NQ',  name: 'E-mini Nasdaq-100',    exchange: 'CME',  currency: 'USD', multiplier: 20,  tickSize: 0.25, tickValue: 5,     months: QUARTERLY },
  MNQ: { root: 'MNQ', name: 'Micro E-mini Nasdaq',  exchange: 'CME',  currency: 'USD', multiplier: 2,   tickSize: 0.25, tickValue: 0.5,   months: QUARTERLY },
  YM:  { root: 'YM',  name: 'E-mini Dow',           exchange: 'CBOT', currency: 'USD', multiplier: 5,   tickSize: 1,    tickValue: 5,     months: QUARTERLY },
  MYM: { root: 'MYM', name: 'Micro E-mini Dow',     exchange: 'CBOT', currency: 'USD', multiplier: 0.5, tickSize: 1,    tickValue: 0.5,   months: QUARTERLY },
  RTY: { root: 'RTY', name: 'E-mini Russell 2000',  exchange: 'CME',  currency: 'USD', multiplier: 50,  tickSize: 0.1,  tickValue: 5,     months: QUARTERLY },
  M2K: { root: 'M2K', name: 'Micro E-mini Russell',  exchange: 'CME',  currency: 'USD', multiplier: 5,   tickSize: 0.1,  tickValue: 0.5,   months: QUARTERLY },
  CL:  { root: 'CL',  name: 'Crude Oil (WTI)',       exchange: 'NYMEX', currency: 'USD', multiplier: 1000, tickSize: 0.01, tickValue: 10,  months: ALL_MONTHS, expiryRule: 'cl-energy' },
  MCL: { root: 'MCL', name: 'Micro WTI Crude Oil',   exchange: 'NYMEX', currency: 'USD', multiplier: 100,  tickSize: 0.01, tickValue: 1,   months: ALL_MONTHS, expiryRule: 'cl-energy' },
});

/**
 * @description Look up a root's metadata (case-insensitive).
 * @param root - Root ticker, e.g. 'es'.
 * @returns The FuturesRoot, or null if not a known root.
 */
export function getFuturesRoot(root: string): FuturesRoot | null {
  return FUTURES_ROOTS[root.trim().toUpperCase()] ?? null;
}

/** All known roots, sorted by ticker. */
export function listFuturesRoots(): FuturesRoot[] {
  return Object.values(FUTURES_ROOTS).sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * @description Map a 1–12 calendar month to its CME month code letter.
 * @param monthNum - Month, 1 (Jan) … 12 (Dec).
 * @returns The single-letter code (e.g. 12 → 'Z').
 * @throws If monthNum is outside 1–12.
 */
export function monthCode(monthNum: number): string {
  if (monthNum < 1 || monthNum > 12) throw new Error(`month out of range: ${monthNum}`);
  return MONTH_CODES[monthNum];
}

/**
 * @description Map a CME month code letter back to its 1–12 calendar month.
 * @param code - Single-letter month code (e.g. 'Z').
 * @returns The month number, or 0 if the letter is not a valid code.
 */
export function monthNumFromCode(code: string): number {
  const i = MONTH_CODES.indexOf(code.trim().toUpperCase());
  return i < 1 ? 0 : i;
}

/**
 * @description Build the canonical contract symbol for a root/month/year.
 * @param root - Root ticker.
 * @param monthNum - Contract month 1–12.
 * @param year - Four-digit year.
 * @returns e.g. ('ES', 12, 2025) → 'ESZ25'.
 */
export function contractSymbol(root: string, monthNum: number, year: number): string {
  return `${root.toUpperCase()}${monthCode(monthNum)}${String(year % 100).padStart(2, '0')}`;
}

/**
 * @description Parse a canonical futures symbol (root + month code + 2-digit year, e.g. 'ESZ25').
 * @param symbol - The symbol to parse.
 * @returns { root, monthNum, year } (2-digit year expanded to 2000+yy), or null if unparseable/unknown root.
 */
export function parseFuturesSymbol(symbol: string): { root: FuturesRoot; monthNum: number; year: number } | null {
  const m = symbol.trim().toUpperCase().match(/^([A-Z0-9]{1,3}?)([FGHJKMNQUVXZ])(\d{2})$/);
  if (!m) return null;
  const root = getFuturesRoot(m[1]);
  const monthNum = monthNumFromCode(m[2]);
  if (!root || !monthNum) return null;
  return { root, monthNum, year: 2000 + Number(m[3]) };
}

/**
 * @description The third Friday of a month, UTC midnight — the equity-index expiry/settlement date.
 * @param year - Four-digit year.
 * @param monthNum - Month 1–12.
 * @returns A UTC Date at 00:00 on the third Friday.
 */
export function thirdFriday(year: number, monthNum: number): Date {
  const first = new Date(Date.UTC(year, monthNum - 1, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7); // 5 = Friday
  return new Date(Date.UTC(year, monthNum - 1, firstFriday + 14));
}

/**
 * @description The expiry date of a contract, per the root's expiry rule. Equity index minis settle
 * on the third Friday of the contract month; WTI crude terminates 3 business days before the 25th
 * of the PRECEDING month.
 * @param root - Root metadata (its expiryRule picks the formula).
 * @param monthNum - Contract month 1–12.
 * @param year - Four-digit year.
 * @returns The expiry Date (UTC).
 */
export function expiryDate(root: FuturesRoot, monthNum: number, year: number): Date {
  if (root.expiryRule === 'cl-energy') return clEnergyExpiry(year, monthNum);
  return thirdFriday(year, monthNum);
}

/**
 * The WTI (CL/MCL) termination rule: 3 business days before the 25th calendar day of the month
 * PRECEDING the contract month; when the 25th is not a business day, count from the prior business
 * day. Weekday approximation (no exchange holiday calendar yet — module scope note applies).
 * Validated against the real Kibot CLZ25 file, whose final bar lands exactly on the computed
 * 2025-11-20.
 */
function clEnergyExpiry(year: number, monthNum: number): Date {
  let y = year;
  let m = monthNum - 1;
  if (m === 0) { m = 12; y -= 1; }
  let d = new Date(Date.UTC(y, m - 1, 25));
  while (isWeekendUtc(d)) d = new Date(d.getTime() - MS_PER_DAY);
  let remaining = 3;
  while (remaining > 0) {
    d = new Date(d.getTime() - MS_PER_DAY);
    if (!isWeekendUtc(d)) remaining -= 1;
  }
  return d;
}

/** True when the UTC day-of-week is Saturday or Sunday. */
function isWeekendUtc(d: Date): boolean {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

/**
 * @description The roll date — when the market treats the next contract as the front month.
 * @param root - Root metadata.
 * @param monthNum - Contract month 1–12.
 * @param year - Four-digit year.
 * @param daysBeforeExpiry - Calendar days before expiry (default 8, the index convention).
 * @returns The roll Date (UTC).
 */
export function rollDate(root: FuturesRoot, monthNum: number, year: number, daysBeforeExpiry = DEFAULT_ROLL_DAYS_BEFORE_EXPIRY): Date {
  return new Date(expiryDate(root, monthNum, year).getTime() - daysBeforeExpiry * MS_PER_DAY);
}

/** Ordered (year, monthNum) listed contract months spanning [startYear-1 .. endYear+1] for a root's month set. */
function listedMonths(root: FuturesRoot, startYear: number, endYear: number): Array<{ year: number; monthNum: number }> {
  const out: Array<{ year: number; monthNum: number }> = [];
  for (let y = startYear - 1; y <= endYear + 1; y++) {
    for (const monthNum of root.months) out.push({ year: y, monthNum });
  }
  return out.sort((a, b) => a.year - b.year || a.monthNum - b.monthNum);
}

/**
 * @description Enumerate the dated contracts whose active-front window overlaps [start, end].
 * Each contract's window runs from the PRIOR listed contract's roll to its own roll, so the returned
 * set tiles the range with no gaps — exactly the contracts you must download to cover [start, end].
 * @param rootSym - Root ticker, e.g. 'ES'.
 * @param start - Range start (inclusive), UTC.
 * @param end - Range end (inclusive for window OVERLAP — a contract whose window merely touches
 *   this instant is included; bar-level exclusivity is the caller's concern, cf. buildContinuousSeries).
 * @param daysBeforeExpiry - Roll convention (default 8).
 * @returns Contracts sorted by expiry; empty if the root is unknown.
 */
export function contractsForRange(rootSym: string, start: Date, end: Date, daysBeforeExpiry = DEFAULT_ROLL_DAYS_BEFORE_EXPIRY): FuturesContract[] {
  const root = getFuturesRoot(rootSym);
  if (!root) return [];
  const months = listedMonths(root, start.getUTCFullYear(), end.getUTCFullYear());
  const out: FuturesContract[] = [];
  for (let i = 0; i < months.length; i++) {
    const q = months[i];
    const prev = months[i - 1];
    const roll = rollDate(root, q.monthNum, q.year, daysBeforeExpiry);
    const activeStart = prev ? rollDate(root, prev.monthNum, prev.year, daysBeforeExpiry) : new Date(roll.getTime() - 92 * MS_PER_DAY);
    if (activeEndOverlaps(activeStart, roll, start, end)) {
      out.push({
        symbol: contractSymbol(root.root, q.monthNum, q.year),
        root: root.root, monthNum: q.monthNum, year: q.year,
        expiry: expiryDate(root, q.monthNum, q.year), roll, activeStart, activeEnd: roll,
      });
    }
  }
  return out;
}

/** True when the active window [aStart, aEnd) intersects the requested [start, end]. */
function activeEndOverlaps(aStart: Date, aEnd: Date, start: Date, end: Date): boolean {
  return aStart.getTime() <= end.getTime() && aEnd.getTime() >= start.getTime();
}

/**
 * @description The front (active) contract for a root at a given instant.
 * @param rootSym - Root ticker.
 * @param asOf - The instant to evaluate, UTC.
 * @returns The active FuturesContract, or null if the root is unknown.
 */
export function activeContractAt(rootSym: string, asOf: Date): FuturesContract | null {
  const day = new Date(asOf.getTime());
  const contracts = contractsForRange(rootSym, day, day);
  return contracts.find((c) => asOf.getTime() < c.roll.getTime()) ?? contracts[contracts.length - 1] ?? null;
}

/**
 * @description Bar duration in minutes for a supported timeframe.
 * @param tf - The timeframe.
 * @returns Minutes per bar (5Min→5, 1Hour→60, 1Day→1440, 1Week→10080). 3Month is not a futures bar size.
 */
export function barMinutes(tf: Timeframe): number {
  switch (tf) {
    case '5Min': return 5;
    case '1Hour': return 60;
    case '1Day': return 1440;
    case '1Week': return 10_080;
    default: return 1440;
  }
}

/** Count weekdays (Mon–Fri) in [from, to) — the expiry/roll business-day approximation. Expected-BAR
 *  math no longer uses this; it counts real session buckets via futures-session-calendar. */
export function weekdaysBetween(from: Date, to: Date): number {
  let n = 0;
  for (let t = utcMidnight(from); t < to.getTime(); t += MS_PER_DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** Floor a Date to UTC midnight epoch-ms. */
function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * @description Expected bar count for a contract's active window at a timeframe — the "whole contract"
 * denominator the completeness validator measures against. Counts REAL Globex session buckets
 * (futures-session-calendar): the ~23h weekday session, the 17:00–18:00 maintenance halt, weekend
 * close, full-closure holidays, and 13:00 early closes. Daily/weekly timeframes count trading days.
 * @param contract - The dated contract.
 * @param tf - Bar timeframe.
 * @param root - Root metadata. Reserved for per-exchange calendars (CME vs NYMEX notices can
 *   diverge); every built-in root currently trades the shared Globex schedule.
 * @param windowStart - Optional clamp start (default contract.activeStart).
 * @param windowEnd - Optional clamp end (default contract.activeEnd).
 * @returns Expected number of bars over the (clamped) active window.
 */
export function expectedBarCount(contract: FuturesContract, tf: Timeframe, root: FuturesRoot, windowStart?: Date, windowEnd?: Date): number {
  void root;
  const from = new Date(Math.max((windowStart ?? contract.activeStart).getTime(), contract.activeStart.getTime()));
  const to = new Date(Math.min((windowEnd ?? contract.activeEnd).getTime(), contract.activeEnd.getTime()));
  if (to.getTime() <= from.getTime()) return 0;
  if (tf === '1Day' || tf === '1Week') return tradingDaysBetween(from, to);
  return countSessionBuckets(from.getTime(), to.getTime(), barMinutes(tf) * 60_000);
}
