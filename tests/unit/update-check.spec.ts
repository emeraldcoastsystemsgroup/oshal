/**
 * Update-check daemon guards — the pure logic the daily cron and /api/updates ride on.
 *
 * Guards (guard-per-fix doctrine): version compare (the drift contract), source-block →
 * raw-manifest URL resolution, remote version extraction (incl. the regex fallback), and
 * local manifest reading. Network + timer paths are exercised live, not here.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the update-check daemon's pure logic.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Completion guards: detectNewUpdates alerts once per released version (not every daily tick), applyAppUpdate fails closed on bad/uninstalled names before touching git or the volume.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
  type UpdateCheckReport,
} from '../../src/app/routes/update-check-cron';

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
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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
    core: { runningVersion: '2.1.0', runningCommit: 'aaaaaaaaaaaa', latestCommit: sha, latestCommitDate: null, updateAvailable: true, repo: 'o/r' },
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
});
