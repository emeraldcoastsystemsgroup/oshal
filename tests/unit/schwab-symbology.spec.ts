/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the class-share symbology split (found live 2026-07-26): Schwab's APIs reject the engine's dot notation ("invalidSymbols":["BRK.B"]) and require slash (BRK/B). If translation drifts, the live book silently diverges from paper on any class-share name — core top-ups fail every fire while Alpaca paper succeeds.
 */

import { describe, expect, it } from 'vitest';
import { toSchwabSymbol, fromSchwabSymbol } from '../../src/features/trading/services/schwab-market-data';

describe('Schwab class-share symbology translation', () => {
  it('translates engine dot notation to Schwab slash notation', () => {
    expect(toSchwabSymbol('BRK.B')).toBe('BRK/B');
    expect(toSchwabSymbol('BF.B')).toBe('BF/B');
    expect(toSchwabSymbol('brk.b')).toBe('BRK/B');
    expect(toSchwabSymbol(' BRK.B ')).toBe('BRK/B');
  });

  it('translates Schwab slash notation back to engine dot notation', () => {
    expect(fromSchwabSymbol('BRK/B')).toBe('BRK.B');
    expect(fromSchwabSymbol('bf/b')).toBe('BF.B');
  });

  it('passes plain symbols through unchanged in both directions', () => {
    for (const sym of ['AAPL', 'AB', 'SPY', 'NANC', 'XLE', 'XLB', 'SNDK', 'TEM']) {
      expect(toSchwabSymbol(sym)).toBe(sym);
      expect(fromSchwabSymbol(sym)).toBe(sym);
    }
  });

  it('round-trips class shares exactly (engine → wire → engine)', () => {
    for (const sym of ['BRK.B', 'BF.B', 'AAPL', 'AB']) {
      expect(fromSchwabSymbol(toSchwabSymbol(sym))).toBe(sym);
    }
  });

  it('only translates a single trailing class letter (conservative scope)', () => {
    // Multi-letter suffixes and non-class forms must pass through untouched — translating
    // them would corrupt symbols the rule was never probed against.
    expect(toSchwabSymbol('BRK.BB')).toBe('BRK.BB');
    expect(fromSchwabSymbol('ABC/DE')).toBe('ABC/DE');
    expect(toSchwabSymbol('')).toBe('');
  });
});
