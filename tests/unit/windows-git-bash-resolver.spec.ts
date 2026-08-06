/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Execute the shared scheduled-task Git Bash resolver against valid MSYS/MINGW identity, empty/non-zero/WSL/hung variants, rejected direct and resolved paths, production discovery, and failed-taskkill descendant cleanup; mutation-guard all three fail-closed caller invocations and lab-path quoting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Give the real PowerShell process boundary explicit host-startup headroom while retaining the bounded in-process version probe and descendant-cleanup assertions.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Give the lab-path quoting PowerShell probe the same explicit full-suite startup allowance as the other real process-boundary assertions.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Parse only a completed JSON result line so a child-process timeout reports its bounded-process error instead of being obscured by a JSON parse of trailing verbose diagnostics.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Make the hung-probe case an actual guard. Returning null inside the time budget is equally true of a resolver that kills its child and one that abandons it spinning, so the previous assertions passed while three orphans burned 20.6 CPU-hours; assert instead that no marker-tagged probe survives the call, and reap any leak in afterAll so a regression in this suite cannot peg the developer's machine.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');
const resolver = join(repoRoot, 'scripts', 'lib', 'windows-git-bash.ps1');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const scratch = mkdtempSync(join(tmpdir(), 'oshal-git-bash-resolver-'));
const probe = join(scratch, 'resolve.ps1');
const discoveryProbe = join(scratch, 'discover.ps1');
const resolvedTargetProbe = join(scratch, 'resolved-target.ps1');
const emptyVersionHook = join(scratch, 'empty-version.sh');
const hungVersionHook = join(scratch, 'hung-version.sh');
const validIdentityHook = join(scratch, 'valid-identity.sh');
const nonzeroOutputHook = join(scratch, 'nonzero-output.sh');
const wslIdentityHook = join(scratch, 'wsl-identity.sh');

afterAll(() => {
  // Net for every path, not just the asserted one: this suite deliberately manufactures a bash
  // that never exits, so a regression anywhere in it must not leave the developer's box spinning.
  reapStrayProbes(strayProbePids().filter((pid) => !suiteStartStrayPids.includes(pid)));
  rmSync(scratch, { recursive: true, force: true });
});

const portableGitIdentity = process.platform === 'win32'
  ? ''
  : 'MSYSTEM=MINGW64\nuname() { printf MINGW64_NT-test; }\n';
writeFileSync(validIdentityHook, portableGitIdentity);
writeFileSync(emptyVersionHook, `${portableGitIdentity}unset BASH_VERSION\n`);
writeFileSync(hungVersionHook, 'while :; do :; done\n');
writeFileSync(nonzeroOutputHook, "printf '__OSHAL_GIT_BASH__:5.2.0:MINGW64:MINGW64_NT-test\\n'\nexit 23\n");
writeFileSync(wslIdentityHook, 'unset MSYSTEM\nuname() { printf Linux; }\n');

writeFileSync(probe, [
  'param([string]$Resolver, [string]$Candidate, [int]$TimeoutMs)',
  '. $Resolver',
  '$VerbosePreference = "Continue"',
  '$selected = Resolve-OshalGitBash -CandidatePaths @($Candidate) -ProbeTimeoutMs $TimeoutMs -Verbose',
  '[pscustomobject]@{ Found = ($null -ne $selected); Selected = [string]$selected } | ConvertTo-Json -Compress',
].join('\n'));

writeFileSync(discoveryProbe, [
  'param([string]$Resolver)',
  '. $Resolver',
  '$selected = Resolve-OshalGitBash',
  '[pscustomobject]@{ Found = ($null -ne $selected); Selected = [string]$selected } | ConvertTo-Json -Compress',
].join('\n'));

writeFileSync(resolvedTargetProbe, [
  'param([string]$Resolver, [string]$Candidate, [string]$ResolvedTarget)',
  '. $Resolver',
  '$script:probeCalled = $false',
  'function Test-Path { param([string]$LiteralPath, $PathType) return $true }',
  'function Resolve-Path { [CmdletBinding()] param([string]$LiteralPath) return [pscustomobject]@{ ProviderPath = $ResolvedTarget } }',
  'function Invoke-OshalGitBashVersionProbe { param([string]$Path, [int]$TimeoutMs) $script:probeCalled = $true; return "5.2.0" }',
  '$selected = Resolve-OshalGitBash -CandidatePaths @($Candidate)',
  '[pscustomobject]@{ Found = ($null -ne $selected); ProbeCalled = $script:probeCalled } | ConvertTo-Json -Compress',
].join('\n'));

interface ResolverOutcome {
  Found: boolean;
  Selected: string;
}

const resolveRealBash = (): string => {
  if (process.platform !== 'win32') return realpathSync(execFileSync('which', ['bash'], { encoding: 'utf8' }).trim());
  let directory = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up++) {
    for (const relative of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = join(directory, relative);
      if (existsSync(candidate)) return realpathSync(candidate);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('no Git Bash found near git --exec-path; resolver guard cannot execute');
};

const bash = resolveRealBash();
const bashPath = (path: string): string => path.replace(/\\/g, '/');
const processTestTimeoutMs = 30_000;

/**
 * @description Lists live Git Bash probes by the marker the resolver stamps into every probe
 * command line. The hung-probe assertions below compare this before and after: returning null and
 * finishing inside the budget are BOTH satisfied by a resolver that simply gives up and orphans a
 * spinning child, which is exactly the defect that burned 20.6 CPU-hours on 2026-08-05/06. Only a
 * process-table check can see it.
 * @returns Process IDs of live marker-tagged probes; empty off Windows.
 */
const strayProbePids = (): number[] => {
  if (process.platform !== 'win32') return [];
  // Match the probe's full invocation shape, not the bare marker: any shell that merely MENTIONS
  // the marker (a grep for it, this very file being edited) is a bash.exe carrying that string on
  // its command line, and a guard that counts those is a guard that fails at random.
  const listed = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "@((Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" -ErrorAction SilentlyContinue |"
    + " Where-Object { $_.CommandLine -like '*--noprofile --norc -c*printf __OSHAL_GIT_BASH__:*' })"
    + ".ProcessId) -join ','",
  ], { encoding: 'utf8' }).trim();
  return listed ? listed.split(',').filter(Boolean).map(Number) : [];
};

const reapStrayProbes = (pids: number[]): void => {
  if (process.platform !== 'win32' || pids.length === 0) return;
  for (const pid of pids) {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { /* already gone between listing and reaping */ }
  }
};

const suiteStartStrayPids = strayProbePids();

const runResolver = (candidate: string, startupFile = '', timeoutMs = 3_000) => {
  const started = Date.now();
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe,
    resolver, candidate, String(timeoutMs),
  ], {
    encoding: 'utf8',
    timeout: 25_000,
    env: {
      ...process.env,
      BASH_ENV: startupFile ? bashPath(startupFile) : '',
    },
  });
  const line = (result.stdout ?? '').trim().split(/\r?\n/)
    .findLast((candidate) => candidate.trimStart().startsWith('{')) ?? '';
  return { result, elapsedMs: Date.now() - started, outcome: line ? JSON.parse(line) as ResolverOutcome : null };
};

const runPowerShellProbe = (script: string, args: string[], timeout = 15_000) => spawnSync(powershell, [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args,
], { encoding: 'utf8', timeout });

const parseLastJsonLine = <T>(stdout: string): T => {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? '';
  return JSON.parse(line) as T;
};

const expectProbeSucceeded = (run: ReturnType<typeof runResolver>): ResolverOutcome => {
  expect(run.result.status, `${run.result.error?.message ?? ''}\n${run.result.stdout}\n${run.result.stderr}`).toBe(0);
  expect(run.outcome).not.toBeNull();
  return run.outcome as ResolverOutcome;
};

describe('shared Windows Git Bash resolver', () => {
  it('selects a candidate only after a Git-for-Windows identity probe', () => {
    const run = runResolver(bash, validIdentityHook);
    const outcome = expectProbeSucceeded(run);
    expect(outcome, `${run.result.stdout}\n${run.result.stderr}`).toEqual({
      Found: true,
      Selected: bash,
    });
  }, processTestTimeoutMs);

  it('rejects a zero-exit candidate whose BASH_VERSION is empty', () => {
    const outcome = expectProbeSucceeded(runResolver(bash, emptyVersionHook));
    expect(outcome).toEqual({ Found: false, Selected: '' });
  }, processTestTimeoutMs);

  it('rejects valid-looking probe output from a non-zero candidate', () => {
    const outcome = expectProbeSucceeded(runResolver(bash, nonzeroOutputHook));
    expect(outcome).toEqual({ Found: false, Selected: '' });
  }, processTestTimeoutMs);

  it('rejects a Bash runtime that identifies as WSL/Linux', () => {
    const run = runResolver(bash, process.platform === 'win32' ? wslIdentityHook : '');
    expect(expectProbeSucceeded(run)).toEqual({ Found: false, Selected: '' });
    expect(run.result.stdout).toMatch(/Rejected non-MSYS\/MINGW Bash identity/);
  }, processTestTimeoutMs);

  it('kills and rejects a hung version probe within a finite budget', () => {
    const before = strayProbePids();
    const run = runResolver(bash, hungVersionHook, 200);
    // Assert the leak FIRST. Ordering is deliberate: a cleanup regression also blows the elapsed
    // budget, so a timing assertion placed earlier would mask the actual defect behind a slow-test
    // failure and send the next reader hunting a performance problem instead of an orphan.
    const leaked = strayProbePids().filter((pid) => !before.includes(pid));
    reapStrayProbes(leaked);
    expect(leaked, `hung probe left ${leaked.length} spinning Git Bash process(es) behind`).toEqual([]);
    expect(expectProbeSucceeded(run)).toEqual({ Found: false, Selected: '' });
    // The helper's worst cleanup path is bounded; leave scheduler headroom under the full suite.
    expect(run.elapsedMs).toBeLessThan(20_000);
  }, processTestTimeoutMs);

  it.each([
    ['System32 Bash', join(scratch, 'Windows', 'System32', 'bash.exe')],
    ['Sysnative Bash', join(scratch, 'Windows', 'Sysnative', 'bash.exe')],
    ['SysWOW64 Bash', join(scratch, 'Windows', 'SysWOW64', 'bash.exe')],
    ['WSL launcher', join(scratch, 'Windows', 'wsl.exe')],
  ])('rejects a %s path before probing', (_label, candidate) => {
    const run = runResolver(candidate);
    expect(expectProbeSucceeded(run)).toEqual({ Found: false, Selected: '' });
    expect(run.result.stdout).toMatch(/Rejected System32\/WSL Bash candidate/);
  }, processTestTimeoutMs);

  it('returns null for a missing otherwise-safe candidate', () => {
    const run = runResolver(join(scratch, 'missing', 'bash.exe'));
    expect(expectProbeSucceeded(run)).toEqual({ Found: false, Selected: '' });
  }, processTestTimeoutMs);

  it('rejects a candidate whose resolved target becomes System32 Bash', () => {
    const result = runPowerShellProbe(resolvedTargetProbe, [
      resolver,
      join(scratch, 'safe-looking', 'bash.exe'),
      join(scratch, 'Windows', 'System32', 'bash.exe'),
    ]);
    expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toEqual({ Found: false, ProbeCalled: false });
  }, processTestTimeoutMs);

  it('discovers the installed Git Bash through the production candidate path', () => {
    const result = runPowerShellProbe(discoveryProbe, [resolver]);
    expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const outcome = parseLastJsonLine<ResolverOutcome>(result.stdout);
    if (process.platform === 'win32') {
      expect(outcome.Found).toBe(true);
      expect(outcome.Selected.toLowerCase()).toBe(bash.toLowerCase());
    } else {
      expect(outcome).toEqual({ Found: false, Selected: '' });
    }
  }, processTestTimeoutMs);

  it('rechecks and terminates descendants when taskkill fails', () => {
    if (process.platform !== 'win32') return;
    const childScript = join(scratch, 'tree-child.ps1');
    const parentScript = join(scratch, 'tree-parent.ps1');
    const treeProbe = join(scratch, 'tree-probe.ps1');
    const parentPidFile = join(scratch, 'tree-parent.pid');
    const childPidFile = join(scratch, 'tree-child.pid');
    writeFileSync(childScript, 'param([string]$PidFile)\nSet-Content -LiteralPath $PidFile -Value $PID\nStart-Sleep -Seconds 300\n');
    writeFileSync(parentScript, [
      'param([string]$ParentPidFile, [string]$ChildPidFile, [string]$ChildScript, [string]$Shell)',
      'Set-Content -LiteralPath $ParentPidFile -Value $PID',
      '$childArgs = "-NoProfile -File `"$ChildScript`" `"$ChildPidFile`""',
      '$null = Start-Process -FilePath $Shell -ArgumentList $childArgs -PassThru',
      'while (-not (Test-Path -LiteralPath $ChildPidFile)) { Start-Sleep -Milliseconds 10 }',
      'Start-Sleep -Seconds 300',
    ].join('\n'));
    writeFileSync(treeProbe, [
      'param([string]$Resolver, [string]$ParentScript, [string]$ParentPidFile, [string]$ChildPidFile, [string]$ChildScript, [string]$Shell)',
      '. $Resolver',
      '$script:taskkillCalled = $false',
      'function Invoke-OshalGitBashProbeTaskkill { param($Process, [string]$Path) $script:taskkillCalled = $true; return $false }',
      '$parentArgs = "-NoProfile -File `"$ParentScript`" `"$ParentPidFile`" `"$ChildPidFile`" `"$ChildScript`" `"$Shell`""',
      '$parent = Start-Process -FilePath $Shell -ArgumentList $parentArgs -PassThru',
      '$deadline = (Get-Date).AddSeconds(10)',
      'while (-not (Test-Path -LiteralPath $ChildPidFile)) { if ((Get-Date) -ge $deadline) { throw "child PID timeout" }; Start-Sleep -Milliseconds 20 }',
      '$stopped = Stop-OshalGitBashProbe $parent "forced-taskkill-failure"',
      '$parentProcessId = [int](Get-Content -LiteralPath $ParentPidFile)',
      '$childProcessId = [int](Get-Content -LiteralPath $ChildPidFile)',
      '$parentAlive = $null -ne (Get-Process -Id $parentProcessId -ErrorAction SilentlyContinue)',
      '$childAlive = $null -ne (Get-Process -Id $childProcessId -ErrorAction SilentlyContinue)',
      'if ($parentAlive) { Stop-Process -Id $parentProcessId -Force -ErrorAction SilentlyContinue }',
      'if ($childAlive) { Stop-Process -Id $childProcessId -Force -ErrorAction SilentlyContinue }',
      '[pscustomobject]@{ Stopped = $stopped; TaskkillCalled = $script:taskkillCalled; ParentAlive = $parentAlive; ChildAlive = $childAlive } | ConvertTo-Json -Compress',
    ].join('\n'));
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = runPowerShellProbe(treeProbe, [resolver, parentScript, parentPidFile, childPidFile, childScript, shell], 30_000);
    expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toEqual({
      Stopped: true,
      TaskkillCalled: true,
      ParentAlive: false,
      ChildAlive: false,
    });
  }, 35_000);

  it('keeps every scheduled caller on the exact shared fail-closed invocation path', () => {
    const watchdog = readFileSync(join(repoRoot, 'scripts', 'oshal-stack-watchdog.ps1'), 'utf8');
    const store = readFileSync(join(repoRoot, 'scripts', 'publish-store-nightly.ps1'), 'utf8');
    const lab = readFileSync(join(repoRoot, 'scripts', 'publish-lab-report.ps1'), 'utf8');
    expect(watchdog).toContain('$script:gitBash = Resolve-OshalGitBash');
    expect(watchdog).not.toContain('function Get-BashExe');
    expect(watchdog).toMatch(/no validated Git Bash found[\s\S]{0,160}exit 2/);
    expect(store).toMatch(/\$bash = Resolve-OshalGitBash[\s\S]{0,220}exit 2/);
    expect(lab).toMatch(/\$bash = Resolve-OshalGitBash[\s\S]{0,160}FailMail/);
    expect(lab).not.toMatch(/&\s+["']C:\\Program Files\\Git\\bin\\bash\.exe/);
    expect(watchdog).toContain('Invoke-Timed $script:gitBash "-lc');
    expect(store).toContain('cmd /c "`"$bash`" scripts/publish-store.sh');
    expect(lab).toContain('$repoArg = ConvertTo-BashSingleQuoted $repoFwd');
    expect(lab).toContain('$dep = & $bash -lc "cd $repoArg && bash scripts/deploy-oswarm-site.sh"');
  });

  it('Bash-quotes an apostrophe in the self-located lab checkout path', () => {
    const lab = readFileSync(join(repoRoot, 'scripts', 'publish-lab-report.ps1'), 'utf8');
    const quoteFunction = lab.match(/function ConvertTo-BashSingleQuoted[\s\S]*?\r?\n\}/)?.[0];
    expect(quoteFunction).toBeTruthy();
    const quoteProbe = join(scratch, 'quote-path.ps1');
    writeFileSync(quoteProbe, `param([string]$Value)\n${quoteFunction}\n(ConvertTo-BashSingleQuoted $Value) | ConvertTo-Json -Compress\n`);
    const result = runPowerShellProbe(quoteProbe, ["C:/Roger's Repo"]);
    expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
    expect(parseLastJsonLine(result.stdout)).toBe("'C:/Roger'\"'\"'s Repo'");
  }, 20_000);
});
