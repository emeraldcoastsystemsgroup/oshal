/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — coreConfig parsing: legacy equal split, per-symbol `SYM:pct` targets, `:0` exemption-only holds, mixed forms, clamping.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { coreConfig } from '../../src/app/trading-schedule-dispatch';

describe('coreConfig (TRADING_CORE_SYMBOLS parsing)', () => {
  beforeEach(() => {
    delete process.env.TRADING_CORE_SYMBOLS;
    delete process.env.TRADING_CORE_TARGET_PCT;
  });

  it('is empty when unset', () => {
    const c = coreConfig();
    expect(c.symbols).toEqual([]);
    expect(c.targetPct).toBe(0);
  });

  it('legacy form: bare symbols split TRADING_CORE_TARGET_PCT equally', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SPY,QQQ';
    process.env.TRADING_CORE_TARGET_PCT = '30';
    const c = coreConfig();
    expect(c.symbols).toEqual(['SPY', 'QQQ']);
    expect(c.targetPct).toBe(30);
    expect(c.perSymbolPct.get('SPY')).toBe(15);
    expect(c.perSymbolPct.get('QQQ')).toBe(15);
  });

  it('legacy form with target 0 is exemption-only (the pre-07-10 SKHY hold shape)', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SKHYV,SKHY';
    process.env.TRADING_CORE_TARGET_PCT = '0';
    const c = coreConfig();
    expect(c.symbols).toEqual(['SKHYV', 'SKHY']);
    expect(c.targetPct).toBe(0);
    expect(c.perSymbolPct.get('SKHYV')).toBe(0);
  });

  it('per-symbol targets: SPY:35 beside :0 holds, ignoring the env total', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SPY:35,SKHYV:0,SKHY:0';
    process.env.TRADING_CORE_TARGET_PCT = '0';
    const c = coreConfig();
    expect(c.symbols).toEqual(['SPY', 'SKHYV', 'SKHY']);
    expect(c.targetPct).toBe(35);
    expect(c.perSymbolPct.get('SPY')).toBe(35);
    expect(c.perSymbolPct.get('SKHYV')).toBe(0);
    expect(c.perSymbolPct.get('SKHY')).toBe(0);
  });

  it('mixed form: explicit pcts keep their value, bare names split the env target', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SPY:20,QQQ,IWM';
    process.env.TRADING_CORE_TARGET_PCT = '10';
    const c = coreConfig();
    expect(c.perSymbolPct.get('SPY')).toBe(20);
    expect(c.perSymbolPct.get('QQQ')).toBe(5);
    expect(c.perSymbolPct.get('IWM')).toBe(5);
    expect(c.targetPct).toBe(30);
  });

  it('clamps per-symbol and total to 95', () => {
    process.env.TRADING_CORE_SYMBOLS = 'SPY:120,QQQ:80';
    const c = coreConfig();
    expect(c.perSymbolPct.get('SPY')).toBe(95);
    expect(c.perSymbolPct.get('QQQ')).toBe(80);
    expect(c.targetPct).toBe(95); // total clamped
  });

  it('lower-cases and trims entries; drops empties and junk pcts fall back to bare', () => {
    process.env.TRADING_CORE_SYMBOLS = ' spy:35 , , skhyv:0 ';
    const c = coreConfig();
    expect(c.symbols).toEqual(['SPY', 'SKHYV']);
    expect(c.perSymbolPct.get('SPY')).toBe(35);
  });
});
