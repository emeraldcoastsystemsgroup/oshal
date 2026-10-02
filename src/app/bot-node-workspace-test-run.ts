/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | vitest always gets an explicit config: the workspace's own when it has one (then its `npm test` is safe), otherwise a generated one in the private HOME passed with --config, run through node. A workspace without a config let vitest search upward from /app/workspace-shared/<root> and load the image's own /app/vite.config.ts (MODULE_NOT_FOUND, exit 1, zero tests), which failed a correct implementation as red (live, 2026-10-02 21:24 UTC).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | vitest always gets an explicit config: the workspace's own when it has one (then its `npm test` is safe), otherwise a generated one in the private HOME passed with --config, run through node. A workspace without a config let vitest search upward from /app/workspace-shared/<root> and load the image's own /app/vite.config.ts (MODULE_NOT_FOUND, exit 1, zero tests), which failed a correct implementation as red (live, 2026-10-02 21:24 UTC).
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The node-side workspace test run behind the `workspace-tests/run` deterministic provider intent: in the ticket's shared workspace folder, with a private HOME and a process environment built from scratch (no node secrets, CI=1 so vitest never watches, colour off so the output parses), it makes a toolchain (`npm install --ignore-scripts` when package.json exists and node_modules does not; the image's global vitest linked in when that cannot run), runs `npm test` or vitest directly, both bounded in time and output, and reports the exit code, the parsed counts, the failing test names and the output tail. There is no command, argument or path from the request: the only input is the workspace id the signed intent carries. A run that cannot happen says why instead of passing.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChildLogger } from '@/shared/logger';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { parseTestOutput, type WorkspaceTestRun } from '@/features/swarm-orchestration';

const logger = createChildLogger({ module: 'bot-node-workspace-test-run' });

/** How long `npm install --ignore-scripts` may take. */
export const INSTALL_TIMEOUT_MS = 180_000;
/** How long the test run may take. */
export const RUN_TIMEOUT_MS = 300_000;
/** Where the bot image installs vitest globally (Dockerfile.oshal, `npm install -g … vitest`). */
export const DEFAULT_IMAGE_VITEST_DIR = '/usr/local/lib/node_modules/vitest';
const OUTPUT_CAP_BYTES = 256 * 1024;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const MAX_WALK_ENTRIES = 2000;
const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const VITEST_CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.js'];
/** Parent variables a child may keep: the runtime path, locale, and what npm and cmd.exe need on Windows. */
const INHERITED_KEYS = ['PATH', 'Path', 'PATHEXT', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'ComSpec', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE'];

/** @description One bounded child process. */
export interface WorkspaceTestSpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

/** @description What the child process produced. */
export interface WorkspaceTestSpawnResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** @description Spawns one bounded child process; the default uses node:child_process. */
export type WorkspaceTestSpawner = (request: WorkspaceTestSpawnRequest) => Promise<WorkspaceTestSpawnResult>;

/** @description Seams for tests: the spawner, the workspace root, the image's vitest and the parent env. */
export interface WorkspaceTestRunDeps {
  spawn?: WorkspaceTestSpawner;
  workspaceRoot?: string;
  imageVitestDir?: string;
  parentEnv?: NodeJS.ProcessEnv;
}

/**
 * @description The child's environment, built from scratch: a private HOME and temp, CI=1 (vitest
 * runs once instead of watching), npm quiet and cache-local, plus the runtime path and locale. No
 * node secret, token or OSHAL setting is inherited.
 * @param parent - The node's environment, read for the inherited keys only.
 * @param home - The private directory the run may write to.
 * @returns The environment.
 */
export function workspaceTestProcessEnv(parent: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: home,
    TEMP: home,
    TMP: home,
    CI: '1',
    NODE_ENV: 'test',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    npm_config_cache: path.join(home, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_loglevel: 'error',
  };
  for (const key of INHERITED_KEYS) {
    const value = parent[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  return env;
}

/**
 * @description Runs the tests of one ticket workspace and reports the run.
 * @param workspaceFolderId - The root ticket's folder id (a lower-case UUID), as the signed intent carries it.
 * @param deps - Seams; production uses the defaults.
 * @returns The run; `ran` false names why no verdict exists.
 */
export async function runWorkspaceTests(workspaceFolderId: string, deps: WorkspaceTestRunDeps = {}): Promise<WorkspaceTestRun> {
  const startedAt = Date.now();
  if (!WORKSPACE_ID.test(workspaceFolderId)) return notRun('invalid-workspace-id', startedAt);
  const workspace = path.join(deps.workspaceRoot ?? resolveSharedWorkspaceRoot(), workspaceFolderId);
  const deliverables = path.join(workspace, 'deliverables');
  if (!fs.existsSync(deliverables)) return notRun('no-deliverables', startedAt);
  const pkg = readPackage(workspace);
  const testScript = typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim() ? pkg.scripts.test.trim() : null;
  const testFiles = countTestFiles(deliverables);
  if (!testScript && testFiles === 0) return notRun('no-tests-declared', startedAt);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-workspace-tests-'));
  const spawnFn = deps.spawn ?? spawnProcess;
  const env = workspaceTestProcessEnv(deps.parentEnv ?? process.env, home);
  try {
    const toolchain = await ensureToolchain(workspace, pkg != null, spawnFn, env, deps.imageVitestDir ?? DEFAULT_IMAGE_VITEST_DIR);
    if (!toolchain.ok) return notRun(`no-toolchain: ${toolchain.reason}`, startedAt, toolchain.output);
    const plan = choosePlan(workspace, toolchain.kind, testScript, home);
    logger.info({ workspaceFolderId, toolchain: toolchain.kind, command: plan.label, testFiles }, 'Workspace test run starting');
    const result = await spawnFn({ command: plan.command, args: plan.args, cwd: workspace, env, timeoutMs: RUN_TIMEOUT_MS });
    if (result.timedOut) return notRun('timeout', startedAt, result.output);
    const parsed = parseTestOutput(result.output);
    const run: WorkspaceTestRun = {
      ran: true, command: plan.label, exitCode: result.exitCode,
      passed: parsed.passed, failed: parsed.failed, failedTests: parsed.failedTests,
      outputTail: tail(result.output), durationMs: Date.now() - startedAt,
    };
    logger.info({ workspaceFolderId, exitCode: run.exitCode, passed: run.passed, failed: run.failed, durationMs: run.durationMs }, 'Workspace test run finished');
    return run;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

type Toolchain = { ok: true; kind: 'installed' | 'image-vitest' } | { ok: false; reason: string; output?: string };

/**
 * @description Makes vitest resolvable from the workspace: already installed; else `npm install
 * --ignore-scripts` when package.json exists; else the image's global vitest linked into
 * node_modules. Nothing from the package's lifecycle scripts runs.
 * @param workspace - The workspace directory.
 * @param hasPackage - Whether package.json exists.
 * @param spawnFn - The spawner.
 * @param env - The child environment.
 * @param imageVitestDir - The image's global vitest directory.
 * @returns The toolchain, or why none could be made.
 */
async function ensureToolchain(workspace: string, hasPackage: boolean, spawnFn: WorkspaceTestSpawner, env: Record<string, string>, imageVitestDir: string): Promise<Toolchain> {
  const localVitest = path.join(workspace, 'node_modules', 'vitest');
  if (fs.existsSync(localVitest)) return { ok: true, kind: 'installed' };
  let reason = 'no package.json';
  let output: string | undefined;
  if (hasPackage) {
    const install = await spawnFn({ ...npmInvocation(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']), cwd: workspace, env, timeoutMs: INSTALL_TIMEOUT_MS });
    if (!install.timedOut && install.exitCode === 0 && fs.existsSync(localVitest)) return { ok: true, kind: 'installed' };
    reason = install.timedOut ? 'npm install timed out' : `npm install exited ${install.exitCode}${fs.existsSync(localVitest) ? '' : ' without vitest'}`;
    output = install.output;
  }
  if (fs.existsSync(imageVitestDir)) {
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    if (!fs.existsSync(localVitest)) fs.symlinkSync(imageVitestDir, localVitest, process.platform === 'win32' ? 'junction' : 'dir');
    logger.warn({ workspace, reason }, 'Workspace toolchain: the image vitest is linked in');
    return { ok: true, kind: 'image-vitest' };
  }
  return { ok: false, reason: `${reason}; image vitest absent`, output };
}

/**
 * @description The command. vitest searches for a config upward from its root, and a workspace under
 * /app/workspace-shared has the image's own /app/vite.config.ts above it, so the run always names a
 * config: the workspace's own when it has one (its `npm test` is then safe when installed), otherwise
 * a generated one in the private HOME that points at deliverables/, passed with --config through node.
 * @param workspace - The workspace directory.
 * @param kind - The toolchain.
 * @param testScript - package.json's test script, when any.
 * @param home - The private directory a generated config may be written to.
 * @returns The command, its args and a label for the record.
 */
function choosePlan(workspace: string, kind: 'installed' | 'image-vitest', testScript: string | null, home: string): { command: string; args: string[]; label: string } {
  const hasConfig = VITEST_CONFIGS.some((name) => fs.existsSync(path.join(workspace, name)));
  if (hasConfig && kind === 'installed' && testScript) return { ...npmInvocation(['test']), label: 'npm test' };
  const vitest = path.join(workspace, 'node_modules', 'vitest', 'vitest.mjs');
  if (hasConfig) return { command: process.execPath, args: [vitest, 'run'], label: 'vitest run' };
  const config = path.join(home, 'vitest.config.mjs');
  fs.writeFileSync(config, `export default { test: { root: ${JSON.stringify(workspace)}, dir: 'deliverables', include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'], passWithNoTests: false } };\n`);
  return { command: process.execPath, args: [vitest, 'run', '--config', config], label: 'vitest run --config <generated>' };
}

/**
 * @description npm run through the node binary that runs this process (its bundled npm-cli.js, found
 * beside node or under its lib), so no shell and no .cmd shim is involved on any platform; the bare
 * `npm` on PATH is the fallback when neither location exists.
 * @param args - npm's arguments.
 * @returns The command and args.
 */
export function npmInvocation(args: string[]): { command: string; args: string[] } {
  const nodeDir = path.dirname(process.execPath);
  for (const candidate of [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate, ...args] };
  }
  return { command: 'npm', args };
}

/**
 * @description One bounded child process without a shell, its output kept to the last OUTPUT_CAP_BYTES.
 * @param request - The process.
 * @returns Its exit code, output and whether it was killed at the deadline.
 */
function spawnProcess(request: WorkspaceTestSpawnRequest): Promise<WorkspaceTestSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_CAP_BYTES) output = output.slice(-OUTPUT_CAP_BYTES);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, request.timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ exitCode: null, output: `${output}\n${err.message}`, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }); });
  });
}

function readPackage(workspace: string): { scripts?: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as { scripts?: Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/**
 * @description Counts JS/TS test files under a directory, skipping dependency and build folders.
 * @param root - The directory.
 * @returns The count, capped by the walk budget.
 */
function countTestFiles(root: string): number {
  const pending = [root];
  let seen = 0;
  let count = 0;
  while (pending.length && seen < MAX_WALK_ENTRIES) {
    const dir = pending.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) pending.push(path.join(dir, entry.name)); }
      else if (TEST_FILE.test(entry.name)) count += 1;
    }
  }
  return count;
}

function tail(output: string): string {
  return output.length > OUTPUT_TAIL_BYTES ? output.slice(-OUTPUT_TAIL_BYTES) : output;
}

function notRun(reason: string, startedAt: number, output = ''): WorkspaceTestRun {
  return { ran: false, command: null, exitCode: null, passed: 0, failed: 0, failedTests: [], reason, outputTail: tail(output), durationMs: Date.now() - startedAt };
}
