/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — TRADING_SYMBOL_BLOCKLIST parsing: empty, csv, trim/case, junk entries.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { symbolBlocklist } from '../../src/features/trading/services/portfolio';

describe('symbolBlocklist (TRADING_SYMBOL_BLOCKLIST parsing)', () => {
  beforeEach(() => { delete process.env.TRADING_SYMBOL_BLOCKLIST; });

  it('is empty when unset', () => {
    expect(symbolBlocklist().size).toBe(0);
  });

  it('parses, trims, and upper-cases a csv list', () => {
    process.env.TRADING_SYMBOL_BLOCKLIST = ' mrna , Intc,BA ';
    const b = symbolBlocklist();
    expect(b.has('MRNA')).toBe(true);
    expect(b.has('INTC')).toBe(true);
    expect(b.has('BA')).toBe(true);
    expect(b.size).toBe(3);
  });

  it('drops empty entries', () => {
    process.env.TRADING_SYMBOL_BLOCKLIST = 'MRNA,,  ,';
    expect(symbolBlocklist().size).toBe(1);
  });
});
