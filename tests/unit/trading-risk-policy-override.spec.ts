/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TRADING_TAKE_PROFIT_PCT override on riskPolicy: applied to both books, clamped, absent/junk falls back to the posture preset.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { riskPolicy, RISK_POLICIES } from '../../src/features/trading/services/portfolio';

describe('riskPolicy TRADING_TAKE_PROFIT_PCT override', () => {
  beforeEach(() => {
    delete process.env.TRADING_TAKE_PROFIT_PCT;
    delete process.env.TRADING_RISK_POSTURE_LIVE;
    process.env.TRADING_RISK_POSTURE = 'active';
  });

  it('falls back to the posture preset when unset', () => {
    expect(riskPolicy('paper').takeProfitPct).toBe(RISK_POLICIES.active.takeProfitPct);
  });

  it('overrides take-profit for both books, leaving every other dial untouched', () => {
    process.env.TRADING_TAKE_PROFIT_PCT = '25';
    for (const mode of ['paper', 'live'] as const) {
      const pol = riskPolicy(mode);
      expect(pol.takeProfitPct).toBe(25);
      expect(pol.stopLossPct).toBe(RISK_POLICIES.active.stopLossPct);
      expect(pol.maxPerNamePct).toBe(RISK_POLICIES.active.maxPerNamePct);
    }
  });

  it('clamps to 95 and ignores zero/negative/junk', () => {
    process.env.TRADING_TAKE_PROFIT_PCT = '400';
    expect(riskPolicy('paper').takeProfitPct).toBe(95);
    process.env.TRADING_TAKE_PROFIT_PCT = '0';
    expect(riskPolicy('paper').takeProfitPct).toBe(RISK_POLICIES.active.takeProfitPct);
    process.env.TRADING_TAKE_PROFIT_PCT = 'wide';
    expect(riskPolicy('paper').takeProfitPct).toBe(RISK_POLICIES.active.takeProfitPct);
  });
});
