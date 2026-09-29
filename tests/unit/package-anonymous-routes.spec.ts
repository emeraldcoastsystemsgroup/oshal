/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Refuse malformed anonymous-route manifests through the real loader and pin exact raw-path matching.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { readManifest } from '@/features/swarm-apps/services/swarm-app-loader';
import { matchesAnonymousPackageRoute, readAnonymousPackageMounts } from '@/shared/package-anonymous-routes';
import { AUTHORIZATION_SCENARIOS } from '@/app/routes/test-lab-authorization-scenarios';
import { readFileSync, existsSync } from 'node:fs';

const roots: string[] = [];
const route = () => ({ module: 'route.js', factory: 'createRoutes', mountPath: '/api/public-fixture', auth: 'public',
  anonymousRoutes: [{ method: 'GET', path: '/:token/video.mp4' }] });
function load(change: Record<string, unknown> = {}, manifestChange: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'oshal-anonymous-schema-')); roots.push(root);
  const file = join(root, 'oshal-app.yaml');
  writeFileSync(join(root, 'authorization.yaml'), yaml.dump({ version: 1, resources: { videos: { scopes: ['own'] } },
    permissions: { 'videos.read': { resource: 'videos', effect: 'read', minimumTier: 'viewer' } },
    roles: { reader: { tier: 'viewer', grants: [{ permission: 'videos.read', scope: 'own' }] } },
    bindings: { http: [{ id: 'video-read', method: 'GET', path: '/:token/video.mp4', allOf: ['videos.read'] }] } }));
  writeFileSync(file, yaml.dump({ name: 'public-fixture', displayName: 'Public fixture', suite: 'ai-creative',
    uses: ['package-anonymous-routes'], routes: [{ ...route(), ...change }], ...manifestChange }));
  return readManifest(file);
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('anonymous package manifest contract', () => {
  it('registers every boundary proof in the Test Lab and focused local command', () => {
    const scenario = AUTHORIZATION_SCENARIOS.find(row => row.id === 'package-anonymous-routes');
    expect(scenario?.regressionTests).toHaveLength(4);
    expect(scenario?.steps[0].run).toBeTypeOf('function');
    const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:package-anonymous-routes'];
    for (const test of scenario!.regressionTests!) {
      expect(existsSync(test.path)).toBe(true); expect(command).toContain(test.path);
    }
  });
  it('loads an exact named GET and separately declared HEAD', () => {
    const loaded = load({ anonymousRoutes: [...route().anonymousRoutes, { method: 'HEAD', path: '/:token/video.mp4' }] });
    expect(readAnonymousPackageMounts(loaded)[0].anonymousRoutes).toHaveLength(2);
  });
  it.each([false, true])('refuses disjoint anonymous owners on the same mount regardless of order (reverse=%s)', reverse => {
    const routes = [route(), { ...route(), module: 'other.js', factory: 'createOther',
      anonymousRoutes: [{ method: 'GET', path: '/:token/thumbnail.png' }] }];
    if (reverse) routes.reverse();
    expect(() => load({}, { routes })).toThrow(/anonymousRoutes.*one.*mount/i);
  });
  it('allows independent anonymous owners on different mounts', () => {
    const loaded = load({}, { routes: [route(), { ...route(), mountPath: '/api/other-fixture', module: 'other.js' }] });
    expect(readAnonymousPackageMounts(loaded)).toHaveLength(2);
  });
  it.each([
    undefined, null, false, '*', [], {}, [{ method: 'GET' }], [{ path: '/video.mp4' }],
    [{ method: 'POST', path: '/video.mp4' }], [{ method: 'get', path: '/video.mp4' }],
    [{ method: 'OPTIONS', path: '/video.mp4' }], [{ method: '*', path: '/video.mp4' }],
    [{ method: ['GET'], path: '/video.mp4' }], [{ method: 'GET', path: '/video.mp4', bypass: true }],
    ...['/', '/*', '/:id', '/:a/:b', '/:id/*', '/:id?', '/:id(.*)/video.mp4', '/video.mp4/',
      '//video.mp4', '/./video.mp4', '/../video.mp4', '/%2e/video.mp4', '/video.mp4?x=y', '/video.mp4#x',
      '/video.mp4;other', '/:id/:id/video.mp4', 'https://example.test/video.mp4', '/a\\b/video.mp4']
      .map(path => [{ method: 'GET', path }]),
    [route().anonymousRoutes[0], route().anonymousRoutes[0]],
    Array.from({ length: 33 }, (_, i) => ({ method: 'GET', path: '/file' + i })),
  ].filter(value => value !== undefined))('refuses invalid declaration %# before mounting', anonymousRoutes => {
    expect(() => load({ anonymousRoutes })).toThrow(/anonymousRoutes/);
  });
  it.each(['oidc', 'operator', 'service', 'service-or-oidc', undefined])('refuses non-explicit-public mode %s', auth => {
    expect(() => load({ auth, requiresAuth: false })).toThrow();
  });
  it.each(['/api', '/api/', '/api/:app', '/api/foo*', '/api/foo/', '/api/../foo', '/api/foo%2fbar'])(
    'refuses non-literal/overbroad mount %s', mountPath => expect(() => load({ mountPath })).toThrow(/anonymousRoutes/));
  it('requires its compatibility floor', () => expect(() => load({}, { uses: [] })).toThrow(/anonymousRoutes/));
  it('refuses a catalog or callback bypass', () => {
    expect(() => load({}, { uses: ['package-anonymous-routes', 'application-authorization'],
      authorization: { version: 1, catalog: 'authorization.yaml' } })).toThrow(/anonymousRoutes/);
    expect(() => load({ callbackVerifier: 'createVerifier' })).toThrow(/anonymousRoutes/);
  });
  it('preserves declarations without an opt-in', () => {
    expect(readAnonymousPackageMounts(load({ anonymousRoutes: undefined }))).toEqual([]);
  });
  it('matches complete raw paths without expanding HEAD, case, slashes or encodings', () => {
    const [mount] = readAnonymousPackageMounts(load());
    expect(matchesAnonymousPackageRoute(mount, 'GET', '/api/public-fixture/abc/video.mp4')).toBe(true);
    for (const method of ['HEAD', 'OPTIONS', 'POST', 'get']) {
      expect(matchesAnonymousPackageRoute(mount, method, '/api/public-fixture/abc/video.mp4')).toBe(false);
    }
    for (const suffix of ['/abc/VIDEO.mp4', '/abc/video.mp4/', '/abc/video.mp4/other', '/abc%2fmore/video.mp4',
      '/abc/video.mp4?x=y', '/./video.mp4', '/../video.mp4', '//video.mp4']) {
      expect(matchesAnonymousPackageRoute(mount, 'GET', '/api/public-fixture' + suffix)).toBe(false);
    }
  });
});
