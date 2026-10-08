/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove registered logging reads preserve caller access and never change diagnostic settings.
 */
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn() }) }));
import { LOGGING_SCENARIOS } from '../../src/app/routes/test-lab-logging-scenarios';

const scenario = LOGGING_SCENARIOS.find(value => value.id === 'native-runtime-logging')!;
afterEach(() => { vi.unstubAllGlobals(); });

it('registers meaningful unit/browser guards and only explicit caller-session GET reads', async () => {
  expect(scenario.explicitOnly).toBe(true);
  expect(scenario.regressionTests).toEqual(expect.arrayContaining([
    { level: 'unit', path: 'tests/unit/logging-native-screen.spec.ts' },
    { level: 'browser', path: 'tests/unit/logging-native-browser.spec.ts' },
  ]));
  const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => ({ ok: true, status: 200,
    json: async () => ({ source: 'native-kernel-observer', level: 'info', audit_always_enabled: true }) }));
  vi.stubGlobal('fetch', fetch);
  const result = await scenario.steps[0].run('synthetic-session-cookie', {});
  expect(result.state).toBe('pass');
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { cookie: 'synthetic-session-cookie' } });
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('method');
});

it('refuses to claim success for unavailable or unauthorized native logging', async () => {
  for (const status of [401, 403, 404, 503]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status })));
    const result = await scenario.steps[0].run('', {});
    expect(result.state).not.toBe('pass');
    expect(result.status).toBe(status);
  }
});

it('does not certify a configuration that can mute mandatory audit or a different backend', async () => {
  for (const body of [
    { source: 'native-kernel-observer', level: 'info', audit_always_enabled: false },
    { source: 'legacy', level: 'trace', audit_always_enabled: true },
  ]) {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
    expect((await scenario.steps[0].run('', {})).state).toBe('fail');
  }
});

it('requires the bounded query and honest retention rather than accepting an arbitrary empty array', async () => {
  for (const retention of ['memory-until-restart', 'durable-forever', undefined]) {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => ({ ok: true, status: 200,
      json: async () => ({ source: 'native-kernel-observer', data: [], meta: { retention } }) }));
    vi.stubGlobal('fetch', fetch);
    expect((await scenario.steps[1].run('', {})).state).toBe(retention === 'memory-until-restart' ? 'pass' : 'fail');
    expect(fetch.mock.calls[0][0]).toContain('/api/v1/logs/query?limit=1');
  }
});
