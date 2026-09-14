/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify actual dashboard coverage is registered and read-only readiness preserves unavailable/refused outcomes.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Pin the briefing settings client readiness step and the briefing asset suite in the registration.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';
import { DASHBOARD_SCENARIOS } from '@/app/routes/test-lab-dashboard-scenarios';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('registers daily dashboard once with browser, Home lifecycle and HTTP asset coverage', () => {
  const registered = SCENARIOS.filter(item => item.id === 'cockpit-daily-dashboard');
  expect(registered).toEqual(DASHBOARD_SCENARIOS);
  expect(registered[0].regressionTests).toEqual(expect.arrayContaining([
    { level: 'browser', path: 'tests/unit/jarvis-dashboard-browser.spec.ts' },
    { level: 'browser', path: 'tests/unit/app-home-browser.spec.ts' },
    { level: 'unit', path: 'tests/unit/app-home-lifecycle.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-dashboard-assets.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-briefing-assets.spec.ts' },
    { level: 'integration', path: 'tests/unit/jarvis-delayed-visual-lifecycle.integration.spec.ts' },
    { level: 'unit', path: 'tests/unit/isolated-browser.spec.ts' },
  ]));
});

it('reads only fixed assets using current session and never starts assistant work', async () => {
  vi.stubEnv('PORT', '5017');
  const fetcher = vi.fn(async (url: string) => new Response('/* installed client */', {
    headers: { 'content-type': url.endsWith('.css') ? 'text/css' : 'application/javascript' },
  }));
  vi.stubGlobal('fetch', fetcher);
  for (const step of DASHBOARD_SCENARIOS[0].steps) expect((await step.run('test-session')).state).toBe('pass');
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    'http://127.0.0.1:5017/api/jarvis/assets/jarvis-dashboard.css',
    'http://127.0.0.1:5017/api/jarvis/assets/jarvis-dashboard.js',
    'http://127.0.0.1:5017/api/jarvis/briefings/client.js',
    'http://127.0.0.1:5017/cockpit/js/views/AppsHomeView.js',
  ]);
  for (const call of vi.mocked(fetch).mock.calls) expect(call[1]).toEqual({
    headers: { cookie: 'test-session' }, redirect: 'manual', signal: expect.any(AbortSignal),
  });
});

it.each([[401, 'degraded'], [403, 'degraded'], [503, 'degraded'], [404, 'gap'], [302, 'fail']])(
  'reports HTTP %i as %s without following a login redirect', async (status, state) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: Number(status) })));
    expect((await DASHBOARD_SCENARIOS[0].steps[0].run('')).state).toBe(state);
  },
);

it('refuses a successful HTML login page and reports an unavailable asset separately', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } })));
  expect((await DASHBOARD_SCENARIOS[0].steps[0].run('')).state).toBe('fail');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
  expect((await DASHBOARD_SCENARIOS[0].steps[0].run('')).state).toBe('degraded');
});
