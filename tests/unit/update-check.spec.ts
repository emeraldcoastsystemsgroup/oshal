/**
 * Update-check daemon guards — the pure logic the daily cron and /api/updates ride on.
 *
 * Guards (guard-per-fix doctrine): version compare (the drift contract), source-block →
 * raw-manifest URL resolution, remote version extraction (incl. the regex fallback), and
 * local manifest reading. Scoped HTTP checks use owned temporary manifests, synthetic
 * sessions and recorded upstream responses; no installer, timer or live provider runs.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the update-check daemon's pure logic.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Completion guards: detectNewUpdates alerts once per released version (not every daily tick), applyAppUpdate fails closed on bad/uninstalled names before touching git or the volume.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 release identity: getRunningBuild reports a well-formed OSHAL_RELEASE and nulls the `unreleased` default and anything off-scheme, and the real GET /api/version route (mounted on an Express app, reached over HTTP) serves `release` publicly while /api/updates stays behind the auth gate.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Exercise current scoped cache visibility and operator-only refresh over real HTTP with isolated manifests and recorded upstream reads.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { createUpdateCheckVisibility } from '@/app/composition/update-check-visibility';
import {
  compareVersions,
  rawManifestUrl,
  parseRemoteVersion,
  readLocalManifest,
  getRunningBuild,
  detectNewUpdates,
  applyAppUpdate,
  resolveStoreToken,
  scrubSecret,
  registerUpdateRoutes,
  runUpdateCheck,
  type UpdateCheckReport,
} from '../../src/app/routes/update-check-cron';

/** @description Remove only this suite's owned, directly nested temporary directory. */
function removeFixtureDirectory(directory: string, prefix: string): void {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith(prefix)) {
    throw new Error('Refusing cleanup outside the owned update fixture directory');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

describe('compareVersions — the store drift contract', () => {
  it('orders plain dotted versions numerically, not lexically', () => {
    expect(compareVersions('1.1.0', '1.0.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0); // lexical compare would get this wrong
    expect(compareVersions('0.9.0', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('treats missing segments as zero and tolerates a leading v', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.1.9')).toBeGreaterThan(0);
  });

  it('ranks a release above its own pre-release (the core beta case)', () => {
    expect(compareVersions('2.1.0', '2.1.0-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('2.1.0-beta.1', '2.1.0-beta.2')).toBeLessThan(0);
    expect(compareVersions('2.1.0-beta.1', '2.1.0-beta.1')).toBe(0);
  });
});

describe('update administration and current caller discovery over HTTP', () => {
  const request = globalThis.fetch;
  let directory: string, server: Server, base: string, allowed: Set<string>;
  let active = true, unavailable = false, mismatched = false;
  const upstream = vi.fn(async () => new Response(JSON.stringify({ sha: 'a'.repeat(40), commit: {} }), { status: 200 }));
  const scope = vi.fn(async () => ['own-app', 'shared-app', 'hidden-app'].map(name => ({ name })));
  const resolveActor = vi.fn(async () => {
    if (unavailable) throw new Error('directory unavailable');
    return { sub: mismatched ? 'forged-owner' : 'fixture-member', issuer: 'urn:fixture', isActive: active, isSwarmAdmin: false } as AuthorizationActor;
  });
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'update-visibility-'));
    for (const name of ['own-app', 'shared-app', 'hidden-app', 'foreign-app']) {
      const target = path.join(directory, 'deployed-apps', name); fs.mkdirSync(target, { recursive: true });
      const source = name === 'foreign-app' ? '\nsource:\n  url: https://github.com/fixture/private-source\n  path: foreign-app\n  ref: main\n' : '';
      fs.writeFileSync(path.join(target, 'oshal-app.yaml'), `name: ${name}\nversion: 1.0.0\n${source}`);
    }
    vi.stubEnv('OSHAL_WORKSPACE_ROOT', directory); vi.stubEnv('GIT_SHA', 'unknown');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator'); vi.stubEnv('OSHAL_OPERATOR_EMAILS', '');
    vi.stubGlobal('fetch', upstream); await runUpdateCheck();
    const app = express();
    const visibility = createUpdateCheckVisibility({ listApps: scope }, {
      resolveActor, canDiscover: async name => allowed.has(name),
    });
    registerUpdateRoutes(app, (req, res, next) => {
      const user = req.get('x-fixture-user');
      if (!['member', 'operator'].includes(user ?? '')) { res.sendStatus(401); return; }
      Object.assign(req, { oidc: { isAuthenticated: () => true, user: { sub: `fixture-${user}` } } }); next();
    }, { loadApp: async () => { throw new Error('installer must not run'); }, visibleApps: visibility });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(done => server.once('listening', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    allowed = new Set(['own-app', 'shared-app']); active = true; unavailable = false; mismatched = false;
    scope.mockClear(); resolveActor.mockClear(); upstream.mockClear();
  });
  afterAll(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(done => server.close(() => done()));
    vi.unstubAllGlobals(); vi.unstubAllEnvs(); removeFixtureDirectory(directory, 'update-visibility-');
  });
  const call = (query = '', user = 'member') => request(base + '/api/updates' + query, { headers: { 'x-fixture-user': user } });

  it('returns only currently discoverable cached apps, never foreign or denied names/source errors', async () => {
    const response = await call('?ownerSub=fixture-operator&scope=all'); expect(response.status).toBe(200);
    const report = await response.json(); expect(report.core).toBeNull();
    expect(report.apps.map((app: { name: string }) => app.name)).toEqual(['own-app', 'shared-app']);
    expect(JSON.stringify(report)).not.toMatch(/foreign-app|hidden-app|private-source/);
    expect(scope).toHaveBeenCalledWith(undefined, { ownerSub: 'fixture-member', isOperator: false });
    expect(upstream).not.toHaveBeenCalled();
  });
  it('removes a revoked discovery grant on the next cached read without refreshing upstream', async () => {
    expect((await (await call()).json()).apps).toHaveLength(2);
    allowed.delete('shared-app'); expect((await (await call()).json()).apps.map((app: { name: string }) => app.name)).toEqual(['own-app']);
    expect(resolveActor).toHaveBeenCalledTimes(2); expect(upstream).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'unavailable', 'mismatch'])('refuses %s current authority without cached catalog metadata', async state => {
    active = state !== 'inactive'; unavailable = state === 'unavailable'; mismatched = state === 'mismatch';
    const response = await call(); expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/own-app|hidden-app|foreign-app/);
    expect(scope).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
  it('refuses anonymous and ordinary refresh before any upstream check or catalog read', async () => {
    expect((await call('?refresh=1', 'anonymous')).status).toBe(401);
    expect((await call('?refresh=1&operator=true&ownerSub=fixture-operator')).status).toBe(403);
    expect(scope).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
  it('preserves the operator full cache and refresh, and denies refresh after revocation', async () => {
    const cached = await (await call('', 'operator')).json(); expect(cached.apps).toHaveLength(4); expect(cached.core).not.toBeNull();
    expect(cached.apps.find((app: { name: string }) => app.name === 'foreign-app')).toMatchObject({
      sourceUrl: 'https://raw.githubusercontent.com/fixture/private-source/main/foreign-app/oshal-app.yaml', error: 'manifest fetch failed (HTTP 200)',
    });
    expect((await call('?refresh=1', 'operator')).status).toBe(200); expect(upstream).toHaveBeenCalledTimes(2);
    vi.stubEnv('OSHAL_OPERATOR_SUBS', ''); expect((await call('?refresh=1', 'operator')).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(2); expect(scope).not.toHaveBeenCalled();
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'fixture-operator');
  });
});

describe('rawManifestUrl — source: block resolution', () => {
  it('resolves the installer-written git-subdir shape', () => {
    expect(rawManifestUrl({
      url: 'https://github.com/emeraldcoastsystemsgroup/oshal-applications',
      path: 'hello-oshal',
      ref: 'main',
    })).toBe('https://raw.githubusercontent.com/emeraldcoastsystemsgroup/oshal-applications/main/hello-oshal/oshal-app.yaml');
  });

  it('tolerates .git suffix, trailing slash, and a missing ref (defaults to main)', () => {
    expect(rawManifestUrl({ url: 'https://github.com/org/repo.git/', path: '/pkg/' }))
      .toBe('https://raw.githubusercontent.com/org/repo/main/pkg/oshal-app.yaml');
  });

  it('returns null for absent or non-GitHub sources instead of guessing', () => {
    expect(rawManifestUrl(undefined)).toBeNull();
    expect(rawManifestUrl({ url: 'https://gitlab.com/org/repo', path: 'pkg' })).toBeNull();
    expect(rawManifestUrl({ url: 'https://github.com/org/repo' })).toBeNull(); // no path
  });
});

describe('parseRemoteVersion — store manifest version extraction', () => {
  it('reads the version via a real YAML parse', () => {
    expect(parseRemoteVersion('name: x\nversion: 1.2.3\nstatus: active\n')).toBe('1.2.3');
    expect(parseRemoteVersion("version: '2.0.0'\n")).toBe('2.0.0');
  });

  it('falls back to the line regex when the document has an unparseable block elsewhere', () => {
    const broken = 'version: 3.1.4\nbad:\n  - {unclosed: [\n';
    expect(parseRemoteVersion(broken)).toBe('3.1.4');
  });

  it('returns null when there is no version at all', () => {
    expect(parseRemoteVersion('name: x\nstatus: active\n')).toBeNull();
  });
});

describe('readLocalManifest — deployed package reading', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-update-check-'));
  afterAll(() => { removeFixtureDirectory(tmp, 'oshal-update-check-'); });

  it('reads name/version/source from a real package manifest shape', () => {
    const dir = path.join(tmp, 'hello-oshal');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'oshal-app.yaml'), [
      'name: hello-oshal',
      'version: 1.1.0',
      'source:',
      '  type: git-subdir',
      '  url: https://github.com/emeraldcoastsystemsgroup/oshal-applications',
      '  path: hello-oshal',
      '  ref: main',
    ].join('\n'));
    const m = readLocalManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.name).toBe('hello-oshal');
    expect(m!.version).toBe('1.1.0');
    expect(rawManifestUrl(m!.source)).toContain('raw.githubusercontent.com');
  });

  it('returns null (never throws) for a missing or nameless manifest', () => {
    expect(readLocalManifest(path.join(tmp, 'nope'))).toBeNull();
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'oshal-app.yaml'), 'version: 1.0.0\n');
    expect(readLocalManifest(bad)).toBeNull();
  });
});

describe('detectNewUpdates — alert once per released version, not per tick', () => {
  const empty: UpdateCheckReport = { checkedAt: null, core: null, apps: [] };
  const withAppUpdate = (latest: string): UpdateCheckReport => ({
    checkedAt: 't', core: null,
    apps: [{ name: 'eats', installedVersion: '1.0.0', latestVersion: latest, updateAvailable: true, sourceUrl: 'x' }],
  });
  const withCoreUpdate = (sha: string): UpdateCheckReport => ({
    checkedAt: 't', apps: [],
    core: { runningVersion: '2.1.0', runningCommit: 'aaaaaaaaaaaa', runningRelease: null, latestCommit: sha, latestCommitDate: null, updateAvailable: true, repo: 'o/r' },
  });

  it('announces a newly seen app update, then stays quiet on the identical daily re-check', () => {
    const first = detectNewUpdates(empty, withAppUpdate('1.1.0'));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('eats');
    expect(detectNewUpdates(withAppUpdate('1.1.0'), withAppUpdate('1.1.0'))).toHaveLength(0);
  });

  it('re-announces when the store releases a FURTHER version', () => {
    expect(detectNewUpdates(withAppUpdate('1.1.0'), withAppUpdate('1.2.0'))).toHaveLength(1);
  });

  it('announces a core update once per upstream commit, and never on current/unknown', () => {
    expect(detectNewUpdates(empty, withCoreUpdate('bbbbbbbbbbbb'))).toHaveLength(1);
    expect(detectNewUpdates(withCoreUpdate('bbbbbbbbbbbb'), withCoreUpdate('bbbbbbbbbbbb'))).toHaveLength(0);
    expect(detectNewUpdates(withCoreUpdate('bbbbbbbbbbbb'), withCoreUpdate('cccccccccccc'))).toHaveLength(1);
    expect(detectNewUpdates(empty, empty)).toHaveLength(0);
  });
});

describe('applyAppUpdate — fails closed before touching git or the volume', () => {
  const deps = { loadApp: async () => { throw new Error('loadApp must not be reached'); } };

  it('rejects a non-slug name with 400 (path/arg injection fence)', async () => {
    for (const bad of ['../escape', 'Name With Spaces', 'x;rm -rf /', '']) {
      const r = await applyAppUpdate(bad, null, deps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it('rejects a valid slug that is not an installed store package with 404', async () => {
    const r = await applyAppUpdate('definitely-not-installed-zzz', null, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});

describe('store token — resolution precedence and scrubbing', () => {
  const saved = { store: process.env.OSHAL_STORE_TOKEN, gh: process.env.GITHUB_TOKEN };
  afterAll(() => {
    if (saved.store === undefined) delete process.env.OSHAL_STORE_TOKEN; else process.env.OSHAL_STORE_TOKEN = saved.store;
    if (saved.gh === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved.gh;
  });

  it('prefers OSHAL_STORE_TOKEN, falls back to GITHUB_TOKEN, defaults to anonymous', () => {
    delete process.env.OSHAL_STORE_TOKEN; delete process.env.GITHUB_TOKEN;
    expect(resolveStoreToken()).toBe('');
    process.env.GITHUB_TOKEN = 'gh-tok';
    expect(resolveStoreToken()).toBe('gh-tok');
    process.env.OSHAL_STORE_TOKEN = 'store-tok';
    expect(resolveStoreToken()).toBe('store-tok');
  });

  it('scrubSecret removes every occurrence and no-ops on empty', () => {
    expect(scrubSecret('clone https://x:tok123@github.com failed tok123', 'tok123'))
      .toBe('clone https://x:***@github.com failed ***');
    expect(scrubSecret('untouched', '')).toBe('untouched');
  });
});

describe('getRunningBuild — runtime self-identity', () => {
  it('reads the package.json version and treats unknown/empty GIT_SHA as null', () => {
    const prev = process.env.GIT_SHA;
    try {
      process.env.GIT_SHA = 'unknown';
      expect(getRunningBuild().commit).toBeNull();
      process.env.GIT_SHA = 'abc123def456';
      expect(getRunningBuild().commit).toBe('abc123def456');
      expect(typeof getRunningBuild().version).toBe('string'); // repo root package.json is readable
    } finally {
      if (prev === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = prev;
    }
  });

  it('reports a release cut name and nulls the unreleased default and anything off-scheme', () => {
    const prev = process.env.OSHAL_RELEASE;
    try {
      process.env.OSHAL_RELEASE = 'core-2026.09.27';
      expect(getRunningBuild().release).toBe('core-2026.09.27');
      process.env.OSHAL_RELEASE = 'core-2026.09.27.2';
      expect(getRunningBuild().release).toBe('core-2026.09.27.2');
      // The Dockerfile default for every build that is not a cut.
      process.env.OSHAL_RELEASE = 'unreleased';
      expect(getRunningBuild().release).toBeNull();
      // The endpoint is public: an arbitrary build argument must never be reflected.
      for (const bad of ['v2.1.0-beta.1', 'core-2026.9.27', 'core-2026.09.27.0', 'core-2026.09.27<script>', ' ']) {
        process.env.OSHAL_RELEASE = bad;
        expect(getRunningBuild().release, bad).toBeNull();
      }
      delete process.env.OSHAL_RELEASE;
      expect(getRunningBuild().release).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.OSHAL_RELEASE; else process.env.OSHAL_RELEASE = prev;
    }
  });
});

describe('GET /api/version — the release identity a production box is AT', () => {
  let server: Server;
  let base: string;
  const saved = { sha: process.env.GIT_SHA, release: process.env.OSHAL_RELEASE };

  beforeAll(async () => {
    const app = express();
    // A gate that refuses everything: /api/version must not depend on it, /api/updates must.
    registerUpdateRoutes(app, (_req, res) => { res.status(401).json({ error: 'auth required' }); });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (saved.sha === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = saved.sha;
    if (saved.release === undefined) delete process.env.OSHAL_RELEASE; else process.env.OSHAL_RELEASE = saved.release;
  });

  it('serves commit and release anonymously for a release-cut image', async () => {
    process.env.GIT_SHA = 'a'.repeat(40);
    process.env.OSHAL_RELEASE = 'core-2026.09.27';
    const res = await fetch(`${base}/api/version`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'oshal', commit: 'a'.repeat(40), release: 'core-2026.09.27' });
    expect(typeof body.version).toBe('string');
  });

  it('serves release null for a dev build, and keeps /api/updates behind the gate', async () => {
    process.env.OSHAL_RELEASE = 'unreleased';
    const body = await (await fetch(`${base}/api/version`)).json() as Record<string, unknown>;
    expect(body.release).toBeNull();
    expect('release' in body).toBe(true);
    expect((await fetch(`${base}/api/updates`)).status).toBe(401);
  });
});
