/** CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Reproduce tax-basis profit/trailing/peak defects with active policy, while retaining suppress-only stops, uncovered fallback and unmanaged exclusions.
 */
import { describe, expect, it } from 'vitest';
import { protectionCostBasis, exitsToRun, trailingExits, nextPeaks, RISK_POLICIES } from '../../src/features/trading/services/portfolio';
import type { Position } from '../../src/features/trading';
const policy = RISK_POLICIES.active;
const position = (venue: number, last: number, engine?: number): Position => ({
  symbol: 'ABC', qty: 10, avgEntryPrice: venue, currentPrice: last,
  marketValue: last * 10, unrealizedPl: (last - venue) * 10, engineAvgCost: engine,
});

describe('covered protection basis', () => {
  it('uses only a positive finite covered engine basis and otherwise the venue basis', () => {
    expect(protectionCostBasis(position(130, 106, 100))).toBe(100);
    for (const basis of [undefined, 0, -1, NaN, Infinity]) expect(protectionCostBasis(position(130, 106, basis))).toBe(130);
    expect(protectionCostBasis({ ...position(130, 106, 100), unmanaged: true })).toBe(130);
    expect(protectionCostBasis(position(0, 110))).toBeUndefined();
    expect(protectionCostBasis(position(0, 110, 100))).toBe(100);
  });

  it('takes actual engine profit even when the venue reports a wash-sale stop', () => {
    const p = position(130, 110, 100);
    expect(exitsToRun([p], policy)).toEqual([{ symbol: 'ABC', qty: 10, reason: 'take_profit', pnlPct: 10 }]);
    expect(exitsToRun([position(130, 107.99, 100)], policy)).toEqual([]);
    expect(exitsToRun([position(130, 108, 100)], policy)[0].reason).toBe('take_profit');
  });

  it('does not take profit merely because the venue basis understates covered engine cost', () => {
    expect(exitsToRun([position(80, 110, 105)], policy)).toEqual([]);
  });

  it('keeps the existing suppress-only stop decision and never creates a new engine-basis stop', () => {
    expect(exitsToRun([position(130, 100, 100)], policy)).toEqual([]);
    expect(exitsToRun([position(130, 94, 100)], policy)[0].reason).toBe('stop_loss');
    expect(exitsToRun([position(90, 94, 100)], policy)).toEqual([]);
  });

  it('falls back to the original venue P&L when there is no coverage, without inventing coverage', () => {
    expect(exitsToRun([position(100, 108)], policy)[0].reason).toBe('take_profit');
    const p = { ...position(100, 120), unrealizedPl: 0 };
    expect(exitsToRun([p], policy)).toEqual([]);
    expect(exitsToRun([position(100, 94)], policy)[0].reason).toBe('stop_loss');
  });

  it('requires a valid current quote for engine-basis profit but can use covered cost if venue cost is absent', () => {
    for (const last of [undefined, NaN, Infinity, 0, -1]) {
      const p = { ...position(100, 110, 100), currentPrice: last };
      expect(exitsToRun([p], policy)).toEqual([]);
      expect(trailingExits([p], new Map([['ABC', 120]]), policy)).toEqual([]);
    }
    expect(exitsToRun([position(0, 110, 100)], policy)[0].reason).toBe('take_profit');
  });

  it('uses engine cost for trailing gain and new peak floor without changing current-price arming', () => {
    const p = position(130, 106, 100);
    const peaks = nextPeaks([p], new Map());
    expect(peaks.get('ABC')).toBe(106);
    expect(trailingExits([p], new Map([['ABC', 110]]), policy)[0]).toMatchObject({ reason: 'trailing_stop', pnlPct: 6 });
    expect(trailingExits([position(130, 104, 100)], new Map([['ABC', 110]]), policy)).toEqual([]);
    expect(trailingExits([position(100, 106, 110)], new Map([['ABC', 120]]), policy)).toEqual([]);
  });

  it('preserves genuine prior peaks, prunes closed positions and refuses nonfinite peak inputs', () => {
    const p = position(130, 106, 100);
    expect(nextPeaks([p], new Map([['ABC', 140]])).get('ABC')).toBe(140);
    expect(nextPeaks([], new Map([['ABC', 140]])).size).toBe(0);
    expect(nextPeaks([{ ...p, currentPrice: NaN }], new Map([['ABC', Infinity]])).get('ABC')).toBe(100);
    expect(nextPeaks([position(130, 106)], new Map()).get('ABC')).toBe(130);
  });

  it('never creates exits for an unmanaged position even with a stale engine mark', () => {
    const p = { ...position(130, 110, 100), unmanaged: true };
    expect(exitsToRun([p], policy)).toEqual([]);
    expect(trailingExits([p], new Map([['ABC', 150]]), policy)).toEqual([]);
    expect(policy).toMatchObject({ stopLossPct: 5, takeProfitPct: 8, trailArmPct: 5, trailGivebackPct: 3 });
  });
});
