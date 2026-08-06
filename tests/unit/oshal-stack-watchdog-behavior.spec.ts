/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add isolated behavioral guards for watchdog output draining, timeout tree cleanup, atomic/live-owner locking, and windowless launcher exit propagation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exercise process-tree fallback when taskkill fails and prove alert delivery uses a finite native-command budget only after the recovery lock is released.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Give the remaining real PowerShell boundary probes explicit process-startup budgets; their production timeout and cleanup assertions remain unchanged under full-suite host contention.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Identify spawned processes by PID plus start time so rapid Windows PID reuse cannot masquerade as an orphan after exact tree cleanup.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Give the real descendant-CIM and VBS boundaries explicit outer process budgets under full-suite contention; production cleanup and exit assertions remain exact.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const watchdogPath = join(root, 'scripts', 'oshal-stack-watchdog.ps1');
const launcherPath = join(root, 'scripts', 'oshal-stack-watchdog-hidden.vbs');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-watchdog-behavior-'));
const watchdogSource = readFileSync(watchdogPath, 'utf8');

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sourceSection = (start: string, end: string): string => {
  const startAt = watchdogSource.indexOf(start);
  const endAt = watchdogSource.indexOf(end, startAt);
  if (startAt < 0 || endAt < 0) throw new Error(`Watchdog source markers missing: ${start} -> ${end}`);
  return watchdogSource.slice(startAt, endAt);
};

const invokeTimedSource = sourceSection('function Get-ProcessTreeIds', '# ---- classify the docker engine');
const lockSource = sourceSection('function Test-LockOwnerAlive', '# ---- recovery primitives ----');
const alertEmailSource = sourceSection('function ConvertTo-NativeAlertArgument', 'function Send-Alert');
const mainSource = watchdogSource.slice(watchdogSource.indexOf('# =========================== main'));
const errorFormatter = 'function Format-ErrorText($errorRecord) { return [string]$errorRecord }\n';

interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

const runPowerShell = (script: string, args: string[] = [], timeout = 30_000): ProcessResult => {
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
  ], { encoding: 'utf8', timeout });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
};

const runPowerShellAsync = (script: string, args: string[]): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (status) => resolve({ status, stdout, stderr }));
});

const waitForFiles = async (paths: string[]): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${paths.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const parseLastJsonLine = <T>(stdout: string): T => {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) ?? '') as T;
};

const failingTaskkillShim = (): string => process.platform === 'win32' ? [
  'function Invoke-TaskkillTree {',
  '  param([int]$RootProcessId)',
  '  return @{ Ok = $false; Error = "taskkill exit 1" }',
  '}',
].join('\n') : [
  'function Invoke-TaskkillTree {',
  '  param([int]$RootProcessId)',
  '  & /usr/bin/pkill -KILL -P $RootProcessId 2>$null',
  '  & /usr/bin/kill -KILL $RootProcessId 2>$null',
  '  return @{ Ok = $true; Error = "" }',
  '}',
].join('\n');

const verifyOutputDrain = (): void => {
  const noisy = join(scratch, 'noisy-child.ps1');
  const probe = join(scratch, 'invoke-timed-noisy.ps1');
  writeFileSync(noisy, "[Console]::Out.Write(('o' * 262144))\n[Console]::Error.Write(('e' * 262144))\nexit 0\n");
  writeFileSync(probe, `param([string]$Child)\n${errorFormatter}${invokeTimedSource}\n` +
    '$childArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Child`""\n' +
    '$shell = if (Test-Path $PSHOME\\powershell.exe) { $PSHOME + "\\powershell.exe" } else { $PSHOME + "/pwsh" }\n' +
    '$result = Invoke-Timed $shell $childArgs 15000\n' +
    '@{ Exited = $result.Exited; ExitCode = $result.ExitCode; OutLength = $result.Out.Length; ErrLength = $result.Err.Length } | ConvertTo-Json -Compress\n');

  const result = runPowerShell(probe, [noisy], 25_000);
  expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}`).toBe(0);
  expect(parseLastJsonLine(result.stdout)).toEqual({
    Exited: true,
    ExitCode: 0,
    OutLength: 262_144,
    ErrLength: 262_144,
  });
};

const verifyTimeoutTreeCleanup = (): void => {
  const child = join(scratch, 'timeout-child.ps1');
  const parent = join(scratch, 'timeout-parent.ps1');
  const probe = join(scratch, 'invoke-timed-timeout.ps1');
  const parentPid = join(scratch, 'timeout-parent.pid');
  const childPid = join(scratch, 'timeout-child.pid');
  writeFileSync(child, 'param([string]$PidFile)\n@{ Pid = $PID; StartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath $PidFile\nStart-Sleep -Seconds 300\n');
  writeFileSync(parent,
    'param([string]$ParentPidFile, [string]$ChildPidFile, [string]$ChildScript, [string]$Shell)\n' +
    '@{ Pid = $PID; StartedAt = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks } | ConvertTo-Json -Compress | Set-Content -LiteralPath $ParentPidFile\n' +
    '$child = Start-Process -FilePath $Shell -ArgumentList @("-NoProfile", "-File", $ChildScript, $ChildPidFile) -PassThru\n' +
    'while (-not (Test-Path -LiteralPath $ChildPidFile)) { Start-Sleep -Milliseconds 10 }\n' +
    'Start-Sleep -Seconds 300\n');
  const taskkillShim = failingTaskkillShim();
  writeFileSync(probe, `param([string]$Parent, [string]$ParentPid, [string]$ChildPid, [string]$Child, [string]$Shell)\n${errorFormatter}${invokeTimedSource}\n${taskkillShim}\n` +
    '$parentArgs = "-NoProfile -File `"$Parent`" `"$ParentPid`" `"$ChildPid`" `"$Child`" `"$Shell`""\n' +
    '$result = Invoke-Timed $Shell $parentArgs 2000\n' +
    'function Test-ExactProcessAlive([string]$IdentityFile) {\n' +
    '  if (-not (Test-Path -LiteralPath $IdentityFile)) { return $true }\n' +
    '  $identity = Get-Content -LiteralPath $IdentityFile -Raw | ConvertFrom-Json\n' +
    '  $candidate = Get-Process -Id ([int]$identity.Pid) -ErrorAction SilentlyContinue\n' +
    '  if ($null -eq $candidate) { return $false }\n' +
    '  try { return $candidate.StartTime.ToUniversalTime().Ticks -eq [long]$identity.StartedAt } catch { return $false }\n' +
    '}\n' +
    '$deadline = (Get-Date).AddSeconds(5)\n' +
    'do {\n' +
    '  $parentAlive = Test-ExactProcessAlive $ParentPid\n' +
    '  $childAlive = Test-ExactProcessAlive $ChildPid\n' +
    '  if (-not $parentAlive -and -not $childAlive) { break }\n' +
    '  Start-Sleep -Milliseconds 50\n' +
    '} while ((Get-Date) -lt $deadline)\n' +
    '$observedParentAlive = $parentAlive; $observedChildAlive = $childAlive\n' +
    'if ($parentAlive) { Stop-Process -Id ([int](Get-Content $ParentPid -Raw | ConvertFrom-Json).Pid) -Force -ErrorAction SilentlyContinue }\n' +
    'if ($childAlive) { Stop-Process -Id ([int](Get-Content $ChildPid -Raw | ConvertFrom-Json).Pid) -Force -ErrorAction SilentlyContinue }\n' +
    '@{ Exited = $result.Exited; ExitCode = $result.ExitCode; TreeStopped = $result.TreeStopped; Err = $result.Err; ParentAlive = $observedParentAlive; ChildAlive = $observedChildAlive } | ConvertTo-Json -Compress\n');

  const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : powershell;
  const result = runPowerShell(probe, [parent, parentPid, childPid, child, shell], 30_000);
  expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  const outcome = parseLastJsonLine<{
    Exited: boolean; ExitCode: number; TreeStopped: boolean; Err: string; ParentAlive: boolean; ChildAlive: boolean;
  }>(result.stdout);
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    Exited: false,
    ExitCode: -1,
    TreeStopped: true,
    ParentAlive: false,
    ChildAlive: false,
  });
  expect(outcome.Err).toMatch(/timed out/i);
  if (process.platform === 'win32') expect(outcome.Err).toMatch(/taskkill exit 1/i);
};

const verifyLockOwnership = async (): Promise<void> => {
  expect(lockSource).toMatch(/\[System\.IO\.FileMode\]::CreateNew/);
  const contender = join(scratch, 'lock-contender.ps1');
  const lock = join(scratch, 'watchdog.lock');
  const gate = join(scratch, 'lock.gate');
  const readyA = join(scratch, 'ready-a');
  const readyB = join(scratch, 'ready-b');
  const resultA = join(scratch, 'result-a');
  const resultB = join(scratch, 'result-b');
  writeFileSync(contender, `param([string]$LockPath, [string]$Gate, [string]$Ready, [string]$Result)\n$lockFile = $LockPath\nfunction Log($m) {}\n${errorFormatter}${lockSource}\n` +
    'Set-Content -LiteralPath $Ready -Value ready\n' +
    'while (-not (Test-Path -LiteralPath $Gate)) { Start-Sleep -Milliseconds 10 }\n' +
    '$owned = Acquire-Lock\n' +
    'Set-Content -LiteralPath $Result -Value ([int]$owned)\n' +
    'if ($owned) { Start-Sleep -Seconds 1 }\n');

  const first = runPowerShellAsync(contender, [lock, gate, readyA, resultA]);
  const second = runPowerShellAsync(contender, [lock, gate, readyB, resultB]);
  await waitForFiles([readyA, readyB]);
  writeFileSync(gate, 'go');
  const processes = await Promise.all([first, second]);
  expect(processes.map((result) => result.status)).toEqual([0, 0]);
  expect([readFileSync(resultA, 'utf8').trim(), readFileSync(resultB, 'utf8').trim()].sort()).toEqual(['0', '1']);

  writeFileSync(lock, `${process.pid} 2000-01-01T00:00:00.0000000Z`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(lock, old, old);
  const liveOwnerProbe = join(scratch, 'live-owner-lock.ps1');
  writeFileSync(liveOwnerProbe, `param([string]$LockPath)\n$lockFile = $LockPath\nfunction Log($m) {}\n${errorFormatter}${lockSource}\n` +
    '$before = Get-Content -LiteralPath $lockFile -Raw\n' +
    '$owned = Acquire-Lock\n' +
    '$after = Get-Content -LiteralPath $lockFile -Raw\n' +
    '@{ Owned = $owned; Unchanged = ($before -eq $after) } | ConvertTo-Json -Compress\n');
  const liveOwner = runPowerShell(liveOwnerProbe, [lock]);
  expect(liveOwner.status, `${liveOwner.stdout}\n${liveOwner.stderr}`).toBe(0);
  expect(parseLastJsonLine(liveOwner.stdout)).toEqual({ Owned: false, Unchanged: true });
};

const verifyLauncherExit = (): void => {
  const launcherSource = readFileSync(launcherPath, 'utf8');
  if (process.platform !== 'win32') {
    expect(launcherSource).toMatch(/sh\.Run\([^\r\n]+,\s*0,\s*True\)/);
    expect(launcherSource).toMatch(/WScript\.Quit\s+exitCode/);
    return;
  }

  const launcher = join(scratch, 'oshal-stack-watchdog-hidden.vbs');
  const harmlessWatchdog = join(scratch, 'oshal-stack-watchdog.ps1');
  copyFileSync(launcherPath, launcher);
  writeFileSync(harmlessWatchdog, 'exit 37\n');
  const result = spawnSync('cscript.exe', ['//B', '//Nologo', launcher], { encoding: 'utf8', timeout: 15_000 });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(37);
};

const verifyAlertLockBoundary = (): void => {
  const probe = join(scratch, 'alert-budget.ps1');
  writeFileSync(probe, `${errorFormatter}` +
    'function Test-ApiUp { return $true }\n' +
    'function Log($m) { $script:lastLog = [string]$m }\n' +
    'function Invoke-Timed($file, $fileArgs, $timeoutMs) { $script:timeout = $timeoutMs; return @{ Exited = $false; ExitCode = -1; Err = "timed out" } }\n' +
    `${alertEmailSource}\n` +
    'Invoke-AlertEmail "subject" "body"\n' +
    '@{ Timeout = $script:timeout; Log = $script:lastLog } | ConvertTo-Json -Compress\n');
  const result = runPowerShell(probe);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(parseLastJsonLine(result.stdout)).toEqual({ Timeout: 30_000, Log: 'alert email timed out: timed out' });
  expect(mainSource.indexOf('Release-Lock')).toBeLessThan(mainSource.lastIndexOf('Send-Alert $alertSubject $alertBody'));
};

const verifyIncompleteTreeFailure = (): void => {
  const probe = join(scratch, 'tree-cleanup-failure.ps1');
  writeFileSync(probe, `${errorFormatter}${invokeTimedSource}\n` +
    'function Get-ProcessTreeIds($root) { return @(424242) }\n' +
    'function Invoke-TaskkillTree { return @{ Ok = $false; Error = "taskkill exit 1" } }\n' +
    'function Get-LiveProcessIds($ids) { return @(424242) }\n' +
    'function Get-Process { return [pscustomobject]@{ Id = 424242 } }\n' +
    'function Stop-Process { throw "access denied" }\n' +
    'function Wait-ProcessTreeStopped($ids, $timeout) { return @(424242) }\n' +
    '$result = Stop-TimedProcessTree ([pscustomobject]@{ Id = 424242 })\n' +
    '@{ Stopped = $result.Stopped; Errors = ($result.Errors -join "; ") } | ConvertTo-Json -Compress\n');
  const result = runPowerShell(probe);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const outcome = parseLastJsonLine<{ Stopped: boolean; Errors: string }>(result.stdout);
  expect(outcome.Stopped).toBe(false);
  expect(outcome.Errors).toMatch(/cleanup incomplete/i);
};

describe('oshal stack watchdog reliability (behavioral)', () => {
  it('drains stdout and stderr beyond pipe capacity without deadlocking', verifyOutputDrain, 30_000);
  it('returns a timeout failure only after the spawned process tree is gone', verifyTimeoutTreeCleanup, 35_000);
  it('admits exactly one atomic lock contender and never steals an old lock from a live PID', verifyLockOwnership, 20_000);
  it('propagates the underlying watchdog exit through the hidden VBS launcher', verifyLauncherExit, 20_000);
  it('bounds alert docker work after releasing the recovery lock', verifyAlertLockBoundary, 20_000);
  it('returns an explicit failure when a timed-out process tree survives cleanup', verifyIncompleteTreeFailure, 20_000);
});
