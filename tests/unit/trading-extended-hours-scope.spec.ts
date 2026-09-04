/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — source guard (surface-audit 2026-09-03, ADR-136 D3): the engine's pre/post-market conversion to a marketable day limit applies to MARKET orders only. Before this guard every order type was rewritten off the last print, so an operator's explicit price point (GTC limit / stop / trailing stop placed after 4pm) would have executed at the next open at market. The guard reads the source because tradingSession() is wall-clock and the branch cannot be driven deterministically in a unit test without doubling the very boundary in question.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import * as path from 'path';

describe('extended-hours marketable-limit conversion is scoped to MARKET orders (ADR-136 D3)', () => {
  const engine = readFileSync(path.resolve(__dirname, '../../src/app/trading-engine.ts'), 'utf8');

  it('the session branch is gated on orderType === market', () => {
    expect(engine).toMatch(/if \(orderType === 'market' && String\(process\.env\.TRADING_EXTENDED_HOURS \?\? 'true'\)\.toLowerCase\(\) !== 'false'\) \{\s*const session = await tradingSession\(\);/);
  });

  it('non-market orders reach the venue with their decided type, limit, and time-in-force intact', () => {
    // effType/effLimit/effTif are only ever reassigned INSIDE the market-scoped branch.
    const reassignments = engine.match(/effType = 'limit';|effTif = 'day';/g) || [];
    expect(reassignments.length).toBe(2);
    const branchStart = engine.indexOf("if (orderType === 'market' && String(process.env.TRADING_EXTENDED_HOURS");
    const placeCall = engine.indexOf('result = await broker.placeOrder({', branchStart);
    expect(branchStart).toBeGreaterThan(0);
    for (const m of ["effType = 'limit';", "effTif = 'day';"]) {
      const at = engine.indexOf(m);
      expect(at, `${m} must sit inside the market-only branch`).toBeGreaterThan(branchStart);
      expect(at).toBeLessThan(placeCall);
    }
  });
});
