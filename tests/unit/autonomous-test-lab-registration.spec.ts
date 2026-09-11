/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep autonomous suite registration aligned with runnable local commands and prevent browser claims of host test execution.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_SCENARIOS } from '../../src/app/routes/test-lab-autonomous-scenarios';
import { SCENARIOS } from '../../src/app/routes/test-lab-scenarios';

describe('autonomous Test Lab registration', () => {
  it('registers actual unique suites and matches each fixed local runner', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    for (const scenario of AUTONOMOUS_SCENARIOS) {
      expect(SCENARIOS.find(item => item.id === scenario.id)).toBe(scenario);
      const paths = scenario.regressionTests!.map(test => test.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const path of paths) expect(existsSync(resolve(path)), path).toBe(true);
      const commands: Record<string, string> = {
        'first-run-provisioning': scripts['test:provisioning'],
        'manifest-bot-initialization': scripts['test:bot-initialization'],
        'nightly-isolated-regression': readFileSync('scripts/ci/run-nightly-isolated.mjs', 'utf8'),
      };
      const command = commands[scenario.id];
      expect(new Set(command.match(/tests\/unit\/[a-z0-9-]+\.spec\.ts/g))).toEqual(new Set(paths));
    }
    expect(scripts['test:nightly-isolated']).toBe('node scripts/ci/run-nightly-isolated.mjs');
  });

  it('keeps a browser request explicitly pending when the local runner is unavailable', async () => {
    const scenario = AUTONOMOUS_SCENARIOS.find(item => item.id === 'nightly-isolated-regression')!;
    const result = await scenario.steps[0].run('', {});
    expect(result.state).toBe('degraded');
    expect(result.detail).toContain('No tests ran');
  });
});
