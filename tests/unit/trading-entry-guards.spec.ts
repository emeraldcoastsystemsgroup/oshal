/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — rotation entry guards. The regression under test is the 2026-07-14 live open: the autopilot stopped IBM out at -23.8% on its Q2 revenue-miss gap and re-bought it in the same fire. Covers both guards (same-fire re-entry, gap-down), the fail-open contract on missing data, the prior-session-close selection (today's forming bar must NOT be mistaken for yesterday's close), and slot backfill.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  maxGapDownPct, gapPct, priorSessionClose, etSessionDate, entryBlock, selectEntryTargets,
  DEFAULT_MAX_GAP_DOWN_PCT, type EntryGuardInput,
} from '../../src/features/trading';

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
