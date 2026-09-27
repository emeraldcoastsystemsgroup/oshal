/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared harness for the ADR-167 core release pipeline specs (cut-release, promote, the on-box managed release helper, the drift check). Each spec runs the SHIPPED script in a real Git Bash against real git repositories (a bare origin plus a clone), with only the commands that would reach an engine, a registry or another host - docker, ssh, curl, the probe runners - replaced by recording stand-ins on PATH. One copy of the shell resolution and the fixture plumbing, so the four specs cannot drift into driving a different shell or a different stand-in contract.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUN_TIMEOUT_MS = 120_000;

/**
 * @description Forward-slash form of a path, which Git Bash, git and the scripts accept on Windows.
 * @param p a native path
 * @returns the path with every backslash turned into a slash
 */
export function posix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * @description Git Bash's own absolute path form (`/c/...` on Windows): the scripts' trust walks
 * and remote-path patterns require a path that starts with `/`.
 * @param p a native path
 * @returns the POSIX absolute path Git Bash uses for it
 */
export function msys(p: string): string {
  const slashed = posix(p);
  return process.platform === 'win32' ? slashed.replace(/^([A-Za-z]):\//, (_m, d: string) => `/${d.toLowerCase()}/`) : slashed;
}

/**
 * @description Locate Git Bash without falling into Windows' WSL launcher (another filesystem
 * namespace, which would judge a different tree than the one a case built).
 * @returns the bash executable to run
 */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1) {
    for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing a different shell namespace');
}

export const BASH = resolveBash();

/**
 * @description Create a scratch directory and register it for removal.
 * @param prefix directory name prefix
 * @param cleanup the spec's cleanup list
 * @returns the new directory (native form)
 */
export function scratchDir(prefix: string, cleanup: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

/**
 * @description Write an LF-only executable file, creating its directory.
 * @param file target path
 * @param lines file content, one entry per line
 */
export function writeExec(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 });
}

/**
 * @description Run git with a fixed identity and no host configuration leaking into the case.
 * @param cwd the repository
 * @param args git arguments
 * @returns trimmed stdout
 */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=oshal maintainers', '-c', 'user.email=maintainer@emeraldcoastsystemsgroup.com',
    '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** A bare origin and a clone of it, both real repositories. */
export interface FixtureRepo {
  origin: string;
  work: string;
}

/**
 * @description Build a bare origin plus a working clone whose first commit holds `files`, pushed to main.
 * @param root scratch directory to build in
 * @param files repository-relative path -> content
 * @returns the two repository paths
 */
export function makeRepo(root: string, files: Record<string, string>): FixtureRepo {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', posix(origin), work);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content, { mode: rel.endsWith('.sh') ? 0o755 : 0o644 });
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fixture: initial');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  return { origin, work };
}

/**
 * @description Commit one more change on top of the clone and optionally publish it to origin/main.
 * @param work the clone
 * @param rel file to write
 * @param content its content
 * @param publish push to origin main when true
 * @returns the new commit's full sha
 */
export function commitChange(work: string, rel: string, content: string, publish = true): string {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), content);
  git(work, 'add', '--', rel);
  git(work, 'commit', '-q', '-m', `fixture: change ${rel}`);
  if (publish) git(work, 'push', '-q', 'origin', 'HEAD:main');
  return git(work, 'rev-parse', 'HEAD');
}

/** A finished script run. */
export interface Run {
  status: number | null;
  out: string;
}

/**
 * @description Run a shipped script in Git Bash with `bin` first on PATH (so its stand-ins win) and an
 * environment scrubbed of every OSHAL_* variable of the calling shell.
 * @param script the script to run
 * @param args its arguments
 * @param bin directory of stand-ins to put first on PATH
 * @param env extra environment for the case
 * @returns exit status and combined output
 */
export function runScript(script: string, args: string[], bin: string, env: Record<string, string> = {}): Run {
  const runner = path.join(bin, '..', 'run-under-shims.sh');
  if (!fs.existsSync(runner)) {
    writeExec(runner, [
      '#!/usr/bin/env bash',
      'bin="$1"; shift; target="$1"; shift',
      'if command -v cygpath >/dev/null 2>&1; then bin="$(cygpath -u "$bin")"; target="$(cygpath -u "$target")"; fi',
      'chmod +x "$bin"/* 2>/dev/null',
      'export PATH="$bin:$PATH"',
      'exec bash "$target" "$@"',
    ]);
  }
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith('OSHAL_')) base[key] = value;
  const result = spawnSync(BASH, [posix(runner), posix(bin), posix(script), ...args], {
    encoding: 'utf8', timeout: RUN_TIMEOUT_MS, env: { ...base, ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * @description Run an inline bash program under the same stand-ins (used to source a script's
 * functions without executing its entrypoint).
 * @param program bash source
 * @param bin directory of stand-ins to put first on PATH
 * @param env extra environment for the case
 * @returns exit status and combined output
 */
export function runProgram(program: string, bin: string, env: Record<string, string> = {}): Run {
  const file = path.join(bin, '..', `program-${Math.random().toString(36).slice(2)}.sh`);
  writeExec(file, ['#!/usr/bin/env bash', program]);
  return runScript(file, [], bin, env);
}

/**
 * @description Read a text file, or '' when it does not exist.
 * @param file the path
 * @returns its content
 */
export function readOr(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
