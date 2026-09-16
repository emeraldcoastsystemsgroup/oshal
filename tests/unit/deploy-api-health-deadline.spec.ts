/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard oshal-deploy.sh's api health wait. A fixed 40x3s window rolled back a HEALTHY deploy on 2026-09-16: this box loads 83 swarm apps at boot and went healthy about eight minutes in, so the script rolled back, recreated 36 bots on the old image, hit the same 120 s wall on the rollback and reported "ROLLBACK DEGRADED - THE STACK IS NOT SERVING" over a stack that was serving minutes later. These cases run the REAL wait_api out of the real script in Git Bash against a stand-in docker that replays a scripted sequence of container states, so the distinction that matters - a slow boot is not a failed boot - is executed rather than read.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';

const DEPLOY = resolve(__dirname, '..', '..', 'scripts', 'oshal-deploy.sh');
const SOURCE = readFileSync(DEPLOY, 'utf8');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-waitapi-'));
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

/**
 * @description Slice the real API_HEALTH_SECONDS default and wait_api body out of the deploy script,
 * so these cases execute the shipped code rather than a copy that can drift away from it.
 * @returns The shell source of the knob and the function.
 */
function waitApiSource(): string {
  const start = SOURCE.indexOf('API_HEALTH_SECONDS=');
  const open = SOURCE.indexOf('wait_api() {', start);
  const end = SOURCE.indexOf('\n}\n', open);
  expect(start, 'API_HEALTH_SECONDS is gone from the deploy script').toBeGreaterThan(-1);
  expect(open, 'wait_api is gone from the deploy script').toBeGreaterThan(-1);
  expect(end, 'wait_api has no closing brace where expected').toBeGreaterThan(-1);
  return SOURCE.slice(start, end + 3);
}

interface Run { status: number | null; out: string; elapsedMs: number }

/**
 * @description Run the real wait_api against a stand-in docker that reports `states` in order (the
 * last one repeating) and answers `docker logs` with `logsLine`.
 * @param states - Health/status values the stand-in reports, one per inspect call.
 * @param logsLine - What `docker logs` prints; omit the auto-load marker to exercise that branch.
 * @param seconds - The OSHAL_DEPLOY_API_HEALTH_SECONDS budget for this run.
 * @returns Exit status, combined output and wall time.
 */
function runWait(states: string[], logsLine: string, seconds: number): Run {
  const id = Math.random().toString(36).slice(2);
  const bin = join(SCRATCH, `bin-${id}`);
  mkdirSync(bin, { recursive: true });
  const stateFile = join(bin, 'states.txt').replaceAll('\\', '/');
  writeFileSync(join(bin, 'states.txt'), states.join('\n') + '\n');
  writeFileSync(join(bin, 'count.txt'), '0');
  // A stand-in docker: `inspect` walks the scripted list (repeating the last), `logs` prints one line.
  writeFileSync(join(bin, 'docker'), [
    '#!/usr/bin/env bash',
    'here="$(dirname "$0")"',
    'if [ "$1" = "inspect" ]; then',
    '  n=$(cat "$here/count.txt"); n=$((n + 1)); printf %s "$n" >"$here/count.txt"',
    '  total=$(wc -l <"$here/states.txt")',
    '  [ "$n" -gt "$total" ] && n=$total',
    '  sed -n "${n}p" "$here/states.txt"; exit 0',
    'fi',
    'if [ "$1" = "logs" ]; then printf \'%s\\n\' "$LOGS_LINE"; exit 0; fi',
    'exit 0',
  ].join('\n') + '\n');
  const probe = join(SCRATCH, `probe-${id}.sh`);
  writeFileSync(probe, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'FAKE_BIN="$1"',
    'chmod +x "$FAKE_BIN/docker"',
    // PATH entries must be POSIX-form under MSYS: a C:/... entry splits on its colon.
    'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN="$(cygpath -u "$FAKE_BIN")"; fi',
    'export PATH="$FAKE_BIN:$PATH"',
    'command -v docker | grep -q "^$FAKE_BIN/docker$" || { echo "stand-in docker is not first on PATH" >&2; exit 97; }',
    'API_CONTAINER=oshal-local-api',
    'log() { printf \'LOG:%s\\n\' "$*"; }',
    waitApiSource(),
    'wait_api; printf \'RC:%s\\n\' "$?"',
  ].join('\n') + '\n');
  const started = Date.now();
  const result = spawnSync(BASH, [probe.replaceAll('\\', '/'), bin.replaceAll('\\', '/')], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, OSHAL_DEPLOY_API_HEALTH_SECONDS: String(seconds), LOGS_LINE: logsLine },
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const rc = /RC:(\d+)/.exec(out);
  return { status: rc ? Number(rc[1]) : result.status, out, elapsedMs: Date.now() - started };
}

const LOADED = 'Swarm app auto-load complete';

describe('the deploy waits for a slow api instead of rolling back a healthy one', () => {
  it('reads its budget from the environment, with a default generous enough for this box', () => {
    // The defect was a hard-coded window. A literal `seq 1 40` here is the bug returning.
    expect(SOURCE).toMatch(/API_HEALTH_SECONDS=\$\{OSHAL_DEPLOY_API_HEALTH_SECONDS:-(\d+)\}/);
    const fallback = Number(/API_HEALTH_SECONDS=\$\{OSHAL_DEPLOY_API_HEALTH_SECONDS:-(\d+)\}/.exec(SOURCE)![1]);
    expect(fallback, 'the api took about eight minutes on 2026-09-16; a default under that rolls back a healthy deploy')
      .toBeGreaterThanOrEqual(600);
    expect(waitApiSource(), 'wait_api is back on a fixed iteration count').not.toMatch(/seq 1 \d+/);
  });

  it('keeps waiting through "starting" and succeeds when the api finally answers', () => {
    const run = runWait(['starting', 'starting', 'starting', 'healthy'], LOADED, 60);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('api healthy after');
    expect(run.out).toContain('api fully up (healthy + auto-load)');
  }, 60_000);

  it('fails FAST on a state that means a failed boot, rather than burning the budget', () => {
    const run = runWait(['starting', 'unhealthy'], LOADED, 300);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain("that is a failed boot, not a slow one");
    // The point of the fast path: it must not sit out a 300 s budget to learn this.
    expect(run.elapsedMs, 'a failed boot must be reported immediately').toBeLessThan(30_000);
  }, 60_000);

  it('still gives up when the budget really does run out, and says so with the number', () => {
    const run = runWait(['starting'], LOADED, 1);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toMatch(/api never went healthy within 1s \(last: starting\)/);
  }, 60_000);

  it('treats healthy-but-never-loaded as a failure of its own, not as success', () => {
    const run = runWait(['healthy'], 'GET /health', 1);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain('auto-load never completed');
  }, 60_000);
});
