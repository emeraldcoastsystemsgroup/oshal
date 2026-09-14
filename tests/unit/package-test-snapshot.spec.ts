/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise source growth races and bounded snapshot reads with real temporary files.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Seal packaged route sources and tool surfaces while excluding their runtime and credential files.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Prove Playwright recipe admission follows verified browser capabilities and the harness check.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | A package's catalog/ data is staged into the sealed snapshot and changes its revision; credentials, runtime output and directories outside the allowlist stay out.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | personas/ is staged alongside catalog/: a manifest loaded through the framework loader reads the persona files it names.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const race = vi.hoisted(() => ({ phase: '', file: '', largestRead: 0 }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: (...args: Parameters<typeof fs.openSync>) => {
    const fd = fs.openSync(...args);
    if (race.phase === 'open') { race.phase = ''; fs.appendFileSync(race.file, Buffer.alloc(5 * 1024 * 1024)); }
    return fd;
  }, readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
    race.largestRead = Math.max(race.largestRead, buffer.length);
    if (race.phase === 'read') { race.phase = ''; fs.appendFileSync(race.file, Buffer.alloc(5 * 1024 * 1024)); }
    return fs.readSync(fd, buffer, offset, length, position);
  } };
});
import { hasNodeTestHarness, RUNNER_OUT_OF_SCOPE, snapshotPackageTests, packageTestRecipePending } from '@/features/swarm-apps/services/package-test-snapshot';
import { inventoryPackageTests } from '@/features/swarm-apps/services/package-test-inventory';
import { mkdirSync } from 'node:fs';
import { packageTestCase } from '../fixtures/package-testing';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); race.phase = ''; });

it('keeps unsupported Node source languages visibly pending before execution', () => {
  const declaration = packageTestCase({ runner: { kind: 'node-test', scope: 'package', files: ['tests/invoice.test.ts'] } });
  expect(packageTestRecipePending(declaration)).toContain('JavaScript suite files');
});

it.each(['open', 'read'])('refuses source growth during %s without allocating the grown file', phase => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-source-race-')); roots.push(root);
  race.file = path.join(root, 'routes.js'); race.largestRead = 0;
  writeFileSync(race.file, 'module.exports = {};'); race.phase = phase;
  expect(() => snapshotPackageTests(root)).toThrow('Package source changed while reading.');
  expect(race.largestRead).toBeLessThanOrEqual(21);
});

it('seals unchanged source bytes without including the installer stamp in child input', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-source-stable-')); roots.push(root);
  writeFileSync(path.join(root, 'routes.js'), 'module.exports = {};');
  writeFileSync(path.join(root, '.oshal-install.json'), JSON.stringify({ sha: 'a'.repeat(40) }));
  const result = snapshotPackageTests(root);
  expect(result.sourceCommit).toBe('a'.repeat(40));
  expect(result.files.map(file => file.path)).toEqual(['routes.js']);
  expect(result.files[0].content.toString()).toBe('module.exports = {};');
  expect(snapshotPackageTests(root).revision).toBe(result.revision);
});

it('detects a newly shipped unregistered suite while ignoring helper files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-inventory-')); roots.push(root);
  mkdirSync(path.join(root, 'tests'));
  for (const name of ['known.test.js', 'fixture.js', 'new.spec.ts']) writeFileSync(path.join(root, 'tests', name), '');
  expect(inventoryPackageTests('fixture', root, new Set(['tests/known.test.js']))).toEqual({
    appName: 'fixture', missingRegistrations: ['tests/new.spec.ts'],
  });
  expect(inventoryPackageTests('fixture', root, new Set(['tests/known.test.js', 'tests/new.spec.ts'])).missingRegistrations).toEqual([]);
});

it('includes packaged tool and route sources in revisions without admitting their runtime data', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-package-layout-')); roots.push(root);
  const included = ['src-routes/identity.ts', 'tools/studio/index.html', 'tools/studio/editor.js'];
  const excluded = ['tools/output/result.html', 'tools/data/customer.json', 'tools/credentials.json',
    'src-routes/.env', 'src-routes/tokens.json', 'src-routes/uploads/document.md'];
  for (const name of [...included, ...excluded]) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), 'original');
  }
  const first = snapshotPackageTests(root);
  expect(first.files.map(file => file.path).sort()).toEqual(included.sort());
  for (const name of excluded) writeFileSync(path.join(root, name), 'changed');
  expect(snapshotPackageTests(root).revision).toBe(first.revision);
  for (const name of included) {
    writeFileSync(path.join(root, name), 'changed');
    expect(snapshotPackageTests(root).revision).not.toBe(first.revision);
    writeFileSync(path.join(root, name), 'original');
  }
});

it('stages the catalog/ data and personas/ that package code reads at runtime, and still nothing outside the allowlist', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lab-package-catalog-')); roots.push(root);
  const included = ['catalog/servos.json', 'catalog/drivers.json', 'routes/driver-catalog.js', 'personas/director.yaml'];
  const excluded = ['catalog/credentials.json', 'catalog/output/run.json', 'catalog/data/customer.json',
    'docs/ARCHITECTURE.md', 'firmware/controller.ino'];
  for (const name of [...included, ...excluded]) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), '{}');
  }
  const first = snapshotPackageTests(root);
  expect(first.files.map(file => file.path).sort()).toEqual(included.sort());
  writeFileSync(path.join(root, 'catalog/servos.json'), '{"changed":true}');
  expect(snapshotPackageTests(root).revision).not.toBe(first.revision);
});

it('admits a Node-harness Playwright recipe only once the browser prerequisites are verified, and nothing else', () => {
  const recipe = packageTestCase({ level: 'browser', runner: { kind: 'playwright', scope: 'package', files: ['tests/browser/proof.mjs'] },
    prerequisites: ['runner:playwright', 'browser:chromium', 'core:shared-theme-assets'], sideEffects: 'none' });
  expect(packageTestRecipePending(recipe)).toBe('The playwright runner is unavailable.');
  const chromium = new Set(['runner:playwright', 'browser:chromium']);
  expect(packageTestRecipePending(recipe, chromium)).toBe('Additional prerequisites require verification: core:shared-theme-assets.');
  const verified = new Set([...chromium, 'core:shared-theme-assets']);
  expect(packageTestRecipePending(recipe, verified)).toBeUndefined();
  expect(packageTestRecipePending({ ...recipe, level: 'unit' }, verified)).toContain('own verified runner');
  expect(packageTestRecipePending({ ...recipe, sideEffects: 'external-write' }, verified)).toContain('External effects');
  expect(packageTestRecipePending({ ...recipe, runner: { ...recipe.runner, files: ['tests/browser/proof.ts'] } }, verified)).toContain('JavaScript suite files');
  expect(packageTestRecipePending({ ...recipe, runner: { kind: 'vitest', scope: 'package', files: ['tests/a.spec.ts'] } }, verified)).toBe('The vitest runner is unavailable.');
  expect(packageTestRecipePending({ ...recipe, runner: { kind: 'external', scope: 'package', files: ['tests/a.mjs'] } }, verified)).toBe(RUNNER_OUT_OF_SCOPE.external);
  const node = packageTestCase({ runner: { kind: 'node-test', scope: 'package', files: ['tests/a.test.cjs'] }, prerequisites: ['runner:node-test'] });
  expect(packageTestRecipePending(node)).toBeUndefined();
  expect(packageTestRecipePending({ ...node, prerequisites: ['runner:node-test', 'core:dependencies'] })).toContain('core:dependencies');
  expect(packageTestRecipePending({ ...node, prerequisites: ['runner:node-test', 'core:dependencies'] }, new Set(['core:dependencies']))).toBeUndefined();
});

it('recognizes the Node test harness a browser recipe must carry', () => {
  expect(hasNodeTestHarness(Buffer.from("import { test, before } from 'node:test';\n"))).toBe(true);
  expect(hasNodeTestHarness(Buffer.from("const { test } = require('node:test');\n"))).toBe(true);
  expect(hasNodeTestHarness(Buffer.from("import { chromium } from 'playwright';\nconsole.log('bare script');\n"))).toBe(false);
});
