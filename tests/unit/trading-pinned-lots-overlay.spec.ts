/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-138 D3 pure guards: the overlay math (no pin, partial pin scales pro rata, full pin removes the symbol, over-pin never opens a short), the rules normalizer (pct XOR price per leg; stop XOR trailing; clamps), and the `lot-` request-id convention; plus SOURCE guards that the dispatcher applies the overlay BEFORE positions feed any decision and that freeStaleSells skips lot orders, and that the engine maps extended_hours for LIMIT orders only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';
import { subtractPinnedLots, normalizePinnedLotRules, hasExitRules, isLotOrderClientId, describeRules } from '../../src/app/trading-pinned-lots';
import type { Position } from '../../src/features/trading';

const pos = (symbol: string, qty: number, px = 100): Position => ({ symbol, qty, avgEntryPrice: px * 0.9, marketValue: qty * px, unrealizedPl: qty * px * 0.1, currentPrice: px, unrealizedIntradayPl: qty });

describe('the overlay — the autopilot sees the book minus protected shares', () => {
  it('no pins → the same positions', () => {
    const p = [pos('AAPL', 10), pos('MSFT', 5)];
    expect(subtractPinnedLots(p, new Map())).toBe(p);
  });
  it('a partial pin leaves the residual, scaled pro rata', () => {
    const out = subtractPinnedLots([pos('AAPL', 10)], new Map([['AAPL', 4]]));
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(6);
    expect(out[0].marketValue).toBeCloseTo(600, 6);
    expect(out[0].unrealizedPl).toBeCloseTo(60, 6);
    expect(out[0].unrealizedIntradayPl).toBeCloseTo(6, 6);
  });
  it('a full pin removes the symbol entirely; an over-pin never opens a short', () => {
    expect(subtractPinnedLots([pos('AAPL', 10), pos('MSFT', 5)], new Map([['AAPL', 10]])).map((p) => p.symbol)).toEqual(['MSFT']);
    expect(subtractPinnedLots([pos('AAPL', 10)], new Map([['AAPL', 25]]))).toEqual([]);
  });
  it('symbol match is case-insensitive', () => {
    expect(subtractPinnedLots([pos('aapl', 10)], new Map([['AAPL', 10]]))).toEqual([]);
  });
});

describe('rules normalizer', () => {
  it('percent XOR price per leg; stop XOR trailing', () => {
    expect(() => normalizePinnedLotRules({ takeProfitPct: 10, takeProfitPrice: 55 })).toThrow(/percent OR a price/);
    expect(() => normalizePinnedLotRules({ stopLossPct: 8, trailingStopPct: 5 })).toThrow(/one of them/);
    expect(() => normalizePinnedLotRules({ stopPrice: 40, stopLossPct: 8 })).toThrow(/one of them/);
    expect(normalizePinnedLotRules({ takeProfitPct: 10, trailingStopPct: 5, timeStopDays: 30.4 })).toEqual({ takeProfitPct: 10, takeProfitPrice: null, stopLossPct: null, stopPrice: null, trailingStopPct: 5, timeStopDays: 30 });
  });
  it('clamps and empties', () => {
    expect(() => normalizePinnedLotRules({ trailingStopPct: 80 })).toThrow(/Trailing percent/);
    expect(hasExitRules(normalizePinnedLotRules({}))).toBe(false);
    expect(hasExitRules(normalizePinnedLotRules({ stopLossPct: 8 }))).toBe(true);
    expect(describeRules({ takeProfitPct: 10, stopPrice: 46, timeStopDays: 30 })).toBe('take profit +10% · stop at $46 · time stop 30d');
  });
  it('lot request ids are recognisable in the ledger', () => {
    expect(isLotOrderClientId('spec-user-0001:lot-3b221362-tp-1')).toBe(true);
    expect(isLotOrderClientId('spec-user-0001:auto-live-2026-09-04T13:35-AAPL-sell')).toBe(false);
    expect(isLotOrderClientId(null)).toBe(false);
  });
});

describe('source guards — the hooks exist where they must', () => {
  const dispatch = readFileSync(path.resolve(__dirname, '../../src/app/trading-schedule-dispatch.ts'), 'utf8');
  const engine = readFileSync(path.resolve(__dirname, '../../src/app/trading-engine.ts'), 'utf8');

  it('the dispatcher applies the overlay right after the positions read, fail-closed, before any consumer', () => {
    const overlay = dispatch.indexOf('const positions = subtractPinnedLots(positionsRead.positions, pinnedRead.m);');
    expect(overlay).toBeGreaterThan(0);
    expect(dispatch.slice(0, overlay)).toMatch(/if \(!pinnedRead\.ok\) \{[\s\S]{0,400}return \{ scanned: 0/);
    for (const consumer of ['ensureCore(ctx, sub, book, account, positions', 'computeExits(ctx, sub, book, positions', 'rotateSleeve(ctx, sub, book, account, positions']) {
      expect(dispatch.indexOf(consumer), `${consumer} must run AFTER the overlay`).toBeGreaterThan(overlay);
    }
    expect(dispatch).not.toMatch(/const positions = positionsRead\.positions;/);
  });
  it('freeStaleSells never cancels a protected lot\'s exit orders', () => {
    expect(dispatch).toMatch(/SELECT broker_order_id, symbol, client_order_id FROM oshal_trading_orders/);
    expect(dispatch).toMatch(/if \(isLotOrderClientId\(r\.client_order_id\)\) continue;/);
  });
  it('the engine honours extended_hours for LIMIT orders only', () => {
    expect(engine).toContain("if (d.extended_hours === true && effType === 'limit') extendedHours = true;");
  });
});
