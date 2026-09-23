/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 rollout wiring guard: .env documents warn/enforce, compose forwards the operator value to the controller, and the real Helm render carries both its warn default and an enforce override.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerOf, envValue, helmTemplate } from '../helpers/helm-template';

const MODE = 'OSHAL_CONCIERGE_COVERAGE_MODE';

describe('P8 concierge coverage deployment wiring', () => {
  it('documents the migration default and forwards an operator override through compose', () => {
    const envExample = readFileSync(resolve('.env.example'), 'utf8');
    const compose = readFileSync(resolve('docker-compose.oshal-local.yml'), 'utf8');

    expect(envExample).toContain(`${MODE}=warn`);
    expect(envExample).toMatch(/Switch to `enforce` only after the\s*#?\s*package corpus is green/);
    expect(compose).toContain(`${MODE}: ` + '${' + `${MODE}:-warn}`);
  });

  it('renders warn by default and enforce from the first-class Helm value', () => {
    const defaults = containerOf(helmTemplate(), 'Deployment', 'oshal-api', 'api');
    const enforced = containerOf(
      helmTemplate({ sets: ['api.conciergeCoverageMode=enforce'] }),
      'Deployment',
      'oshal-api',
      'api',
    );

    expect(envValue(defaults, MODE)).toBe('warn');
    expect(envValue(enforced, MODE)).toBe('enforce');
  });
});
