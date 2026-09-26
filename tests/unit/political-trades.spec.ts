/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Deterministic date-preserving aggregation guard for congressional trade feed rows.
 */

import { describe, expect, it } from 'vitest';
import { aggregatePoliticalTrades } from '@/features/world-data/political-trades';

describe('political trade feed aggregation', () => {
  it('groups by ticker and transaction day while retaining purchase/sale counts and notional', () => {
    const result = aggregatePoliticalTrades([
      { Ticker: ' msft ', Transaction: 'Purchase', TransactionDate: '2026-09-20T23:00:00-05:00', Amount: '$1,001' },
      { Ticker: 'MSFT', Transaction: 'Sale', TransactionDate: '2026-09-20T08:00:00Z', Amount: 2000 },
      { Ticker: 'MSFT', Transaction: 'Purchase', TransactionDate: '2026-09-19T08:00:00Z', Amount: 300 },
    ], new Date('2026-09-25T12:00:00Z'), 30);
    expect(result.trades).toBe(3);
    expect(result.observations).toEqual([
      { ticker: 'MSFT', transactionDate: '2026-09-19T00:00:00.000Z', buys: 1, sells: 0, notional: 300 },
      { ticker: 'MSFT', transactionDate: '2026-09-20T00:00:00.000Z', buys: 1, sells: 1, notional: 3001 },
    ]);
  });

  it('falls back to report date and refuses malformed, stale, future, and unrelated rows', () => {
    const result = aggregatePoliticalTrades([
      { Ticker: 'AAPL', Transaction: 'Purchase', ReportDate: '2026-09-24', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', TransactionDate: 'not-a-date', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', TransactionDate: '2026-08-01', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Purchase', TransactionDate: '2026-09-26', Amount: 10 },
      { Ticker: 'AAPL', Transaction: 'Dividend', TransactionDate: '2026-09-24', Amount: 10 },
      { Ticker: '123', Transaction: 'Purchase', TransactionDate: '2026-09-24', Amount: 10 },
    ], new Date('2026-09-25T12:00:00Z'), 30);
    expect(result.trades).toBe(1);
    expect(result.observations[0].transactionDate).toBe('2026-09-24T00:00:00.000Z');
  });
});
