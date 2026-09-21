/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove a PAUSED stack-watchdog run observes monitoring and still takes no docker action: the real entry point with a pause file present reaches no start primitive, and the real observe-only code runs scripts/monitoring-liveness-check.sh --strict through a real Bash, alerts on red with a quote-free body, throttles repeats and re-alerts after a recovery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const watchdogPath = join(root, 'scripts', 'oshal-stack-watchdog.ps1');
const resolverPath = join(root, 'scripts', 'lib', 'windows-git-bash.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-paused-observe-'));
const watchdogSource = readFileSync(watchdogPath, 'utf8');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * @description Slices a named region out of the real watchdog source so the probe below executes
 * production code rather than a paraphrase of it.
 * @param start First marker line of the region.
 * @param end First marker line after the region.
 * @returns The source text between the two markers.
 */
const sourceSection = (start: string, end: string): string => {
  const startAt = watchdogSource.indexOf(start);
  const endAt = watchdogSource.indexOf(end, startAt);
  if (startAt < 0 || endAt < 0) throw new Error(`Watchdog source markers missing: ${start} -> ${end}`);
  return watchdogSource.slice(startAt, endAt);
};

const invokeTimedSource = sourceSection('function Get-ProcessTreeIds', '# ---- classify the docker engine');
const bashQuoteSource = sourceSection('function ConvertTo-BashSingleQuoted', '# The routing-critical heartbeats');
const observeSource = sourceSection('# ---- observe-only (the watchdog is PAUSED) ----', '# =========================== main');

const posix = (value: string): string => value.replace(/\\/g, '/');

interface ScratchRepo {
  path: string;
  recorderFor: (name: string) => string;
}

/**
 * @description Builds a throwaway repo whose scripts/ entries record that they ran. The liveness
 * check is a stub so the verdict is controlled; every other script the watchdog could invoke is a
 * tripwire whose recorder file must stay absent.
 * @param name Unique directory name under the scratch root.
 * @param livenessExit Exit code the stubbed liveness check returns.
 * @returns The repo path and a resolver for each script's recorder file.
 */
const makeScratchRepo = (name: string, livenessExit: number): ScratchRepo => {
  const path = join(scratch, name);
  mkdirSync(join(path, 'scripts'), { recursive: true });
  mkdirSync(join(path, '.recorder'), { recursive: true });
  const stub = (script: string, body: string): void => {
    writeFileSync(
      join(path, 'scripts', script),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> .recorder/${script}.log\n${body}\n`,
      { encoding: 'utf8' },
    );
  };
  // The red branch must survive the alert-body sanitiser, so the stub answers with the same shape
  // the real check uses when it fails: several lines, and a docker hint carrying double quotes.
  stub('monitoring-liveness-check.sh', livenessExit === 0
    ? 'echo "Monitoring: watching 35 oshal targets, all up."\nexit 0'
    : 'echo "## MONITORING IS NOT WATCHING - Prometheus is not answering on http://127.0.0.1:9091."\n'
      + 'echo "##   docker inspect oshal-local-api --format \'{{index .Config.Labels \\"oshal.tier\\"}}\'"\n'
      + `exit ${livenessExit}`);
  stub('oshal-up.sh', 'exit 0');
  stub('swarm-routability-check.sh', 'exit 1');
  return { path, recorderFor: (script: string) => join(path, '.recorder', `${script}.log`) };
};

/**
 * @description Resolves the Bash the watchdog itself would use, through the production resolver on
 * Windows. Fails loudly rather than skipping: a guard that opts out is a guard that does not exist.
 * @returns An absolute path to a validated Bash executable.
 */
const resolveBash = (): string => {
  if (process.platform !== 'win32') return '/bin/bash';
  const probe = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${resolverPath}'; Resolve-OshalGitBash`,
  ], { encoding: 'utf8', timeout: 90_000 });
  const lines = (probe.stdout ?? '').trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
  return (lines.at(-1) ?? '').trim();
};

const gitBash = resolveBash();

interface ObserveOutcome {
  Exit: number;
  Log: string;
}

/**
 * @description Runs the real observe-only region with the engine-presence probe pinned, a real
 * Invoke-Timed, a real Bash and a recording Send-Alert.
 * @param repo Scratch repo supplying the stubbed liveness check.
 * @param enginePresent Whether the probe should report a live docker engine pipe.
 * @param stateFile Watchdog state file backing the repeat-alert throttle.
 * @param alertFile File the recording Send-Alert appends one JSON line to per alert.
 * @param cooldownMin Minutes the throttle must wait before re-alerting.
 * @returns The observation's exit code and its joined log lines.
 */
const observe = (
  repo: ScratchRepo,
  enginePresent: boolean,
  stateFile: string,
  alertFile: string,
  cooldownMin = 60,
): ObserveOutcome => {
  const probe = join(scratch, `observe-probe-${Math.random().toString(36).slice(2)}.ps1`);
  writeFileSync(probe, [
    'param([string]$Bash, [string]$RepoPath, [int]$EnginePresent, [string]$StateFile, [string]$AlertFile, [int]$CooldownMin)',
    '$Repo = $RepoPath',
    '$MonitoringAlertCooldownMin = $CooldownMin',
    '$script:gitBash = $Bash',
    '$script:logLines = @()',
    'function Log($m) { $script:logLines += [string]$m }',
    'function Format-ErrorText($errorRecord) { return [string]$errorRecord }',
    '$state = @{ lastRecovery = ""; consecutiveFailures = 0; lastMonitoringAlert = "" }',
    'if (Test-Path -LiteralPath $StateFile) { (Get-Content $StateFile -Raw | ConvertFrom-Json).psobject.properties | ForEach-Object { $state[$_.Name] = $_.Value } }',
    'function Save-State { ($state | ConvertTo-Json -Compress) | Set-Content $StateFile -Encoding ascii }',
    'function Send-Alert([string]$subject, [string]$body) { @{ Subject = $subject; Body = $body } | ConvertTo-Json -Compress | Add-Content $AlertFile }',
    invokeTimedSource,
    bashQuoteSource,
    observeSource,
    'function Test-DockerEnginePipePresent { return ($EnginePresent -eq 1) }',
    '$code = @(Invoke-PausedMonitoringObservation)[-1]',
    '@{ Exit = [int]$code; Log = ($script:logLines -join " | ") } | ConvertTo-Json -Compress',
    '',
  ].join('\n'), { encoding: 'utf8' });

  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe,
    gitBash, posix(repo.path), enginePresent ? '1' : '0', stateFile, alertFile, String(cooldownMin),
  ], { encoding: 'utf8', timeout: 180_000 });
  expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const lines = (result.stdout ?? '').trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) ?? '') as ObserveOutcome;
};

const alertsIn = (alertFile: string): Array<{ Subject: string; Body: string }> => (
  existsSync(alertFile)
    ? readFileSync(alertFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : []
);

describe('paused stack watchdog observes monitoring without acting', () => {
  it('requires a validated Bash to run these guards at all', () => {
    expect(gitBash, 'no validated Git for Windows Bash was resolved; the watchdog cannot observe on this host').toBeTruthy();
  });

  it('stays quiet and spawns nothing when the docker engine is not running', () => {
    const repo = makeScratchRepo('engine-absent', 0);
    const alertFile = join(scratch, 'engine-absent.alerts');
    const outcome = observe(repo, false, join(scratch, 'engine-absent.state.json'), alertFile);
    expect(outcome.Exit).toBe(0);
    expect(outcome.Log).toMatch(/the docker engine is not running/);
    expect(existsSync(repo.recorderFor('monitoring-liveness-check.sh'))).toBe(false);
    expect(alertsIn(alertFile)).toHaveLength(0);
  }, 200_000);

  it('runs the liveness check with --strict and stays quiet while monitoring is watching', () => {
    const repo = makeScratchRepo('overlay-green', 0);
    const alertFile = join(scratch, 'overlay-green.alerts');
    const outcome = observe(repo, true, join(scratch, 'overlay-green.state.json'), alertFile);
    expect(outcome.Exit).toBe(0);
    expect(readFileSync(repo.recorderFor('monitoring-liveness-check.sh'), 'utf8').trim()).toBe('--strict');
    expect(outcome.Log).toMatch(/monitoring is watching/);
    expect(alertsIn(alertFile)).toHaveLength(0);
  }, 200_000);

  it('alerts with a quote-free single-line body and exits non-zero when monitoring is not watching', () => {
    const repo = makeScratchRepo('overlay-red', 1);
    const alertFile = join(scratch, 'overlay-red.alerts');
    const outcome = observe(repo, true, join(scratch, 'overlay-red.state.json'), alertFile);
    expect(outcome.Exit).toBe(1);
    expect(outcome.Log).toMatch(/MONITORING IS NOT WATCHING/);
    const alerts = alertsIn(alertFile);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].Subject).toMatch(/monitoring overlay is NOT watching/i);
    // Send-Alert refuses a double quote and a multi-line docker argument, so a body that carries
    // either loses the email the operator is meant to receive.
    expect(alerts[0].Body).not.toContain('"');
    expect(alerts[0].Body).not.toMatch(/[\r\n]/);
    expect(alerts[0].Body).toContain('exit 1');
    expect(alerts[0].Body).toContain('Prometheus is not answering');
    expect(alerts[0].Body).toContain('bash scripts/oshal-up.sh');
  }, 200_000);

  it('throttles repeat alerts, then alerts again once the overlay has recovered and failed anew', () => {
    const stateFile = join(scratch, 'throttle.state.json');
    const alertFile = join(scratch, 'throttle.alerts');
    const red = makeScratchRepo('throttle-red', 1);
    const green = makeScratchRepo('throttle-green', 0);

    expect(observe(red, true, stateFile, alertFile).Exit).toBe(1);
    expect(alertsIn(alertFile)).toHaveLength(1);

    const repeat = observe(red, true, stateFile, alertFile);
    expect(repeat.Exit).toBe(1);
    expect(repeat.Log).toMatch(/repeat alert suppressed/);
    expect(alertsIn(alertFile)).toHaveLength(1);

    expect(observe(green, true, stateFile, alertFile).Exit).toBe(0);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).lastMonitoringAlert).toBe('');

    expect(observe(red, true, stateFile, alertFile).Exit).toBe(1);
    expect(alertsIn(alertFile)).toHaveLength(2);
  }, 400_000);

  it('takes no docker action on a real paused run of the watchdog entry point', () => {
    const repo = makeScratchRepo('real-run', 0);
    const localAppData = join(scratch, 'appdata');
    mkdirSync(join(localAppData, 'oshal'), { recursive: true });
    writeFileSync(join(localAppData, 'oshal', 'stack-watchdog.pause'), 'paused by the guard\n');

    const result = spawnSync(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', watchdogPath, '-Repo', repo.path,
    ], {
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, LOCALAPPDATA: localAppData },
    });
    expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);

    const log = readFileSync(join(localAppData, 'oshal', 'oshal-stack-watchdog.log'), 'utf8');
    // Every recovery primitive announces itself BEFORE it acts, so their absence from this run's
    // own log is evidence the pause gate was never crossed - not a claim about the source text.
    expect(log).not.toMatch(/killing wedged Docker processes/);
    expect(log).not.toMatch(/wsl --shutdown/);
    expect(log).not.toMatch(/starting Docker Desktop/);
    expect(log).not.toMatch(/running scripts\/oshal-up\.sh/);
    expect(log).not.toMatch(/RECOVERY (SUCCEEDED|FAILED)/);
    expect(existsSync(repo.recorderFor('oshal-up.sh'))).toBe(false);
    expect(existsSync(repo.recorderFor('swarm-routability-check.sh'))).toBe(false);
    expect(log).toMatch(/paused observe-only: (monitoring is watching|the docker engine is not running)/);
  }, 320_000);
});
