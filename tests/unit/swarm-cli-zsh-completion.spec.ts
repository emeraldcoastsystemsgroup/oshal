/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the swarm-cli zsh completion (BACKLOG: `swarm-cli` zsh completion). The script had only ever been emitted and line-counted; nothing had run it in zsh, so the README and runbook called it unexecuted. This runs it in a REAL zsh: the script the CLI actually prints (`swarm-cli completion zsh`) must pass `zsh -n`, and TAB pressed in an interactive zsh on a pseudo-terminal (tests/helpers/zsh-complete.zsh) must offer exactly the top-level commands, the three completion shells, the `revoke` token action, and the contexts a real `swarm-cli login` saved for `--context` (before and after the subcommand) - once for each install the script supports: `eval` from ~/.zshrc and `_swarm-cli` autoloaded from $fpath, which take different branches of its dispatch tail. No zsh is a loud failure, never a skip: set OSHAL_ZSH to a zsh binary that has the zsh/zpty module, or put one on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'packages', 'swarm-cli', 'bin', 'swarm-cli.js');
const DRIVER = path.join(REPO_ROOT, 'tests', 'helpers', 'zsh-complete.zsh');
const ZSH = process.env.OSHAL_ZSH || 'zsh';
const STUB_PAT = 'oshal_pat_zshcompletion0000000000000000000000000000';
/** compinit alone takes ~8 s under MSYS2 on Windows; well under a second elsewhere. */
const ZSH_RUN_TIMEOUT_MS = 200_000;

const TOP_LEVEL_COMMANDS = [
  'ask', 'catalog', 'chat', 'completion', 'help', 'history',
  'login', 'logout', 'tasks', 'tokens', 'version', 'whoami',
];
const SAVED_CONTEXTS = ['prod-east', 'staging'];
const CASES: Array<{ typed: string; expected: string[] }> = [
  { typed: 'swarm-cli ', expected: TOP_LEVEL_COMMANDS },
  { typed: 'swarm-cli completion ', expected: ['bash', 'powershell', 'zsh'] },
  { typed: 'swarm-cli tokens ', expected: ['revoke'] },
  { typed: 'swarm-cli --context ', expected: SAVED_CONTEXTS },
  { typed: 'swarm-cli ask --context ', expected: SAVED_CONTEXTS },
];

/**
 * @description The environment every zsh child gets. The zsh under test goes first on PATH
 * because the driver starts its inner interactive shell as plain `zsh`; the state dir points
 * `--context` completion at the contexts this spec saved, never at the operator's ~/.oshal.
 * @param stateDir - OSHAL_CLI_STATE_DIR holding the saved contexts.
 * @returns {NodeJS.ProcessEnv} the child environment.
 */
function zshEnv(stateDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OSHAL_CLI_STATE_DIR: stateDir, TERM: 'xterm' };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  if (path.isAbsolute(ZSH)) env[pathKey] = `${path.dirname(ZSH)}${path.delimiter}${env[pathKey] ?? ''}`;
  return env;
}

/**
 * @description Answer the one call `swarm-cli login` makes to verify a personal token, so the
 * contexts under test are written by the CLI's own login path rather than by hand.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} the stub's base URL and closer.
 */
function startWhoamiStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const ok = req.url === '/api/cli-tokens/whoami' && req.headers.authorization === `Bearer ${STUB_PAT}`;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { sub: 'zsh-completion-user', operator: false } : { error: 'unauthorized' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.close(() => r()); }) });
    });
  });
}

/**
 * @description Run the real CLI as a child process.
 * @param args - CLI arguments.
 * @param stateDir - OSHAL_CLI_STATE_DIR for the run.
 * @returns {Promise<{code: number, out: string}>} exit code and combined output.
 */
function runCli(args: string[], stateDir: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, OSHAL_CLI_STATE_DIR: stateDir, OSHAL_API_URL: '', OSHAL_CLI_TOKEN: '', SWARM_SERVICE_SECRET: '', OSHAL_USER_SUB: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

let zshProbe: string | Error | undefined;

/**
 * @description Fail loudly, naming the fix, when no usable zsh can be started. Called from
 * inside each test (probed once), so a missing zsh reports every case as FAILED rather than
 * as skipped behind a failed hook.
 * @returns {string} the version line of the zsh under test.
 */
function requireZsh(): string {
  if (zshProbe === undefined) {
    const probe = spawnSync(ZSH, ['-f', '-c', 'zmodload zsh/zpty && print -r -- "zsh $ZSH_VERSION"'], { encoding: 'utf8', timeout: 60_000 });
    if (probe.error || probe.status !== 0) {
      const why = (probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
        ? `no zsh at '${ZSH}'`
        : `'${ZSH}' could not load zsh/zpty (${probe.error?.message ?? probe.stderr.trim()})`;
      zshProbe = new Error(`${why}. This guard runs the REAL zsh completion system and does not skip: `
        + 'set OSHAL_ZSH to a zsh binary that has the zsh/zpty module (e.g. /usr/bin/zsh, or '
        + 'C:\\msys64\\usr\\bin\\zsh.exe on Windows), or put one on PATH.');
    } else {
      zshProbe = probe.stdout.trim();
    }
  }
  if (zshProbe instanceof Error) throw zshProbe;
  return zshProbe;
}

/**
 * @description Press TAB after each typed line in one interactive zsh with the completion
 * installed in the given mode, and return the matches offered per line.
 * @param mode - `sourced` (eval from ~/.zshrc) or `autoload` (`_swarm-cli` on $fpath).
 * @param workDir - Directory holding the installed script; the run's working directory.
 * @param script - The script's path relative to workDir. Relative on purpose: zsh resolves it
 *   against its own $PWD, which is the only spelling an MSYS2/Cygwin zsh on Windows treats as
 *   absolute when compinit records where to autoload `_swarm-cli` from.
 * @param stateDir - OSHAL_CLI_STATE_DIR holding the saved contexts.
 * @returns {{matches: string[][], raw: string}} sorted unique matches per typed line, and the raw output.
 */
function completeInZsh(mode: 'sourced' | 'autoload', workDir: string, script: string, stateDir: string) {
  const run = spawnSync(ZSH, [DRIVER, mode, script, ...CASES.map((c) => c.typed)], {
    cwd: workDir, env: zshEnv(stateDir), encoding: 'utf8', timeout: ZSH_RUN_TIMEOUT_MS,
  });
  const raw = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.error || run.status !== 0) {
    throw new Error(`zsh completion driver failed (${run.error?.message ?? `exit ${run.status}`}):\n${raw}`);
  }
  const blocks = (run.stdout ?? '').split(/^ZCAP-LINE \d+$/m).slice(1);
  if (blocks.length !== CASES.length) throw new Error(`expected ${CASES.length} completions, got ${blocks.length}:\n${raw}`);
  const matches = blocks.map((block) => {
    if (!block.includes('ZCAP-END')) throw new Error(`a completion did not finish:\n${block}`);
    // eslint-disable-next-line no-control-regex
    const words = [...block.matchAll(/MATCH:([^\r\n\x1b]*)/g)].map((m) => m[1]);
    return [...new Set(words)].sort();
  });
  return { matches, raw };
}

const completionRuns = new Map<string, { matches: string[][]; raw: string } | Error>();

/**
 * @description One zsh session per install mode, run by the first case that needs it and
 * shared by the rest; a failed run is remembered so every case of that mode reports it.
 * @param mode - `sourced` or `autoload`.
 * @param workDir - Directory holding the installed script.
 * @param script - The script's path relative to workDir.
 * @param stateDir - OSHAL_CLI_STATE_DIR holding the saved contexts.
 * @returns {{matches: string[][], raw: string}} the session's matches per typed line.
 */
function completionsFor(mode: 'sourced' | 'autoload', workDir: string, script: string, stateDir: string) {
  requireZsh();
  let run = completionRuns.get(mode);
  if (run === undefined) {
    try {
      run = completeInZsh(mode, workDir, script, stateDir);
    } catch (err) {
      run = err as Error;
    }
    completionRuns.set(mode, run);
  }
  if (run instanceof Error) throw run;
  return run;
}

describe('swarm-cli zsh completion — executed in a real zsh', () => {
  let tmp: string;
  let stateDir: string;
  let emitted: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-zsh-'));
    stateDir = path.join(tmp, 'state');
    const stub = await startWhoamiStub();
    try {
      for (const context of SAVED_CONTEXTS) {
        const login = await runCli(['login', '--url', stub.url, '--token', STUB_PAT, '--context', context, '--quiet', '--no-banner'], stateDir);
        expect(login.code, login.out).toBe(0);
      }
    } finally {
      await stub.close();
    }
    const emit = spawnSync(process.execPath, [CLI, 'completion', 'zsh'], { encoding: 'utf8' });
    expect(emit.status, emit.stderr).toBe(0);
    emitted = emit.stdout;
    // The two documented installs: eval "$(swarm-cli completion zsh)", and the output saved
    // as _swarm-cli in a directory on $fpath.
    fs.mkdirSync(path.join(tmp, 'eval'));
    fs.writeFileSync(path.join(tmp, 'eval', 'swarm-cli.zsh'), emitted);
    fs.mkdirSync(path.join(tmp, 'fpath'));
    fs.writeFileSync(path.join(tmp, 'fpath', '_swarm-cli'), emitted);
  }, 120_000);

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the script the CLI prints passes zsh -n', () => {
    requireZsh();
    expect(emitted).toMatch(/^#compdef swarm-cli\n/);
    const check = spawnSync(ZSH, ['-n', 'eval/swarm-cli.zsh'], { cwd: tmp, encoding: 'utf8', timeout: 60_000 });
    expect(check.error).toBeUndefined();
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  }, 90_000);

  describe.each([
    { mode: 'sourced' as const, script: 'eval/swarm-cli.zsh' },
    { mode: 'autoload' as const, script: 'fpath/_swarm-cli' },
  ])('$mode install', ({ mode, script }) => {
    it.each(CASES.map((c, i) => ({ ...c, i })))('$typed + TAB offers exactly the expected matches', ({ expected, i }) => {
      const run = completionsFor(mode, tmp, script, stateDir);
      expect(run.matches[i], run.raw).toEqual([...expected].sort());
    }, ZSH_RUN_TIMEOUT_MS + 30_000);
  });
});
