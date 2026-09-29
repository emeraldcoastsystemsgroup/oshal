/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard the FIFTH state. A holding whose shares all sit in protected lots is dropped by subtractPinnedLots before anything governs it, so it reached no answer at all and a surface read it as NOT KNOWN - a deliberately protected position shown as unexamined, which is this module's own failure inverted. The boundary is driven, not described: the REAL subtraction decides which symbols vanish, and the cases assert the constructor is the only answer available for those and that a partial pin is NOT one of them. The wording is asserted to say the lots still work their own exits, because `exitsApply: false` on its own would read as unprotected, and to say how the state ENDS, because it is a setting and not a finding.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the readout the trading surface paints from ADR-159. The three cases that matter are the three the operator cannot otherwise tell apart: a holding the engine cannot account for (no order of any kind), a holding the operator ring-fenced himself (a setting, not a finding), and a holding NOBODY LOOKED AT because the ledger read failed - which must never read as "managed". The live-book shape is pinned by name: USO is 0 buys / 4 sells and is also TRADING_CORE_SYMBOLS=USO:0, so it carries BOTH reasons and the readout has to say both. The withholding rules asserted here are read off the order paths themselves (trading-schedule-dispatch.ts:253 filters every exit for a fenced symbol; ensureCore skips only an unmanaged one), so a change to either is meant to turn this red.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guard the SIXTH state (ADR-052 addendum P6): on a book where the idle-cash yield sleeve is armed, its fund is parked cash the dispatch exempts from every exit, and the readout must say so instead of reporting the fund's exits as applying. The cases pin the answer (exitsApply false, ordersApply true, a 'yield-sleeve' reason that names the float, the withheld exits, the sell-first funding and how the state ends), that an unarmed book reads exactly as before, that an unaccounted fund reads unaccounted only (the dispatch disarms the sleeve for it), that an unread ledger keeps the exits false and the orders unknown, and that a fund named in TRADING_CORE_SYMBOLS is never the sleeve's. The boundary is the dispatch's own arming and exemption, so the parity case drives the REAL resolveYieldSleeve, sleevePositions and sleeveExemptSymbols over one knob, env and ring-fence matrix and requires armedYieldSleeve and the readout to agree with them symbol by symbol; the pool is a double for the working-order read only (paper book, settlement off), and the real companion for the fire is tests/unit/trading-dispatch-yield-sleeve-fire.spec.ts, where the fund sits past its stop and is never sold.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Position, TradingBook } from '../../src/features/trading/services/broker-adapter';
import { coreConfig, type CoreConfig } from '../../src/app/trading-dispatch-core';
import { armedYieldSleeve, pinnedInFullGovernance, positionGovernance, positionGovernanceBySymbol, type ArmedYieldSleeve } from '../../src/app/trading-position-governance';
import { subtractPinnedLots } from '../../src/app/trading-pinned-lots';
import { resolveYieldSleeve, sleeveExemptSymbols, sleevePositions } from '../../src/app/trading-dispatch-yield-sleeve';

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

/**
 * The sixth state (ADR-052 addendum P6). On a book where the idle-cash yield sleeve is armed, the
 * dispatch removes the fund from every leg's view and adds it to the core exemption set, so no exit
 * ever fires on it - the readout has to say that, and say nothing new on a book where it is off.
 */
describe('the armed yield sleeve\'s fund is parked cash: exempt from every exit, traded by the sleeve', () => {
  const ENV = ['TRADING_YIELD_SLEEVE', 'TRADING_YIELD_SLEEVE_FLOAT_PCT', 'TRADING_YIELD_SLEEVE_SYMBOL', 'TRADING_CORE_SYMBOLS', 'TRADING_CORE_TARGET_PCT'];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => { for (const k of ENV) { saved.set(k, process.env[k]); delete process.env[k]; } });
  afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  const sleeve: ArmedYieldSleeve = { symbol: 'SGOV', floatPct: 5 };
  const knob = (yieldSleeveFloatPct: number | null) => ({ config: { yieldSleeveFloatPct } });

  it('unarmed, the fund is an ordinary holding: the answer is exactly what it was before the sleeve existed', () => {
    const before = { symbol: 'SGOV', exitsApply: true, ordersApply: true, reasons: [] };
    expect(positionGovernance(held('SGOV', 150, 'covered'), noFence)).toEqual(before);
    expect(positionGovernance(held('SGOV', 150, 'covered'), noFence, null)).toEqual(before);
  });

  it('armed, the fund reads exempt from every exit and still traded - by the sleeve itself', () => {
    const g = positionGovernance(held('SGOV', 150, 'covered'), noFence, sleeve);
    expect(g.exitsApply, 'sleevePositions removes it from every exit leg').toBe(false);
    expect(g.ordersApply, 'the sleeve sells it first to fund entries and parks or refills it').toBe(true);
    expect(g.reasons.map((r) => r.kind)).toEqual(['yield-sleeve']);
    const [reason] = g.reasons;
    expect(reason.label).toBe('yield sleeve');
    expect(reason.detail).toContain('working float 5% of equity');
    for (const withheld of ['stop-loss', 'take-profit', 'trailing exit', 'rebalance trim']) {
      expect(reason.detail, 'the operator must be told the ' + withheld + ' is withheld').toContain(withheld);
    }
    expect(reason.detail).toContain('sells SGOV first to fund entries');
    expect(reason.detail).toContain('setting, not a finding');
    expect(reason.detail, 'say how the state ends').toContain('when the sleeve is disarmed');
  });

  it('only the fund changes: every other holding on the armed book reads as it did, and the match ignores case', () => {
    const book = positionGovernanceBySymbol([held('sgov', 150, 'covered'), held('ANET', 20, 'covered'), held('USO', 400, 'unmanaged')], noFence, sleeve);
    expect(book.SGOV.reasons.map((r) => r.kind)).toEqual(['yield-sleeve']);
    expect(book.ANET).toEqual({ symbol: 'ANET', exitsApply: true, ordersApply: true, reasons: [] });
    expect(book.USO.reasons.map((r) => r.kind)).toEqual(['unaccounted']);
  });

  it('an unaccounted fund reads unaccounted only: the dispatch disarms the sleeve rather than manage what its fills do not explain', () => {
    const g = positionGovernance(held('SGOV', 150, 'unmanaged'), noFence, sleeve);
    expect(g.reasons.map((r) => r.kind)).toEqual(['unaccounted']);
    expect(g.exitsApply).toBe(false);
    expect(g.ordersApply).toBe(false);
  });

  it('an unread ledger keeps the exits false (exempt either way) and the orders NOT KNOWN', () => {
    const g = positionGovernance(held('SGOV', 150, 'unread'), noFence, sleeve);
    expect(g.reasons.map((r) => r.kind)).toEqual(['yield-sleeve', 'accountability-unknown']);
    expect(g.exitsApply).toBe(false);
    expect(g.ordersApply, 'whether the sleeve trades it depends on a mark nobody read').toBeNull();
  });

  it('a fund named in TRADING_CORE_SYMBOLS is never the sleeve\'s: the ring-fence answers, as the dispatch refuses to arm', () => {
    const fence: CoreConfig = { symbols: ['SGOV'], targetPct: 0, perSymbolPct: new Map([['SGOV', 0]]) };
    expect(armedYieldSleeve(knob(5), 'paper', fence)).toBeNull();
    expect(kinds(held('SGOV', 150, 'covered'), fence)).toEqual(['ring-fenced']);
    expect(positionGovernance(held('SGOV', 150, 'covered'), fence, sleeve).reasons.map((r) => r.kind)).toEqual(['ring-fenced']);
  });

  it('armedYieldSleeve reads the one resolver: a knob decides, an absent knob inherits the mode-aware arm, 0 is off', () => {
    expect(armedYieldSleeve(null, 'paper', noFence), 'off by default').toBeNull();
    expect(armedYieldSleeve(knob(8), 'live', noFence)).toEqual({ symbol: 'SGOV', floatPct: 8 });
    process.env.TRADING_YIELD_SLEEVE = 'paper';
    expect(armedYieldSleeve(knob(null), 'paper', noFence), 'blank float = the pre-registered 5%').toEqual({ symbol: 'SGOV', floatPct: 5 });
    expect(armedYieldSleeve(knob(null), 'live', noFence), 'a paper arm does not arm live').toBeNull();
    expect(armedYieldSleeve(knob(0), 'paper', noFence), 'an explicit 0 disarms an env-armed book').toBeNull();
    process.env.TRADING_YIELD_SLEEVE_SYMBOL = 'bil';
    process.env.TRADING_YIELD_SLEEVE_FLOAT_PCT = '7';
    expect(armedYieldSleeve(undefined, 'paper', noFence)).toEqual({ symbol: 'BIL', floatPct: 7 });
  });

  it('agrees with the dispatch symbol by symbol: armed exactly when resolveYieldSleeve arms, exempt exactly what it exempts', async () => {
    const paper: TradingBook = {
      bookId: '00000000-0000-4000-8000-0000000060f1', ref: 'paper', kind: 'paper', broker: null, accountNumber: null,
      connectionKey: null, capitalCapUsd: null, learn: true, enabled: true,
    };
    const pool = { query: async () => ({ rows: [] }) } as never;
    const positions = [held('SGOV', 150, 'covered'), held('ANET', 20, 'covered'), held('SPY', 40, 'covered')];
    const matrix: Array<{ env: Record<string, string>; strategy: ReturnType<typeof knob> | null }> = [
      { env: {}, strategy: null },
      { env: {}, strategy: knob(6) },
      { env: { TRADING_YIELD_SLEEVE: 'paper' }, strategy: null },
      { env: { TRADING_YIELD_SLEEVE: 'live' }, strategy: null },
      { env: { TRADING_YIELD_SLEEVE: 'both' }, strategy: knob(0) },
      { env: { TRADING_YIELD_SLEEVE: 'paper', TRADING_CORE_SYMBOLS: 'SPY:30,SGOV:10' }, strategy: null },
      { env: { TRADING_YIELD_SLEEVE: 'paper', TRADING_YIELD_SLEEVE_SYMBOL: 'ANET' }, strategy: null },
    ];
    for (const { env, strategy } of matrix) {
      for (const k of ENV) delete process.env[k];
      Object.assign(process.env, env);
      const override = strategy as never;
      const core = coreConfig(override);
      const control = await resolveYieldSleeve(pool, 'spec-governance-sleeve', paper, override, positions);
      const armed = armedYieldSleeve(override, paper.kind, core);
      const label = JSON.stringify({ env, strategy });
      expect(armed === null, label + ': armed exactly when the dispatch arms').toBe(control === null);
      if (control) expect(armed).toEqual({ symbol: control.symbol, floatPct: control.floatPct });
      const answered = positionGovernanceBySymbol(positions, core, armed);
      const legView = new Set(sleevePositions(positions, control).map((p) => p.symbol));
      const exempt = new Set([...core.symbols, ...sleeveExemptSymbols(control)]);
      for (const p of positions) {
        const dispatchRunsExits = legView.has(p.symbol) && !exempt.has(p.symbol);
        expect(answered[p.symbol].exitsApply, label + ': ' + p.symbol).toBe(dispatchRunsExits);
      }
    }
  });
});
