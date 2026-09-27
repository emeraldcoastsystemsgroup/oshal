/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — rotation entry guards. The regression under test is the 2026-07-14 live open: the autopilot stopped IBM out at -23.8% on its Q2 revenue-miss gap and re-bought it in the same fire. Covers both guards (same-fire re-entry, gap-down), the fail-open contract on missing data, the prior-session-close selection (today's forming bar must NOT be mistaken for yesterday's close), and slot backfill.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-052 addendum — the market-wide gap-down filter's pure half: marketGapBlock (blocks at and beyond the bar, never at 0, fails OPEN on a missing or unusable price) and marketGapFilterPct, the one resolver the dispatch and the Strategy Lab share (a finite knob outranks the env, 0 is an explicit off, an absent knob inherits the mode-aware TRADING_MARKET_GAP_FILTER only for the armed book kind, a Lab walk with no book is off, clamps and garbage).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Regression: a BLANK TRADING_MARKET_GAP_PCT is unset. The compose file forwards it as `${TRADING_MARKET_GAP_PCT:-}`, so a box armed with TRADING_MARKET_GAP_FILTER=paper and no bar in .env hands the api an empty string, which the resolver used to read as 0 (off while armed). The blank is taken from the compose file itself (composeEnvDefault), whitespace is blank too, and a deliberate '0' stays the explicit off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  maxGapDownPct, gapPct, priorSessionClose, etSessionDate, entryBlock, selectEntryTargets,
  DEFAULT_MAX_GAP_DOWN_PCT, type EntryGuardInput,
  marketGapBlock, marketGapFilterPct, modeArmed, DEFAULT_MARKET_GAP_PCT,
} from '../../src/features/trading';
import { composeEnvDefault } from '../helpers/compose-env-default';

/** A guard with no exits pending and no price opinions — the permissive baseline each test narrows. */
function guard(over: Partial<EntryGuardInput> = {}): EntryGuardInput {
  return {
    exiting: new Set<string>(),
    priorCloses: new Map<string, number>(),
    currentPrices: new Map<string, number>(),
    maxGapDownPct: 8,
    ...over,
  };
}

describe('maxGapDownPct (TRADING_ROTATION_MAX_GAP_DOWN_PCT)', () => {
  beforeEach(() => { delete process.env.TRADING_ROTATION_MAX_GAP_DOWN_PCT; });

  it('defaults to 8% when unset', () => {
    expect(maxGapDownPct()).toBe(DEFAULT_MAX_GAP_DOWN_PCT);
    expect(maxGapDownPct()).toBe(8);
  });

  it('honors an operator override', () => {
    process.env.TRADING_ROTATION_MAX_GAP_DOWN_PCT = '12.5';
    expect(maxGapDownPct()).toBe(12.5);
  });

  it('treats 0 as an explicit OFF switch (a guard you cannot disable cannot be backtested)', () => {
    process.env.TRADING_ROTATION_MAX_GAP_DOWN_PCT = '0';
    expect(maxGapDownPct()).toBe(0);
  });

  it('treats garbage as OFF rather than blocking the whole sleeve', () => {
    process.env.TRADING_ROTATION_MAX_GAP_DOWN_PCT = 'not-a-number';
    expect(maxGapDownPct()).toBe(0);
  });
});

describe('gapPct', () => {
  it('signs a gap DOWN negative', () => {
    // IBM on 2026-07-14: $296.70 prior close → $225.94.
    expect(gapPct(225.94, 296.70)).toBeCloseTo(-23.85, 1);
  });

  it('signs a gap UP positive', () => {
    expect(gapPct(110, 100)).toBeCloseTo(10, 6);
  });

  it('returns null on an unusable reference close (no opinion ≠ flat)', () => {
    expect(gapPct(100, 0)).toBeNull();
    expect(gapPct(100, -5)).toBeNull();
    expect(gapPct(100, NaN)).toBeNull();
  });
});

describe('priorSessionClose', () => {
  const today = '2026-07-14';

  it("takes YESTERDAY's close, never today's forming bar — the whole point of the guard", () => {
    // A mid-session daily series already carries a partial bar for today. Taking the last element
    // would compare today's price against ITSELF, computing a ~0% gap and no-opping the guard on
    // exactly the day it matters.
    const closes = [
      { d: '2026-07-10', c: 300 },
      { d: '2026-07-13', c: 296.7 },
      { d: '2026-07-14', c: 225.94 }, // today, still forming
    ];
    expect(priorSessionClose(closes, today)).toBe(296.7);
  });

  it('uses the last available session when the series stops short of today', () => {
    const closes = [{ d: '2026-07-10', c: 300 }, { d: '2026-07-13', c: 296.7 }];
    expect(priorSessionClose(closes, today)).toBe(296.7);
  });

  it('skips unusable bars', () => {
    const closes = [{ d: '2026-07-10', c: 300 }, { d: '2026-07-13', c: 0 }];
    expect(priorSessionClose(closes, today)).toBe(300);
  });

  it('returns null when nothing precedes today (no opinion → caller fails open)', () => {
    expect(priorSessionClose([{ d: '2026-07-14', c: 225.94 }], today)).toBeNull();
    expect(priorSessionClose([], today)).toBeNull();
    expect(priorSessionClose(undefined, today)).toBeNull();
  });
});

describe('etSessionDate', () => {
  it('returns the MARKET day, not the server day', () => {
    // 2026-07-14 02:30 UTC is still 2026-07-13 in New York (22:30 EDT).
    expect(etSessionDate(Date.parse('2026-07-14T02:30:00Z'))).toBe('2026-07-13');
    expect(etSessionDate(Date.parse('2026-07-14T13:35:00Z'))).toBe('2026-07-14');
  });
});

describe('entryBlock — guard 1: never re-buy what the stop is selling this fire', () => {
  it('refuses a name the protective leg is exiting right now (THE IBM REGRESSION)', () => {
    const block = entryBlock('IBM', guard({ exiting: new Set(['IBM']) }));
    expect(block).not.toBeNull();
    expect(block!.reason).toBe('exiting-this-fire');
  });

  it('is case-insensitive', () => {
    expect(entryBlock('ibm', guard({ exiting: new Set(['IBM']) }))!.reason).toBe('exiting-this-fire');
  });

  it('still refuses even with the gap guard disabled — the two guards are independent', () => {
    const block = entryBlock('IBM', guard({ exiting: new Set(['IBM']), maxGapDownPct: 0 }));
    expect(block!.reason).toBe('exiting-this-fire');
  });

  it('allows an untouched name', () => {
    expect(entryBlock('EOG', guard({ exiting: new Set(['IBM']) }))).toBeNull();
  });
});

describe('entryBlock — guard 2: never buy into a gap-down', () => {
  const ibm = () => guard({
    priorCloses: new Map([['IBM', 296.7]]),
    currentPrices: new Map([['IBM', 225.94]]),
  });

  it('refuses IBM at -23.8% against an 8% bar', () => {
    const block = entryBlock('IBM', ibm());
    expect(block).not.toBeNull();
    expect(block!.reason).toBe('gap-down');
    expect(block!.gapPct).toBeCloseTo(-23.85, 1);
  });

  it('allows it when the operator raises the bar past the gap', () => {
    expect(entryBlock('IBM', { ...ibm(), maxGapDownPct: 30 })).toBeNull();
  });

  it('allows it when the guard is switched OFF', () => {
    expect(entryBlock('IBM', { ...ibm(), maxGapDownPct: 0 })).toBeNull();
  });

  it('blocks exactly AT the bar, not just past it', () => {
    const g = guard({ priorCloses: new Map([['X', 100]]), currentPrices: new Map([['X', 92]]) });
    expect(entryBlock('X', g)!.reason).toBe('gap-down'); // -8.0% with an 8 bar
  });

  it('allows a name just inside the bar', () => {
    const g = guard({ priorCloses: new Map([['X', 100]]), currentPrices: new Map([['X', 92.5]]) });
    expect(entryBlock('X', g)).toBeNull(); // -7.5%
  });

  it('never blocks a gap UP', () => {
    const g = guard({ priorCloses: new Map([['X', 100]]), currentPrices: new Map([['X', 140]]) });
    expect(entryBlock('X', g)).toBeNull();
  });

  it('FAILS OPEN on missing data — a data hole must not silently empty the sleeve', () => {
    expect(entryBlock('X', guard({ currentPrices: new Map([['X', 50]]) }))).toBeNull();  // no prior close
    expect(entryBlock('X', guard({ priorCloses: new Map([['X', 100]]) }))).toBeNull();   // no current price
    expect(entryBlock('X', guard())).toBeNull();                                          // neither
  });
});

describe('selectEntryTargets', () => {
  it('backfills a refused leader from the next-best candidate (a block costs no deployment)', () => {
    // IBM is the #2 rank but gapped; the sleeve should still hold N names, not N-1.
    const g = guard({
      priorCloses: new Map([['IBM', 296.7]]),
      currentPrices: new Map([['IBM', 225.94]]),
    });
    const { targets, blocked } = selectEntryTargets(['EOG', 'IBM', 'AMAT', 'BIIB'], 3, g);
    expect(targets).toEqual(['EOG', 'AMAT', 'BIIB']);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ symbol: 'IBM', reason: 'gap-down' });
  });

  it('holds rank order among the survivors (strongest first)', () => {
    const { targets } = selectEntryTargets(['A', 'B', 'C'], 3, guard());
    expect(targets).toEqual(['A', 'B', 'C']);
  });

  it('never exceeds N', () => {
    const { targets } = selectEntryTargets(['A', 'B', 'C', 'D'], 2, guard());
    expect(targets).toEqual(['A', 'B']);
  });

  it('returns a SHORT list when the slate runs out of clean names (never pads with a blocked one)', () => {
    const g = guard({ exiting: new Set(['B', 'C']) });
    const { targets, blocked } = selectEntryTargets(['A', 'B', 'C'], 3, g);
    expect(targets).toEqual(['A']);
    expect(blocked.map((b) => b.symbol)).toEqual(['B', 'C']);
  });

  it("reproduces the fixed IBM fire end-to-end: stopped out AND gapped → refused twice over", () => {
    const g = guard({
      exiting: new Set(['IBM']),
      priorCloses: new Map([['IBM', 296.7]]),
      currentPrices: new Map([['IBM', 225.94]]),
    });
    const { targets, blocked } = selectEntryTargets(['IBM', 'EOG'], 2, g);
    expect(targets).toEqual(['EOG']);           // IBM is NOT re-bought
    expect(blocked[0].reason).toBe('exiting-this-fire'); // the stop wins the refusal
  });
});

describe('marketGapBlock — the market-wide gap-down verdict (ADR-052 addendum)', () => {
  it('blocks when SPY sits at or beyond the bar below its prior close', () => {
    expect(marketGapBlock(490, 500, 1)).toMatchObject({ blocked: true, spyPrice: 490, spyPriorClose: 500, thresholdPct: 1 });
    expect(marketGapBlock(490, 500, 1).gapPct).toBeCloseTo(-2, 9);
    // Exactly ON the line blocks (the rule reads "down >= X%").
    expect(marketGapBlock(495, 500, 1).blocked).toBe(true);
  });

  it('does not block a smaller dip, a flat tape or a gap UP', () => {
    expect(marketGapBlock(497.5, 500, 1).blocked).toBe(false);
    expect(marketGapBlock(500, 500, 1).blocked).toBe(false);
    expect(marketGapBlock(520, 500, 1).blocked).toBe(false);
  });

  it('fails OPEN on missing or unusable data — a data hole must never stop the book buying', () => {
    expect(marketGapBlock(null, 500, 1)).toMatchObject({ blocked: false, gapPct: null });
    expect(marketGapBlock(450, null, 1)).toMatchObject({ blocked: false, gapPct: null });
    expect(marketGapBlock(450, 0, 1)).toMatchObject({ blocked: false, gapPct: null });
  });

  it('a threshold of 0 is the off switch and never blocks, however deep the gap', () => {
    expect(marketGapBlock(250, 500, 0).blocked).toBe(false);
  });
});

describe('marketGapFilterPct — ONE resolver for the dispatch and the Strategy Lab', () => {
  const ENV = ['TRADING_MARKET_GAP_FILTER', 'TRADING_MARKET_GAP_PCT'];
  beforeEach(() => { for (const k of ENV) delete process.env[k]; });

  it('is OFF by default for both books and for a Lab walk', () => {
    expect(marketGapFilterPct(undefined, 'paper')).toBe(0);
    expect(marketGapFilterPct(null, 'live')).toBe(0);
    expect(marketGapFilterPct(undefined, null)).toBe(0);
  });

  it('an absent knob inherits the mode-aware env arm — paper arms paper ONLY', () => {
    process.env.TRADING_MARKET_GAP_FILTER = 'paper';
    expect(marketGapFilterPct(undefined, 'paper')).toBe(DEFAULT_MARKET_GAP_PCT);
    expect(DEFAULT_MARKET_GAP_PCT).toBe(1);
    expect(marketGapFilterPct(undefined, 'live')).toBe(0);
    // A Lab walk has no book, so the env can never arm it: the twin row's own knob decides.
    expect(marketGapFilterPct(undefined, null)).toBe(0);
    process.env.TRADING_MARKET_GAP_FILTER = 'both';
    expect(marketGapFilterPct(null, 'live')).toBe(1);
    process.env.TRADING_MARKET_GAP_PCT = '1.5';
    expect(marketGapFilterPct(null, 'paper')).toBe(1.5);
  });

  it('a finite knob on the applied strategy outranks the env — 0 is an explicit off, >0 arms', () => {
    process.env.TRADING_MARKET_GAP_FILTER = 'both';
    expect(marketGapFilterPct(0, 'paper')).toBe(0);
    delete process.env.TRADING_MARKET_GAP_FILTER;
    expect(marketGapFilterPct(2, 'live')).toBe(2);
    expect(marketGapFilterPct(2, null)).toBe(2); // the Lab reads the same knob the same way
  });

  it('a BLANK bar is unset: armed with the value compose forwards for an unset .env, it is the pre-registered 1.0, not off', () => {
    // docker-compose.oshal-local.yml forwards `${TRADING_MARKET_GAP_PCT:-}`: leave the bar out of .env
    // and the api's process.env holds exactly this string. The arm alone must arm the filter.
    const forwarded = composeEnvDefault('TRADING_MARKET_GAP_PCT');
    expect(forwarded).toBe('');
    expect(composeEnvDefault('TRADING_MARKET_GAP_FILTER')).toBe('false'); // an untouched box stays off
    process.env.TRADING_MARKET_GAP_FILTER = 'paper'; // the operator's one-line arm in .env
    process.env.TRADING_MARKET_GAP_PCT = forwarded;
    expect(marketGapFilterPct(undefined, 'paper')).toBe(DEFAULT_MARKET_GAP_PCT);
    expect(marketGapFilterPct(undefined, 'live')).toBe(0); // the arm still decides the book kind
    process.env.TRADING_MARKET_GAP_PCT = '   ';
    expect(marketGapFilterPct(undefined, 'paper')).toBe(DEFAULT_MARKET_GAP_PCT);
    process.env.TRADING_MARKET_GAP_PCT = '0'; // a deliberate zero is not blank: the explicit off
    expect(marketGapFilterPct(undefined, 'paper')).toBe(0);
  });

  it('clamps to 50 and treats garbage as off', () => {
    expect(marketGapFilterPct(400, 'paper')).toBe(50);
    expect(marketGapFilterPct(-3, 'paper')).toBe(0);
    process.env.TRADING_MARKET_GAP_FILTER = 'paper';
    process.env.TRADING_MARKET_GAP_PCT = 'not-a-number';
    expect(marketGapFilterPct(undefined, 'paper')).toBe(0);
  });

  it('modeArmed parses paper|live|both|true exactly like the earnings gate', () => {
    process.env.TRADING_MARKET_GAP_FILTER = 'LIVE';
    expect(modeArmed('TRADING_MARKET_GAP_FILTER', 'live')).toBe(true);
    expect(modeArmed('TRADING_MARKET_GAP_FILTER', 'paper')).toBe(false);
    process.env.TRADING_MARKET_GAP_FILTER = 'true';
    expect(modeArmed('TRADING_MARKET_GAP_FILTER', 'paper')).toBe(true);
    process.env.TRADING_MARKET_GAP_FILTER = 'yes';
    expect(modeArmed('TRADING_MARKET_GAP_FILTER', 'paper')).toBe(false);
  });
});
