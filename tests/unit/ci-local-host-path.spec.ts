/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard for the local CI runner on a host without cygpath (the Spark). It called cygpath unguarded for its state directory, the gitleaks mount and the standalone quiesce restore, so on Linux the state directory became /oshal and every nightly ended "another ci-local run is in progress", exit 2. Each case runs the shipped shell in a real bash on the real filesystem: scripts/ci/ci-host-path.sh, scripts/ci-local.sh itself up to its lock, the gitleaks_container_scan text sliced from it, and scripts/ci/ci-quiesce.sh's standalone entry. The Linux cases first prove cygpath is absent from the PATH they run on; a cygpath stand-in proves the Git Bash translation is unchanged where cygpath exists.
 */

/**
 * The local CI runner on a host without cygpath.
 *
 * `docker` is always a recording stand-in first on PATH and DOCKER_HOST points at a closed loopback
 * port, so no case can reach an engine: the runner cases end at the state directory or the lock,
 * before anything would start a container, and the mount case records the scanner's argv only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BASH, ROOT, functionBody, toBash } from '../helpers/ci-local-probe';

const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-host-path-'));
const HELPER = toBash(join(ROOT, 'scripts', 'ci', 'ci-host-path.sh'));
const CI_LOCAL = toBash(join(ROOT, 'scripts', 'ci-local.sh'));
const QUIESCE = toBash(join(ROOT, 'scripts', 'ci', 'ci-quiesce.sh'));
const RUNNER_FILES = ['scripts/ci-local.sh', 'scripts/ci/ci-quiesce.sh', 'scripts/operations/ci-quiesce-live-proof.sh'];
const CASE_TIMEOUT = 60_000;
/** Git Bash always carries cygpath, so the no-cygpath cases can only be judged on a POSIX host. */
const WINDOWS = process.platform === 'win32';
let seq = 0;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** @description A fresh directory under this spec's scratch tree. @param name prefix. @returns its path. */
function scratch(name: string): string {
  seq += 1;
  const dir = join(SCRATCH, `${name}-${seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @description Stand-in tools: `docker` records each argv line; `cygpath`, when asked for, answers
 * `CYG[<flag>]<path>` so a case can see exactly which translation was requested.
 * @param withCygpath whether to provide the cygpath stand-in.
 * @returns the stand-in bin directory.
 */
function standIns(withCygpath: boolean): string {
  const bin = scratch('bin');
  writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$(dirname "$0")/docker-calls.log"\n', { mode: 0o755 });
  if (withCygpath) {
    writeFileSync(join(bin, 'cygpath'), '#!/usr/bin/env bash\nprintf \'CYG[%s]%s\' "$1" "$2"\n', { mode: 0o755 });
  }
  return bin;
}

/** @description Every argv line the docker stand-in in `bin` received. @param bin stand-in dir. @returns the lines. */
function dockerCalls(bin: string): string[] {
  const file = join(bin, 'docker-calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/**
 * @description The caller's environment without anything that could steer the runner from outside
 * the case (every OSHAL_* setting, LOCALAPPDATA, XDG_STATE_HOME, DOCKER_HOST), plus the case's own.
 * @param extra the settings this case wants.
 * @returns the environment.
 */
function caseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OSHAL_.*|LOCALAPPDATA|XDG_STATE_HOME|DOCKER_HOST)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, OSHAL_CI_ENV_FILE: join(SCRATCH, 'no-such.env'), DOCKER_HOST: 'tcp://127.0.0.1:9', ...extra };
}

/**
 * @description Run `body` in bash with the stand-ins first on PATH. When `noCygpath` is set the
 * probe refuses to continue if any cygpath is reachable, so a pass is never a host that has one.
 * @param bin stand-in directory.
 * @param body the shell to run; its positional parameters are `args`.
 * @param args arguments for the body.
 * @param env the case environment.
 * @param noCygpath require that no cygpath is on PATH.
 * @returns exit status and combined output.
 */
function run(bin: string, body: string, args: string[], env: NodeJS.ProcessEnv, noCygpath: boolean): { status: number | null; out: string } {
  const probe = join(scratch('probe'), 'probe.sh');
  writeFileSync(probe, [
    '#!/usr/bin/env bash',
    'FAKE_BIN="$1"; shift',
    // PATH entries must be POSIX-form under MSYS: a C:/... entry splits on its colon.
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    'export PATH="$FAKE_BIN:$PATH"',
    'command -v docker | grep -q "^$FAKE_BIN/docker$" || { echo "stand-in docker is not first on PATH" >&2; exit 97; }',
    noCygpath ? 'if command -v cygpath >/dev/null 2>&1; then echo "cygpath is on PATH: $(command -v cygpath)" >&2; exit 96; fi' : '',
    body,
  ].join('\n') + '\n');
  const result = spawnSync(BASH, [toBash(probe), toBash(bin), ...args], { env, encoding: 'utf8', timeout: CASE_TIMEOUT - 5_000 });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** @description Print ci_state_dir for an environment. @param bin stand-ins. @param env case env. @param noCygpath see run. */
const stateDirFor = (bin: string, env: NodeJS.ProcessEnv, noCygpath: boolean) =>
  run(bin, '. "$1"; ci_state_dir', [HELPER], env, noCygpath);

/** @description Run the real scripts/ci-local.sh (no flags) under the stand-ins. @param bin stand-ins. @param env case env. */
const ciLocal = (bin: string, env: NodeJS.ProcessEnv) => run(bin, 'bash "$1"', [CI_LOCAL], env, true);

/** @description The production gitleaks_container_scan, sliced from ci-local.sh, run on `exportDir`. */
const mountRun = (bin: string, exportDir: string, noCygpath: boolean) =>
  run(bin, `. "$1"\n${functionBody('gitleaks_container_scan')}\ngitleaks_container_scan "$2"`, [HELPER, toBash(exportDir)], caseEnv({}), noCygpath);

describe.skipIf(WINDOWS)('scripts/ci/ci-host-path.sh on a host without cygpath', () => {
  it('derives the state directory from LOCALAPPDATA, then XDG_STATE_HOME, then ~/.local/state', () => {
    const bin = standIns(false);
    const home = scratch('home');
    const fromLocal = stateDirFor(bin, caseEnv({ HOME: home, LOCALAPPDATA: '/srv/local-app-data', XDG_STATE_HOME: '/srv/xdg' }), true);
    expect(fromLocal, fromLocal.out).toEqual({ status: 0, out: '/srv/local-app-data/oshal' });
    const fromXdg = stateDirFor(bin, caseEnv({ HOME: home, XDG_STATE_HOME: '/srv/xdg' }), true);
    expect(fromXdg, fromXdg.out).toEqual({ status: 0, out: '/srv/xdg/oshal' });
    const fromHome = stateDirFor(bin, caseEnv({ HOME: home }), true);
    expect(fromHome, fromHome.out).toEqual({ status: 0, out: `${toBash(home)}/.local/state/oshal` });
  }, CASE_TIMEOUT);

  it('hands a path to the host unchanged', () => {
    const result = run(standIns(false), '. "$1"; host_path "$2"', [HELPER, '/var/tmp/ci-scan-src'], caseEnv({}), true);
    expect(result).toEqual({ status: 0, out: '/var/tmp/ci-scan-src' });
  }, CASE_TIMEOUT);

  it('creates a usable state directory, and names the real cause when it cannot', () => {
    const bin = standIns(false);
    const fresh = join(scratch('state'), 'nested', 'oshal');
    const made = run(bin, '. "$1"; ci_state_dir_ready "$2"', [HELPER, toBash(fresh)], caseEnv({}), true);
    expect(made.status, made.out).toBe(0);
    expect(existsSync(fresh)).toBe(true);
    const blocker = join(scratch('blocked'), 'a-file');
    writeFileSync(blocker, 'not a directory\n');
    const refused = run(bin, '. "$1"; ci_state_dir_ready "$2"', [HELPER, toBash(join(blocker, 'oshal'))], caseEnv({}), true);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain(`cannot create the state directory ${toBash(join(blocker, 'oshal'))}`);
    expect(refused.out).toContain('Not a directory');
    expect(refused.out).toContain('set LOCALAPPDATA or XDG_STATE_HOME to a writable directory');
  }, CASE_TIMEOUT);
});

describe('where cygpath exists (Git Bash), the translation is exactly what it was', () => {
  it('derives the state directory through cygpath -u and the mount source through cygpath -m', () => {
    const bin = standIns(true);
    const home = scratch('home');
    const local = stateDirFor(bin, caseEnv({ HOME: home, LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local' }), false);
    expect(local).toEqual({ status: 0, out: 'CYG[-u]C:\\Users\\op\\AppData\\Local/oshal' });
    const fallback = stateDirFor(bin, caseEnv({ HOME: home }), false);
    expect(fallback).toEqual({ status: 0, out: `CYG[-u]${toBash(home)}/AppData/Local/oshal` });
    const exportDir = scratch('export');
    const mount = mountRun(bin, exportDir, false);
    expect(mount.status, mount.out).toBe(0);
    expect(dockerCalls(bin)).toEqual([
      `run --rm --network none -v CYG[-m]${toBash(exportDir)}:/scan:ro zricethezav/gitleaks:latest detect --source=/scan --no-git --config=/scan/.gitleaks.toml --redact`,
    ]);
  }, CASE_TIMEOUT);
});

describe.skipIf(WINDOWS)('scripts/ci-local.sh on a host without cygpath', () => {
  it('mounts the export itself into the secret scanner, never an empty source', () => {
    const bin = standIns(false);
    const exportDir = scratch('export');
    const mount = mountRun(bin, exportDir, true);
    expect(mount.status, mount.out).toBe(0);
    expect(dockerCalls(bin)).toEqual([
      `run --rm --network none -v ${toBash(exportDir)}:/scan:ro zricethezav/gitleaks:latest detect --source=/scan --no-git --config=/scan/.gitleaks.toml --redact`,
    ]);
  }, CASE_TIMEOUT);

  it('exits 4 naming a state directory it cannot create - never "another run is in progress" - and starts nothing', () => {
    const bin = standIns(false);
    const blocker = join(scratch('blocked'), 'a-file');
    writeFileSync(blocker, 'not a directory\n');
    const result = ciLocal(bin, caseEnv({ HOME: scratch('home'), LOCALAPPDATA: toBash(blocker) }));
    expect(result.status, result.out).toBe(4);
    expect(result.out).toContain(`cannot create the state directory ${toBash(blocker)}/oshal`);
    expect(result.out).toContain('Not a directory');
    expect(result.out).not.toContain('another ci-local run is in progress');
    expect(result.out).not.toContain('GATE ');
    expect(dockerCalls(bin)).toEqual([]);
  }, CASE_TIMEOUT);

  it('exits 4 with the mkdir error when the lock path cannot be created, and leaves what is there alone', () => {
    const bin = standIns(false);
    const local = scratch('localappdata');
    const lock = join(local, 'oshal', 'ci-local.lock');
    mkdirSync(join(local, 'oshal'), { recursive: true });
    writeFileSync(lock, 'a file squatting the lock path\n');
    const result = ciLocal(bin, caseEnv({ HOME: scratch('home'), LOCALAPPDATA: toBash(local) }));
    expect(result.status, result.out).toBe(4);
    expect(result.out).toContain(`cannot create the run lock ${toBash(lock)}`);
    expect(result.out).toContain('File exists');
    expect(result.out).not.toContain('another ci-local run is in progress');
    expect(readFileSync(lock, 'utf8')).toBe('a file squatting the lock path\n');
    expect(dockerCalls(bin)).toEqual([]);
  }, CASE_TIMEOUT);

  it('still exits 2, "in progress", when another run holds the lock - and does not take it from that run', () => {
    const bin = standIns(false);
    const local = scratch('localappdata');
    const lock = join(local, 'oshal', 'ci-local.lock');
    mkdirSync(lock, { recursive: true });
    const held = `${Math.floor(Date.now() / 1000)}\n`;
    writeFileSync(join(lock, 'ts'), held);
    const result = ciLocal(bin, caseEnv({ HOME: scratch('home'), LOCALAPPDATA: toBash(local) }));
    expect(result.status, result.out).toBe(2);
    expect(result.out).toContain('another ci-local run is in progress - exiting');
    expect(readFileSync(join(lock, 'ts'), 'utf8')).toBe(held);
    expect(existsSync(join(local, 'oshal', 'ci-local.log')), 'the run logs to the derived directory').toBe(true);
    expect(dockerCalls(bin)).toEqual([]);
  }, CASE_TIMEOUT);
});

describe.skipIf(WINDOWS)('scripts/ci/ci-quiesce.sh on its own, on a host without cygpath', () => {
  it('--resume reads the same state directory ci-local.sh writes', () => {
    const bin = standIns(false);
    const local = scratch('localappdata');
    const env = caseEnv({ HOME: scratch('home'), LOCALAPPDATA: toBash(local) });
    const nothing = run(bin, 'bash "$1" --resume', [QUIESCE], env, true);
    expect(nothing.status, nothing.out).toBe(0);
    expect(nothing.out).toContain(`quiesce: no ${toBash(local)}/oshal/ci-quiesce.state - nothing to restore`);
    mkdirSync(join(local, 'oshal', 'ci-local.lock'), { recursive: true });
    const held = run(bin, 'bash "$1" --resume', [QUIESCE], env, true);
    expect(held.status, held.out).toBe(2);
    expect(held.out).toContain(`a ci-local run holds ${toBash(local)}/oshal/ci-local.lock`);
    expect(dockerCalls(bin)).toEqual([]);
  }, CASE_TIMEOUT);
});

describe('no runner file calls cygpath except through scripts/ci/ci-host-path.sh', () => {
  it('leaves cygpath only in comments of the three files that called it unguarded', () => {
    for (const file of RUNNER_FILES) {
      const code = readFileSync(join(ROOT, file), 'utf8').split('\n').filter((line) => !/^\s*#/.test(line));
      expect(code.filter((line) => line.includes('cygpath')), file).toEqual([]);
      expect(code.some((line) => line.includes('scripts/ci/ci-host-path.sh')), `${file} sources the helper`).toBe(true);
    }
  });
});
