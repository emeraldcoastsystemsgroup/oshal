/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Drive the real pre-push hook, disposable Git history, archive and installed compiler: an unknown push range must not treat a final docs commit as the entire push. The publish gate is an explicitly named ordering fixture, not leak-wall proof.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const HOOK = join(REPO, '.githooks/pre-push').replace(/\\/g, '/');
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const MODULES = realpathSync(join(REPO, 'node_modules'));
const GOOD = 'export const count: number = 1;\n';
const BAD = 'export const count: number = "committed-type-error";\n';
const owned = new Set<string>();
type Fixture = { root: string; repo: string; scratch: string; env: NodeJS.ProcessEnv };

/** Run actual bounded tools; spawn/timeout/signal failures must not count as hook refusals. */
function command(f: Fixture, file: string, args: string[], input = '') {
  const result = spawnSync(file, args, { cwd: f.repo, env: f.env, input, encoding: 'utf8',
    timeout: 30_000, maxBuffer: 512 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.signal || result.status === null) throw new Error('fixture tool did not finish normally');
  return { status: result.status, output: result.stdout + result.stderr };
}
function git(f: Fixture, ...args: string[]) {
  const result = command(f, 'git', args);
  expect(result.status, result.output).toBe(0);
  return result.output.trim();
}
function commit(f: Fixture, message: string, ...paths: string[]) {
  git(f, 'add', '--', ...paths);
  git(f, 'commit', '-m', message, '--', ...paths);
  return git(f, 'rev-parse', 'HEAD');
}

/** Whitelist process mechanics only: no inherited credentials, npm settings or Git hooks/config. */
function environment(root: string, scratch: string): NodeJS.ProcessEnv {
  const windows = process.env.SystemRoot;
  const search = process.platform === 'win32'
    ? [dirname(process.execPath), 'C:/Program Files/Git/bin', 'C:/Program Files/Git/usr/bin',
      join(windows!, 'System32'), join(windows!, 'System32/WindowsPowerShell/v1.0')].join(';')
    : process.env.PATH;
  return { PATH: search, SystemRoot: windows, ComSpec: process.env.ComSpec, PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: scratch, TMP: scratch, TMPDIR: scratch.replace(/\\/g, '/'),
    NODE_OPTIONS: '--max-old-space-size=128', NODE_DISABLE_COMPILE_CACHE: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty-git-config'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'oshal maintainers', GIT_COMMITTER_NAME: 'oshal maintainers',
    GIT_AUTHOR_EMAIL: 'maintainer@emeraldcoastsystemsgroup.com',
    GIT_COMMITTER_EMAIL: 'maintainer@emeraldcoastsystemsgroup.com',
    npm_config_userconfig: join(root, 'empty-npm-config'),
    npm_config_globalconfig: join(root, 'empty-npm-global-config'),
    npm_config_cache: join(root, 'npm-cache'), npm_config_offline: 'true',
    npm_config_yes: 'false', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
    npm_config_fund: 'false', npm_config_update_notifier: 'false' };
}

/** Owned repo only; no remote is contacted, no real project's config/index/hooks are altered. */
function fixture(gateExit = 0): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'oshal-prepush-range-')); owned.add(root);
  const repo = join(root, 'repo'); const scratch = join(root, 'scratch');
  for (const dir of [repo, scratch, join(root, 'empty-template'), join(repo, 'src'), join(repo, 'scripts')]) mkdirSync(dir);
  for (const name of ['empty-git-config', 'empty-npm-config', 'empty-npm-global-config']) writeFileSync(join(root, name), '');
  const f = { root, repo, scratch, env: environment(root, scratch) };
  git(f, 'init', '--initial-branch=main', '--template=' + join(root, 'empty-template'));
  git(f, 'config', 'commit.gpgsign', 'false'); git(f, 'config', 'push.default', 'simple');
  writeFileSync(join(repo, 'src/index.ts'), GOOD);
  writeFileSync(join(repo, 'package.json'), '{"name":"prepush-range-fixture","private":true}\n');
  writeFileSync(join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, declaration: true, target: 'ES5', module: 'CommonJS', lib: ['ES5'], types: [],
  }, include: ['src/**/*.ts'] }));
  // Only the leak-wall collaborator is replaced; preserve its argv/stdin/order and refusal.
  writeFileSync(join(repo, 'scripts/publish-gate.sh'), '#!/usr/bin/env bash\n' +
    'printf "fixture publish gate\\n" >&2\nprintf "%s\\n" "$@" > gate-args.txt\n' +
    `cat > gate-stdin.txt\nexit ${gateExit}\n`);
  commit(f, 'test: initial fixture', 'src/index.ts', 'package.json', 'tsconfig.json', 'scripts/publish-gate.sh');
  expect(existsSync(join(MODULES, 'typescript/bin/tsc'))).toBe(true);
  symlinkSync(MODULES, join(repo, 'node_modules'), 'junction');
  return f;
}

/** A real local remote-tracking ref, not a Git command double; never fetch or push. */
function tracking(f: Fixture, head = git(f, 'rev-parse', 'HEAD')) {
  git(f, 'remote', 'add', 'origin', join(f.root, 'never-contacted.git'));
  git(f, 'config', 'branch.main.remote', 'origin');
  git(f, 'config', 'branch.main.merge', 'refs/heads/main');
  git(f, 'update-ref', 'refs/remotes/origin/main', head);
  expect(git(f, 'rev-parse', '@{push}')).toBe(head);
}
function source(f: Fixture) {
  writeFileSync(join(f.repo, 'src/index.ts'), BAD);
  commit(f, 'test: committed source error', 'src/index.ts');
}
function docs(f: Fixture) {
  writeFileSync(join(f.repo, 'notes.md'), '# Fixture documentation\n');
  commit(f, 'docs: final documentation change', 'notes.md');
}
/** Own the entire hook process tree so a timeout cannot outlive fixture teardown. */
function executeHook(f: Fixture, input: string): Promise<{ status: number; output: string }> {
  return new Promise((accept, reject) => {
    const child = spawn(BASH, [HOOK, 'origin', 'unused-local-fixture'], { cwd: f.repo, env: f.env,
      stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
    let output = ''; let failure: Error | undefined;
    const stop = (reason: string) => {
      failure ??= new Error(reason);
      if (!child.pid) return;
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { env: f.env, windowsHide: true, timeout: 10_000, stdio: 'pipe' });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { failure = error as Error; } }
    };
    const timer = setTimeout(() => stop('fixture hook deadline exceeded'), 30_000);
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 512 * 1024) stop('fixture hook output bound exceeded');
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { failure = error; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (failure || signal || status === null) reject(new Error(`${failure?.message ?? 'hook interrupted'}\n${output.slice(-4000)}`));
      else accept({ status, output });
    });
    child.stdin.on('error', error => { failure = error; });
    child.stdin.end(input);
  });
}
async function runHook(f: Fixture) {
  const input = `refs/heads/main ${git(f, 'rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`;
  const result = await executeHook(f, input);
  expect(readFileSync(join(f.repo, 'gate-args.txt'), 'utf8')).toBe('--pre-push\n');
  expect(readFileSync(join(f.repo, 'gate-stdin.txt'), 'utf8')).toBe(input);
  expect(readdirSync(f.scratch)).toEqual([]); // Hook-owned archive and dependency link were removed.
  return result;
}
async function rejectsCommittedError(f: Fixture) {
  const result = await runHook(f);
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('error TS2322');
  expect(result.output).toContain('committed HEAD does not typecheck');
  expect(result.output.indexOf('fixture publish gate')).toBeLessThan(result.output.indexOf('typechecking COMMITTED HEAD'));
}

afterEach(() => {
  for (const root of owned) {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('oshal-prepush-range-')) throw new Error('fixture cleanup path refused');
    const link = join(root, 'repo/node_modules');
    if (existsSync(link)) unlinkSync(link); // Remove the junction itself, never recurse into installed dependencies.
    rmSync(root, { recursive: true, force: true });
  }
  owned.clear();
});

// Leave time for the owned 30-second hook deadline and process-tree teardown before test cleanup.
describe.sequential('pre-push range admission / real Git, hook, archive and installed compiler', { timeout: 45_000 }, () => {
  it('refuses unknown-range earlier broken source despite a final docs commit and a repaired working tree', async () => {
    const f = fixture(); source(f); docs(f);
    expect(command(f, 'git', ['rev-parse', '--verify', '@{push}']).status).not.toBe(0);
    expect(git(f, 'diff', '--name-only', 'HEAD~1..HEAD')).toBe('notes.md');
    writeFileSync(join(f.repo, 'src/index.ts'), GOOD);
    await rejectsCommittedError(f);
  });

  it('refuses unknown-range source behind a final docs-only merge, not just a linear history', async () => {
    const f = fixture(); const base = git(f, 'rev-parse', 'HEAD'); source(f);
    git(f, 'switch', '-c', 'fixture-docs', base); docs(f); git(f, 'switch', 'main');
    git(f, 'merge', '--no-ff', '-m', 'docs: merge fixture documentation', 'fixture-docs');
    expect(git(f, 'diff', '--name-only', 'HEAD~1..HEAD')).toBe('notes.md');
    expect(git(f, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    await rejectsCommittedError(f);
  });

  it('verifies valid committed HEAD when the unknown range ends with documentation', async () => {
    const f = fixture(); docs(f); const result = await runHook(f);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('typechecking COMMITTED HEAD');
    expect(result.output).toContain('committed HEAD typechecks');
  });

  it('preserves the known-range docs-only optimization after the publish gate', async () => {
    const f = fixture(); tracking(f); docs(f);
    expect(git(f, 'diff', '--name-only', '@{push}..HEAD')).toBe('notes.md');
    const result = await runHook(f); expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('fixture publish gate');
    expect(result.output).not.toContain('typechecking COMMITTED HEAD');
  });

  it('still refuses source changes in a known complete range even when the last commit is docs-only', async () => {
    const f = fixture(); tracking(f); source(f); docs(f);
    expect(git(f, 'diff', '--name-only', '@{push}..HEAD')).toContain('src/index.ts');
    await rejectsCommittedError(f);
  });

  it('treats a configured but missing remote-tracking ref as unknown, not as docs-only', async () => {
    const f = fixture(); tracking(f); git(f, 'update-ref', '-d', 'refs/remotes/origin/main'); source(f); docs(f);
    expect(command(f, 'git', ['rev-parse', '--verify', '@{push}']).status).not.toBe(0);
    await rejectsCommittedError(f);
  });

  it.each([false, true])('publish-gate refusal prevents verification or docs optimization (known range: %s)', async known => {
    const f = fixture(1); if (known) tracking(f); docs(f);
    const result = await runHook(f); expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('BLOCKED by the publish gate');
    expect(result.output).not.toContain('typechecking COMMITTED HEAD');
  });
});
