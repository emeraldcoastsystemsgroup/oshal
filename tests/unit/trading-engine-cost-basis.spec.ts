/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard the wash-sale stop-loss veto. On 2026-09-14 the live book stop-lossed 10 names and all 10 were spurious: each was measured against Schwab's reported averagePrice, which is the WASH-SALE-ADJUSTED basis (a disallowed loss folded into the replacement shares), so a name the engine had bought at 244.47 and could sell at 252.39 read as "-5.07%" and was sold. Fixtures here are those real fills, to the cent. The veto may only SUPPRESS a venue-basis stop; it must never create one.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | replayEngineRealized: a symbol back to flat realizes exactly sells minus buys (the identity the stored venue-basis column fails); a re-buy is priced at its own cost; partial sells close at the running average; an uncovered sell gets no figure; unusable rows are skipped.
 */

import { describe, expect, it } from 'vitest';
import { exitsToRun, RISK_POLICIES } from '../../src/features/trading/services/portfolio';
import type { Position } from '../../src/features/trading/services/broker-adapter';
import { replayEngineCost, engineCostBasisFor, replayEngineRealized } from '../../src/app/trading-engine-cost-basis';

// The LIVE book runs the `active` posture (5% hard stop, 8% take-profit). Testing under the 9%-stop
// posture made every veto case vacuous: a -5% to -8% venue loss never reaches a 9% stop, so the
// cases passed with the veto deleted. Mutation-checked against `active` instead.
const active = RISK_POLICIES.active;

/** A position exactly as the Schwab adapter reports it: the venue's (possibly wash-sale-adjusted) average. */
const venue = (symbol: string, qty: number, venueAvg: number, last: number, engineAvgCost?: number): Position => ({
  symbol, qty, avgEntryPrice: venueAvg, currentPrice: last, marketValue: qty * last,
  unrealizedPl: qty * (last - venueAvg),
  ...(engineAvgCost !== undefined ? { engineAvgCost } : {}),
});

const reasons = (positions: Position[]) =>
  Object.fromEntries(exitsToRun(positions, active).map((e) => [e.symbol, e.reason]));

describe('the wash-sale stop-loss veto (real 2026-09-14 live-book fills)', () => {
  it('holds CRM: the venue said -5.07% but the engine bought at 244.47 and it trades at 252.39 (+3.24%)', () => {
    expect(reasons([venue('CRM', 5, 265.878, 252.3901, 244.465)]).CRM).toBeUndefined();
  });

  it('holds the near-flat names the venue basis turned into stops', () => {
    const r = reasons([
      venue('SLB', 23, 58.2665, 55.215, 55.2902), // engine -0.14%, venue -5.24%
      venue('SMCI', 32, 39.52, 37.275, 37.375), // engine -0.27%, venue -5.68%
      venue('HOOD', 25, 121.7664, 114.05, 114.6411), // engine -0.52%, venue -6.34%
      venue('TEM', 14, 62.9879, 59.05, 59.37), // engine -0.54%, venue -6.25%
      venue('GILD', 6, 153.2, 144.045, 145.17), // engine -0.77%, venue -5.98%
    ]);
    expect(r).toEqual({});
  });

  it('still stops a genuine loser — the veto only removes stops the engine’s own cost does not support', () => {
    // Engine paid 100, venue inflated to 110, now 90: -10% on the engine's own money. Must sell.
    expect(reasons([venue('REAL', 10, 110, 90, 100)]).REAL).toBe('stop_loss');
  });

  it('still stops at exactly the line against the engine basis', () => {
    const line = 100 * (1 - active.stopLossPct / 100);
    expect(reasons([venue('EDGE', 10, 130, line - 0.01, 100)]).EDGE).toBe('stop_loss');
  });

  it('never CREATES a stop: an engine basis above the venue average cannot trigger a sell the venue would not', () => {
    // Venue avg 100, now 97 (-3%, hold). A higher engine basis would read -7.8% — ignored by design.
    expect(reasons([venue('HOLD', 10, 100, 97, 105.2)]).HOLD).toBeUndefined();
  });

  it('leaves take-profit untouched', () => {
    const tp = 100 * (1 + (active.takeProfitPct + 1) / 100);
    expect(reasons([venue('WIN', 10, 100, tp, 100)]).WIN).toBe('take_profit');
  });

  it('is unchanged when no engine basis is known — adopted and manual positions keep today’s behaviour', () => {
    expect(reasons([venue('ADOPTED', 10, 110, 100)]).ADOPTED).toBe('stop_loss');
  });

  it('ignores a non-positive or non-finite engine basis rather than dividing by it', () => {
    expect(reasons([venue('ZERO', 10, 110, 100, 0)]).ZERO).toBe('stop_loss');
    expect(reasons([venue('NAN', 10, 110, 100, Number.NaN)]).NAN).toBe('stop_loss');
  });

  it('needs a live price to veto: without one it falls back to the venue decision', () => {
    const p = venue('NOPX', 10, 110, 100, 100);
    delete p.currentPrice;
    expect(reasons([p]).NOPX).toBe('stop_loss');
  });
});

describe('replayEngineCost — average cost over the engine’s own fills', () => {
  const fill = (side: 'buy' | 'sell', qty: number, px: number) => ({ side, filled_qty: qty, filled_avg_price: px });

  it('averages buys', () => {
    expect(replayEngineCost([fill('buy', 10, 100), fill('buy', 10, 110)])).toEqual({ qty: 20, avg: 105 });
  });

  it('keeps the average on a partial sell (average-cost, not FIFO)', () => {
    const r = replayEngineCost([fill('buy', 10, 100), fill('buy', 10, 110), fill('sell', 5, 150)]);
    expect(r.qty).toBe(15);
    expect(r.avg).toBeCloseTo(105, 9);
  });

  it('resets to flat, so a re-buy starts a fresh basis — exactly what the venue basis does NOT do', () => {
    // 09-02 sell at a loss, 09-03 re-buy: the venue folds the loss in; the engine must not.
    const r = replayEngineCost([fill('buy', 10, 144.56), fill('sell', 10, 137.05), fill('buy', 10, 143.97)]);
    expect(r).toEqual({ qty: 10, avg: 143.97 });
  });

  it('ignores unfilled rows and never goes negative on an oversell', () => {
    const r = replayEngineCost([fill('sell', 5, 100), { side: 'buy', filled_qty: 0, filled_avg_price: 99 }, fill('buy', 4, 50)]);
    expect(r).toEqual({ qty: 4, avg: 50 });
  });
});

describe('engineCostBasisFor — only trusted when the engine accounts for the WHOLE position', () => {
  it('returns the engine basis when its replayed qty equals the venue qty', () => {
    expect(engineCostBasisFor({ qty: 5, avg: 244.465 }, 5)).toBe(244.465);
  });

  it('refuses when the venue holds MORE than the engine bought — manual lots make the true basis unknowable', () => {
    expect(engineCostBasisFor({ qty: 5, avg: 244.465 }, 7)).toBeUndefined();
  });

  it('refuses when the engine thinks it holds more than the venue — its ledger is out of step', () => {
    expect(engineCostBasisFor({ qty: 9, avg: 244.465 }, 5)).toBeUndefined();
  });

  it('refuses a flat or zero-cost replay', () => {
    expect(engineCostBasisFor({ qty: 0, avg: 0 }, 0)).toBeUndefined();
  });

  it('tolerates fractional-share rounding in the comparison', () => {
    expect(engineCostBasisFor({ qty: 5.0000004, avg: 100 }, 5)).toBe(100);
  });
});

describe('replayEngineRealized — realized P&L on the engine’s own cost', () => {
  const row = (order_id: string, side: 'buy' | 'sell', filled_qty: number, filled_avg_price: number) =>
    ({ order_id, side, filled_qty, filled_avg_price });

  it('a symbol that goes back to flat realizes exactly its sells minus its buys', () => {
    const rows = [row('b1', 'buy', 6, 202.195), row('s1', 'sell', 6, 192.6), row('b2', 'buy', 6, 193.2),
      row('s2', 'sell', 6, 184.99), row('b3', 'buy', 6, 201.11), row('s3', 'sell', 6, 199.225)];
    const sales = replayEngineRealized(rows);
    const cash = rows.reduce((sum, r) => sum + (r.side === 'sell' ? 1 : -1) * r.filled_qty * r.filled_avg_price, 0);
    const realized = [...sales.values()].reduce((sum, s) => sum + s.realizedPnl, 0);
    expect(realized).toBeCloseTo(cash, 6);
  });

  it('prices a re-buy at what it cost, not that plus the disallowed loss the venue folds in', () => {
    const sales = replayEngineRealized([row('b1', 'buy', 6, 201.11), row('s1', 'sell', 6, 199.225),
      row('b2', 'buy', 6, 187.595), row('s2', 'sell', 6, 190.0)]);
    expect(sales.get('s2')!.costBasis).toBeCloseTo(187.595, 6);
    expect(sales.get('s2')!.realizedPnl).toBeCloseTo((190.0 - 187.595) * 6, 6);
  });

  it('closes partial sells at the running average cost', () => {
    const sales = replayEngineRealized([row('b1', 'buy', 10, 10), row('b2', 'buy', 10, 20), row('s1', 'sell', 5, 18),
      row('s2', 'sell', 15, 12)]);
    expect(sales.get('s1')).toEqual({ costBasis: 15, realizedPnl: 15 });
    expect(sales.get('s2')!.realizedPnl).toBeCloseTo((12 - 15) * 15, 6);
  });

  it('gives no figure for a sell the ledger cannot cover, and starts fresh after it', () => {
    const sales = replayEngineRealized([row('b1', 'buy', 6, 100), row('s1', 'sell', 12, 110),
      row('b2', 'buy', 3, 50), row('s2', 'sell', 3, 60)]);
    expect(sales.has('s1')).toBe(false);
    expect(sales.get('s2')).toEqual({ costBasis: 50, realizedPnl: 30 });
  });

  it('skips unusable rows rather than dividing by them', () => {
    const sales = replayEngineRealized([row('b0', 'buy', 0, 100), row('b1', 'buy', 2, Number.NaN), row('s0', 'sell', 1, 10)]);
    expect(sales.size).toBe(0);
  });
});
