/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove scheduled Local CI fetches and pins origin/main, interactive --head remains on HEAD, failed fetch is a labeled HEAD fallback, every committed-source consumer uses the pinned SHA, and the hidden launcher propagates the real gate exit.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CI_PATH = join(ROOT, 'scripts', 'ci-local.sh');
const LAUNCHER_PATH = join(ROOT, 'scripts', 'ci-local-hidden.vbs');
const CI_SOURCE = readFileSync(CI_PATH, 'utf8');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-source-ref-'));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** @description Locate Git Bash without falling into Windows' WSL launcher. */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up++) {
    for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing the WSL bash on PATH');
}

const BASH = resolveBash();

/** @description Run Git against a disposable repository with prompts disabled. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/** @description Commit one generation marker and return its immutable SHA. */
function commitGeneration(repo: string, generation: string): string {
  writeFileSync(join(repo, 'generation.txt'), generation);
  git(repo, 'add', '--', 'generation.txt');
  git(repo, 'commit', '--quiet', '-m', `generation ${generation}`);
  return git(repo, 'rev-parse', 'HEAD');
}

interface Fixture {
  operator: string;
  headSha: string;
  remoteMainSha: string;
}

/** @description Create stale origin/main tracking plus a divergent local topic HEAD. */
function createFixture(name: string): Fixture {
  const base = join(SCRATCH, name);
  const origin = join(base, 'origin.git');
  const writer = join(base, 'writer');
  const operator = join(base, 'operator');
  mkdirSync(base, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'main', writer], { stdio: 'ignore' });
  git(writer, 'config', 'user.name', 'OSHAL Maintainer');
  git(writer, 'config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  commitGeneration(writer, 'A');
  git(writer, 'remote', 'add', 'origin', origin);
  git(writer, 'push', '--quiet', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '--quiet', origin, operator]);
  git(operator, 'config', 'user.name', 'OSHAL Maintainer');
  git(operator, 'config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  git(operator, 'switch', '-c', 'topic');
  const headSha = commitGeneration(operator, 'TOPIC');
  const remoteMainSha = commitGeneration(writer, 'B');
  git(writer, 'push', '--quiet', 'origin', 'main');
  return { operator, headSha, remoteMainSha };
}

/** @description Extract the production resolver without executing the full multi-hour gate. */
function resolverSource(): string {
  const start = CI_SOURCE.indexOf('SOURCE_REF=HEAD');
  const end = CI_SOURCE.indexOf('# GATE_SRC is where', start);
  if (start < 0 || end < 0) throw new Error('ci-local source-ref markers are missing');
  return CI_SOURCE.slice(start, end);
}

interface Resolution {
  ref: string;
  sha: string;
  posture: string;
  output: string;
}

/** @description Execute the real resolver body against one disposable checkout. */
function resolveFixture(fixture: Fixture, scheduled: boolean): Resolution {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probe = join(SCRATCH, `probe-${suffix}.sh`);
  const script = `#!/usr/bin/env bash\nset -uo pipefail\nREPO_DIR="$1"\nSCHEDULED="$2"\nHEAD_MODE=1\nlog(){ printf 'LOG:%s\\n' "$*"; }\n${resolverSource()}\nresolve_source_commit || exit 9\nprintf 'RESULT:%s|%s|%s\\n' "$SOURCE_REF" "$SOURCE_SHA" "$SOURCE_POSTURE"\n`;
  writeFileSync(probe, script);
  const repoArg = fixture.operator.replaceAll('\\', '/');
  const probeArg = probe.replaceAll('\\', '/');
  const result = spawnSync(BASH, [probeArg, repoArg, scheduled ? '1' : '0'], {
    encoding: 'utf8', timeout: 20_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = output.match(/RESULT:([^|]+)\|([0-9a-f]{40,64})\|([^\r\n]+)/);
  expect(match, output).toBeTruthy();
  return { ref: match![1], sha: match![2], posture: match![3], output };
}

describe('scheduled Local CI immutable source selection', () => {
  it('fetches and pins origin/main even when local HEAD is a divergent topic', () => {
    const fixture = createFixture('scheduled-origin-main');
    const resolved = resolveFixture(fixture, true);
    expect(resolved).toMatchObject({
      ref: 'origin/main', sha: fixture.remoteMainSha, posture: 'scheduled-origin-main',
    });
    expect(git(fixture.operator, 'rev-parse', 'HEAD')).toBe(fixture.headSha);
  }, 30_000);

  it('keeps interactive --head on local HEAD without fetching origin/main', () => {
    const fixture = createFixture('interactive-head');
    const before = git(fixture.operator, 'rev-parse', 'refs/remotes/origin/main');
    const resolved = resolveFixture(fixture, false);
    expect(resolved).toMatchObject({ ref: 'HEAD', sha: fixture.headSha, posture: 'interactive-head' });
    expect(git(fixture.operator, 'rev-parse', 'refs/remotes/origin/main')).toBe(before);
  }, 30_000);

  it('labels a failed scheduled fetch and falls back to the already-pinned HEAD', () => {
    const fixture = createFixture('fetch-failure');
    const missing = join(SCRATCH, 'missing-origin.git').replaceAll('\\', '/');
    git(fixture.operator, 'remote', 'set-url', 'origin', missing);
    const resolved = resolveFixture(fixture, true);
    expect(resolved).toMatchObject({
      ref: 'HEAD', sha: fixture.headSha, posture: 'DEGRADED_FETCH_FAILED_HEAD_FALLBACK',
    });
    expect(resolved.output).toContain('WARNING DEGRADED_FETCH_FAILED_HEAD_FALLBACK');
  }, 30_000);

  it('threads SOURCE_SHA through every archive/build and reports the same identity', () => {
    expect(CI_SOURCE).not.toMatch(/git archive HEAD/);
    expect(CI_SOURCE.match(/git archive "\$SOURCE_SHA"/g)).toHaveLength(3);
    expect(CI_SOURCE).toContain('archive-ref=$SOURCE_REF sha=$SOURCE_SHORT_SHA posture=$SOURCE_POSTURE');
    expect(CI_SOURCE).toContain('(source $SOURCE_REF $SOURCE_SHORT_SHA; posture=$SOURCE_POSTURE)');
  });
});

describe('scheduled Local CI hidden launcher', () => {
  it('waits for the gate and propagates its exit status to Task Scheduler', () => {
    const launcherSource = readFileSync(LAUNCHER_PATH, 'utf8');
    expect(launcherSource).toMatch(/sh\.Run\(command,\s*0,\s*True\)/);
    expect(launcherSource).toMatch(/WScript\.Quit\s+exitCode/);
    if (process.platform !== 'win32') return;
    const root = join(SCRATCH, 'launcher-exit');
    const scripts = join(root, 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(LAUNCHER_PATH, join(scripts, 'ci-local-hidden.vbs'));
    writeFileSync(join(scripts, 'ci-local.sh'), '#!/usr/bin/env bash\nexit 37\n');
    const launcher = join(scripts, 'ci-local-hidden.vbs');
    const run = spawnSync('cscript.exe', ['//B', '//Nologo', launcher], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(37);
  });
});
