/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added a fail-closed guard for patched transitive resolutions, the native-free desktop input path, Electron's supported Node floor, and the speaker runtime/test security pins so a future lock refresh cannot silently restore the audited advisories.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require Electron as an exact production dependency and retain the clean packed-consumer smoke that installs with development packages and lifecycle scripts omitted.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Split dependency areas into focused suites so every governance-counted test callback remains below fifty physical lines.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guard the speaker image's complete hash-locked install graph and fail if Docker falls back to unhashed input requirements.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Guard the Electron two-package installer and real Windows capture/user32 acceptance runner so npm runtime packaging and desktop artifacts cannot drift apart.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');

interface PackageLockEntry {
  dependencies?: Record<string, string>;
  dev?: boolean;
  version?: string;
}

interface PackageLock {
  packages: Record<string, PackageLockEntry>;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  overrides?: Record<string, string | Record<string, string>>;
  scripts?: Record<string, string>;
}

/** @description Reads a repository JSON file without allowing environment-dependent paths. */
function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relativePath), 'utf8')) as T;
}

describe('root dependency security baseline', () => {
  it('locks the audited root transitive packages to patched versions', () => {
    const manifest = readJson<PackageManifest>('package.json');
    const lock = readJson<PackageLock>('package-lock.json');
    expect(manifest.overrides).toMatchObject({
      'socket.io-parser': '4.2.7',
      'ip-address': '10.4.0',
      postcss: '8.5.25',
      exceljs: { uuid: '11.1.1' },
      'mavlink-mappings-gen': { xml2js: '0.6.2' },
    });
    expect(lock.packages['node_modules/socket.io-parser'].version).toBe('4.2.7');
    expect(lock.packages['node_modules/ip-address'].version).toBe('10.4.0');
    expect(lock.packages['node_modules/postcss'].version).toBe('8.5.25');
    expect(lock.packages['node_modules/uuid'].version).toBe('11.1.1');
    expect(lock.packages['node_modules/xml2js'].version).toBe('0.6.2');
  });

});

describe('desktop dependency security baseline', () => {
  it('keeps the desktop node on patched production Electron without nut.js', () => {
    const manifest = readJson<PackageManifest>('packages/oshal-chat/package.json');
    const lock = readJson<PackageLock>('packages/oshal-chat/package-lock.json');
    const inputSource = readFileSync(resolve(REPO_ROOT, 'packages/oshal-chat/src/main/system-tools.ts'), 'utf8');
    expect(manifest.dependencies).toMatchObject({ electron: '43.3.0' });
    expect(manifest.dependencies?.['@nut-tree-fork/nut-js']).toBeUndefined();
    expect(manifest.devDependencies?.electron).toBeUndefined();
    expect(manifest.devDependencies).toMatchObject({ 'electron-builder': '^26.15.3' });
    expect(manifest.engines?.node).toBe('>=22.12.0');
    expect(lock.packages[''].dependencies).toMatchObject({ electron: '43.3.0' });
    expect(lock.packages['node_modules/electron'].version).toBe('43.3.0');
    expect(lock.packages['node_modules/electron'].dev).not.toBe(true);
    expect(Object.keys(lock.packages).some((path) => path.includes('@nut-tree-fork'))).toBe(false);
    expect(inputSource).not.toContain("requireFn('@nut-tree-fork/nut-js')");
    expect(inputSource).toMatch(/controlInput[\s\S]*await psControl\(resolved\)/);
  });

  it('keeps a production-only packed-consumer smoke in the package contract', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'packages/oshal-chat/scripts/test-packed-install.mjs'), 'utf8');
    expect(source).toMatch(/npmOutput\(\['pack'/);
    expect(source).toMatch(/'install', '--omit=dev', '--ignore-scripts'/);
    expect(source).toContain("resolve('@oshal/chat/package.json')");
    expect(source).toContain("resolve('electron/package.json')");
  });

  it('stages installers without duplicating the npm Electron runtime', () => {
    const manifest = readJson<PackageManifest>('packages/oshal-chat/package.json');
    const builder = readFileSync(resolve(REPO_ROOT, 'packages/oshal-chat/scripts/build-desktop.mjs'), 'utf8');
    const boundary = readFileSync(resolve(REPO_ROOT, 'packages/oshal-chat/src/main/windows-desktop-boundary.ts'), 'utf8');
    const stagedManifest = builder.match(/const appManifest = \{([\s\S]*?)\n  \};/)?.[1] ?? '';
    expect(manifest.scripts?.dist).toContain('scripts/build-desktop.mjs');
    expect(manifest.scripts?.['test:windows-boundary']).toContain('windows-desktop-boundary.js');
    expect(builder).toContain('projectDir: temporaryProject');
    expect(builder).toContain('directories: { app: appRoot');
    expect(stagedManifest).not.toContain('dependencies');
    expect(boundary).toContain('await captureScreen(640)');
    expect(boundary).toContain("kind: 'move'");
    expect(boundary).toContain("coordinateSpace: 'physical'");
  });
});

describe('speaker dependency security baseline', () => {
  it('pins the speaker runtime and test stack to audited compatible releases', () => {
    const requirements = readFileSync(resolve(REPO_ROOT, 'services/speaker-diarization/requirements.txt'), 'utf8');
    const devRequirements = readFileSync(resolve(REPO_ROOT, 'services/speaker-diarization/requirements-dev.txt'), 'utf8');
    expect(requirements).not.toMatch(/^fastapi==/m);
    expect(requirements).toMatch(/^starlette==1\.3\.1$/m);
    expect(devRequirements).toMatch(/^pytest==9\.0\.3$/m);
  });

  it('installs the complete production graph from hashes only', () => {
    const lock = readFileSync(resolve(REPO_ROOT, 'services/speaker-diarization/requirements.lock'), 'utf8');
    const dockerfile = readFileSync(resolve(REPO_ROOT, 'services/speaker-diarization/Dockerfile'), 'utf8');
    const pins = lock.match(/^[a-z0-9][a-z0-9._-]*==[^\s\\]+/gim) ?? [];
    const hashes = lock.match(/--hash=sha256:[a-f0-9]{64}/g) ?? [];
    expect(pins.length).toBeGreaterThan(10);
    expect(hashes.length).toBeGreaterThanOrEqual(pins.length);
    expect(lock).not.toMatch(/^\s*--trusted-host\b/m);
    expect(lock).not.toMatch(/^\s*-[^-r]\b/m);
    expect(dockerfile).toContain('COPY requirements.lock ./');
    expect(dockerfile).toContain('pip install --no-cache-dir --require-hashes --requirement requirements.lock');
    expect(dockerfile).not.toContain('pip install --no-cache-dir --requirement requirements.txt');
  });
});
