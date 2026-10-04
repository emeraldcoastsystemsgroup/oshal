/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the shell-lock live-acceptance case over a fake second-caller port: passes only when an unknown name is refused 404 with exactly the lock fields, every cockpit spelling and the experience page redirect to the landing, and no name serves the landing application; the pre-fix answers (a built-in 200, a served /Cockpit/) fail; an operator caller, an unmapped host or a missing port is unavailable by name; every request is a GET carrying the focused host.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require a matching explicitly bound actual origin before any case request, with no Host or forwarded-host overrides.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const shellLock = requireCjs('../../scripts/lib/live-acceptance-shell-lock.js');
const HOST = 'sales.fixture.invalid';
const LANDING_APP = 'intelligent-sales';
const LANDING = `/cockpit/?app=${LANDING_APP}`;

/**
 * @description A box that holds the second caller to the focused landing, as the fixed build does.
 * @param over - Routes replaced for one case.
 * @returns The fake port and its recorded calls.
 */
function box(over: Record<string, FakeHandler> = {}) {
  const redirect: FakeHandler = () => ({ status: 302, text: '', location: LANDING });
  return fakeApi({
    'GET /api/cli-tokens/whoami': () => ({ status: 200, json: { sub: 'fixture-member', operator: false } }),
    'GET /api/ui/profile': ({ query }) => (query.includes('name=')
      ? { status: 404, json: { error: 'experience_unavailable', landingApp: LANDING_APP, operator: false } }
      : { status: 200, json: { profile: { name: LANDING_APP }, requested: LANDING_APP, source: 'swarm-app', landingApp: LANDING_APP, operator: false } }),
    'GET /cockpit/': redirect, 'GET /Cockpit/': redirect, 'GET /COCKPIT/index.html': redirect, 'GET /experience/index.html': redirect,
    ...over,
  });
}

const run = (port: ReturnType<typeof fakeApi>, options = { focusedHost: HOST }) => shellLock.run({
  second: { api: port.api, ownerSub: 'fixture-member', origin: `https://${HOST}` } }, options);

describe('shell-lock live acceptance', () => {
  it('passes on the fixed build, asking only GETs as the focused host', async () => {
    const port = box();
    const result = await run(port);
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('an unknown name is refused 404 experience_unavailable (landing intelligent-sales)');
    expect(result.detail).toContain(`4 surface spellings redirect to ${LANDING}`);
    expect(result.detail).toContain('no name serves the landing application intelligent-sales');
    expect(port.calls.every((call) => call.method === 'GET' && !('host' in call.headers)
      && !('x-forwarded-host' in call.headers))).toBe(true);
    expect(port.calls.map((call) => call.path)).toEqual(['/api/cli-tokens/whoami', '/api/ui/profile', ...shellLock.SURFACES, '/api/ui/profile']);
    expect(result.cleanup).toMatchObject({ removed: [], outstanding: [], errors: [] });
  });

  it('fails on the pre-fix answers: the built-in profile for an unknown name, or a served /Cockpit/', async () => {
    const builtIn = await run(box({ 'GET /api/ui/profile': () => ({ status: 200, json: { profile: { name: 'zzz', description: 'Default full-operator profile (built-in fallback)' }, landingApp: LANDING_APP, operator: false } }) }));
    expect(builtIn.state).toBe('fail');
    expect(builtIn.detail).toContain('answered 200 with profile');
    const served = await run(box({ 'GET /Cockpit/': () => ({ status: 200, text: '<title>Cockpit</title>', contentType: 'text/html' }) }));
    expect(served.state).toBe('fail');
    expect(served.detail).toContain('/Cockpit/ -> 200');
  });

  it('fails when a refusal carries more than the lock fields, or no name serves the deployment profile', async () => {
    const leaky = await run(box({ 'GET /api/ui/profile': () => ({ status: 404, json: { error: 'experience_unavailable', landingApp: LANDING_APP, operator: false, profile: {} } }) }));
    expect(leaky.state).toBe('fail');
    const framework = await run(box({ 'GET /api/ui/profile': ({ query }) => (query.includes('name=')
      ? { status: 404, json: { error: 'experience_unavailable', landingApp: LANDING_APP, operator: false } }
      : { status: 200, json: { profile: { name: 'oshal-framework' }, requested: 'oshal-framework', source: 'disk', landingApp: LANDING_APP, operator: false } }) }));
    expect(framework.state).toBe('fail');
    expect(framework.detail).toContain('profile=oshal-framework');
  });

  it('is unavailable by name without a second caller, without a focused host, for an operator, or on an unmapped host', async () => {
    expect((await shellLock.run({}, { focusedHost: HOST })).detail).toContain('OSHAL_VERIFY_SECOND_PAT');
    expect((await run(box(), { focusedHost: '' })).detail).toContain('OSHAL_VERIFY_FOCUSED_HOST');
    const operator = await run(box({ 'GET /api/cli-tokens/whoami': () => ({ status: 200, json: { sub: 'fixture-operator', operator: true } }) }));
    expect([operator.state, operator.detail.includes('is an operator')]).toEqual(['unavailable', true]);
    const unmapped = await run(box({ 'GET /api/ui/profile': () => ({ status: 404, json: { error: 'experience_unavailable', landingApp: null, operator: false } }) }));
    expect([unmapped.state, unmapped.detail.includes('HOST_APP_MAP')]).toEqual(['unavailable', true]);
  });

  it.each([undefined, '', 'not-a-url', 'http://127.0.0.1:35457', 'https://unmapped.fixture.invalid',
    `ftp://${HOST}`, `https://fixture-user@${HOST}`, `https://${HOST}/other`, `https://${HOST}/?query=1`,
    `https://${HOST}/#fragment`])('sends nothing when the caller origin is missing, invalid or mismatched: %s', async origin => {
    const port = box();
    const result = await shellLock.run({ second: { api: port.api, origin } }, { focusedHost: HOST });
    expect(result.state).toBe('unavailable');
    expect(result.detail).toContain('OSHAL_VERIFY_BASE_URL');
    expect(port.calls).toEqual([]);
  });

  it('accepts the canonical hostname of the actual bound origin, including uppercase and a port', async () => {
    const port = box();
    const result = await shellLock.run({ second: { api: port.api, origin: `https://${HOST.toUpperCase()}:8443` } }, { focusedHost: HOST });
    expect(result.state).toBe('pass');
    expect(port.calls.every(call => Object.keys(call.headers).length === 0)).toBe(true);
  });
});
