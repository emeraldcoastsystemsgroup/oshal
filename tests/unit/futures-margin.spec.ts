/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guards for the futures margin model (BACKLOG row 414): per-contract requirement selection with the conservative day-trade fallback, the fundable-contract cap and its house-buffer fraction, the maintenance margin-call test on mark-to-market equity, spec staleness, and the notional/leverage arithmetic derived from the real contract multiplier.
 */
import { describe, it, expect } from 'vitest';
import {
  marginPerContract, affordableContracts, isMarginCall, marginSpecStaleness,
  notionalValue, leverageAt, MARGIN_MODEL_DEFAULTS,
} from '../../src/features/trading';
import type { FuturesMarginSpec } from '../../src/features/trading';

/**
 * A SYNTHETIC spec. The figures are round numbers chosen to make the arithmetic readable — they are
 * NOT an exchange quote, which is exactly why the production module ships no built-in table: a
 * performance bond without a citation is a guess with a decimal point.
 */
const SPEC: FuturesMarginSpec = {
  root: 'TEST', initialMargin: 10_000, maintenanceMargin: 9_000, currency: 'USD',
  asOf: '2026-01-01', source: 'synthetic fixture — not an exchange quote',
};

describe('marginPerContract', () => {
  it('uses the exchange initial requirement by default', () => {
    expect(marginPerContract(SPEC)).toBe(10_000);
    expect(MARGIN_MODEL_DEFAULTS.basis).toBe('initial');
  });

  it('uses the broker day-trade concession when asked for AND present', () => {
    expect(marginPerContract({ ...SPEC, dayTradeMargin: 2_000 }, 'day-trade')).toBe(2_000);
  });

  it('falls back to INITIAL — the conservative direction — when no day-trade figure exists', () => {
    // A missing broker concession must never read as a cheaper requirement than the exchange's.
    expect(marginPerContract(SPEC, 'day-trade')).toBe(10_000);
    expect(marginPerContract({ ...SPEC, dayTradeMargin: 0 }, 'day-trade')).toBe(10_000);
  });
});

describe('affordableContracts — the fundable-size cap', () => {
  it('floors to whole contracts the account can actually post margin for', () => {
    expect(affordableContracts(100_000, SPEC)).toBe(10);
    expect(affordableContracts(99_999, SPEC)).toBe(9); // never rounds up into an unfundable lot
    expect(affordableContracts(9_999, SPEC)).toBe(0);
  });

  it('a house buffer reduces usable equity proportionally', () => {
    expect(affordableContracts(100_000, SPEC, { usableEquityFraction: 0.5 })).toBe(5);
    expect(affordableContracts(100_000, SPEC, { usableEquityFraction: 0.25 })).toBe(2);
  });

  it('the day-trade basis funds more contracts off the same equity', () => {
    const spec = { ...SPEC, dayTradeMargin: 2_500 };
    expect(affordableContracts(100_000, spec, { basis: 'day-trade' })).toBe(40);
    expect(affordableContracts(100_000, spec, { basis: 'initial' })).toBe(10);
  });

  it('a broke or nonsensical account funds nothing — never a negative or infinite size', () => {
    expect(affordableContracts(0, SPEC)).toBe(0);
    expect(affordableContracts(-5_000, SPEC)).toBe(0);
    expect(affordableContracts(100_000, { ...SPEC, initialMargin: 0 })).toBe(0);
    expect(affordableContracts(Number.NaN, SPEC)).toBe(0);
  });
});

describe('isMarginCall — the maintenance test', () => {
  it('fires when mark-to-market equity falls below maintenance × quantity', () => {
    expect(isMarginCall(17_999, 2, SPEC)).toBe(true);   // needs 18,000
    expect(isMarginCall(18_000, 2, SPEC)).toBe(false);  // exactly at maintenance is NOT a call
    expect(isMarginCall(50_000, 2, SPEC)).toBe(false);
  });

  it('scales with size — the same equity is fine small and a call large', () => {
    expect(isMarginCall(20_000, 2, SPEC)).toBe(false);
    expect(isMarginCall(20_000, 3, SPEC)).toBe(true);
  });

  it('a flat book is never a call', () => {
    expect(isMarginCall(-1_000, 0, SPEC)).toBe(false);
  });
});

describe('marginSpecStaleness', () => {
  it('is silent inside the tolerance and loud outside it', () => {
    expect(marginSpecStaleness(SPEC, '2026-01-20', 30)).toBeNull();
    const warn = marginSpecStaleness(SPEC, '2026-08-01', 30);
    expect(warn).toBeTruthy();
    expect(warn).toContain('TEST');
    expect(warn).toContain(SPEC.source); // the citation travels WITH the complaint
  });

  it('is disabled at maxAgeDays 0 (the default) so an un-aged run is not spammed', () => {
    expect(marginSpecStaleness(SPEC, '2099-01-01', 0)).toBeNull();
    expect(MARGIN_MODEL_DEFAULTS.maxSpecAgeDays).toBe(0);
  });

  it('an unparseable date WARNS rather than silently passing', () => {
    expect(marginSpecStaleness({ ...SPEC, asOf: 'whenever' }, '2026-08-01', 30)).toContain('unparseable');
  });
});

describe('notional and leverage — the layer that needs no margin table', () => {
  it('notional is price × the real contract multiplier × size', () => {
    expect(notionalValue(5_000, 50, 2)).toBe(500_000); // ES at 5000, 2 lots
    expect(notionalValue(70, 1_000, 3)).toBe(210_000); // CL at 70, 3 lots
  });

  it('is a positive magnitude for a short book too', () => {
    expect(notionalValue(5_000, 50, -2)).toBe(500_000);
  });

  it('leverage answers "could this account have held that?" without any performance bond', () => {
    expect(leverageAt(5_000, 50, 2, 100_000)).toBeCloseTo(5, 10);
    expect(leverageAt(5_000, 50, 8, 100_000)).toBeCloseTo(20, 10);
  });

  it('a wiped-out account reports 0, not Infinity — an unfundable book, not infinite leverage', () => {
    expect(leverageAt(5_000, 50, 2, 0)).toBe(0);
    expect(leverageAt(5_000, 50, 2, -1)).toBe(0);
  });
});
