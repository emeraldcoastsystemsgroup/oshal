/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the BUG-21 tail: prove the unattended watch actually fails when the overlay is not there, that a confirmed failure reaches the alert rail, that a standing outage does not mail every run, that recovery is announced once, and that an absent engine is observed rather than started. The strict check, curl, the closed socket, Git Bash, cscript and PowerShell all run for real; only the `docker` CLI is doubled, on PATH, so the exact argv is asserted instead of a live container being exec'd.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const WATCH_PATH = join(ROOT, 'scripts', 'monitoring-liveness-watch.sh');
const CHECK_PATH = join(ROOT, 'scripts', 'monitoring-liveness-check.sh');
const LAUNCHER_PATH = join(ROOT, 'scripts', 'monitoring-liveness-watch-hidden.vbs');
const REGISTER_PATH = join(ROOT, 'scripts', 'register-monitoring-liveness-task.ps1');
const ALERT_ENTRYPOINT = '/app/scripts/oshal-send-alert.js';
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-monitoring-watch-'));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * @description Locate Git Bash without falling into Windows' WSL launcher.
 * @returns Absolute path to a real Git Bash executable.
 */
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
 * @description Reserve then release a TCP port so a probe against it is refused, not merely slow.
 * @returns A port number that nothing was listening on a moment ago.
 */
async function closedPort(): Promise<number> {
  return new Promise((resolveWith, rejectWith) => {
    const server = createServer();
    server.once('error', rejectWith);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        server.close(() => rejectWith(new Error('no port assigned')));
        return;
      }
      const { port } = address;
      server.close(() => resolveWith(port));
    });
  });
}

interface Harness {
  dir: string;
  stateDir: string;
  callLog: string;
  binDir: string;
}

/**
 * @description Build an isolated run directory with a recording `docker` shim first on PATH.
 * @param name Sub-directory name, so a failing case is identifiable on disk.
 * @returns The harness paths the run helpers need.
 */
function createHarness(name: string): Harness {
  const dir = join(SCRATCH, name);
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const callLog = join(dir, 'docker-calls.log');
  writeFileSync(join(binDir, 'docker'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$FAKE_DOCKER_LOG"',
    'if [ "$1" = "ps" ]; then exit "${FAKE_DOCKER_PS_STATUS:-0}"; fi',
    'exit 0',
    '',
  ].join('\n'));
  return { dir, stateDir, callLog, binDir };
}

/**
 * @description Run the shipped watch script with the recording docker shim ahead of the real one.
 * @param harness Run directory produced by createHarness.
 * @param env Extra environment for this run (ports, thresholds, engine status).
 * @returns Exit status plus the combined output of the run.
 */
function runWatch(harness: Harness, env: Record<string, string>): { status: number; output: string } {
  const run = spawnSync(BASH, [WATCH_PATH], {
    encoding: 'utf8',
    timeout: 90_000,
    env: {
      ...process.env,
      PATH: `${harness.binDir}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_DOCKER_LOG: harness.callLog,
      MONITORING_WATCH_STATE_DIR: harness.stateDir,
      ...env,
    },
  });
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/** @description Read every command line the docker shim recorded, oldest first. */
function dockerCalls(harness: Harness): string[] {
  if (!existsSync(harness.callLog)) return [];
  return readFileSync(harness.callLog, 'utf8').split('\n').filter((line) => line.length > 0);
}

/** @description Count the alert deliveries the watch actually issued. */
function alertCalls(harness: Harness): string[] {
  return dockerCalls(harness).filter((line) => line.includes(ALERT_ENTRYPOINT));
}

/** @description Read the streak state the watch persisted between runs. */
function readState(harness: Harness): string {
  const file = join(harness.stateDir, 'monitoring-liveness-watch.state');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * @description Write a stand-in check whose exit status the case controls.
 * @param harness Run directory produced by createHarness.
 * @param status Exit status the stand-in should return.
 * @returns Path to the stand-in check script.
 */
function writeStubCheck(harness: Harness, status: number): string {
  const path = join(harness.dir, `stub-check-${status}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\necho "Monitoring: watching 35 oshal targets, all up."\nexit ${status}\n`);
  return path;
}

describe('monitoring-liveness-check --strict against a target that is not there', () => {
  it('exits non-zero and names the endpoint it could not reach', async () => {
    const port = await closedPort();
    const run = spawnSync(BASH, [CHECK_PATH, '--strict'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PROMETHEUS_PORT: String(port) },
    });
    expect(run.status, run.stdout ?? '').toBe(1);
    expect(run.stdout).toContain('MONITORING IS NOT WATCHING');
    expect(run.stdout).toContain(`http://127.0.0.1:${port}`);
  }, 70_000);
});

describe('unattended monitoring-liveness watch', () => {
  it('alerts through the existing rail once the failure is confirmed, and propagates the exit status', async () => {
    const port = await closedPort();
    const harness = createHarness('confirmed-failure');
    const run = runWatch(harness, {
      PROMETHEUS_PORT: String(port),
      MONITORING_WATCH_CONFIRM_RUNS: '1',
    });
    expect(run.status, run.output).toBe(1);
    const alerts = alertCalls(harness);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('exec oshal-local-api node /app/scripts/oshal-send-alert.js');
    expect(alerts[0]).toContain('oshal monitoring is NOT watching');
    expect(readState(harness)).toContain('alerted=1');
  }, 90_000);

  it('stays quiet until the configured number of consecutive runs have failed', async () => {
    const port = await closedPort();
    const harness = createHarness('confirm-streak');
    const env = { PROMETHEUS_PORT: String(port), MONITORING_WATCH_CONFIRM_RUNS: '3' };
    const first = runWatch(harness, env);
    expect(first.status, first.output).toBe(1);
    expect(first.output).toContain('not alerting yet');
    expect(alertCalls(harness)).toHaveLength(0);
    const second = runWatch(harness, env);
    expect(second.output).toContain('consecutive 2/3');
    expect(alertCalls(harness)).toHaveLength(0);
    const third = runWatch(harness, env);
    expect(third.output).toContain('consecutive 3/3');
    expect(alertCalls(harness)).toHaveLength(1);
  }, 120_000);

  it('does not mail an identical line on every run of a standing outage', async () => {
    const port = await closedPort();
    const harness = createHarness('realert-window');
    const env = {
      PROMETHEUS_PORT: String(port),
      MONITORING_WATCH_CONFIRM_RUNS: '1',
      MONITORING_WATCH_REALERT_MINUTES: '60',
    };
    runWatch(harness, env);
    const repeat = runWatch(harness, env);
    expect(repeat.output).toContain('alert suppressed');
    expect(alertCalls(harness)).toHaveLength(1);
  }, 120_000);

  it('announces recovery exactly once and clears the streak', async () => {
    const port = await closedPort();
    const harness = createHarness('recovery');
    runWatch(harness, { PROMETHEUS_PORT: String(port), MONITORING_WATCH_CONFIRM_RUNS: '1' });
    expect(alertCalls(harness)).toHaveLength(1);
    const passing = writeStubCheck(harness, 0);
    const recovered = runWatch(harness, { MONITORING_LIVENESS_CHECK: passing });
    expect(recovered.status, recovered.output).toBe(0);
    const alerts = alertCalls(harness);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain('oshal monitoring is watching again');
    expect(readState(harness)).toContain('consecutive=0');
    expect(readState(harness)).toContain('alerted=0');
    const stillHealthy = runWatch(harness, { MONITORING_LIVENESS_CHECK: passing });
    expect(stillHealthy.status, stillHealthy.output).toBe(0);
    expect(alertCalls(harness)).toHaveLength(2);
  }, 120_000);

  it('observes an absent engine instead of starting anything', async () => {
    const port = await closedPort();
    const harness = createHarness('engine-absent');
    const run = runWatch(harness, {
      PROMETHEUS_PORT: String(port),
      MONITORING_WATCH_CONFIRM_RUNS: '1',
      FAKE_DOCKER_PS_STATUS: '1',
    });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('observing only');
    expect(alertCalls(harness)).toHaveLength(0);
    for (const call of dockerCalls(harness)) {
      expect(call).not.toMatch(/^(start|run|restart|compose|create|unpause)\b/);
    }
  }, 90_000);
});

describe('monitoring liveness scheduled-task wiring', () => {
  it('launches the watch next to itself and propagates its exit status to Task Scheduler', () => {
    const launcherSource = readFileSync(LAUNCHER_PATH, 'utf8');
    expect(launcherSource).toMatch(/sh\.Run\(command,\s*0,\s*True\)/);
    expect(launcherSource).toMatch(/WScript\.Quit\s+exitCode/);
    expect(launcherSource).toContain('WScript.ScriptFullName');
    expect(launcherSource).not.toMatch(/C:\\Projects/i);
    if (process.platform !== 'win32') return;
    const scripts = join(SCRATCH, 'launcher-exit', 'scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(LAUNCHER_PATH, join(scripts, 'monitoring-liveness-watch-hidden.vbs'));
    writeFileSync(join(scripts, 'monitoring-liveness-watch.sh'), '#!/usr/bin/env bash\nexit 37\n');
    const run = spawnSync('cscript.exe', ['//B', '//Nologo', join(scripts, 'monitoring-liveness-watch-hidden.vbs')], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(37);
  }, 40_000);

  it('registers the launcher of the checkout it ships in, never a typed path', () => {
    const registerSource = readFileSync(REGISTER_PATH, 'utf8');
    expect(registerSource).toContain('Join-Path $PSScriptRoot');
    expect(registerSource).not.toMatch(/C:\\Projects/i);
    if (process.platform !== 'win32') return;
    const run = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REGISTER_PATH, '-DryRun',
    ], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain(join(ROOT, 'scripts', 'monitoring-liveness-watch-hidden.vbs'));
    expect(run.stdout).toContain('wscript.exe //B //Nologo');
  }, 70_000);
});
