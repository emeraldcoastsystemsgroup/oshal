/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-159 - the engine manages only what it can account for. The engine reads the VENUE's positions, so shares bought by hand land in the armed book and acquire engine decisions measured against a basis the engine never paid (the operator: "yes i bought some shares on the outside"). These guards prove the three order-decision functions emit NOTHING for a position marked unmanaged while staying byte-identical for a covered one, that partial coverage counts as unmanaged, that the attachment marks and counts it, and that exposure and capital keep counting it - it is real money at the venue and hiding it would understate risk. The covered expectations are written as explicit literals so they fail if the withholding ever leaks into an accounted position.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ logs: [] as Array<{ level: string; fields: Record<string, unknown>; msg: string }> }));

vi.mock('@/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/logger')>();
  const capture = (level: string) => (fields: Record<string, unknown>, msg: string) => { h.logs.push({ level, fields, msg }); };
  return {
    ...actual,
    createChildLogger: () => ({ info: capture('info'), warn: capture('warn'), error: capture('error'), debug: capture('debug') }),
  };
});

import {
  exitsToRun, trailingExits, rebalanceTrims, sizeEntry, unmanagedSymbols, RISK_POLICIES,
} from '../../src/features/trading/services/portfolio';
import type { BrokerAccount, Position } from '../../src/features/trading/services/broker-adapter';
import { withEngineCostBasis, type EngineFillRow } from '../../src/app/trading-engine-cost-basis';

/** The LIVE book's posture: 5% hard stop, 8% take-profit, 3% per-name cap, 6% trail arm / 2% giveback. */
const active = RISK_POLICIES.active;
const SUB = 'spec-adr159-sub';

const acct = (over: Partial<BrokerAccount> = {}): BrokerAccount =>
  ({ cash: 100_000, buyingPower: 100_000, equity: 100_000, currency: 'USD', ...over });

/** A venue position exactly as the broker adapter reports it, plus whatever mark the attachment left. */
const pos = (symbol: string, qty: number, avgEntryPrice: number, last: number, mark: Partial<Position> = {}): Position => ({
  symbol, qty, avgEntryPrice, currentPrice: last, marketValue: qty * last, unrealizedPl: qty * (last - avgEntryPrice), ...mark,
});

/** One filled order row as `oshal_trading_orders` returns it to the replay. */
const fill = (symbol: string, side: 'buy' | 'sell', qty: number, px: number): EngineFillRow & { symbol: string } =>
  ({ symbol, side, filled_qty: qty, filled_avg_price: px });

/** A pool whose one SELECT returns exactly these filled-order rows. */
const poolOf = (rows: Array<EngineFillRow & { symbol: string }>) => ({ query: vi.fn(async () => ({ rows })) });
const attach = (rows: Array<EngineFillRow & { symbol: string }>, positions: Position[]): Promise<Position[]> =>
  withEngineCostBasis({ pool: poolOf(rows) } as never, SUB, 'live', positions);

beforeEach(() => { h.logs.length = 0; });

describe('withEngineCostBasis marks what the engine cannot account for (ADR-159)', () => {
  it('leaves a fully covered long accounted: the engine basis is attached and nothing is marked', async () => {
    const [p] = await attach([fill('USO', 'buy', 100, 70)], [pos('USO', 100, 72, 74)]);
    expect(p.engineAvgCost).toBeCloseTo(70, 9);
    expect(p.unmanaged).toBeUndefined();
  });

  it('marks a PARTIALLY covered long unmanaged - 40 of 100 shares is no basis for the other 60', async () => {
    const [p] = await attach([fill('USO', 'buy', 40, 70)], [pos('USO', 100, 72, 74)]);
    expect(p.unmanaged).toBe(true);
    expect(p.engineAvgCost).toBeUndefined();
  });

  it('marks a long the engine never bought at all', async () => {
    const [p] = await attach([], [pos('USO', 200, 154.54, 157.77)]);
    expect(p.unmanaged).toBe(true);
  });

  it('marks a long whose ledger has drifted ABOVE the venue quantity - the history no longer explains it', async () => {
    const [p] = await attach([fill('USO', 'buy', 140, 70)], [pos('USO', 100, 72, 74)]);
    expect(p.unmanaged).toBe(true);
  });

  it('marks a long the engine bought and then partly sold OUTSIDE the engine', async () => {
    // The engine bought 100 and sold 20 of its own; the operator sold 30 more by hand, so the venue
    // holds 50 against a ledger that still says 80.
    const [p] = await attach([fill('USO', 'buy', 100, 70), fill('USO', 'sell', 20, 75)], [pos('USO', 50, 72, 74)]);
    expect(p.unmanaged).toBe(true);
  });

  it('marks per position, not per book: a covered name beside an uncovered one keeps its basis', async () => {
    const out = await attach(
      [fill('CRM', 'buy', 5, 244.465), fill('USO', 'buy', 40, 70)],
      [pos('CRM', 5, 265.878, 252.3901), pos('USO', 100, 72, 74)],
    );
    expect(out[0]).toMatchObject({ symbol: 'CRM', engineAvgCost: 244.465 });
    expect(out[0].unmanaged).toBeUndefined();
    expect(out[1]).toMatchObject({ symbol: 'USO', unmanaged: true });
  });

  it('never marks a flat or short row - the rule is about long quantities the ledger must cover', async () => {
    const out = await attach([], [pos('FLAT', 0, 10, 11), pos('SHORT', -5, 10, 11)]);
    expect(out[0].unmanaged).toBeUndefined();
    expect(out[1].unmanaged).toBeUndefined();
  });

  it('carries the unmanaged COUNT on the attachment log line, so ledger drift is visible', async () => {
    await attach([fill('CRM', 'buy', 5, 244.465)], [pos('CRM', 5, 265.878, 252.3901), pos('USO', 100, 72, 74)]);
    const line = h.logs.find((l) => l.msg === 'engine cost basis attached');
    expect(line).toBeDefined();
    expect(line?.fields).toMatchObject({ longs: 2, covered: 1, unmanaged: 1 });
  });

  it('a FAILED ledger read marks nothing - a database blip must not unmanage a whole book', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('connection terminated'); }) };
    const out = await withEngineCostBasis({ pool } as never, SUB, 'live', [pos('USO', 100, 72, 74)]);
    expect(out[0].unmanaged).toBeUndefined();
    expect(out[0].engineAvgCost).toBeUndefined();
  });
});

/* ── the three order-decision functions ───────────────────────────────────────────────────────── */

/** A covered book that wants one of every decision: a stop, a take-profit, a trail and a cap trim. */
const stopped = () => pos('LOSR', 10, 100, 100 * (1 - (active.stopLossPct + 1) / 100), { engineAvgCost: 100 });
const winner = () => pos('WINR', 10, 100, 100 * (1 + (active.takeProfitPct + 1) / 100), { engineAvgCost: 100 });
/** Up 10% from entry (armed past trailArmPct) and 3% off its 115 peak (past trailGivebackPct). */
const trailer = () => pos('TRLR', 10, 100, 110, { engineAvgCost: 100 });
const peaks = () => new Map([['TRLR', 115]]);
/** $6,000 against the active posture's 3%-of-100K ($3,000) per-name cap. */
const fat = () => pos('FATT', 60, 90, 100, { engineAvgCost: 90 });

describe('a COVERED position keeps exactly today\'s decisions', () => {
  it('exitsToRun still stops the loser and takes the winner', () => {
    expect(exitsToRun([stopped(), winner()], active).map((e) => [e.symbol, e.reason])).toEqual([['LOSR', 'stop_loss'], ['WINR', 'take_profit']]);
  });

  it('trailingExits still books the armed winner that gave back from its peak', () => {
    expect(trailingExits([trailer()], peaks(), active).map((e) => [e.symbol, e.reason])).toEqual([['TRLR', 'trailing_stop']]);
  });

  it('rebalanceTrims still trims the name over its per-name cap', () => {
    const trims = rebalanceTrims([fat()], 100_000, active);
    expect(trims.map((t) => [t.symbol, t.reason, t.qty])).toEqual([['FATT', 'cap_trim', 30]]);
  });
});

describe('an UNMANAGED position gets no order decision at all', () => {
  const un = (p: Position): Position => ({ ...p, unmanaged: true });

  it('exitsToRun emits nothing - not the stop, not the take-profit', () => {
    expect(exitsToRun([un(stopped()), un(winner())], active)).toEqual([]);
  });

  it('trailingExits emits nothing', () => {
    expect(trailingExits([un(trailer())], peaks(), active)).toEqual([]);
  });

  it('rebalanceTrims emits nothing', () => {
    expect(rebalanceTrims([un(fat())], 100_000, active)).toEqual([]);
  });

  it('withholds ONLY its own decisions - a covered position beside it is untouched', () => {
    expect(exitsToRun([un(stopped()), winner()], active).map((e) => [e.symbol, e.reason])).toEqual([['WINR', 'take_profit']]);
    expect(trailingExits([un(pos('OTHR', 10, 100, 110)), trailer()], new Map([['TRLR', 115], ['OTHR', 115]]), active)
      .map((e) => e.symbol)).toEqual(['TRLR']);
    expect(rebalanceTrims([un(pos('BIGU', 60, 90, 100)), fat()], 100_000, active).map((t) => t.symbol)).toEqual(['FATT']);
  });

  it('is driven by the MARK, never inferred from a missing engine basis - an unmarked position is unchanged', () => {
    // The strategy-lab replay and every other caller that never runs the attachment must keep today's
    // behaviour; only a position the attachment actually marked is withheld.
    const plain = pos('LOSR', 10, 100, 100 * (1 - (active.stopLossPct + 1) / 100));
    expect(plain.engineAvgCost).toBeUndefined();
    expect(exitsToRun([plain], active).map((e) => e.reason)).toEqual(['stop_loss']);
  });

  it('unmanagedSymbols reports exactly the held longs the engine cannot account for', () => {
    const book = [un(pos('USO', 100, 72, 74)), pos('CRM', 5, 265, 252), un(pos('GONE', 0, 10, 11))];
    expect([...unmanagedSymbols(book)]).toEqual(['USO']);
  });
});

/* ── monitored, not hidden ────────────────────────────────────────────────────────────────────── */

describe('exposure, capital and the caps still count an unmanaged position', () => {
  /** $24,900 of tech (NVDA), all of it unmanaged, against the active posture's 25% per-sector cap. */
  const unmanagedTech = pos('NVDA', 249, 100, 100, { unmanaged: true });

  it('its market value still consumes total-deployed room', () => {
    // 850 x $100 of energy = $85,000 = the active posture's whole maxDeployedPct of a 100K book.
    const deployedAll = pos('XOM', 850, 100, 100, { unmanaged: true });
    const r = sizeEntry('AAPL', 100, 1, acct({ cash: 10_000 }), [deployedAll], active);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/deployed cap/);
  });

  it('its market value still consumes per-SECTOR room', () => {
    // $24,900 of the 25% ($25,000) tech budget is already held, so a $100 share does not fit.
    const r = sizeEntry('AAPL', 100, 1, acct({ cash: 75_000 }), [unmanagedTech], active);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/sector cap/);
  });

  it('it still occupies one of the maxPositions slots', () => {
    const book = Array.from({ length: active.maxPositions }, (_, i) => pos(`N${i}`, 1, 1, 1, { unmanaged: true }));
    expect(sizeEntry('AAPL', 100, 1, acct(), book, active).blocked).toMatch(/max positions/);
  });

  it('its open loss still counts toward the daily-loss halt', () => {
    const bleeding = pos('USO', 1000, 100, 100, { unmanaged: true });
    bleeding.unrealizedPl = -((active.dailyLossHaltPct / 100) * 100_000) - 1;
    expect(sizeEntry('AAPL', 100, 1, acct(), [bleeding], active).blocked).toBe('daily-loss halt');
  });

  it('it still counts in the cap base every OTHER name is trimmed against', () => {
    // The unmanaged name is withheld; the covered over-cap name is trimmed exactly as before.
    expect(rebalanceTrims([unmanagedTech, fat()], 100_000, active).map((t) => [t.symbol, t.qty])).toEqual([['FATT', 30]]);
  });
});

describe('the autopilot never adds to an unmanaged holding', () => {
  it('sizeEntry refuses to add to it (as it refuses to add to any open holding)', () => {
    const r = sizeEntry('USO', 70, 1, acct(), [pos('USO', 200, 154.54, 157.77, { unmanaged: true })], active);
    expect(r.qty).toBe(0);
    expect(r.blocked).toMatch(/holding/);
  });
});
