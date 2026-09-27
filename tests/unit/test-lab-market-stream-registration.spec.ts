/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-143 market-data stream card is registered exactly once, its attached suites exist on disk, and its status step grades honestly: unarmed is degraded and names the operator step, an entitlement refusal fails, an authenticated session with a print passes without claiming the regular-hours observation, and the real kernel status in this (unarmed) process is degraded. The step output is checked for the absence of a credential.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { MARKET_STREAM_SCENARIOS, marketStreamStatusStep } from '@/app/routes/test-lab-market-stream-scenarios';
import type { MarketStreamStatus } from '@/features/trading';

function status(overrides: Partial<MarketStreamStatus> = {}): MarketStreamStatus {
  return { enabled: true, state: 'authenticated', feed: 'iex', maxSymbols: 30, staleAfterSec: 60, symbols: ['AAPL'], dropped: [], lastError: null, lastPrintAt: null, ...overrides };
}

describe('ADR-143 market-data stream Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    const [scenario] = MARKET_STREAM_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    expect(scenario.regressionTests!.map((t) => t.path)).toContain('tests/unit/trading-market-data-stream.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['kernel-status']);
    expect(scenario.description).toContain('local protocol proof');
  });

  it('is degraded, not failed, while the node is unarmed and names the operator step', () => {
    const r = marketStreamStatusStep(status({ enabled: false, state: 'disabled' }));
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('not armed');
    expect(r.detail).toContain('local protocol proof');
    expect(r.detail).toContain('operator step');
  });

  it('fails on an entitlement refusal and carries the venue message', () => {
    const r = marketStreamStatusStep(status({ state: 'entitlement_blocked', lastError: 'subscription denied' }));
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('subscription denied');
  });

  it('passes on an authenticated session with a print, without claiming the regular-hours observation', () => {
    const r = marketStreamStatusStep(status({ lastPrintAt: '2026-09-28T14:31:02.000Z', symbols: ['AAPL', 'MSFT'] }));
    expect(r.state).toBe('pass');
    expect(r.detail).toContain('2 symbol(s)');
    expect(r.detail).toContain('2026-09-28T14:31:02.000Z');
    expect(r.detail).toContain('not the dated paper-ticket observation');
  });

  it('is degraded while authenticated with no print and while reconnecting', () => {
    expect(marketStreamStatusStep(status()).state).toBe('degraded');
    expect(marketStreamStatusStep(status()).detail).toContain('no print yet');
    const backoff = marketStreamStatusStep(status({ state: 'backoff', lastError: 'connect ECONNREFUSED' }));
    expect(backoff.state).toBe('degraded');
    expect(backoff.detail).toContain('backoff');
    expect(backoff.detail).toContain('ECONNREFUSED');
  });

  it('reads the real kernel status in this unarmed process and echoes nothing secret', async () => {
    process.env.ALPACA_PAPER_KEY_ID = 'lab-spec-key';
    process.env.ALPACA_PAPER_SECRET_KEY = 'lab-spec-secret';
    delete process.env.TRADING_STREAM_ENABLED;
    try {
      const r = await MARKET_STREAM_SCENARIOS[0].steps[0].run('', {});
      expect(r.state).toBe('degraded');
      expect(r.output).toMatchObject({ enabled: false, state: 'disabled' });
      expect(JSON.stringify(r)).not.toMatch(/lab-spec-key|lab-spec-secret|wss:\/\//);
    } finally {
      delete process.env.ALPACA_PAPER_KEY_ID;
      delete process.env.ALPACA_PAPER_SECRET_KEY;
    }
  });
});
