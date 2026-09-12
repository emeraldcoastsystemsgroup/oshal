/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise actual package Node execution, immutable source selection and lifecycle authority through the real Docker sandbox.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Prove runtime-data exclusion in the child and bounded refusal when current authority never resolves.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Execute packaged surface and route-source assertions without forwarding nested runtime data.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Give the real packaged-surface Docker fixture the same outer test budget as neighboring isolated execution cases.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { InstalledAppTestCatalog } from '@/features/swarm-apps/services/installed-app-test-catalog';
import { createPackageExecutionFixture, ObservedPackageTestSandbox, PACKAGE_TEST_IMAGE,
  type PackageExecutionFixtureOptions } from '../fixtures/package-test-execution';
import { executePackageTest } from '@/features/swarm-apps/services/package-test-execution';
import type { PackageTestSandbox } from '@/features/swarm-apps/services/package-test-sandbox';

let root: string, sandbox: ObservedPackageTestSandbox, catalog: InstalledAppTestCatalog;

it('distinguishes an unavailable execution process from failing package assertions', async () => {
  const unavailable = { run: async () => ({ exitCode: null, output: '', image: '', timedOut: false,
    cancelled: false, cleanupVerified: true }) } as PackageTestSandbox;
  const snapshot = { revision: 'fixture', files: [] };
  const result = await executePackageTest({ name: 'Fixture', path: 'tests/fixture.test.js', suiteFiles: [], timeoutMs: 1000,
    snapshot, snapshotNow: () => snapshot, current: async () => true, sandbox: unavailable });
  expect(result).toMatchObject({ status: 'pending', cleanupVerified: true, error: 'The isolated runner is unavailable.' });
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oshal-package-execution-'));
  sandbox = new ObservedPackageTestSandbox();
  catalog = new InstalledAppTestCatalog({ sandbox, runnerImage: PACKAGE_TEST_IMAGE });
});
afterEach(() => {
  const child = relative(resolve(tmpdir()), resolve(root));
  if (!child.startsWith('oshal-package-execution-') || child.includes('..')) throw new Error('Unsafe fixture cleanup');
  rmSync(root, { recursive: true, force: true });
});

/** @description Register a real inert package and select its current exact executable case.
 * @param options Focused source variants.
 * @returns Registered fixture and selection, with no executed package code. */
function registered(options: PackageExecutionFixtureOptions = {}) {
  const fixture = createPackageExecutionFixture(root, options);
  catalog.register(fixture.record);
  const visible = new Map([[fixture.record.name, fixture.record.displayName]]);
  const selected = catalog.list(visible, { canRunSuites: true }).find(test => test.id === fixture.caseId)!;
  expect(selected).toBeDefined(); return { ...fixture, visible, selected };
}

/** @description Supply only trusted fixture authority to the same catalog run path used by HTTP.
 * @returns A current authorization callback and inert smoke base, unused by Node suites. */
function executionOptions() { return { apiBaseUrl: 'http://127.0.0.1:1', canRunSuites: true, revalidate: async () => true }; }

it('runs actual packaged surface and route-source assertions in the isolated child', async () => {
  const f = createPackageExecutionFixture(root);
  const inputs = { 'tools/editor.html': '<main>Editor</main>', 'src-routes/editor.ts': 'export const title = "Editor";',
    'tools/data/customer.json': 'PRIVATE_FIXTURE', 'src-routes/credentials.json': 'PRIVATE_FIXTURE' };
  for (const [name, content] of Object.entries(inputs)) {
    mkdirSync(dirname(join(f.dir, name)), { recursive: true }); writeFileSync(join(f.dir, name), content);
  }
  writeFileSync(f.suitePath, `const { test } = require('node:test');
const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('packaged editor contract and runtime exclusion', () => {
  assert.match(fs.readFileSync(path.join(root, 'tools/editor.html'), 'utf8'), /<main>Editor<\\/main>/);
  assert.match(fs.readFileSync(path.join(root, 'src-routes/editor.ts'), 'utf8'), /export const title/);
  for (const name of ['tools/data/customer.json', 'src-routes/credentials.json']) {
    assert.equal(fs.existsSync(path.join(root, name)), false);
  }
});`);
  catalog.register(f.record);
  const visible = new Map([[f.record.name, f.record.displayName]]);
  const selected = catalog.list(visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  const result = await catalog.run(selected, visible, executionOptions());
  expect(result.status, result.output).toBe('passed'); expect(result.output).toContain('# pass 1');
  expect(sandbox.last?.cleanupVerified).toBe(true);
}, 60000);

/** @description Seed synthetic business files which must never enter an executable source snapshot.
 * @param dir Disposable package directory.
 * @returns Package-relative paths used by real child filesystem assertions. */
function excludedRuntimeFiles(dir: string): string[] {
  const paths = ['data/captures.sqlite', 'docs/out/customer-proposal.md', 'workspace/uploads/contract.json',
    'uploads/account.json', '.env', 'credentials.json', 'lib/credentials.json', 'lib/data/runtime.json', 'tests/private.sqlite'];
  for (const name of paths) {
    const file = join(dir, name); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'EXCLUDED_FIXTURE_BUSINESS_DATA');
  }
  return paths;
}

it('registers without executing and then runs two actual package business assertions', async () => {
  const f = registered(); expect(sandbox.calls).toBe(0);
  expect(f.selected.runnable).toBe(true); expect(f.selected.executionRevision).toMatch(/^[a-f0-9]{64}$/);
  const result = await catalog.run(f.selected, f.visible, executionOptions());
  expect(result.status).toBe('passed'); expect(sandbox.calls).toBe(1);
  expect(sandbox.last).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, cleanupVerified: true });
  expect(sandbox.last?.output).toContain('whole-item totals preserve integer minor currency units');
}, 60000);

it('reports a genuinely broken package assertion as failed rather than unavailable or passed', async () => {
  const f = registered({ broken: true });
  const result = await catalog.run(f.selected, f.visible, executionOptions());
  expect(result.status).toBe('failed'); expect(sandbox.last?.exitCode).not.toBe(0);
  expect(sandbox.last?.output).toContain('AssertionError'); expect(sandbox.last?.cleanupVerified).toBe(true);
}, 60000);

it('reports an enforced process deadline as failed and verifies container cleanup', async () => {
  const f = registered({ delayMs: 10000 });
  const result = await catalog.run(f.selected, f.visible, { ...executionOptions(), timeoutMs: 500 });
  expect(result).toMatchObject({ status: 'failed', timedOut: true, cleanupVerified: true });
  expect(sandbox.last).toMatchObject({ timedOut: true, cleanupVerified: true });
}, 60000);

it('requires suite authority and a successful fresh callback before calling the sandbox', async () => {
  const f = registered();
  for (const options of [{ ...executionOptions(), canRunSuites: false }, { ...executionOptions(), revalidate: undefined },
    { ...executionOptions(), revalidate: async () => false }, { ...executionOptions(), revalidate: async () => { throw new Error('Fixture access revoked'); } }]) {
    expect((await catalog.run(f.selected, f.visible, options)).status).toBe('pending');
  }
  expect(sandbox.calls).toBe(0);
}, 30000);

it('keeps unresolved fixture dependencies pending without executing a package', async () => {
  const f = registered({ prerequisites: ['runner:node-test', 'fixture:docker-postgres16'] });
  expect(f.selected.runnable).toBe(false); expect(f.selected.pendingReason).toContain('fixture:docker-postgres16');
  expect((await catalog.run(f.selected, f.visible, executionOptions())).status).toBe('pending'); expect(sandbox.calls).toBe(0);
}, 30000);

it('omits runtime data from the real child while retaining immutable executable source', async () => {
  const f = registered(), paths = excludedRuntimeFiles(f.dir);
  writeFileSync(f.suitePath, readFileSync(f.suitePath, 'utf8') + `
test('installed business files are not test source', () => {
  const fs = require('node:fs');
  for (const file of ${JSON.stringify(paths)}) assert.throws(() => fs.readFileSync(file), { code: 'ENOENT' });
});\n`);
  catalog.register(f.record);
  const selected = catalog.list(f.visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  const result = await catalog.run(selected, f.visible, executionOptions());
  expect(result).toMatchObject({ status: 'passed', cleanupVerified: true });
  expect(result.output).toContain('installed business files are not test source');
  expect(result.output).not.toContain('EXCLUDED_FIXTURE_BUSINESS_DATA');
  for (const name of paths) writeFileSync(join(f.dir, name), 'CHANGED_EXCLUDED_FIXTURE_DATA');
  catalog.register(f.record);
  const afterData = catalog.list(f.visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  expect(afterData.executionRevision).toBe(selected.executionRevision); expect(afterData.revision).toBe(selected.revision);
  writeFileSync(f.helperPath, 'exports.lineTotal = () => 0;\n'); catalog.register(f.record);
  const afterCode = catalog.list(f.visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  expect(afterCode.executionRevision).not.toBe(selected.executionRevision);
}, 60000);

it('bounds a never-resolving initial authority read and refuses before starting Docker', async () => {
  const f = registered(), started = Date.now();
  const result = await catalog.run(f.selected, f.visible, { ...executionOptions(), revalidate: () => new Promise<boolean>(() => {}) });
  expect(result.status).toBe('pending'); expect(result.output).toBeUndefined(); expect(sandbox.calls).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(4500); expect(Date.now() - started).toBeLessThan(12000);
}, 15000);

it('withholds real completed output when a later authority read never resolves', async () => {
  const f = registered(), started = Date.now(); let checks = 0;
  const result = await catalog.run(f.selected, f.visible, { ...executionOptions(),
    revalidate: () => ++checks === 1 ? Promise.resolve(true) : new Promise<boolean>(() => {}) });
  expect(checks).toBeGreaterThanOrEqual(2); expect(sandbox.calls).toBe(1);
  expect(sandbox.last).toMatchObject({ exitCode: 0, cleanupVerified: true });
  expect(result.status).toBe('pending'); expect(result.output).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(12000);
}, 15000);

it('refuses a changed imported implementation even when the declared suite bytes are unchanged', async () => {
  const f = registered(), before = readFileSync(f.suitePath, 'utf8');
  writeFileSync(f.helperPath, "exports.lineTotal = () => 0;\n");
  expect(readFileSync(f.suitePath, 'utf8')).toBe(before);
  expect((await catalog.run(f.selected, f.visible, executionOptions())).status).toBe('pending'); expect(sandbox.calls).toBe(0);
  catalog.register(f.record);
  const current = catalog.list(f.visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  expect(current.executionRevision).not.toBe(f.selected.executionRevision); expect(current.revision).not.toBe(f.selected.revision);
}, 30000);

it('refuses changed installer provenance and changed selected test bytes before execution', async () => {
  const f = registered();
  writeFileSync(join(f.dir, '.oshal-install.json'), JSON.stringify({ repo: 'https://example.invalid/reviewed-package', sha: 'a'.repeat(40) }));
  expect((await catalog.run(f.selected, f.visible, executionOptions())).status).toBe('pending');
  catalog.register(f.record);
  const current = catalog.list(f.visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  expect(current.sourceCommit).toBe('a'.repeat(40));
  writeFileSync(f.suitePath, readFileSync(f.suitePath, 'utf8') + '\nthrow new Error("Changed test");\n');
  expect((await catalog.run(current, f.visible, executionOptions())).status).toBe('pending'); expect(sandbox.calls).toBe(0);
}, 30000);

it('withholds results when an imported helper changes while the real sandbox is in flight', async () => {
  const f = registered({ delayMs: 3000 });
  const running = catalog.run(f.selected, f.visible, executionOptions());
  await sandbox.requested; writeFileSync(f.helperPath, 'exports.lineTotal = () => 0;\n');
  expect((await running).status).toBe('pending'); expect(sandbox.calls).toBe(1);
  expect(sandbox.last?.cleanupVerified).toBe(true);
}, 60000);

it('revoked current authority aborts an in-flight suite and cannot publish a pass', async () => {
  const f = registered({ delayMs: 10000 }); let allowed = true;
  const running = catalog.run(f.selected, f.visible, { ...executionOptions(), revalidate: async () => allowed });
  await sandbox.requested; allowed = false;
  expect((await running).status).toBe('pending');
  expect(sandbox.last).toMatchObject({ cancelled: true, cleanupVerified: true });
}, 60000);

it('retiring and replacing an activation invalidates an in-flight old case', async () => {
  const f = registered({ delayMs: 10000 });
  const running = catalog.run(f.selected, f.visible, executionOptions());
  await sandbox.requested; catalog.unregister(f.record.name);
  f.record.version = '2.0.0'; f.manifest.version = '2.0.0'; writeFileSync(f.file, yaml.dump(f.manifest)); catalog.register(f.record);
  expect((await running).status).toBe('pending');
  const replacement = catalog.list(f.visible, { canRunSuites: true }).find(test => test.id === f.caseId)!;
  expect(replacement.appVersion).toBe('2.0.0'); expect(replacement.revision).not.toBe(f.selected.revision);
  expect(sandbox.last).toMatchObject({ cancelled: true, cleanupVerified: true });
}, 60000);

it('propagates caller cancellation to the actual container and never reports a cancelled run as passed', async () => {
  const f = registered({ delayMs: 10000 }), abort = new AbortController();
  const running = catalog.run(f.selected, f.visible, { ...executionOptions(), signal: abort.signal });
  await sandbox.requested; abort.abort();
  expect((await running).status).toBe('pending');
  expect(sandbox.last).toMatchObject({ cancelled: true, cleanupVerified: true });
}, 60000);
