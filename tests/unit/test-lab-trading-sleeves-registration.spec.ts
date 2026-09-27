/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-168 trading-sleeves card is registered exactly once with suites that exist on disk, and its readback grades honestly: the real constant on a node with no core symbols passes without claiming the paper proof; an unbucketed name, a duplicate, a changed default prefix, a default name in a multi-market bucket and a swing-leg overlap each fail and name the offender; a core symbol of this node inside the universe is degraded.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { TRADING_SLEEVES_SCENARIOS, multiMarketUniverseStep, type SleeveUniverseInput } from '@/app/routes/test-lab-trading-sleeves-scenarios';
import { DEFAULT_UNIVERSE, MULTI_MARKET_UNIVERSE, MULTI_MARKET_BUCKETS, sectorOf } from '@/features/trading';

/** The real kernel values, with one field overridden per refusal case. */
function input(overrides: Partial<SleeveUniverseInput> = {}): SleeveUniverseInput {
  return {
    universe: MULTI_MARKET_UNIVERSE, defaultUniverse: DEFAULT_UNIVERSE, bucketOf: sectorOf,
    extensionBuckets: Object.keys(MULTI_MARKET_BUCKETS), swingUniverse: ['USO', 'GLD'], coreSymbols: [], ...overrides,
  };
}

describe('ADR-168 trading-sleeves Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    const [scenario] = TRADING_SLEEVES_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    expect(scenario.regressionTests!.map((t) => t.path)).toContain('tests/unit/trading-portfolio.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['universe-readback']);
    expect(scenario.description).toContain('paper soak');
  });

  it('passes on the real constant and still says it is not the paper proof', () => {
    const r = multiMarketUniverseStep(input());
    expect(r.state).toBe('pass');
    expect(r.detail).toContain(`${MULTI_MARKET_UNIVERSE.length} names`);
    expect(r.detail).toContain('not the paper proof');
    expect(r.output).toMatchObject({ unbucketed: [], duplicates: [], swingOverlap: [], coreOverlap: [], defaultIsPrefix: true });
  });

  it('fails on each broken rule and names the offender', () => {
    const unbucketed = multiMarketUniverseStep(input({ universe: [...MULTI_MARKET_UNIVERSE, 'ZZZZ'] }));
    expect(unbucketed.state).toBe('fail');
    expect(unbucketed.detail).toContain('unbucketed: ZZZZ');
    const duplicate = multiMarketUniverseStep(input({ universe: [...MULTI_MARKET_UNIVERSE, 'TLT'] }));
    expect(duplicate.detail).toContain('duplicated: TLT');
    const reordered = multiMarketUniverseStep(input({ universe: [...MULTI_MARKET_UNIVERSE].reverse() }));
    expect(reordered.detail).toContain('no longer its unchanged prefix');
    const leaked = multiMarketUniverseStep(input({ bucketOf: (s) => (s === 'NVDA' ? 'fixed-income' : sectorOf(s)) }));
    expect(leaked.detail).toContain('default names in a multi-market bucket: NVDA');
    const swing = multiMarketUniverseStep(input({ swingUniverse: ['TLT'] }));
    expect(swing.state).toBe('fail');
    expect(swing.detail).toContain('shared with the swing leg: TLT');
  });

  it('is degraded when this node holds a universe name as a core symbol', () => {
    const r = multiMarketUniverseStep(input({ coreSymbols: ['EFA'] }));
    expect(r.state).toBe('degraded');
    expect(r.detail).toContain('EFA');
    expect(r.detail).toContain('rotation skips as core');
  });

  it('runs the real step against this process: the swing leg and an unset core list leave it passing', async () => {
    const prior = process.env.TRADING_CORE_SYMBOLS;
    delete process.env.TRADING_CORE_SYMBOLS;
    try {
      const r = await TRADING_SLEEVES_SCENARIOS[0].steps[0].run('', {});
      expect(r.state).toBe('pass');
      expect(r.output).toMatchObject({ size: MULTI_MARKET_UNIVERSE.length, defaultSize: DEFAULT_UNIVERSE.length });
    } finally {
      if (prior === undefined) delete process.env.TRADING_CORE_SYMBOLS;
      else process.env.TRADING_CORE_SYMBOLS = prior;
    }
  });
});
