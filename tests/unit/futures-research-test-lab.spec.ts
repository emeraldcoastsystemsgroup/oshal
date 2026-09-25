/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep Futures regression registration discoverable and distinct from live acceptance.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Include the real-source quality gate regression suite.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Discover the queued-review PostgreSQL suite.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Keep both forward evidence suites discoverable through the existing Futures scenario.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Discover the real frozen-context and outcome-feedback boundary suite.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Discover both real-file and private-database archive import suites.
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Discover the pre-optimizer reuse boundary suite.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Discover the source-alert worker and owner-routing suite.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { FUTURES_RESEARCH_SCENARIOS } from '@/app/routes/test-lab-futures-scenarios';
describe('Futures Test Lab registration', () => {
  it('registers the actual unit and database suites without claiming browser execution', async () => {
    const scenario = FUTURES_RESEARCH_SCENARIOS[0];
    expect(SCENARIOS.filter(item => item.id === scenario.id)).toEqual([scenario]);
    expect(scenario.regressionTests).toHaveLength(15);
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    const result = await scenario.steps[0].run('', {});
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain('No tests ran');
  });
});
