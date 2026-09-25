/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep Futures regression registration discoverable and distinct from live acceptance.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { FUTURES_RESEARCH_SCENARIOS } from '@/app/routes/test-lab-futures-scenarios';
describe('Futures Test Lab registration', () => {
  it('registers the actual unit and database suites without claiming browser execution', async () => {
    const scenario = FUTURES_RESEARCH_SCENARIOS[0];
    expect(SCENARIOS.filter(item => item.id === scenario.id)).toEqual([scenario]);
    expect(scenario.regressionTests).toHaveLength(5);
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    const result = await scenario.steps[0].run('', {});
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain('No tests ran');
  });
});
