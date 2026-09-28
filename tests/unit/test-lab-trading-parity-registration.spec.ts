/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-052 addendum trading-parity Test Lab card is registered exactly once with suites that exist on disk, its two DB guards are on the isolated nightly scenario, and its readback grades honestly: paper armed passes and reports the source (env, strategy knob), today's SPY verdict and the counterfactual rows; paper not armed is degraded and names the setting that starts the soak; an explicit strategy 0 reads as off; the plan step summarises open, re-underwritten, amended and closed-by-door plans; no server context is degraded without reading; neither step ever claims the soak.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-052 addendum P6: the card's third step, yield-sleeve-readback, and the sleeve's DB fire spec on the isolated nightly scenario. Paper armed passes and prints the fund and the ledger's sell-first evidence (funding sales a buy followed, and those none did); not armed (or a strategy 0) is degraded and names TRADING_YIELD_SLEEVE=paper; an absent decision ledger says so; it never claims the soak.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { AUTONOMOUS_SCENARIOS } from '@/app/routes/test-lab-autonomous-scenarios';
import {
  TRADING_PARITY_SCENARIOS, marketGapStep, exitPlanStep, yieldSleeveStep, paritySource, type ParityFacts, type SleeveFacts,
} from '@/app/routes/test-lab-trading-parity-scenarios';

/** Facts for a node where `paper` is armed at the pre-registered values and live is off. */
function facts(over: Partial<ParityFacts> = {}): ParityFacts {
  return {
    books: [
      { book: 'paper', marketGapPct: 1, marketGapSource: 'env', planSessions: 20, planSource: 'env' },
      { book: 'live', marketGapPct: 0, marketGapSource: 'off', planSessions: 0, planSource: 'off' },
    ],
    counterfactualRows: 3, lastHeldDay: '2026-09-25',
    paperPlans: { open: 4, superseded: 2, amended: 1, closedByDoor: { 'plan-expiry': 1, breakdown: 2 } },
    todayGap: { blocked: false, gapPct: -0.42, spyPrice: 497.9, spyPriorClose: 500, thresholdPct: 1 },
    ...over,
  };
}
const unarmedPaper = (): ParityFacts['books'] => [
  { book: 'paper', marketGapPct: 0, marketGapSource: 'off', planSessions: 0, planSource: 'strategy' },
  { book: 'live', marketGapPct: 0, marketGapSource: 'off', planSessions: 0, planSource: 'off' },
];

describe('ADR-052 addendum trading-parity Test Lab card', () => {
  it('is registered once with suites that exist on disk; its DB guards run on the isolated nightly scenario', () => {
    const [scenario] = TRADING_PARITY_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['market-gap-readback', 'exit-plan-readback', 'yield-sleeve-readback']);
    const nightly = AUTONOMOUS_SCENARIOS.find((s) => s.id === 'nightly-isolated-regression')!.regressionTests!.map((t) => t.path);
    expect(nightly).toEqual(expect.arrayContaining(['tests/unit/trading-position-plans-postgres.spec.ts', 'tests/unit/trading-parity-fire.spec.ts', 'tests/unit/trading-dispatch-yield-sleeve-fire.spec.ts']));
    expect(scenario.regressionTests!.map((t) => t.path)).toEqual(expect.arrayContaining(['tests/unit/trading-yield-sleeve.spec.ts', 'tests/unit/trading-dispatch-yield-sleeve-fire.spec.ts']));
    expect(scenario.description).toContain('never claim the paper soak');
  });

  it('source labels: a strategy knob (0 included) outranks the env; an unarmed book is off', () => {
    expect(paritySource(0, 0)).toBe('strategy');
    expect(paritySource(2, 2)).toBe('strategy');
    expect(paritySource(undefined, 1)).toBe('env');
    expect(paritySource(null, 0)).toBe('off');
  });

  it('market gap: paper armed passes with the source, today\'s verdict and the counterfactual rows — and is not the soak', () => {
    const r = marketGapStep(facts());
    expect(r.state).toBe('pass');
    expect(r.detail).toContain('paper armed at 1% (env)');
    expect(r.detail).toContain('live off');
    expect(r.detail).toContain('-0.42% vs its prior close — entries proceed');
    expect(r.detail).toContain('3 market-gap counterfactual row(s), last 2026-09-25');
    expect(r.detail).toContain('not the paper soak');
    const held = marketGapStep(facts({ todayGap: { blocked: true, gapPct: -1.8, spyPrice: 491, spyPriorClose: 500, thresholdPct: 1 } }));
    expect(held.detail).toContain('entries HOLD');
    expect(marketGapStep(facts({ todayGap: { blocked: false, gapPct: null, spyPrice: null, spyPriorClose: 500, thresholdPct: 1 } })).detail).toContain('unmeasurable (fails open)');
  });

  it('market gap: paper not armed is degraded and names the setting that starts the soak', () => {
    const r = marketGapStep(facts({ books: unarmedPaper(), counterfactualRows: null, todayGap: null }));
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('TRADING_MARKET_GAP_FILTER=paper');
    expect(r.detail).toContain('No counterfactual ledger on this node yet.');
  });

  it('exit plans: paper armed summarises the plan ledger; not armed (or a strategy 0) is degraded', () => {
    const r = exitPlanStep(facts());
    expect(r.state).toBe('pass');
    expect(r.detail).toContain('paper armed at 20 sessions (env)');
    expect(r.detail).toContain('4 open plan(s), 2 re-underwritten, 1 amended; closed by door: plan-expiry 1, breakdown 2.');
    const off = exitPlanStep(facts({ books: unarmedPaper(), paperPlans: null }));
    expect(off.state).toBe('degraded');
    expect(off.detail).toContain('paper off (strategy knob 0)');
    expect(off.detail).toContain('TRADING_EXIT_PLANS=paper');
    expect(off.detail).toContain('No plan has been stamped on this node yet.');
  });

  it('yield sleeve: paper armed passes with the fund and the ledger\'s sell-first evidence — and is not the soak', () => {
    const f: SleeveFacts = {
      books: [{ book: 'paper', floatPct: 5, source: 'env' }, { book: 'live', floatPct: 0, source: 'off' }],
      symbol: 'SGOV', paperLedger: { fundSales: 4, fundedFires: 3, unfollowedSales: 1, parks: 2, refills: 1, lastFundDay: '2026-09-25' },
    };
    const r = yieldSleeveStep(f);
    expect(r.state).toBe('pass');
    expect(r.detail).toContain('paper armed with a 5% float (env); live off; fund SGOV.');
    expect(r.detail).toContain('4 funding sale(s) of SGOV, 3 followed by the buys they funded, 1 with no buy after them; 2 park(s), 1 refill(s); last funding 2026-09-25.');
    expect(r.detail).toContain('not the paper soak');
  });

  it('yield sleeve: paper not armed (or a strategy 0) is degraded and names the setting; an absent ledger says so', () => {
    const r = yieldSleeveStep({ books: [{ book: 'paper', floatPct: 0, source: 'strategy' }, { book: 'live', floatPct: 0, source: 'off' }], symbol: 'SGOV', paperLedger: null });
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('paper off (strategy knob 0)');
    expect(r.detail).toContain('TRADING_YIELD_SLEEVE=paper');
    expect(r.detail).toContain('No decision ledger on this node yet.');
  });

  it('with no server run context the steps read nothing and say so', async () => {
    for (const step of TRADING_PARITY_SCENARIOS[0].steps) {
      const r = await step.run('', {});
      expect(r.state).toBe('degraded');
      expect(r.detail).toContain('nothing was read');
    }
  });
});
