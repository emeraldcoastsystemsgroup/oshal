/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | P8 rollout wiring guard: .env documents warn/enforce, compose forwards the operator value to the controller, and the real Helm render carries both its warn default and an enforce override.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | P8 rollout close-out: flip and pin every shipped deployment default to enforce while preserving the explicit warn override in Compose and Helm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerOf, envValue, helmTemplate } from '../helpers/helm-template';

const MODE = 'OSHAL_CONCIERGE_COVERAGE_MODE';

describe('P8 concierge coverage deployment wiring', () => {
  it('documents and forwards the fail-closed default through compose', () => {
    const envExample = readFileSync(resolve('.env.example'), 'utf8');
    const compose = readFileSync(resolve('docker-compose.oshal-local.yml'), 'utf8');

    expect(envExample).toContain(`${MODE}=enforce`);
    expect(envExample).toMatch(/use `warn` only as a temporary observation\/rollback posture/);
    expect(compose).toContain(`${MODE}: ` + '${' + `${MODE}:-enforce}`);
  });

  it('renders enforce by default and warn from the first-class Helm value', () => {
    const defaults = containerOf(helmTemplate(), 'Deployment', 'oshal-api', 'api');
    const warning = containerOf(
      helmTemplate({ sets: ['api.conciergeCoverageMode=warn'] }),
      'Deployment',
      'oshal-api',
      'api',
    );

    expect(envValue(defaults, MODE)).toBe('enforce');
    expect(envValue(warning, MODE)).toBe('warn');
  });
});
