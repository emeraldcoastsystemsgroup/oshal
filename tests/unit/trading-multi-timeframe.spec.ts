import { describe, expect, it } from 'vitest';
import { decideSymbol, isShortTermBreakdown, DEFAULT_UNIVERSE } from '../../src/features/trading/services/multi-timeframe';
import type { Timeframe } from '../../src/features/trading/services/market-data';

/** A clean rising series (each bar up `step`) — every trend algo reads "up". */
function rising(n: number, start = 100, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}
/** A clean falling series — every trend algo reads "down". */
function falling(n: number, start = 200, step = 1): number[] {
  return Array.from({ length: n }, (_, i) => start - i * step);
}
/** Build a per-timeframe map with the same shape on every timeframe. */
function allTimeframes(series: number[]): Map<Timeframe, number[]> {
  return new Map<Timeframe, number[]>([
    ['5Min', series], ['1Hour', series], ['1Day', series], ['1Week', series], ['3Month', series],
  ]);
}

describe('multi-timeframe trading decision', () => {
  it('buys when every timeframe trends up (aligned regime)', () => {
    const d = decideSymbol('AAPL', allTimeframes(rising(60)));
    expect(d.action).toBe('buy');
    expect(d.side).toBe('buy');
    expect(d.score).toBeGreaterThan(0.2);
    expect(d.regime).toBeGreaterThanOrEqual(0);
    expect(d.price).toBe(rising(60)[59]); // last close is the reference price
    expect(d.perTimeframe).toHaveLength(5);
  });

  it('sells when every timeframe trends down', () => {
    const d = decideSymbol('XOM', allTimeframes(falling(60)));
    expect(d.action).toBe('sell');
    expect(d.side).toBe('sell');
    expect(d.score).toBeLessThan(-0.2);
  });

  it('holds when the higher-timeframe regime opposes the short-term move (risk gate)', () => {
    // Short timeframes push up, but weekly + quarterly (the regime) are firmly down →
    // the alignment gate must veto the buy and resolve to hold.
    const map = new Map<Timeframe, number[]>([
      ['5Min', rising(60)], ['1Hour', rising(60)], ['1Day', rising(60)],
      ['1Week', falling(60)], ['3Month', falling(60)],
    ]);
    const d = decideSymbol('TSLA', map);
    expect(d.regime).toBeLessThan(0);
    expect(d.action).not.toBe('buy');
  });

  it('holds when no algorithm fires (too little history on every timeframe)', () => {
    // Series shorter than SMA20/RSI14/donchian20/gravity-25 windows → no votes → hold.
    const tooShort = Array.from({ length: 10 }, (_, i) => 100 + i);
    const d = decideSymbol('KO', allTimeframes(tooShort));
    expect(d.action).toBe('hold');
    expect(d.side).toBeNull();
    expect(d.score).toBe(0);
  });

  it('still decides when some timeframes lack data (renormalizes weights)', () => {
    const map = new Map<Timeframe, number[]>([['1Day', rising(60)], ['1Week', rising(60)]]);
    const d = decideSymbol('MSFT', map);
    expect(d.perTimeframe).toHaveLength(2);
    expect(d.rationale).toContain('tf w/o data');
    expect(['buy', 'sell', 'hold']).toContain(d.action);
  });

  it('flags a short-timeframe breakdown when 5min+1h crash while the regime is still up', () => {
    // Today's tech-crash shape: intraday (5Min+1Hour) falling hard, but daily/weekly/quarterly still
    // rising → the regime-weighted decision is NOT a sell, yet a held name should protect itself.
    const map = new Map<Timeframe, number[]>([
      ['5Min', falling(60)], ['1Hour', falling(60)],
      ['1Day', rising(60)], ['1Week', rising(60)], ['3Month', rising(60)],
    ]);
    const d = decideSymbol('NVDA', map);
    expect(d.action).not.toBe('sell');           // the weighted score never flags it (regime up)
    expect(isShortTermBreakdown(d)).toBe(true);   // but the short-TF breakdown catches the crash
  });

  it('needs BOTH short timeframes bearish to flag a breakdown (no single-wiggle whipsaw)', () => {
    const map = new Map<Timeframe, number[]>([
      ['5Min', falling(60)], ['1Hour', rising(60)],
      ['1Day', rising(60)], ['1Week', rising(60)], ['3Month', rising(60)],
    ]);
    expect(isShortTermBreakdown(decideSymbol('MSFT', map))).toBe(false);
  });

  it('does not flag a breakdown when the short timeframes are healthy', () => {
    expect(isShortTermBreakdown(decideSymbol('AAPL', allTimeframes(rising(60))))).toBe(false);
  });

  it('ships a diversified ~100-name default universe with no duplicates', () => {
    expect(DEFAULT_UNIVERSE.length).toBeGreaterThanOrEqual(95);
    expect(new Set(DEFAULT_UNIVERSE).size).toBe(DEFAULT_UNIVERSE.length);
    for (const sym of DEFAULT_UNIVERSE) expect(sym).toMatch(/^[A-Z]{1,5}$/);
  });
});
