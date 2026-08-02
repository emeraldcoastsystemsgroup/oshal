/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the Export-generation Target-1 partial scale-out (BACKLOG row 402): 1R measured off the RAW initial stop, the truncating percent-of-filled quantity with its one-lot whole-position case, limit-fill semantics including gap-open improvement, the short mirror, the post-target MFE stop move with its ATR fudge fallback and 2-tick buffer, and the default-OFF posture that keeps the dynstops generation target-free.
 */
import { describe, it, expect } from 'vitest';
import { resolveTarget1, target1FillPrice, resolvePostTargetStop, TARGET_LADDER_DEFAULTS } from '../../src/features/trading';
import type { OhlcvBar } from '../../src/features/trading/services/market-data';

const TICK = 0.25;
const ON = { useTargets: true };

function bar(o: number, h: number, l: number, c: number): OhlcvBar {
  return { o, h, l, c, v: 1000 };
}

describe('resolveTarget1 — the Export generation\'s partial', () => {
  const base = { direction: 'long' as const, entryPrice: 100, rawInitialStop: 96, filledQuantity: 10 };

  it('is OFF unless asked for — the default generation (dynstops) ships no targets', () => {
    expect(resolveTarget1(base)).toBeNull();
    expect(TARGET_LADDER_DEFAULTS.useTargets).toBe(false);
    expect(resolveTarget1({ ...base, config: { useTargets: false } })).toBeNull();
  });

  it('prices the target at 1R off the RAW initial stop, not a rounded or clamped one', () => {
    // riskPerUnit = |100 - 96| = 4; multiplier 1.0 → target 104.
    const t = resolveTarget1({ ...base, config: ON })!;
    expect(t.riskPerUnit).toBeCloseTo(4, 10);
    expect(t.price).toBeCloseTo(104, 10);
    // A different RAW stop must move the target even when the entry is unchanged — this is the
    // clause that goes red if someone "tidies" the port onto the validated stop.
    expect(resolveTarget1({ ...base, rawInitialStop: 93, config: ON })!.price).toBeCloseTo(107, 10);
  });

  it('honours Target1Multiplier as a multiple of R', () => {
    expect(resolveTarget1({ ...base, config: { ...ON, target1Multiplier: 2 } })!.price).toBeCloseTo(108, 10);
    expect(resolveTarget1({ ...base, config: { ...ON, target1Multiplier: 0.5 } })!.price).toBeCloseTo(102, 10);
  });

  it('quantity is a TRUNCATED percent of filled size (the C# int cast), not a rounded one', () => {
    // 7 × 50% = 3.5 → trunc 3, never 4. Rounding would close more than his code does.
    expect(resolveTarget1({ ...base, filledQuantity: 7, config: ON })!.quantity).toBe(3);
    expect(resolveTarget1({ ...base, filledQuantity: 10, config: ON })!.quantity).toBe(5);
    expect(resolveTarget1({ ...base, filledQuantity: 9, config: { ...ON, target1Percent: 33 } })!.quantity).toBe(2);
  });

  it('a ONE-LOT position takes a one-lot "partial" that closes the whole position', () => {
    // max(1, trunc(1 × 50%)) = max(1, 0) = 1. This is his behavior at small size, not a bug — and
    // the caller must know, because no post-target stop move can follow a full exit.
    const t = resolveTarget1({ ...base, filledQuantity: 1, config: ON })!;
    expect(t.quantity).toBe(1);
    expect(t.closesWholePosition).toBe(true);
    expect(resolveTarget1({ ...base, filledQuantity: 10, config: ON })!.closesWholePosition).toBe(false);
  });

  it('mirrors for shorts — the target sits BELOW the entry', () => {
    const t = resolveTarget1({ direction: 'short', entryPrice: 100, rawInitialStop: 104, filledQuantity: 10, config: ON })!;
    expect(t.riskPerUnit).toBeCloseTo(4, 10);
    expect(t.price).toBeCloseTo(96, 10);
  });

  it('refuses to invent a target when 1R is unmeasurable or the position is empty', () => {
    expect(resolveTarget1({ ...base, rawInitialStop: 100, config: ON })).toBeNull(); // zero risk
    expect(resolveTarget1({ ...base, rawInitialStop: NaN, config: ON })).toBeNull();
    expect(resolveTarget1({ ...base, filledQuantity: 0, config: ON })).toBeNull();
  });

  it('an explicit-undefined config value uses the default instead of producing NaN', () => {
    const t = resolveTarget1({ ...base, config: { useTargets: true, target1Multiplier: undefined } })!;
    expect(t.price).toBeCloseTo(104, 10);
  });
});

describe('target1FillPrice — limit-order fill semantics', () => {
  it('does not fill on a bar that never reached the limit', () => {
    expect(target1FillPrice('long', 104, bar(100, 103.75, 99, 103))).toBeNull();
    expect(target1FillPrice('short', 96, bar(100, 101, 96.25, 97))).toBeNull();
  });

  it('fills AT the limit when the bar trades through it intrabar', () => {
    expect(target1FillPrice('long', 104, bar(100, 105, 99, 103))).toBeCloseTo(104, 10);
    expect(target1FillPrice('short', 96, bar(100, 101, 95, 97))).toBeCloseTo(96, 10);
  });

  it('a GAP through a limit fills BETTER, at the open — the mirror of a stop\'s gap penalty', () => {
    // A long's sell limit at 104 with the bar opening at 107 fills at 107, not 104. Filling at the
    // limit here would quietly hand the gap to nobody; filling worse would be a stop's behavior.
    expect(target1FillPrice('long', 104, bar(107, 108, 106, 107.5))).toBeCloseTo(107, 10);
    expect(target1FillPrice('short', 96, bar(93, 94, 92, 93.5))).toBeCloseTo(93, 10);
  });

  it('never fills on a non-finite limit', () => {
    expect(target1FillPrice('long', NaN, bar(100, 200, 99, 150))).toBeNull();
  });
});

describe('resolvePostTargetStop — the one-shot MFE stop move', () => {
  const base = { direction: 'long' as const, entryPrice: 100, atr: 2, tickSize: TICK };

  it('moves the stop to entry + MFEStopPct% of the MFE distance, less a 2-tick buffer', () => {
    // MFE price 110 → distance 10 → 50% = 5 → 105, minus 2 ticks (0.5) = 104.5.
    expect(resolvePostTargetStop({ ...base, mfePrice: 110, config: ON })).toBeCloseTo(104.5, 10);
    expect(resolvePostTargetStop({ ...base, mfePrice: 110, config: { ...ON, mfeStopPct: 25 } })).toBeCloseTo(102, 10);
  });

  it('falls back to the ATR fudge when MFE never moved in the trade\'s favor', () => {
    // No favorable excursion → entry + 0.5 × ATR(2) = 101, minus 2 ticks = 100.5.
    expect(resolvePostTargetStop({ ...base, mfePrice: 99, config: ON })).toBeCloseTo(100.5, 10);
    expect(resolvePostTargetStop({ ...base, mfePrice: NaN, config: ON })).toBeCloseTo(100.5, 10);
    expect(resolvePostTargetStop({ ...base, mfePrice: 100, config: ON })).toBeCloseTo(100.5, 10); // exactly flat
  });

  it('mirrors for shorts — the stop comes DOWN toward entry and the buffer widens it', () => {
    // MFE price 90 → distance 10 → 50% = 5 → 95, plus 2 ticks = 95.5.
    expect(resolvePostTargetStop({ ...base, direction: 'short', mfePrice: 90, config: ON })).toBeCloseTo(95.5, 10);
    expect(resolvePostTargetStop({ ...base, direction: 'short', mfePrice: 101, config: ON })).toBeCloseTo(99.5, 10);
  });

  it('is monotone in MFE — a better excursion can only produce a higher long stop', () => {
    const at = (mfe: number): number => resolvePostTargetStop({ ...base, mfePrice: mfe, config: ON });
    expect(at(120)).toBeGreaterThan(at(110));
    expect(at(110)).toBeGreaterThan(at(105));
  });
});
