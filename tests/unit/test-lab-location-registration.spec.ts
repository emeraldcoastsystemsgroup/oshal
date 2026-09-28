/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ADR-169 L1 location log-safety card is registered exactly once with suites that exist on disk, its two real steps pass in this process against the shipped redact config, locationSafeError and the shared geo maths, and the redaction step grades honestly: a redact list missing a namespaced key, a censor that echoes the value and an error projection that keeps the message each fail and name what leaked.
 */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { LOCATION_REDACT_KEYS, LOCATION_SCENARIOS, locationRedactionStep } from '@/app/routes/test-lab-location-scenarios';
import { LOG_REDACT_OPTIONS, locationSafeError } from '@/shared/logger';

describe('ADR-169 L1 location log-safety Test Lab card', () => {
  it('is registered once with suites that exist on disk', () => {
    const [scenario] = LOCATION_SCENARIOS;
    expect(SCENARIOS.filter((s) => s.id === scenario.id)).toEqual([scenario]);
    expect(scenario.regressionTests!.map((t) => t.path)).toContain('tests/unit/location-log-guard.spec.ts');
    for (const test of scenario.regressionTests!) expect(existsSync(test.path), test.path).toBe(true);
    expect(scenario.steps.map((s) => s.id)).toEqual(['log-redaction', 'geo-canary']);
    expect(scenario.explicitOnly).toBeUndefined();
  });

  it('runs both real steps in this process and passes on the shipped config', async () => {
    const [redaction, geo] = LOCATION_SCENARIOS[0].steps;
    const first = await redaction.run('', {});
    expect(first.state).toBe('pass');
    expect(first.detail).toContain('nobody\'s location');
    const second = await geo.run('', {});
    expect(second.state).toBe('pass');
    expect(second.detail).toContain('6 synthetic geo checks pass');
  });

  it('fails when the build lacks a namespaced key and names it', () => {
    const paths = LOG_REDACT_OPTIONS.paths.filter((p) => p !== 'coords' && p !== '*.coords');
    const r = locationRedactionStep({ redact: { paths, censor: '[REDACTED]' }, safeError: locationSafeError });
    expect(r.state).toBe('fail');
    expect(r.detail).toContain('coords, *.coords');
  });

  it('fails when a synthetic fix reaches the serialised line', () => {
    const r = locationRedactionStep({ redact: { paths: [...LOCATION_REDACT_KEYS], censor: '-12.34567' }, safeError: locationSafeError });
    expect(r.state).toBe('fail');
    expect(r.output).toMatchObject({ leakedFix: ['-12.34567'] });
  });

  it('fails when the error projection keeps the URL', () => {
    const keepsMessage = (error: unknown): unknown => ({ message: (error as Error).message });
    const r = locationRedactionStep({ redact: LOG_REDACT_OPTIONS, safeError: keepsMessage });
    expect(r.state).toBe('fail');
    expect(r.output).toMatchObject({ leakedError: ['geo.example', '-12.34567', '-31.98765'] });
  });
});
