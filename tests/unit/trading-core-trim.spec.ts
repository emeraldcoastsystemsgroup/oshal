/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — coreTradePlan. The core used to only ever BUY, so its target % was really a one-way FLOOR that ratcheted up and never came back (live: 79.2% SPY against a 60% target, with nothing in the system able to correct it). Covers both directions, the dead band, the `:0` exemption-only hold that must never be bought OR trimmed (the SKHY IPO position), and the short-sale guard.
 */
import { describe, it, expect } from 'vitest';
import { coreTradePlan } from '../../src/app/trading-schedule-dispatch';

// The live book as it stood at the 2026-07-14 close.
const EQUITY = 51_233.01;
const SPY_PX = 751.70;
const SPY_VALUE = 40_592;   // 54 shares — 79.2% of equity
const SPY_QTY = 54;

describe('coreTradePlan — the core tracks its target in BOTH directions', () => {
  it('trims the real 2026-07-14 book back toward its 60% target', () => {
    // target = 60% of 51,233 = 30,740; held 40,592 → 9,852 over → 9,852 / 751.70 = 13 shares.
    const plan = coreTradePlan(60, EQUITY, SPY_VALUE, SPY_QTY, SPY_PX, 877);
    expect(plan.action).toBe('trim');
    expect(plan.qty).toBe(13);
  });

  it('still buys UP to target when under (the original behavior is intact)', () => {
    const plan = coreTradePlan(60, EQUITY, 20_000, 26, SPY_PX, 12_000);
    expect(plan.action).toBe('buy');
    // shortfall 10,740 vs cash 877*... here cash 12,000*0.98 = 11,760 → shortfall binds → 14 shares.
    expect(plan.qty).toBe(Math.floor(10_739.806 / SPY_PX));
  });

  it('a BUY is still bounded by available cash, never by the shortfall alone', () => {
    const plan = coreTradePlan(60, EQUITY, 20_000, 26, SPY_PX, 1_000);
    expect(plan.action).toBe('buy');
    expect(plan.qty).toBe(1); // floor(1000*0.98 / 751.70)
  });

  it('a TRIM needs no cash — it RAISES cash', () => {
    const plan = coreTradePlan(60, EQUITY, SPY_VALUE, SPY_QTY, SPY_PX, 0);
    expect(plan.action).toBe('trim');
    expect(plan.qty).toBe(13);
  });

  it('holds inside the 1%-of-equity dead band (no churn on noise)', () => {
    const target = 0.60 * EQUITY;                     // 30,739.81
    const justOver = target + EQUITY * 0.009;         // inside the band
    expect(coreTradePlan(60, EQUITY, justOver, 45, SPY_PX, 0).action).toBe('hold');
    const justUnder = target - EQUITY * 0.009;
    expect(coreTradePlan(60, EQUITY, justUnder, 40, SPY_PX, 50_000).action).toBe('hold');
  });

  it('holds when the drift is real but smaller than one share', () => {
    const target = 0.60 * EQUITY;
    // 600 over target: past the ~512 band, but 600 < one 751.70 share.
    expect(coreTradePlan(60, EQUITY, target + 600, 45, SPY_PX, 0).action).toBe('hold');
  });
});

describe('coreTradePlan — the `:0` exemption-only hold is untouchable', () => {
  it('NEVER trims a :0 hold, however far "over" it looks (the SKHY IPO position)', () => {
    // A :0 name has no target, so a naive target-vs-held diff would read as massively over.
    expect(coreTradePlan(0, EQUITY, 25_000, 500, 50, 0)).toEqual({ action: 'hold', qty: 0 });
  });

  it('NEVER buys a :0 hold', () => {
    expect(coreTradePlan(0, EQUITY, 0, 0, 50, 40_000)).toEqual({ action: 'hold', qty: 0 });
  });

  it('treats a negative target as exemption-only too', () => {
    expect(coreTradePlan(-5, EQUITY, 25_000, 500, 50, 40_000).action).toBe('hold');
  });
});

describe('coreTradePlan — a trim can never open a short', () => {
  it('never sells more shares than are actually held, however stale the value row', () => {
    // Position VALUE claims 40,592 (13 shares over target) but we really only hold 4 shares.
    const plan = coreTradePlan(60, EQUITY, SPY_VALUE, 4, SPY_PX, 0);
    expect(plan.action).toBe('trim');
    expect(plan.qty).toBe(4); // bounded by heldQty — not 13
  });

  it('holds rather than shorting when the value row says "over" but nothing is held', () => {
    expect(coreTradePlan(60, EQUITY, SPY_VALUE, 0, SPY_PX, 0).action).toBe('hold');
  });
});

describe('coreTradePlan — degenerate inputs fail safe', () => {
  it('holds on a zero/negative price', () => {
    expect(coreTradePlan(60, EQUITY, SPY_VALUE, SPY_QTY, 0, 0).action).toBe('hold');
    expect(coreTradePlan(60, EQUITY, SPY_VALUE, SPY_QTY, -1, 0).action).toBe('hold');
  });

  it('holds on a zero/negative equity (never size against a $0 book)', () => {
    expect(coreTradePlan(60, 0, SPY_VALUE, SPY_QTY, SPY_PX, 0).action).toBe('hold');
  });

  it('buys from flat when the core is empty and cash is there', () => {
    const plan = coreTradePlan(60, EQUITY, 0, 0, SPY_PX, 50_000);
    expect(plan.action).toBe('buy');
    expect(plan.qty).toBe(Math.floor((0.60 * EQUITY) / SPY_PX)); // shortfall binds, not cash
  });
});
