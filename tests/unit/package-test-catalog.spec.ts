/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Validate real package files through the shared contract, runtime loader and CLI.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { loadPackageTestCatalog, validatePackageTestCatalog } from '@/shared/package-testing';
import { readManifest } from '@/features/swarm-apps';
import { packageManifest, packageTestCase, writeTestPackage } from '../fixtures/package-testing';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'oshal-test-catalog-contract-')); });
afterEach(() => {
  if (!relative(resolve(tmpdir()), resolve(root)).startsWith('oshal-test-catalog-contract-')) throw new Error('Unsafe fixture cleanup');
  rmSync(root, { recursive: true, force: true });
});
it('uses the same contract in actual CLI and runtime loading and requires the capability floor', () => {
  const fixture = writeTestPackage(root);
  expect(readManifest(fixture.file).testing?.version).toBe(1);
  const valid = spawnSync(process.execPath, ['scripts/oshal-app.js', 'validate', fixture.dir], { cwd: process.cwd(), encoding: 'utf8' });
  expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  fixture.manifest.uses = [];
  writeFileSync(fixture.file, yaml.dump(fixture.manifest));
  expect(() => readManifest(fixture.file)).toThrow('uses: [test-catalog]');
  const rejected = spawnSync(process.execPath, ['scripts/oshal-app.js', 'validate', fixture.dir], { cwd: process.cwd(), encoding: 'utf8' });
  expect(rejected.status).not.toBe(0); expect(rejected.stdout + rejected.stderr).toContain('uses: [test-catalog]');
});

it('rejects unsupported versions, duplicate IDs, arbitrary commands and unsafe installation claims', () => {
  const manifest = packageManifest(), test = packageTestCase();
  for (const cases of [[test, test], [{ ...test, runner: { ...test.runner, command: 'echo untrusted' } }],
    [{ ...test, expected: [] }], [{ ...test, installation: 'safe-smoke' }], [{ ...test, isolation: { mode: 'none' } }],
    [{ ...test, limits: { timeoutMs: 99999999 } }]]) {
    expect(() => validatePackageTestCatalog({ version: 1, cases }, manifest)).toThrow(/catalog-fixture testing\./);
  }
  expect(() => validatePackageTestCatalog({ version: 2, cases: [test] }, manifest)).toThrow('version');
  const fixture = writeTestPackage(root);
  expect(() => loadPackageTestCatalog(fixture.dir, { ...manifest, testing: { version: 2, catalog: 'tests/test-lab.yaml' } })).toThrow('version');
});

it('rejects missing, escaping and symlinked suite, catalog and fixture paths', () => {
  const fixture = writeTestPackage(root);
  for (const file of ['tests/missing.spec.ts', '../outside.spec.ts', '/tmp/spec.ts', 'C:/outside.spec.ts', 'tests/../behavior.spec.ts']) {
    writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases: [packageTestCase({ runner: { kind: 'vitest', scope: 'package', files: [file] } })] }));
    expect(() => loadPackageTestCatalog(fixture.dir, fixture.manifest)).toThrow(/testing\./);
  }
  expect(() => loadPackageTestCatalog(fixture.dir, { ...fixture.manifest, testing: { version: 1, catalog: '../outside.yaml' } })).toThrow('relative');
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'input.json'), '{}');
  symlinkSync(outside, join(fixture.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases: [packageTestCase({ isolation: { mode: 'disposable', fixtures: ['linked/input.json'], cleanup: 'Remove fixture.' } })] }));
  expect(() => loadPackageTestCatalog(fixture.dir, fixture.manifest)).toThrow('symlinks');
});

it('decorates legacy smokes once and requires exact smoke identity and honest side effects', () => {
  const manifest = packageManifest();
  const smoke = packageTestCase({ id: 'ready', level: 'integration', runner: { kind: 'smoke', smoke: 'ready' },
    prerequisites: [], sideEffects: 'none', isolation: { mode: 'none' }, installation: 'safe-smoke' });
  expect(validatePackageTestCatalog({ version: 1, cases: [smoke] }, manifest).cases).toHaveLength(1);
  expect(() => validatePackageTestCatalog({ version: 1, cases: [{ ...smoke, id: 'alias' }] }, manifest)).toThrow('original smoke ID');
  expect(() => validatePackageTestCatalog({ version: 1, cases: [packageTestCase({ id: 'ready' })] }, manifest)).toThrow('collides');
  manifest.smoke![0].method = 'POST';
  expect(() => validatePackageTestCatalog({ version: 1, cases: [smoke] }, manifest)).toThrow('installation');
});

it('binds revisions to referenced suite bytes and accepts pinned core references without a sibling checkout', () => {
  const fixture = writeTestPackage(root);
  const before = loadPackageTestCatalog(fixture.dir, fixture.manifest)!;
  writeFileSync(join(fixture.dir, 'tests/behavior.spec.ts'), 'throw new Error("changed assertions");');
  const after = loadPackageTestCatalog(fixture.dir, fixture.manifest)!;
  expect(after.revisions.behavior).not.toBe(before.revisions.behavior);
  const core = packageTestCase({ runner: { kind: 'playwright', scope: 'core', revision: 'a'.repeat(40), files: ['tests/not-shipped-on-controller.spec.ts'] } });
  writeFileSync(join(fixture.dir, 'tests/test-lab.yaml'), yaml.dump({ version: 1, cases: [core] }));
  expect(loadPackageTestCatalog(fixture.dir, fixture.manifest)!.catalog.cases[0].runner).toEqual(core.runner);
  expect(() => validatePackageTestCatalog({ version: 1, cases: [{ ...core, runner: { ...core.runner, revision: 'main' } }] }, fixture.manifest)).toThrow('exact 40');
  expect(loadPackageTestCatalog(fixture.dir, { name: 'old-package' })).toBeNull();
});
