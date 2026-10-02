/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the node-side workspace test run (bot-node-workspace-test-run.ts) and its intent (bot-node-provider-intent.ts). Over a real temp workspace with a recording spawner: the child environment is built from scratch (no node secret, CI=1, colour off, private HOME); npm runs through node's own npm-cli.js with no shell; a workspace with no deliverables or no tests is not run, with the reason; an installed toolchain runs `npm test`; a missing one runs `npm install --ignore-scripts` first; when that fails the image vitest is linked and run through node, without `--dir` when the workspace has its own vitest config; a timeout and a red run report as such with the failing names. The intent parser accepts exactly the controller's shape with a lower-case UUID and nothing else; the executor still demands an exact owner and answers the run as JSON. The real spawn is proven by bot-node-workspace-test-run-real.spec.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkspaceTests, workspaceTestProcessEnv, npmInvocation, INSTALL_TIMEOUT_MS, RUN_TIMEOUT_MS, type WorkspaceTestSpawnRequest } from '../../src/app/bot-node-workspace-test-run';
import { executeTrustedProviderIntent, parseTrustedProviderIntent, trustedProviderAgentId, WORKSPACE_TESTS_AGENT_ID } from '../../src/app/bot-node-provider-intent';
import { WORKSPACE_TESTS_INTENT } from '../../src/features/swarm-orchestration/services/node-workspace-test-runner';

const FOLDER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GREEN = ' ✓ deliverables/src/slugify.test.ts (3 tests) 8ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n';
const RED = ' FAIL  deliverables/src/slugify.test.ts > slugify > keeps underscores\nAssertionError: expected x\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n';

let root: string;
let imageVitest: string;

function workspace(options: { deliverables?: boolean; tests?: boolean; pkg?: boolean; nodeModulesVitest?: boolean; config?: boolean } = {}): string {
  const ws = join(root, FOLDER);
  mkdirSync(ws, { recursive: true });
  if (options.deliverables !== false) mkdirSync(join(ws, 'deliverables', 'src'), { recursive: true });
  if (options.tests !== false && options.deliverables !== false) writeFileSync(join(ws, 'deliverables', 'src', 'slugify.test.ts'), "import { it } from 'vitest'; it('x', () => {});\n");
  if (options.pkg !== false) writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'ws', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }));
  if (options.nodeModulesVitest) mkdirSync(join(ws, 'node_modules', 'vitest'), { recursive: true });
  if (options.config) writeFileSync(join(ws, 'vitest.config.ts'), "export default {};\n");
  return ws;
}

/** A spawner that answers by command and records every request. */
function spawner(answers: { install?: { exitCode: number; output?: string; timedOut?: boolean }; run?: { exitCode: number; output: string; timedOut?: boolean } }) {
  const requests: WorkspaceTestSpawnRequest[] = [];
  const spawn = async (request: WorkspaceTestSpawnRequest) => {
    requests.push(request);
    if (request.args.includes('install')) {
      const a = answers.install ?? { exitCode: 0 };
      if (a.exitCode === 0 && !a.timedOut) mkdirSync(join(request.cwd, 'node_modules', 'vitest'), { recursive: true });
      return { exitCode: a.exitCode, output: a.output ?? '', timedOut: a.timedOut ?? false };
    }
    const r = answers.run ?? { exitCode: 0, output: GREEN };
    return { exitCode: r.exitCode, output: r.output, timedOut: r.timedOut ?? false };
  };
  return { spawn, requests };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-node-workspace-tests-'));
  imageVitest = join(root, 'image-vitest');
  mkdirSync(imageVitest, { recursive: true });
  writeFileSync(join(imageVitest, 'vitest.mjs'), '// image vitest\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the child environment', () => {
  it('is built from scratch: no node secret, CI=1, a private HOME', () => {
    const env = workspaceTestProcessEnv({ PATH: '/usr/bin', SWARM_SERVICE_SECRET: 's', OSHAL_DELEGATION_PRIVATE_KEY: 'k', DATABASE_URL: 'pg', GEMINI_API_KEY: 'g', HOME: '/root' }, '/tmp/private');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/private');
    expect(env.CI).toBe('1');
    expect(env.NODE_ENV).toBe('test');
    expect(Object.keys(env).some((k) => /SECRET|KEY|DATABASE|OSHAL|GEMINI/i.test(k))).toBe(false);
    expect(env.NO_COLOR).toBe('1');
  });
});

describe('the node-side run', () => {
  it('refuses a workspace id that is not a lower-case UUID, without touching the disk', async () => {
    const { spawn, requests } = spawner({});
    const run = await runWorkspaceTests('../etc', { spawn, workspaceRoot: root });
    expect(run).toMatchObject({ ran: false, reason: 'invalid-workspace-id' });
    expect(requests).toHaveLength(0);
  });

  it('a workspace with no deliverables, or no tests, is not run with the reason', async () => {
    workspace({ deliverables: false });
    expect((await runWorkspaceTests(FOLDER, { spawn: spawner({}).spawn, workspaceRoot: root })).reason).toBe('no-deliverables');
    rmSync(join(root, FOLDER), { recursive: true, force: true });
    workspace({ tests: false, pkg: false });
    expect((await runWorkspaceTests(FOLDER, { spawn: spawner({}).spawn, workspaceRoot: root })).reason).toBe('no-tests-declared');
  });

  it('an installed toolchain runs npm test in the workspace with the scrubbed environment and reports the counts', async () => {
    const ws = workspace({ nodeModulesVitest: true });
    const { spawn, requests } = spawner({ run: { exitCode: 0, output: GREEN } });
    const run = await runWorkspaceTests(FOLDER, { spawn, workspaceRoot: root, parentEnv: { PATH: '/usr/bin', SWARM_SERVICE_SECRET: 'never' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ ...npmInvocation(['test']), cwd: ws, timeoutMs: RUN_TIMEOUT_MS });
    expect(requests[0]!.env.SWARM_SERVICE_SECRET).toBeUndefined();
    expect(requests[0]!.env.CI).toBe('1');
    expect(run).toMatchObject({ ran: true, command: 'npm test', exitCode: 0, passed: 3, failed: 0, failedTests: [] });
    expect(existsSync(requests[0]!.env.HOME as string)).toBe(false);
  });

  it('a missing toolchain is installed without lifecycle scripts, then the tests run', async () => {
    workspace();
    const { spawn, requests } = spawner({ install: { exitCode: 0 } });
    const run = await runWorkspaceTests(FOLDER, { spawn, workspaceRoot: root });
    expect(requests.map((r) => r.args.filter((a) => !a.endsWith('npm-cli.js')).join(' '))).toEqual(['install --ignore-scripts --no-audit --no-fund --loglevel=error', 'test']);
    expect(requests.every((r) => r.command === npmInvocation([]).command)).toBe(true);
    expect(requests[0]!.timeoutMs).toBe(INSTALL_TIMEOUT_MS);
    expect(run.ran).toBe(true);
  });

  it('when the install fails, the image vitest is linked in and run through node; with no vitest config, deliverables/ is searched', async () => {
    const ws = workspace();
    const { spawn, requests } = spawner({ install: { exitCode: 1, output: 'npm ERR! network' } });
    const run = await runWorkspaceTests(FOLDER, { spawn, workspaceRoot: root, imageVitestDir: imageVitest });
    expect(existsSync(join(ws, 'node_modules', 'vitest', 'vitest.mjs'))).toBe(true);
    expect(requests[1]).toMatchObject({ command: process.execPath, args: [join(ws, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--dir', 'deliverables'] });
    expect(run).toMatchObject({ ran: true, command: 'vitest run --dir deliverables', passed: 3 });
  });

  it('with its own vitest config the workspace decides where tests are', async () => {
    const ws = workspace({ pkg: false, config: true });
    const { spawn, requests } = spawner({});
    await runWorkspaceTests(FOLDER, { spawn, workspaceRoot: root, imageVitestDir: imageVitest });
    expect(requests[0]).toMatchObject({ args: [join(ws, 'node_modules', 'vitest', 'vitest.mjs'), 'run'] });
  });

  it('no install possible and no image vitest is not run, naming both', async () => {
    workspace();
    const run = await runWorkspaceTests(FOLDER, { spawn: spawner({ install: { exitCode: 1 } }).spawn, workspaceRoot: root, imageVitestDir: join(root, 'absent') });
    expect(run.ran).toBe(false);
    expect(run.reason).toBe('no-toolchain: npm install exited 1 without vitest; image vitest absent');
  });

  it('a red run reports the failing names and the exit code; a timeout is not run', async () => {
    workspace({ nodeModulesVitest: true });
    const red = await runWorkspaceTests(FOLDER, { spawn: spawner({ run: { exitCode: 1, output: RED } }).spawn, workspaceRoot: root });
    expect(red).toMatchObject({ ran: true, exitCode: 1, passed: 2, failed: 1, failedTests: ['deliverables/src/slugify.test.ts > slugify > keeps underscores'] });
    const late = await runWorkspaceTests(FOLDER, { spawn: spawner({ run: { exitCode: null as never, output: '', timedOut: true } }).spawn, workspaceRoot: root });
    expect(late).toMatchObject({ ran: false, reason: 'timeout' });
  });
});

describe('the workspace-tests/run intent', () => {
  it('parses exactly the controller shape with a lower-case UUID, and nothing else', () => {
    expect(parseTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: FOLDER })).toEqual({ schemaVersion: 1, kind: 'workspace-tests', operation: 'run', workspaceFolderId: FOLDER });
    expect(parseTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: '../etc' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: FOLDER.toUpperCase() })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: FOLDER, command: 'rm -rf /' })).toBeUndefined();
    expect(parseTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT })).toBeUndefined();
  });

  it('is owned by test-engineer', () => {
    expect(trustedProviderAgentId({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: FOLDER })).toBe(WORKSPACE_TESTS_AGENT_ID);
    expect(WORKSPACE_TESTS_AGENT_ID).toBe('a0000000-0000-0000-0000-000000000005');
  });

  it('the executor demands an exact owner and answers the run as JSON with no provider record', async () => {
    const deps = { runWorkspaceTests: async (id: string) => ({ ran: true, command: 'npm test', exitCode: 0, passed: 3, failed: 0, failedTests: [], outputTail: '', durationMs: 5, folder: id }) } as never;
    await expect(executeTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: FOLDER }, { userSub: '', creds: {} }, deps)).rejects.toThrow();
    const result = await executeTrustedProviderIntent({ ...WORKSPACE_TESTS_INTENT, workspaceFolderId: FOLDER }, { userSub: '106925151779924703909', creds: {} }, deps);
    expect(result.providerRecords).toEqual([]);
    expect(JSON.parse(result.completion)).toMatchObject({ ran: true, passed: 3, folder: FOLDER });
  });
});
