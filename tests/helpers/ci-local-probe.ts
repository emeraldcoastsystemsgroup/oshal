/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Shared harness for the nightly-gate quiesce and resource-exhausted guards. They run the PRODUCTION text of scripts/ci-local.sh (functions and blocks sliced by their real markers) and its scripts/ci helpers in Git Bash, against a stateful `docker` stand-in first on PATH and an Alertmanager stand-in on a real loopback HTTP port, so the claims are about what the shipped shell actually does. Nothing here can reach the live engine: the stand-in is verified first on PATH inside every probe, and DOCKER_HOST points at a closed loopback port in case anything were to slip past it. Output goes to files, never pipes, so a probe killed mid-gate cannot leave an orphan holding the runner open.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | JSDoc for the exported BASH; runBash takes an optional working directory, so a case can run the standalone --plan from a directory holding decoy files.
 */
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';

/** @description The checkout under test (the probes read its real routability list and compose file). */
export const ROOT = resolve(__dirname, '../..');
/** @description The shipped scripts/ci-local.sh text every slice is cut from. */
export const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
/** @description The settings loader ci-local.sh's helpers source. */
export const CONFIG_HELPER = join(ROOT, 'scripts', 'ci', 'ci-config.sh').replaceAll('\\', '/');
/** @description The resource check ci-local.sh sources. */
export const RESOURCE_HELPER = join(ROOT, 'scripts', 'ci', 'ci-resource.sh').replaceAll('\\', '/');
/** @description The worker quiesce ci-local.sh sources (and its standalone --plan/--resume entry). */
export const QUIESCE_HELPER = join(ROOT, 'scripts', 'ci', 'ci-quiesce.sh').replaceAll('\\', '/');

/** @description Locate Git Bash without falling into Windows' WSL launcher. @returns the bash path. */
export function resolveBash(): string {
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

/**
 * @description The Git Bash every probe runs in, resolved once per spec file. Never WSL's bash:
 * ci-local.sh and its helpers run under Git Bash on this box, and that is the shell being judged.
 */
export const BASH = resolveBash();

/** @description Forward slashes for a path handed to Git Bash. @param p a host path. @returns the path. */
export const toBash = (p: string): string => p.replaceAll('\\', '/');

/**
 * @description Slice one shell function out of ci-local.sh, so the probe runs the production text.
 * @param name the function to slice.
 * @returns its source, from `name() {` through its closing brace.
 */
export function functionBody(name: string): string {
  const start = CI_SOURCE.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} is missing from ci-local.sh`);
  return CI_SOURCE.slice(start, CI_SOURCE.indexOf('\n}\n', start) + 3);
}

/**
 * @description Slice production lines between two markers that must both exist in ci-local.sh.
 * @param from the first line's exact text (included).
 * @param to the last line's exact text (included).
 * @returns the block, newline-terminated.
 */
export function blockBetween(from: string, to: string): string {
  const start = CI_SOURCE.indexOf(from);
  if (start < 0) throw new Error(`ci-local.sh no longer contains: ${from}`);
  const end = CI_SOURCE.indexOf(to, start);
  if (end < 0) throw new Error(`ci-local.sh no longer contains, after it: ${to}`);
  return `${CI_SOURCE.slice(start, end + to.length)}\n`;
}

/**
 * @description The production run-start wiring: resource posture, leftover restore, and the quiesce.
 * @returns the block, from `ci_resource_init` through the quiesce call.
 */
export const START_BLOCK = (): string => blockBetween('ci_resource_init\n', '[ "$QUIESCE" = "1" ] && ci_quiesce_begin');
/**
 * @description The production end of the run: restore, the publish decision, and the outcome line.
 * @returns the block, from the end-of-run restore through the outcome line.
 */
export const END_BLOCK = (): string => blockBetween(
  'ci_quiesce_resume || FAILED_GATES+=(quiesce-resume-failed)', 'log "=== LOCAL CI: $OUTCOME ==="',
);
/**
 * @description The two production trap lines, verbatim, after checking ci-local.sh still installs both.
 * @returns both lines, newline-terminated.
 */
export function trapLines(): string {
  for (const line of ['trap on_exit EXIT', "trap 'on_exit; exit 130' INT TERM"]) {
    if (!CI_SOURCE.includes(`\n${line}\n`)) throw new Error(`ci-local.sh no longer installs: ${line}`);
  }
  return "trap on_exit EXIT\ntrap 'on_exit; exit 130' INT TERM\n";
}

/** What a fixture container looks like to the stand-in. */
export interface FixtureContainer { status: string; tier?: string; env?: string[]; failStart?: boolean; failStop?: boolean }

/**
 * @description Write a stateful `docker` stand-in: each container is a directory holding its status,
 * tier label and environment; inspect/stop/start read and change it, every call is recorded, and
 * any other subcommand (on_exit's rm/network/volume cleanup) is recorded and succeeds.
 * @param dir scratch directory for this probe.
 * @param containers the fixture containers to seed.
 * @returns the stand-in's bin directory and its state directory.
 */
export function dockerStandIn(dir: string, containers: Record<string, FixtureContainer>): { bin: string; state: string } {
  const bin = join(dir, 'bin');
  const state = join(dir, 'docker-state');
  mkdirSync(bin, { recursive: true });
  for (const [name, c] of Object.entries(containers)) {
    const d = join(state, 'containers', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'status'), c.status);
    writeFileSync(join(d, 'tier'), c.tier ?? '');
    writeFileSync(join(d, 'env'), (c.env ?? []).map((line) => `${line}\n`).join(''));
    if (c.failStart) writeFileSync(join(d, 'fail-start'), '');
    if (c.failStop) writeFileSync(join(d, 'fail-stop'), '');
  }
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'S="${DOCKER_STANDIN_STATE:?}"',
    'printf \'%s\\n\' "$*" >> "$S/calls.log"',
    'cmd="${1-}"; shift || true',
    '[ "$cmd" = inspect ] && [ "${1-}" = --format ] && shift 2',
    'd="$S/containers/${1-}"',
    'case "$cmd" in',
    '  inspect) [ -d "$d" ] || { echo "Error: No such object: ${1-}" >&2; exit 1; }',
    '    printf \'%s\\n%s\\n\' "$(cat "$d/status")" "$(cat "$d/tier")"; cat "$d/env" ;;',
    '  stop) [ -d "$d" ] && [ ! -f "$d/fail-stop" ] || exit 1; printf exited > "$d/status"; echo "$1" ;;',
    '  start) [ -d "$d" ] && [ ! -f "$d/fail-start" ] || exit 1; printf running > "$d/status"; echo "$1" ;;',
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'));
  return { bin, state };
}

/**
 * @description A container's status as the stand-in last left it.
 * @param state the stand-in's state directory.
 * @param name the container.
 * @returns running, exited, ...
 */
export const statusOf = (state: string, name: string): string => readFileSync(join(state, 'containers', name, 'status'), 'utf8');
/**
 * @description Every docker call the stand-in received.
 * @param state the stand-in's state directory.
 * @returns one argv line per call, in order.
 */
export const dockerCalls = (state: string): string[] => {
  const file = join(state, 'calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};

/** One request the Alertmanager stand-in received. */
export interface SilenceRequest { method: string; url: string; body: Record<string, unknown> | null }

/**
 * @description An Alertmanager stand-in on a real loopback port: POST /api/v2/silences records the
 * body and answers with a silenceID (the posted id when the body carries one), the way the v2 API does.
 * @param mode 'ok' answers 200; 'fail' answers 500 to everything.
 * @returns its base URL, the recorded requests, and a closer.
 */
export async function alertmanagerStandIn(mode: 'ok' | 'fail' = 'ok'): Promise<{ url: string; requests: SilenceRequest[]; close: () => Promise<void> }> {
  const requests: SilenceRequest[] = [];
  let next = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (mode === 'fail' || req.method !== 'POST' || req.url !== '/api/v2/silences') {
        res.writeHead(mode === 'fail' ? 500 : 404); res.end('stand-in refusal'); return;
      }
      next += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ silenceID: (body?.id as string | undefined) ?? `fixture-silence-${next}` }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((done) => server.close(() => done())) };
}

/**
 * @description The environment a probe runs in: the caller's settings only. Every OSHAL_CI_* and
 * OSHAL_UP_* name the host carries is dropped, .env is pointed at a file that does not exist, and
 * DOCKER_HOST at a closed loopback port, so nothing on this machine can change or receive the result.
 * @param dir scratch directory (the stand-in state lives here).
 * @param extra the settings this case wants.
 * @returns the environment.
 */
export function probeEnv(dir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^OSHAL_(CI|UP)_/i.test(key)) continue;
    // Windows spells it `Path`; a caller's PATH must replace it, not sit beside it.
    if ('PATH' in extra && key.toUpperCase() === 'PATH') continue;
    env[key] = value;
  }
  return {
    ...env,
    OSHAL_CI_ENV_FILE: join(dir, 'no-such.env'),
    DOCKER_HOST: 'tcp://127.0.0.1:9',
    DOCKER_STANDIN_STATE: toBash(join(dir, 'docker-state')),
    ...extra,
  };
}

/**
 * @description Run Git Bash asynchronously (an in-process HTTP stand-in must keep answering), with
 * output to a file rather than a pipe.
 * @param args bash arguments.
 * @param env the environment.
 * @param outFile where stdout and stderr go.
 * @param timeoutMs hard bound; the process is killed past it.
 * @param cwd working directory for the shell (default: this process's).
 * @returns the exit status and the output.
 */
export async function runBash(args: string[], env: NodeJS.ProcessEnv, outFile: string, timeoutMs: number, cwd?: string): Promise<{ status: number | null; output: string }> {
  const fd = openSync(outFile, 'w');
  try {
    const child = spawn(BASH, args, { env, cwd, stdio: ['ignore', fd, fd], windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const status = await new Promise<number | null>((done) => {
      child.once('error', () => done(null));
      child.once('close', (code) => done(code));
    });
    clearTimeout(timer);
    return { status, output: readFileSync(outFile, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/**
 * @description The common head of a probe: strict mode, the stand-in verified first on PATH, the
 * production helpers dot-sourced from argv ($4 config, $5 resource, $6 quiesce), and a `log` that
 * prints. $1 = REPO_DIR, $2 = STATE_DIR, $3 = the stand-in bin directory.
 * @returns the probe head.
 */
export function probeHead(): string {
  return [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'REPO_DIR="$1"; STATE_DIR="$2"; FAKE_BIN="$3"',
    'chmod +x "$FAKE_BIN/docker"',
    // PATH entries must be POSIX-form under MSYS: a C:/... entry splits on its colon.
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    'export PATH="$FAKE_BIN:$PATH"',
    'command -v docker | grep -q "^$FAKE_BIN/docker$" || { echo "stand-in docker is not first on PATH: $(command -v docker)" >&2; exit 97; }',
    "log() { printf '[log] %s\\n' \"$*\"; }",
    'if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi',
    '. "$4"',
    '. "$5"',
    '. "$6"',
    '',
  ].join('\n');
}

/**
 * @description The argv every probe takes after its own path.
 * @param stateDir the probe's STATE_DIR.
 * @param bin the stand-in bin directory.
 * @returns REPO_DIR (the real checkout, so the real routability list is read), STATE_DIR, bin, and
 * the three helpers in the positions probeHead dot-sources.
 */
export const probeArgs = (stateDir: string, bin: string): string[] => [
  toBash(ROOT), toBash(stateDir), toBash(bin), CONFIG_HELPER, RESOURCE_HELPER, QUIESCE_HELPER,
];
