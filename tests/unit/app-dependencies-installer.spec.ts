/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Dependency tiers through the real installer: a real local Git store and the real scripts/oshal-app.js child install REQUIRED apps fail-closed, OPTIONAL apps only when named (--with) or all (--with-optional), refuse a --with name that is not optional and a selected optional app that cannot install (landing nothing), validate/init speak the tiered form, and uninstall blocks only on a REQUIRED dependent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../fixtures/multi-store';

let root: string;
let repo: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'oshal-deps-cli-'));
  repo = createStore(join(root, 'store'), [
    { name: 'scanner', deps: ['engine'], optional: ['cad-kit', 'slicer'] },
    { name: 'engine', deps: [] },
    { name: 'cad-kit', deps: [] },
    { name: 'slicer', deps: [], tiered: true },
    { name: 'wishful', deps: [], optional: ['not-published'] },
  ]).repo;
}, 30000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string[]) {
  return spawnSync(process.execPath, [resolve('scripts/oshal-app.js'), ...args], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, OSHAL_PACKAGE_AUDIT_MODE: 'compatible' },
  });
}
const install = (dest: string, name: string, extra: string[] = []) => cli(['install', name, '--repo', repo, '--dest', dest, ...extra]);
const installed = (dest: string, name: string) => existsSync(join(dest, name, 'oshal-app.yaml'));
const recorded = (dest: string, name: string) => JSON.parse(readFileSync(join(dest, name, '.oshal-install.json'), 'utf8')).dependencies;

describe('install resolves the two tiers', () => {
  it('installs REQUIRED apps and leaves OPTIONAL ones unless asked, recording both tiers', () => {
    const dest = join(root, 'default');
    const result = install(dest, 'scanner');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(installed(dest, 'engine')).toBe(true);
    expect(installed(dest, 'cad-kit') || installed(dest, 'slicer')).toBe(false);
    expect(recorded(dest, 'scanner')).toEqual({
      required: { engine: 'installed-from-store' },
      optional: { 'cad-kit': 'not-selected', slicer: 'not-selected' },
    });
    expect(result.stdout).toContain('optional, not installed: cad-kit, slicer');
  }, 60000);

  it('installs exactly the optional apps named with --with', () => {
    const dest = join(root, 'with');
    const result = install(dest, 'scanner', ['--with', 'slicer']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(installed(dest, 'slicer')).toBe(true);
    expect(installed(dest, 'cad-kit')).toBe(false);
    expect(recorded(dest, 'scanner').optional).toEqual({ 'cad-kit': 'not-selected', slicer: 'installed-from-store' });
  }, 60000);

  it('installs every optional app with --with-optional and records one already present as installed', () => {
    const dest = join(root, 'all');
    expect(install(dest, 'cad-kit').status).toBe(0);
    const result = install(dest, 'scanner', ['--with-optional']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded(dest, 'scanner').optional).toEqual({ 'cad-kit': 'installed', slicer: 'installed-from-store' });
  }, 60000);

  it('refuses a --with name that is not an optional dependency, landing nothing', () => {
    const dest = join(root, 'not-optional');
    const result = install(dest, 'scanner', ['--with', 'engine']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--with names engine — not an optional dependency of "scanner"/);
    expect(installed(dest, 'scanner')).toBe(false);
  }, 60000);

  it('never blocks on an unselected optional app, but fails closed when a SELECTED one cannot install', () => {
    const quiet = join(root, 'wishful-default');
    expect(install(quiet, 'wishful').status).toBe(0);
    expect(recorded(quiet, 'wishful').optional).toEqual({ 'not-published': 'not-selected' });
    const asked = join(root, 'wishful-selected');
    const result = install(asked, 'wishful', ['--with', 'not-published']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/selected optional dependency "not-published" could not be installed/);
    expect(installed(asked, 'wishful')).toBe(false);
  }, 60000);
});

describe('validate and init speak the tiered form', () => {
  it('refuses a tiered manifest without its floor, and the scaffold validates clean', () => {
    const dir = join(root, 'no-floor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'oshal-app.yaml'), 'name: no-floor\ndisplayName: X\nsuite: ai-engineering\nversion: 1.0.0\ndependencies:\n  optional:\n    apps: [cad-kit]\n');
    const refused = cli(['validate', dir]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/needs uses: \[app-dependencies\]/);
    expect(cli(['init', 'fresh-app', '--dir', root]).status).toBe(0);
    const scaffold = readFileSync(join(root, 'fresh-app', 'oshal-app.yaml'), 'utf8');
    expect(scaffold).toMatch(/uses: \[app-dependencies\]/);
    expect(scaffold).toMatch(/dependencies:\n {2}required:\n {4}apps: \[\]/);
    const clean = cli(['validate', join(root, 'fresh-app')]);
    expect(clean.status, clean.stdout).toBe(0);
  });
});

describe('uninstall blocks only on a REQUIRED dependent', () => {
  it('removes an app another lists as optional (reporting it), and blocks one another requires', () => {
    const dest = join(root, 'uninstall');
    expect(install(dest, 'scanner', ['--with', 'cad-kit']).status).toBe(0);
    const optional = cli(['uninstall', 'cad-kit', '--dest', dest, '--yes']);
    expect(optional.status, optional.stdout + optional.stderr).toBe(0);
    expect(optional.stdout).toMatch(/optional dependents \(lose that integration, never block\): .*scanner/);
    expect(installed(dest, 'cad-kit')).toBe(false);
    const required = cli(['uninstall', 'engine', '--dest', dest, '--yes']);
    expect(required.status).toBe(1);
    expect(required.stderr).toMatch(/blocked: scanner depend\(s\) on engine/);
    expect(installed(dest, 'engine')).toBe(true);
  }, 60000);
});
