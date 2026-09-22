/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Split out of trading-watchdog-checks.spec.ts when it reached 975 code lines. The two describes here are about what the watchdog's EVIDENCE can prove before it concludes: the ledger row (an unconfirmed sell is not cover - module seq 5: the status buckets are re-derived from broker-adapter.ts's OrderStatus union plus the 'submitting' reservation trading-engine.ts INSERTs, both adapters' normalizeStatus default arm is pinned to 'pending', a pending/submitting row raises unconfirmed-cover instead of silencing the symbol, the finding is disjoint from bleed per symbol, honours the materiality floor and the core-hold exemption, rides the existing hysteresis, and is scoped by the same bleedBooks allow-list as bleed with three mutations covering the defect, the floor and the scope) and the tape print (the pre-market gap pages only on a print with real size and recency whose quote mid crosses too, with two mutations). Every case moved verbatim; the fixtures, the MUTANT loader and the shipped-module hash guard are tests/helpers/trading-watchdog-checks-harness.ts, shared with the original.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOK, C, NOW, kindsOf, mutationHarness, order, position, root, settings } from '../helpers/trading-watchdog-checks-harness';

const { mutant, dispose } = mutationHarness();
afterAll(dispose);

describe('watchdog checks: the pre-market gap needs a real print', () => {
  const today = '2026-09-04';
  const base = { priorClose: 500, todayIso: today, nowMs: Date.parse(`${today}T12:00:00.000Z`), minSize: 100, maxAgeMin: 15, gapPct: 1 };
  const trade = (over: Record<string, unknown> = {}): any => ({ t: `${today}T11:58:00.000Z`, p: 490, s: 500, ...over });
  const quote = (over: Record<string, unknown> = {}): any => ({ bp: 489.9, ap: 490.1, ...over });

  it('alerts when the print AND the quote mid both cross', () => {
    const r = C.assessGapPrint({ ...base, trade: trade(), quote: quote() });
    expect(r.alert).toBe(true);
    expect(Math.round(r.gap * 10) / 10).toBe(-2);
  });

  it('refuses a thin print, a stale print, yesterday\'s print, and a one-sided quote', () => {
    expect(C.assessGapPrint({ ...base, trade: trade({ s: 1 }), quote: quote() }).skip).toMatch(/thin print/);
    expect(C.assessGapPrint({ ...base, trade: trade({ t: `${today}T11:00:00.000Z` }), quote: quote() }).skip).toMatch(/stale print/);
    expect(C.assessGapPrint({ ...base, trade: trade({ t: '2026-09-03T11:58:00.000Z' }), quote: quote() }).skip).toMatch(/no pre-market print yet/);
    expect(C.assessGapPrint({ ...base, trade: trade(), quote: quote({ bp: 0 }) }).skip).toMatch(/two-sided quote/);
    expect(C.assessGapPrint({ ...base, trade: null, quote: quote() }).skip).toMatch(/no prior close or no trade/);
  });

  it('does not alert when only the trade crosses but the quote mid does not', () => {
    const r = C.assessGapPrint({ ...base, trade: trade(), quote: quote({ bp: 498, ap: 499 }) });
    expect(r.alert).toBe(false);
  });

  it('MUTATION: dropping the size floor pages on a 1-share odd lot', () => {
    const M = mutant("if (size < input.minSize) return { skip: 'thin print (size=' + size + ' < ' + input.minSize + ')' };", '');
    expect(M.assessGapPrint({ ...base, trade: trade({ s: 1 }), quote: quote() }).alert).toBe(true);
  });

  it('MUTATION: dropping the quote corroboration pages on a print the book does not support', () => {
    const M = mutant('return { alert: gap <= -input.gapPct && midGap <= -input.gapPct,', 'return { alert: gap <= -input.gapPct,');
    expect(M.assessGapPrint({ ...base, trade: trade(), quote: quote({ bp: 498, ap: 499 }) }).alert).toBe(true);
  });
});

describe('watchdog checks: an UNCONFIRMED sell is not protective cover', () => {
  // The three buckets, and why this check exists: the ledger's /orders page is the api's read over
  // oshal_trading_orders, so "there is a sell row" is never the same claim as "the venue is holding
  // a sell". Treating the second as proved by the first is what silenced a bleeding symbol.
  const TERMINAL = ['filled', 'canceled', 'rejected', 'expired'];
  const SCOPED = { ref: 'live', enabled: true };
  const BY_HAND = { ref: 'b-77146871', enabled: true };
  const account = { cash: 5_000, buyingPower: 10_000, equity: 100_000 };
  const bleeding = { account, positions: [position('AAPL', { unrealizedPl: -900 })], orders: [] as Array<unknown> };
  const covered = (status: string, over: Record<string, unknown> = {}): any =>
    ({ ...bleeding, orders: [order('AAPL', { status, ...over })] });

  it('the buckets PARTITION the vocabulary the kernel can actually write to the ledger', () => {
    // Re-derived from the kernel, never a typed list - the same rule the portfolio floors follow.
    // broker-adapter.ts's OrderStatus union is every status both adapters normalize to, and
    // trading-engine.ts writes one more the union does not name: the pre-venue 'submitting'
    // reservation placeDecisionOrder INSERTs before it ever calls the broker. A status added to
    // either must land in a bucket here, not in silence.
    const adapter = readFileSync(join(root, 'src', 'features', 'trading', 'services', 'broker-adapter.ts'), 'utf8');
    const union = /export type OrderStatus =([\s\S]*?);/.exec(adapter);
    expect(union, 'the OrderStatus union was not found - the watchdog buckets are unpinned').toBeTruthy();
    const vocabulary = [...(union as RegExpExecArray)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const engine = readFileSync(join(root, 'src', 'app', 'trading-engine.ts'), 'utf8');
    expect(engine, 'the submission reservation no longer writes the status this partition assumes').toContain("'submitting','SUBMITTING'");
    vocabulary.push('submitting');
    expect(vocabulary.sort()).toEqual([...C.CONFIRMED_WORKING_ORDER_STATUSES, ...C.UNCONFIRMED_ORDER_STATUSES, ...TERMINAL].sort());
    expect(C.CONFIRMED_WORKING_ORDER_STATUSES.filter((s: string) => C.UNCONFIRMED_ORDER_STATUSES.includes(s)),
      'a status cannot be both confirmed and unconfirmed').toEqual([]);
    // 'pending' is the DEFAULT arm of BOTH adapters' normalizeStatus, so an unrecognized venue
    // status lands in the unconfirmed bucket rather than being read as cover.
    for (const file of ['alpaca-broker-adapter.ts', 'schwab-broker-adapter.ts']) {
      const text = readFileSync(join(root, 'src', 'features', 'trading', 'services', file), 'utf8');
      expect(/default: return '([a-z_]+)';/.exec(text)?.[1], `${file} default arm`).toBe('pending');
    }
    expect(C.UNCONFIRMED_ORDER_STATUSES).toContain('pending');
  });

  it('only a CONFIRMED-WORKING sell (a status the adapters normalize a working order to) counts as cover, and it still suppresses the bleed finding', () => {
    for (const status of ['accepted', 'partially_filled', 'PARTIALLY_FILLED']) {
      expect(C.isConfirmedWorkingSell(order('AAPL', { status })), status).toBe(true);
      expect(C.evaluateBook(BOOK, covered(status), settings()).findings, status).toEqual([]);
    }
    expect(C.isConfirmedWorkingSell(order('AAPL', { status: 'accepted', side: 'buy' }))).toBe(false);
    expect([...C.confirmedSellSymbols([order('AAPL'), order('MSFT', { status: 'pending' })])]).toEqual(['AAPL']);
  });

  it('an UNCONFIRMED row does NOT suppress - it raises its own finding instead', () => {
    for (const status of ['pending', 'submitting', 'SUBMITTING']) {
      expect(C.isUnconfirmedSell(order('AAPL', { status })), status).toBe(true);
      expect(C.isConfirmedWorkingSell(order('AAPL', { status })), status).toBe(false);
      const r = C.evaluateBook(BOOK, covered(status), settings());
      expect(kindsOf(r), status).toEqual(['unconfirmed-cover']);
      expect(r.findings[0].key).toBe('unconfirmed-cover-b-spec-AAPL');
    }
  });

  it('the message says the ledger, the venue, and that the watchdog cannot tell which', () => {
    const m = C.evaluateBook(BOOK, covered('pending'), settings()).findings[0].message;
    expect(m).toContain('UNCONFIRMED sell');
    expect(m).toContain('the ledger shows a submitted sell (status pending) that the venue has NOT confirmed is working');
    expect(m).toContain('may be genuinely uncovered');
    expect(m).toContain('reads the ORDER LEDGER (oshal_trading_orders), not the venue, so it CANNOT TELL which');
    expect(m).toContain('AAPL');
    expect(m).toContain('b-spec');
  });

  it('a TERMINAL row is unchanged: it never was cover, and the plain bleed finding still fires', () => {
    for (const status of [...TERMINAL, '', undefined]) {
      expect(kindsOf(C.evaluateBook(BOOK, covered(status as string), settings())), String(status)).toEqual(['bleed']);
    }
    expect(kindsOf(C.evaluateBook(BOOK, bleeding, settings())), 'no order rows at all').toEqual(['bleed']);
  });

  it('bleed and unconfirmed-cover are DISJOINT per symbol, so neither hides the other', () => {
    // One confirmed sell outranks any number of unconfirmed rows: the venue is holding an exit.
    const both = { ...bleeding, orders: [order('AAPL', { status: 'pending' }), order('AAPL', { status: 'accepted' })] };
    expect(C.evaluateBook(BOOK, both, settings()).findings).toEqual([]);
    // Two different names, one of each - each gets exactly its own finding.
    const mixed = {
      account,
      positions: [position('AAPL', { unrealizedPl: -900 }), position('MSFT', { unrealizedPl: -900 })],
      orders: [order('MSFT', { status: 'pending' })],
    };
    expect(kindsOf(C.evaluateBook(BOOK, mixed, settings()))).toEqual(['bleed', 'unconfirmed-cover']);
  });

  it('respects the materiality floor and the core-hold exemption, like every other conclusion', () => {
    const dust = position('HMNY', { qty: 42_689, avgEntryPrice: 0.093863, marketValue: 0.04, unrealizedPl: -4_006.87 });
    expect(C.evaluateBook(BOOK, { account, positions: [dust], orders: [order('HMNY', { status: 'pending' })] }, settings()).findings,
      'a book of dust must not emit a wall of these').toEqual([]);
    const core = { account, positions: [position('SKHY', { unrealizedPl: -900 })], orders: [order('SKHY', { status: 'submitting' })] };
    expect(C.evaluateBook(BOOK, core, settings({ core: C.coreSymbolSet('SKHY:0,SPY:60') })).findings,
      'a core hold is exempt from every loss conclusion').toEqual([]);
  });

  it('outside regular hours it does not run, and its kind is inside the reconciliation scope', () => {
    expect(C.evaluateBook(BOOK, covered('pending'), settings({ rth: false })).findings).toEqual([]);
    expect(C.evaluatedKinds(true)).toContain('unconfirmed-cover');
    expect(C.evaluatedKinds(false)).not.toContain('unconfirmed-cover');
  });

  it('is SCOPED by the same bleedBooks allow-list, because it is the bleed question', () => {
    // On the hand-traded rollover every position legitimately has no working sell, so an
    // unconfirmed row there is the normal resting state, not a defect. Unscoped, this finding
    // would page all day on a real-money book and train the operator to ignore the watchdog.
    const st = settings({ bleedBooks: C.bleedBookSet('live') });
    expect(kindsOf(C.evaluateBook(SCOPED, covered('pending'), st))).toEqual(['unconfirmed-cover']);
    expect(C.evaluateBook(BY_HAND, covered('pending'), st).findings, 'the hand-traded book must stay silent').toEqual([]);
    // Blank still means EVERY book - a safety check must fail open, never mute itself.
    for (const raw of ['', '   ', undefined as unknown as string]) {
      const open = settings({ bleedBooks: C.bleedBookSet(raw) });
      expect(kindsOf(C.evaluateBook(BY_HAND, covered('pending'), open)), `raw=${JSON.stringify(raw)}`).toEqual(['unconfirmed-cover']);
    }
    // And scoping it does NOT mute deep-loss on the excluded book, exactly as for bleed.
    const deep = { account, positions: [position('AAPL', { unrealizedPl: -2_500 })], orders: [order('AAPL', { status: 'pending' })] };
    expect(kindsOf(C.evaluateBook(BY_HAND, deep, st))).toEqual(['deep-loss']);
  });

  it('rides the SAME hysteresis machinery: suppressed inside the window, re-paged when it worsens', () => {
    const scope = { refs: ['b-spec'], kinds: C.evaluatedKinds(true) };
    const at = (pl: number): any[] => C.evaluateBook(BOOK, { ...covered('pending'), positions: [position('AAPL', { unrealizedPl: pl })] }, settings()).findings;
    const KEY = 'unconfirmed-cover-b-spec-AAPL';
    const first = C.decideAlerts({}, at(-600), { nowMs: NOW, windowMin: 60, scope });
    expect(first.alerts.map((a: { key: string }) => a.key)).toEqual([KEY]);
    const repeat = C.decideAlerts(first.state, at(-650), { nowMs: NOW + 10 * 60_000, windowMin: 60, scope });
    expect(repeat.alerts).toEqual([]);
    expect(repeat.suppressed).toEqual([KEY]);
    // -6 percent to -15 percent: past the 3-point band, so it pages again inside the window.
    // Deliberately short of deepLossPct (20), which would add a second, unrelated finding.
    const worse = C.decideAlerts(repeat.state, at(-1_500), { nowMs: NOW + 20 * 60_000, windowMin: 60, scope });
    expect(worse.alerts.map((a: { key: string }) => a.key)).toEqual([KEY]);
  });

  it('recovers exactly ONCE when the venue confirms, then alerts again on re-entry', () => {
    const scope = { refs: ['b-spec'], kinds: C.evaluatedKinds(true) };
    const first = C.decideAlerts({}, C.evaluateBook(BOOK, covered('pending'), settings()).findings, { nowMs: NOW, windowMin: 60, scope });
    const confirmed = C.evaluateBook(BOOK, covered('accepted'), settings()).findings;
    const clear = C.decideAlerts(first.state, confirmed, { nowMs: NOW + 10 * 60_000, windowMin: 60, scope });
    expect(clear.recovered).toEqual(['unconfirmed-cover-b-spec-AAPL']);
    expect(Object.keys(clear.state)).toEqual([]);
    expect(C.decideAlerts(clear.state, confirmed, { nowMs: NOW + 20 * 60_000, windowMin: 60, scope }).recovered).toEqual([]);
    const reentry = C.decideAlerts(clear.state, C.evaluateBook(BOOK, covered('pending'), settings()).findings, { nowMs: NOW + 30 * 60_000, windowMin: 60, scope });
    expect(reentry.alerts.length).toBe(1);
  });

  it('MUTATION: letting coverage rest on the ledger-working list again SILENCES the pending row', () => {
    // The exact defect. With 'pending' back inside the coverage test the symbol produces nothing
    // at all - no bleed, no unconfirmed-cover - which is how a genuinely uncovered position went
    // quiet behind a row the venue had never acknowledged.
    const M = mutant('function isConfirmedWorkingSell(order) {\n  return sellStatusIn(order, CONFIRMED_WORKING_ORDER_STATUSES);\n}',
      'function isConfirmedWorkingSell(order) {\n  return sellStatusIn(order, WORKING_ORDER_STATUSES);\n}');
    expect(M.evaluateBook(BOOK, covered('pending'), settings()).findings).toEqual([]);
  });

  it('MUTATION: dropping the materiality floor pages on the $0.04 delisted lot', () => {
    const M = mutant('function findUnconfirmedCover(positions, confirmed, unconfirmed, core, alertPct, minValueUsd) {\n  return materialPositions(positions, minValueUsd)',
      'function findUnconfirmedCover(positions, confirmed, unconfirmed, core, alertPct, minValueUsd) {\n  return positions.slice()');
    const dust = position('HMNY', { qty: 42_689, avgEntryPrice: 0.093863, marketValue: 0.04, unrealizedPl: -4_006.87 });
    expect(kindsOf(M.evaluateBook(BOOK, { account, positions: [dust], orders: [order('HMNY', { status: 'pending' })] }, settings())))
      .toEqual(['unconfirmed-cover']);
  });

  it('MUTATION: dropping the bleed scope pages the hand-traded book', () => {
    const M = mutant('if (settings.rth && bleedScoped) {', 'if (settings.rth) {');
    const st = settings({ bleedBooks: C.bleedBookSet('live') });
    expect(kindsOf(M.evaluateBook(BY_HAND, covered('pending'), st))).toEqual(['unconfirmed-cover']);
  });
});
