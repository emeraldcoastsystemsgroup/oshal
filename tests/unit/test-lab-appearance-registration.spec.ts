/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep profile and disconnect regression discoverable and readiness read-only.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { APPEARANCE_SCENARIOS } from '@/app/routes/test-lab-appearance-scenarios';
import { SCENARIOS } from '@/app/routes/test-lab-scenarios';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('registers real profile and request-disconnect coverage on the existing Lab cards', () => {
  const appearance = SCENARIOS.filter(item => item.id === 'cockpit-appearance');
  expect(appearance).toHaveLength(1);
  expect(appearance[0].regressionTests).toContainEqual({ level: 'browser', path: 'tests/unit/cockpit-profile-browser.spec.ts' });
  expect(SCENARIOS.find(item => item.id === 'cockpit-workspace-navigation')!.regressionTests)
    .toContainEqual({ level: 'integration', path: 'tests/unit/workspace-navigation-routes-cancellation.spec.ts' });
  expect(SCENARIOS.find(item => item.id === 'shared-stl-viewer')!.regressionTests)
    .toContainEqual({ level: 'browser', path: 'tests/unit/stl-viewer-browser.spec.ts' });
});

const profileStep = () => APPEARANCE_SCENARIOS[0].steps.find(step => step.id === 'profile-stylesheet')!;

it('checks the shared renderer asset without requesting an application model or invoking its engine', async () => {
  vi.stubEnv('PORT', '5018');
  const fetcher = vi.fn(async () => new Response('/* shared viewer */', { headers: { 'content-type': 'application/javascript' } }));
  vi.stubGlobal('fetch', fetcher);
  expect((await APPEARANCE_SCENARIOS.find(item => item.id === 'shared-stl-viewer')!.steps[0].run('')).state).toBe('pass');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5018/shared/ui/js/stl-viewer.js', {
    headers: {}, redirect: 'manual', signal: expect.any(AbortSignal),
  });
});

it('checks only the fixed profile asset without reading an account or changing settings', async () => {
  vi.stubEnv('PORT', '5018');
  const fetcher = vi.fn(async () => new Response('.profile-access { color: inherit; }', { headers: { 'content-type': 'text/css' } }));
  vi.stubGlobal('fetch', fetcher);
  expect((await profileStep().run('synthetic-session')).state).toBe('pass');
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:5018/cockpit/css/profile-modal.css', {
    headers: { cookie: 'synthetic-session' }, redirect: 'manual', signal: expect.any(AbortSignal),
  });
});

it.each([[401, 'degraded'], [403, 'degraded'], [503, 'degraded'], [404, 'gap'], [302, 'fail']])(
  'keeps profile readiness HTTP %i distinct as %s', async (status, state) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: Number(status) })));
    expect((await profileStep().run('')).state).toBe(state);
  },
);

it('rejects login HTML and empty CSS, retaining failed fetch as unavailable', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }))
    .mockResolvedValueOnce(new Response('  ', { headers: { 'content-type': 'text/css' } }))
    .mockRejectedValueOnce(new Error('synthetic timeout'));
  vi.stubGlobal('fetch', fetcher);
  expect((await profileStep().run('')).state).toBe('fail');
  expect((await profileStep().run('')).state).toBe('fail');
  expect((await profileStep().run('')).state).toBe('degraded');
});
