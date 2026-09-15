/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the FIFTH state. A holding whose shares all sit in protected lots is dropped by subtractPinnedLots before anything governs it, so it reached no answer at all and a surface read it as NOT KNOWN - a deliberately protected position shown as unexamined, which is this module's own failure inverted. The boundary is driven, not described: the REAL subtraction decides which symbols vanish, and the cases assert the constructor is the only answer available for those and that a partial pin is NOT one of them. The wording is asserted to say the lots still work their own exits, because `exitsApply: false` on its own would read as unprotected, and to say how the state ENDS, because it is a setting and not a finding.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the readout the trading surface paints from ADR-159. The three cases that matter are the three the operator cannot otherwise tell apart: a holding the engine cannot account for (no order of any kind), a holding the operator ring-fenced himself (a setting, not a finding), and a holding NOBODY LOOKED AT because the ledger read failed - which must never read as "managed". The live-book shape is pinned by name: USO is 0 buys / 4 sells and is also TRADING_CORE_SYMBOLS=USO:0, so it carries BOTH reasons and the readout has to say both. The withholding rules asserted here are read off the order paths themselves (trading-schedule-dispatch.ts:253 filters every exit for a fenced symbol; ensureCore skips only an unmanaged one), so a change to either is meant to turn this red.
 */

import { describe, expect, it } from 'vitest';
import type { Position } from '../../src/features/trading/services/broker-adapter';
import type { CoreConfig } from '../../src/app/trading-dispatch-core';
import { pinnedInFullGovernance, positionGovernance, positionGovernanceBySymbol } from '../../src/app/trading-position-governance';
import { subtractPinnedLots } from '../../src/app/trading-pinned-lots';

/** A book with nothing ring-fenced. */
const noFence: CoreConfig = { symbols: [], targetPct: 0, perSymbolPct: new Map() };

/** The live box's own ring-fence on 2026-09-15: TRADING_CORE_SYMBOLS=SKHYV:0,SKHY:0,USO:0. */
const liveFence: CoreConfig = {
  symbols: ['SKHYV', 'SKHY', 'USO'],
  targetPct: 0,
  perSymbolPct: new Map([['SKHYV', 0], ['SKHY', 0], ['USO', 0]]),
};

/** A beta core at a real target beside a `:0` hold. */
const coreFence: CoreConfig = {
  symbols: ['SPY', 'USO'],
  targetPct: 35,
  perSymbolPct: new Map([['SPY', 35], ['USO', 0]]),
};

/** A long exactly as it leaves withEngineCostBasis: covered, uncovered, or never looked at. */
const held = (symbol: string, qty: number, mark: 'covered' | 'unmanaged' | 'unread'): Position => ({
  symbol, qty, avgEntryPrice: 10, currentPrice: 11, marketValue: qty * 11, unrealizedPl: qty,
  ...(mark === 'covered' ? { engineAvgCost: 10 } : {}),
  ...(mark === 'unmanaged' ? { unmanaged: true } : {}),
});

const kinds = (p: Position, core: CoreConfig) => positionGovernance(p, core).reasons.map((r) => r.kind);

describe('the trading surface readout of what the engine will not trade (ADR-159)', () => {
  it('says nothing about a position the engine manages: exits and orders both apply, no reasons', () => {
    const g = positionGovernance(held('ANET', 20, 'covered'), noFence);
    expect(g).toEqual({ symbol: 'ANET', exitsApply: true, ordersApply: true, reasons: [] });
  });

  it('marks a holding the ledger cannot account for: NO exit and NO order of any kind', () => {
    const g = positionGovernance(held('USO', 400, 'unmanaged'), noFence);
    expect(g.exitsApply).toBe(false);
    expect(g.ordersApply).toBe(false);
    expect(g.reasons.map((r) => r.kind)).toEqual(['unaccounted']);
  });

  it("the unaccounted wording names the shares and says monitored, not managed - not just a colour", () => {
    const [reason] = positionGovernance(held('USO', 400, 'unmanaged'), noFence).reasons;
    expect(reason.label).toBe('not managed');
    expect(reason.detail).toContain('400 USO');
    expect(reason.detail).toContain('monitored, not managed');
    for (const withheld of ['stop-loss', 'take-profit', 'trailing exit', 'rebalance trim']) {
      expect(reason.detail, `the operator must be told the ${withheld} is withheld`).toContain(withheld);
    }
  });

  it('keeps ring-fenced separate from unaccounted: different states, different fixes', () => {
    const fenced = positionGovernance(held('SKHY', 100, 'covered'), liveFence);
    expect(fenced.reasons.map((r) => r.kind)).toEqual(['ring-fenced']);
    expect(fenced.reasons[0].detail).toContain('TRADING_CORE_SYMBOLS');
    expect(fenced.reasons[0].detail).toContain('removed from TRADING_CORE_SYMBOLS');
    // The unaccounted reason must NOT offer a config fix, and the fence must not blame the ledger.
    const unaccounted = positionGovernance(held('USO', 400, 'unmanaged'), noFence);
    expect(unaccounted.reasons[0].detail).not.toContain('TRADING_CORE_SYMBOLS');
    expect(fenced.reasons[0].detail).not.toContain('filled orders');
  });

  it('USO on the live book carries BOTH reasons - 0 buys / 4 sells AND USO:0 - in that order', () => {
    const g = positionGovernance(held('USO', 400, 'unmanaged'), liveFence);
    expect(g.reasons.map((r) => r.kind)).toEqual(['unaccounted', 'ring-fenced']);
    expect(g.exitsApply).toBe(false);
    expect(g.ordersApply).toBe(false);
  });

  it('a `:0` hold is a hold in both directions: no exit and no order', () => {
    const g = positionGovernance(held('SKHYV', 50, 'covered'), liveFence);
    expect(g.exitsApply).toBe(false);
    expect(g.ordersApply).toBe(false);
  });

  it('a core hold at a real target is exempt from every sleeve exit but is still rebalanced', () => {
    const g = positionGovernance(held('SPY', 120, 'covered'), coreFence);
    expect(g.reasons.map((r) => r.kind)).toEqual(['core-holding']);
    expect(g.exitsApply, 'the dispatch filters every exit for a fenced symbol').toBe(false);
    expect(g.ordersApply, 'ensureCore still tops it up and trims it toward target').toBe(true);
    expect(g.reasons[0].label).toBe('core hold 35%');
    expect(g.reasons[0].detail).toContain('tops it up toward 35% of equity');
  });

  it('an unaccounted core hold loses its rebalance too, and the wording says so', () => {
    const g = positionGovernance(held('SPY', 120, 'unmanaged'), coreFence);
    expect(g.ordersApply, 'ensureCore withholds a plan for an unmanaged holding').toBe(false);
    const core = g.reasons.find((r) => r.kind === 'core-holding');
    expect(core?.detail).toContain('withheld too');
    expect(core?.detail).not.toContain('still tops it up');
  });

  it('a position nobody looked at reads NOT KNOWN, never managed', () => {
    const g = positionGovernance(held('ABT', 134, 'unread'), noFence);
    expect(g.exitsApply, 'a failed ledger read is null, not true').toBeNull();
    expect(g.ordersApply).toBeNull();
    expect(g.reasons.map((r) => r.kind)).toEqual(['accountability-unknown']);
    expect(g.reasons[0].label).toBe('not known');
    expect(g.reasons[0].detail).toContain('NOT KNOWN');
    expect(g.reasons[0].detail).toContain('failed read, not a finding');
  });

  it('a failed ledger read does not cast doubt on a `:0` ring-fence, which withholds on its own', () => {
    const g = positionGovernance(held('SKHY', 100, 'unread'), liveFence);
    expect(kinds(held('SKHY', 100, 'unread'), liveFence)).toEqual(['ring-fenced']);
    expect(g.exitsApply).toBe(false);
    expect(g.ordersApply).toBe(false);
  });

  it('a failed ledger read DOES cast doubt on a core hold, whose orders depend on the mark', () => {
    const g = positionGovernance(held('SPY', 120, 'unread'), coreFence);
    expect(g.reasons.map((r) => r.kind)).toEqual(['core-holding', 'accountability-unknown']);
    expect(g.exitsApply, 'the fence alone settles the exits').toBe(false);
    expect(g.ordersApply, 'whether the core rebalance runs depends on a mark nobody read').toBeNull();
  });

  it('answers NOT KNOWN for a position that is not a long, rather than guessing', () => {
    const short: Position = { symbol: 'QQQ', qty: -10, avgEntryPrice: 400, marketValue: -4000, unrealizedPl: 0 };
    const g = positionGovernance(short, noFence);
    expect(g.exitsApply).toBeNull();
    expect(g.ordersApply).toBeNull();
    expect(g.reasons[0].detail).toContain('LONG positions');
  });

  it('matches the symbol case-insensitively - the venue does not always shout', () => {
    expect(positionGovernance(held('uso', 400, 'unmanaged'), liveFence).reasons.map((r) => r.kind))
      .toEqual(['unaccounted', 'ring-fenced']);
  });

  it('keys a whole book by UPPER-CASE symbol so a payload can carry one entry per position', () => {
    const book = positionGovernanceBySymbol(
      [held('anet', 20, 'covered'), held('USO', 400, 'unmanaged'), held('SKHY', 100, 'covered')], liveFence,
    );
    expect(Object.keys(book).sort()).toEqual(['ANET', 'SKHY', 'USO']);
    expect(book.ANET.reasons).toEqual([]);
    expect(book.USO.reasons.map((r) => r.kind)).toEqual(['unaccounted', 'ring-fenced']);
    expect(book.SKHY.reasons.map((r) => r.kind)).toEqual(['ring-fenced']);
  });
});

/**
 * The fifth state. `subtractPinnedLots` drops a symbol whose residual is zero, so a fully pinned
 * holding never reaches `positionGovernance` at all - and before this state existed the surface's
 * fallback called that "not known", which is false twice over: somebody did look, and the answer is
 * benign. These cases drive the REAL subtraction so the premise is a fact rather than a claim.
 */
describe('a holding held entirely in protected lots is a state of its own, not an unread one', () => {
  const venue = (symbol: string, qty: number): Position => ({
    symbol, qty, avgEntryPrice: 10, currentPrice: 11, marketValue: qty * 11, unrealizedPl: qty,
  });

  it('the subtraction really does drop it, which is why no governance answer can reach it', () => {
    const positions = [venue('USO', 400), venue('ANET', 100)];
    const visible = subtractPinnedLots(positions, new Map([['USO', 400], ['ANET', 40]]));
    expect(visible.map((p) => p.symbol), 'USO is gone; ANET keeps its residual').toEqual(['ANET']);
    expect(visible[0].qty).toBe(60);
    expect(positionGovernanceBySymbol(visible, noFence).USO, 'so the book answer has no USO entry').toBeUndefined();
  });

  it('a pin that covers MORE than the venue reports still drops the symbol', () => {
    expect(subtractPinnedLots([venue('USO', 400)], new Map([['USO', 500]]))).toEqual([]);
  });

  it('states it in the operator\'s words, naming the quantity and how the state ends', () => {
    const [reason] = pinnedInFullGovernance('USO', 400).reasons;
    expect(reason.kind).toBe('pinned-in-full');
    expect(reason.label).toBe('protected lots');
    expect(reason.detail).toContain('All 400 USO');
    expect(reason.detail, 'a setting, not a finding - say how it ends').toContain('returns to the autopilot when its lots are released');
    expect(reason.detail).toContain('setting, not a finding');
  });

  it('never reads as unprotected: the detail says each lot works the exits it was opened with', () => {
    const g = pinnedInFullGovernance('USO', 400);
    expect(g.exitsApply, 'the AUTOPILOT emits nothing for it').toBe(false);
    expect(g.ordersApply).toBe(false);
    expect(g.reasons[0].detail).toContain('not unprotected');
    expect(g.reasons[0].detail).toContain('works the exits it was opened with');
  });

  it('is NOT the unread state - that bucket keeps its own meaning', () => {
    const g = pinnedInFullGovernance('uso', 400);
    expect(g.symbol, 'upper-cased like every other answer').toBe('USO');
    expect(g.reasons.map((r) => r.kind)).toEqual(['pinned-in-full']);
    expect(g.reasons.map((r) => r.label)).not.toContain('not known');
    // The genuinely unread position still answers not known - this separates two things that shared
    // a bucket, it does not empty the bucket.
    expect(kinds(held('ABT', 134, 'unread'), noFence)).toEqual(['accountability-unknown']);
  });
});
