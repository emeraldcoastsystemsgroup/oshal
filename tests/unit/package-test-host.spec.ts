/**
 * CHANGE LOG
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Verify catalog-driven bulk selection, runner boundaries, serial execution and honest TAP results.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Exercise real disposable timeout/cancellation, owned descendant cleanup, listener release and bounded termination failures.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, nodeHarness, plan, childEnvironment, verdict, execute, runBatch } from '../../scripts/run-package-tests.mjs';
import { runOwnedTestProcess, stopOwnedChild } from '../../scripts/owned-test-process.mjs';

const roots: string[] = [];
const available = new Set(['runner:node-test', 'runner:playwright', 'browser:chromium']);
function fixture(cases?: any[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-package-batch-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'oshal-app.yaml'), JSON.stringify({ name: 'fixture', version: '1.0.0', uses: ['test-catalog'], testing: { version: 1, catalog: 'tests/catalog.yaml' } }));
  fs.writeFileSync(path.join(root, 'tests/proof.mjs'), "import { test } from 'node:test';import assert from 'node:assert/strict';test('actual assertion',()=>assert.equal(2+2,4));\n");
  const base = { id: 'unit', name: 'Real fixture', purpose: 'Exercise the test runner.', level: 'unit', runner: { kind: 'node-test', scope: 'package', files: ['tests/proof.mjs'] }, expected: ['The actual assertion passes.'], prerequisites: ['runner:node-test'], sideEffects: 'none', isolation: { mode: 'disposable', cleanup: 'Memory-only synthetic fixture.' }, limits: { timeoutMs: 15000 }, installation: 'never' };
  fs.writeFileSync(path.join(root, 'tests/catalog.yaml'), JSON.stringify({ version: 1, cases: cases?.map(item => ({ ...base, ...item })) || [base] }));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('oshal-package-batch-')) throw Error('Fixture cleanup boundary changed.');
    fs.rmSync(resolved, { recursive: true });
  }
});

/** Only synthetic children created by these tests are ever targets of the process helper. */
function waitingChild(root: string) {
  const marker = path.join(root, 'owned-child.json');
  const source = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,descendant:child.pid}));
process.on('SIGTERM',()=>{});console.log('owned-ready');setInterval(()=>{},1000);`;
  return { marker, args: ['-e', source] };
}
async function waitForMarker(marker: string) {
  const deadline = Date.now() + 4000;
  while (!fs.existsSync(marker)) {
    if (Date.now() >= deadline) throw Error('Disposable child did not become ready.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return JSON.parse(fs.readFileSync(marker, 'utf8'));
}
function absent(pid: number) {
  try { process.kill(pid, 0); return false; } catch (error: any) { return error.code === 'ESRCH'; }
}

describe('owned package test process lifecycle', () => {
  it('times out an actual disposable child tree and proves both process IDs exited', async () => {
    const root = fixture(), child = waitingChild(root);
    const result = await runOwnedTestProcess(process.execPath, child.args,
      { cwd: root, env: childEnvironment(root), timeoutMs: 1500, cleanup: { graceMs: 50, timeoutMs: 2000 } });
    const ids = await waitForMarker(child.marker);
    expect(result.timedOut).toBe(true); expect(result.cancelled).toBe(false);
    expect(result.output).toContain('owned-ready'); expect(result.cleanup.exitVerified).toBe(true);
    expect(result.cleanup.treeTerminationVerified).toBe(true); expect(result.cleanup.error).toBeNull();
    expect(absent(ids.pid)).toBe(true); expect(absent(ids.descendant)).toBe(true);
  }, 10000);
  it('cancels a running disposable child tree after readiness without claiming a timeout', async () => {
    const root = fixture(), child = waitingChild(root), controller = new AbortController();
    const work = runOwnedTestProcess(process.execPath, child.args,
      { cwd: root, env: childEnvironment(root), signal: controller.signal, timeoutMs: 10000, cleanup: { graceMs: 50, timeoutMs: 2000 } });
    const ids = await waitForMarker(child.marker); controller.abort(); const result = await work;
    expect(result.cancelled).toBe(true); expect(result.timedOut).toBe(false);
    expect(result.cleanup.exitVerified).toBe(true); expect(absent(ids.pid)).toBe(true); expect(absent(ids.descendant)).toBe(true);
  }, 10000);
  it('never starts a process when cancellation already happened', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runOwnedTestProcess('nonexistent-disposable-executable', [], { signal: controller.signal, timeoutMs: 10 });
    expect(result.cancelled).toBe(true); expect(result.cleanup).toBeNull();
  });
  it('records failed Windows tree termination and bounds a stalled termination port', async () => {
    const child = { pid: 12345, exitCode: null, signalCode: null }, never = new Promise(() => {});
    const failed = await stopOwnedChild(child, never, { platform: 'win32', timeoutMs: 10, killTree: async () => 'taskkill failed: 5' });
    expect(failed.exitVerified).toBe(false); expect(failed.error).toContain('taskkill failed: 5');
    const stalled = await stopOwnedChild(child, never, { platform: 'win32', timeoutMs: 10, killTree: () => never });
    expect(stalled.exitVerified).toBe(false); expect(stalled.error).toContain('timed out');
  });
  it('does not signal an absent or already-exited Windows child and requires post-kill exit evidence', async () => {
    let calls = 0; const killTree = async () => { calls++; return null; };
    const noPid = await stopOwnedChild({ pid: undefined }, Promise.resolve({ code: 0 }), { platform: 'win32', killTree });
    const exited = await stopOwnedChild({ pid: 12345, exitCode: 0, signalCode: null }, Promise.resolve({ code: 0 }), { platform: 'win32', killTree });
    expect(noPid.exitVerified).toBe(false); expect(exited.exitVerified).toBe(false); expect(calls).toBe(0);
    const missing = await stopOwnedChild({ pid: 12345, exitCode: null, signalCode: null }, new Promise(() => {}), { platform: 'win32', timeoutMs: 10, killTree });
    expect(missing.exitVerified).toBe(false); expect(missing.treeTerminationVerified).toBe(true);
  });
  it('uses only the owned POSIX group and requires its disappearance after forced escalation', async () => {
    const events: string[] = []; let exists = true;
    const result = await stopOwnedChild({ pid: 12345 }, Promise.resolve({ code: null, signal: 'SIGKILL' }), {
      platform: 'linux', timeoutMs: 10, graceMs: 1, exists: () => exists,
      signalGroup: (pid: number, signal: string) => { events.push(`${pid}:${signal}`); if (signal === 'SIGKILL') exists = false; return null; } });
    expect(events).toEqual(['12345:SIGTERM', '12345:SIGKILL']); expect(result.treeTerminationVerified).toBe(true);
    const stuck = await stopOwnedChild({ pid: 12345 }, Promise.resolve({ code: 0 }), {
      platform: 'linux', timeoutMs: 10, graceMs: 1, exists: () => true, signalGroup: () => null });
    expect(stuck.treeTerminationVerified).toBe(false); expect(stuck.error).toContain('not confirmed');
  });
  it('forwards both batch signals, defers later recipes and removes only its own listeners', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const root = fixture([{ id: 'first' }, { id: 'second' }]), packages = plan(options(root), available);
      const before = process.listenerCount(signal); let calls = 0;
      const rows = await runBatch(packages, async (_root: string, _test: any, control: any) => {
        calls++; process.emit(signal); expect(control.signal.aborted).toBe(true);
        return { status: 'failed', cancelled: true, cleanup: { exitVerified: true } };
      });
      expect(calls).toBe(1); expect(rows.map((row: any) => row.status)).toEqual(['failed', 'deferred']);
      expect(process.listenerCount(signal)).toBe(before);
    }
  });
  it('stops following recipes on unverified cleanup independently of a timeout', async () => {
    const root = fixture([{ id: 'first' }, { id: 'second' }]);
    const rows = await runBatch(plan(options(root), available), async () => ({ status: 'failed', cleanup: { exitVerified: false } }));
    expect(rows.map((row: any) => row.status)).toEqual(['failed', 'deferred']);
  });
});
const options = (root: string, cases: string[] = []) => ({ packages: [root], cases, level: 'all' });

describe('registered package host batches', () => {
  it('plans explicitly and supports several packages and registered case selectors', () => {
    const parsed = parseArgs(['--package', 'one', '--package', 'two', '--case', 'editor', '--level', 'browser']);
    expect(parsed.run).toBe(false); expect(parsed.packages).toHaveLength(2); expect(parsed.cases).toEqual(['editor']);
    expect(() => parseArgs(['--package', 'one', '--command', 'anything'])).toThrow();
    expect(() => parseArgs(['--package', 'one', '--package', 'one'])).toThrow();
  });
  it('rejects misspelled case selections instead of reporting an empty pass', () => {
    expect(() => plan(options(fixture(), ['missing']), available)).toThrow('not found');
  });
  it('selects all registered browser recipes, with Node cases left outside that selection', () => {
    const root = fixture([{ id: 'unit' }, { id: 'browser', level: 'browser', runner: { kind: 'playwright', scope: 'package', files: ['tests/proof.mjs'] }, prerequisites: ['runner:playwright', 'browser:chromium'] }]);
    expect(plan({ ...options(root), level: 'browser' }, available)[0].cases.map((entry: any) => [entry.id, entry.status])).toEqual([['browser', 'ready']]);
  });
  it('keeps unavailable prerequisites and unsupported runners pending', () => {
    const root = fixture([{ id: 'node', prerequisites: ['service:unavailable'] }, { id: 'external', runner: { kind: 'external', scope: 'package', files: ['tests/proof.mjs'] } }]);
    const cases = plan(options(root), available)[0].cases;
    expect(cases.every((entry: any) => entry.status === 'pending')).toBe(true);
    expect(cases[0].reasons.join(' ')).toContain('service:unavailable');
    expect(cases[1].reasons.join(' ')).toContain('external');
  });
  it('does not mistake comments or strings for the Node browser harness', () => {
    expect(nodeHarness('proof.mjs', "// import {test} from 'node:test'\nconst text=\"node:test\";")).toBe(false);
    expect(nodeHarness('proof.mjs', "import {test} from 'node:test';")).toBe(true);
  });
  it('uses the existing confined-file validator before any execution', () => {
    const root = fixture([{ runner: { kind: 'node-test', scope: 'package', files: ['../outside.mjs'] } }]);
    expect(() => plan(options(root), available)).toThrow();
  });
  it('does not forward service credentials into fixture subprocesses', () => {
    const prior = process.env.SWARM_SERVICE_SECRET; process.env.SWARM_SERVICE_SECRET = 'synthetic-host-secret';
    try { expect(childEnvironment(fixture()).SWARM_SERVICE_SECRET).toBeUndefined(); }
    finally { if (prior === undefined) delete process.env.SWARM_SERVICE_SECRET; else process.env.SWARM_SERVICE_SECRET = prior; }
  });
  it('requires successful nonempty unskipped TAP execution', () => {
    const tap = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    expect(verdict(0, tap, false).status).toBe('passed');
    expect(verdict(1, tap, false).status).toBe('failed');
    expect(verdict(0, tap, true).status).toBe('failed');
    expect(verdict(0, '', false).status).toBe('failed');
    expect(verdict(0, tap.replace('# skipped 0', '# skipped 1'), false).status).toBe('failed');
  });
  it('executes real test files in one child and retains the actual failure', async () => {
    const root = fixture(), test = plan(options(root), available)[0].cases[0];
    const passed = await execute(root, test); expect(passed.status).toBe('passed'); expect(passed.counts.pass).toBe(1);
    fs.writeFileSync(path.join(root, 'tests/proof.mjs'), "import { test } from 'node:test';import assert from 'node:assert/strict';test('actual failure',()=>assert.equal(2,3));\n");
    const failed = await execute(root, test); expect(failed.status).toBe('failed'); expect(failed.counts.fail).toBe(1);
  });
  it('executes a declared TypeScript Node harness through the real core tsx adapter', async () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'tests/proof.ts'), "import {test} from 'node:test';import assert from 'node:assert/strict';const value: number=4;test('typed assertion',()=>assert.equal(value,4));\n");
    const catalogFile = path.join(root, 'tests/catalog.yaml'), catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    catalog.cases[0].runner.files = ['tests/proof.ts']; fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    const test = plan(options(root), new Set([...available, 'dependency:tsx']))[0].cases[0];
    const result = await execute(root, test); expect(result.status, result.output).toBe('passed'); expect(result.counts.pass).toBe(1);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const esm = await execute(root, test); expect(esm.status, esm.output).toBe('passed'); expect(esm.counts.pass).toBe(1);
  });
  it('runs independent recipes serially and retains pending cases without executing them', async () => {
    const root = fixture([{ id: 'first' }, { id: 'second' }, { id: 'pending', prerequisites: ['service:unavailable'] }]);
    const packages = plan(options(root), available), events: string[] = []; let active = 0;
    const results = await runBatch(packages, async (_root: string, test: any) => {
      expect(active++).toBe(0); events.push(test.id); await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return { status: 'passed' };
    });
    expect(events).toEqual(['first', 'second']); expect(results.map((row: any) => row.status)).toEqual(['passed', 'passed', 'pending']);
  });
  it('refuses changed registered recipes and stops following work after a timeout', async () => {
    const root = fixture([{ id: 'first' }, { id: 'second' }]), packages = plan(options(root), available);
    fs.appendFileSync(path.join(root, 'tests/proof.mjs'), '// changed fixture\n');
    let calls = 0; const refused = await runBatch(packages, async () => { calls++; return { status: 'passed' }; });
    expect(calls).toBe(0); expect(refused.every((row: any) => row.status === 'failed')).toBe(true);
    const timed = await runBatch(plan(options(root), available), async () => ({ status: 'failed', timedOut: true }));
    expect(timed.map((row: any) => row.status)).toEqual(['failed', 'deferred']);
  });
});
