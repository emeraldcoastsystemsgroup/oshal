/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the silent -OffLan degradation. Test-ShouldGoOffLan returned $false the moment Test-HeadscaleRunning was false, BEFORE it read the -OffLan switch, so an explicit off-LAN request against a stopped Headscale minted a LAN-only OSJOIN1 code and said nothing. Nothing would have gone red: the installer has no Pester suite, and the two existing installer specs parse the script or run install-node.ps1 — neither reaches this decision. These cases cut the real Test-ShouldGoOffLan / New-JoinCodeForThisSwarm text out of the shipped installer and EXECUTE it under real PowerShell against the real common.ps1, stubbing only the five environment probes (Test-HeadscaleRunning, Get-HeadscaleServerUrl, Get-TailnetIPv4, New-HeadscalePreauthKey, Get-LanIPv4) and Read-Host, so a refusal is a refusal only when the process really stops and a join code is a code only when ConvertTo-JoinCode really produced one. A second harness lifts the text after the `# Main` banner verbatim with every step stubbed to announce itself, because the first cut of the fix refused inside Show-Summary -- the LAST step -- and adversarial verification found it built the image, started the stack, ran verification and opened the firewall before saying no. The ordering cases prove the refusal now fires before any of that.
 */

/**
 * Real-boundary guard for the off-LAN join code decision.
 *
 * Headscale is opt-in by operator decision (2026-09-21) — it is an outward-facing network
 * coordination service — but opt-in only works if an explicit opt-in that cannot be honoured
 * FAILS. The defect this file exists for is the opposite: `-OffLan` with Headscale stopped
 * produced a LAN-only `OSJOIN1` code, which looks like success and cannot work off the LAN.
 *
 * What is real here and what is not, stated plainly so nobody reads more into a green run
 * than it earns:
 *   REAL — the decision logic and the ORDER of the main flow. The function bodies, and the
 *     text after the `# Main` banner, are cut out of the shipped
 *     `installer/lib/install-swarm.ps1` and executed by PowerShell, under the same
 *     `Set-StrictMode -Version Latest` the installer sets, against the real
 *     `installer/lib/common.ps1` — so `Stop-WithError`'s `exit 1` and `ConvertTo-JoinCode`'s
 *     `OSJOIN1.`/`OSJOIN2.` output are the production ones, not re-implementations.
 *   STUBBED — five environment probes and `Read-Host`. Four answer for Headscale and the
 *     tailnet (`Test-HeadscaleRunning`, `Get-HeadscaleServerUrl`, `Get-TailnetIPv4`,
 *     `New-HeadscalePreauthKey`); the fifth, `Get-LanIPv4`, always returns an address so that
 *     "no code was minted" can only ever mean "refused". They are what makes the matrix
 *     reachable at all: the real ones need a running Headscale container, a tailnet and a
 *     human. In the main-flow harness every install STEP is stubbed too, to announce itself.
 *     This guard therefore does NOT prove that Headscale detection works against a real
 *     container, nor that a build succeeds — it proves what the installer DOES with each
 *     answer, and WHEN.
 *
 * @module installer-offlan-refusal.spec
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const INSTALLER = path.join(REPO_ROOT, 'installer', 'lib', 'install-swarm.ps1');
const COMMON = path.join(REPO_ROOT, 'installer', 'lib', 'common.ps1');

/** A stand-in controller secret. Present in every minted code, absent when none was minted. */
const SECRET = 'offlan-guard-secret';

/**
 * A stand-in pre-auth key that deliberately does NOT carry Headscale's real `hskey-auth-`
 * prefix. This repo is public and the publish gate scans tracked files for vendor-prefixed
 * credentials, so a realistic-looking fixture trips it — correctly, since the gate cannot
 * know a literal is fake. Nothing here parses the value: `New-HeadscalePreauthKey` is
 * stubbed and `ConvertTo-JoinCode` only base64-encodes it, so all that matters is that it
 * is non-empty. Do not "improve" this into something that looks like a real key.
 */
const PREAUTH_KEY = 'preauth-key-placeholder';

/**
 * @description Resolves a PowerShell executable by inspecting the filesystem only.
 *
 *   Probing by running one made an earlier installer guard flaky: it passed alone and timed
 *   out under the full suite, then hard-failed as if PowerShell were missing. Existence
 *   checks are load-insensitive.
 * @returns An absolute path to powershell/pwsh, or null when this machine has neither.
 */
function findPowerShell(): string | null {
  const candidates: string[] = [];
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) {
    candidates.push(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const base of ['pwsh', 'powershell']) {
      for (const ext of exts) candidates.push(path.join(dir, base + ext));
    }
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable PATH entry - keep looking */
    }
  }
  return null;
}

const POWERSHELL = findPowerShell();

/**
 * @description Cuts one whole `function Name { ... }` block out of a PowerShell script.
 *
 *   Brace-counted rather than regex-matched so the extracted text is the COMPLETE function
 *   the installer ships — which is the point: the guard executes that text, it does not
 *   assert that something resembling it is present.
 * @param script - The PowerShell source.
 * @param name - The function to cut out.
 * @returns The function text, or null when the script defines no such function.
 */
function extractFunction(script: string, name: string): string | null {
  const start = script.indexOf(`function ${name} {`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(start, i + 1);
    }
  }
  return null;
}

/** How the environment answers on this run. '' means the probe found nothing. */
interface OffLanWorld {
  /** Was `-OffLan` passed on the command line? */
  offLan: boolean;
  /** Was `-NonInteractive` passed? */
  nonInteractive: boolean;
  /** Is the oshal-headscale container up? */
  headscaleRunning: boolean;
  /** `server_url` out of infra/headscale/config/config.yaml. */
  serverUrl?: string;
  /** This machine's tailnet IPv4. */
  tailnetIp?: string;
  /** The pre-auth key Headscale minted. */
  authKey?: string;
  /** What a human types at the off-LAN prompt. Setting it asserts the prompt was reached. */
  promptAnswer?: string;
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not worth failing a guard over */
    }
  }
});

/** A PowerShell boolean literal. */
function psBool(value: boolean): string {
  return value ? '$true' : '$false';
}

/** A single-quoted PowerShell string; `''` is the escape for a quote inside one. */
function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * @description Runs the installer's real off-LAN decision against a described environment.
 *
 *   The two functions under test are lifted verbatim out of install-swarm.ps1 and run beside
 *   the real common.ps1, so `Stop-WithError` really exits and `ConvertTo-JoinCode` really
 *   encodes. Only the environment probes are replaced — they are redefined AFTER common.ps1
 *   is dot-sourced, which is what makes the stub win over the real one.
 * @param world - How each probe should answer, and whether the switches were passed.
 * @returns The exit status and everything the operator would have seen.
 */
function runOffLanDecision(world: OffLanWorld): { status: number | null; output: string } {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  const refuse = extractFunction(source, 'Stop-ForAbsentHeadscale');
  const decide = extractFunction(source, 'Test-ShouldGoOffLan');
  const build = extractFunction(source, 'New-JoinCodeForThisSwarm');
  if (!refuse || !decide || !build) {
    throw new Error('install-swarm.ps1 no longer defines Stop-ForAbsentHeadscale / '
      + 'Test-ShouldGoOffLan / New-JoinCodeForThisSwarm');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-offlan-'));
  scratchDirs.push(dir);
  const probe = path.join(dir, 'probe.ps1');

  const lines = [
    // The installer sets both; strict mode is what makes an undefined $OffLan an error rather
    // than a silent $false, so the probe must run under the same rules the real script does.
    'Set-StrictMode -Version Latest',
    "$ErrorActionPreference = 'Stop'",
    // Real Write-*/Stop-WithError/ConvertTo-JoinCode. Path travels in the environment because
    // Windows command-line parsing eats the backslashes of an embedded absolute path.
    '. $env:OSHAL_COMMON_PS1',
    '',
    // --- the script-scope state the two functions close over -------------------------------
    `$OffLan = ${psBool(world.offLan)}`,
    `$NonInteractive = ${psBool(world.nonInteractive)}`,
    "$RepoRoot = 'C:\\does-not-matter'",   // only ever passed to the stubbed Get-HeadscaleServerUrl
    "$CockpitPort = '35457'",
    "$BaseUrl = 'http://localhost:35457'",
    '',
    // --- the environment probes, stubbed so every branch is reachable ----------------------
    `function Test-HeadscaleRunning { return ${psBool(world.headscaleRunning)} }`,
    `function Get-HeadscaleServerUrl { param($RepoRoot) return ${psString(world.serverUrl ?? '')} }`,
    `function Get-TailnetIPv4 { return ${psString(world.tailnetIp ?? '')} }`,
    'function New-HeadscalePreauthKey { param($UserName, $ExpirationHrs) return '
      + `${psString(world.authKey ?? '')} }`,
    // A LAN address is always available, so a LAN-only code is always MINTABLE. That matters:
    // when a case asserts no code was emitted, it is because the installer refused, not
    // because it had nothing to fall back to.
    "function Get-LanIPv4 { return '192.168.1.50' }",
    // Shadowing the Read-Host cmdlet is how the interactive prompt becomes testable. It
    // announces itself so a case can prove the prompt really was (or never was) reached.
    world.promptAnswer === undefined
      ? 'function Read-Host { param($Prompt) Write-Host "PROMPTED"; throw '
        + '"Read-Host was reached in a run that must never prompt" }'
      : `function Read-Host { param($Prompt) Write-Host "PROMPTED"; return ${psString(world.promptAnswer)} }`,
    '',
    refuse,
    '',
    decide,
    '',
    build,
    '',
    `$code = New-JoinCodeForThisSwarm -Secret ${psString(SECRET)}`,
    'Write-Host ("JOINCODE=" + $code)',
    '',
  ];

  fs.writeFileSync(probe, lines.join('\r\n'));

  const result = spawnSync(
    POWERSHELL as string,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
    {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, OSHAL_COMMON_PS1: COMMON },
    },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** Every step the main flow calls, in shipped order, and what each stub hands back. */
const MAIN_FLOW_STEPS: Array<[name: string, returns: string]> = [
  ['Assert-Docker', ''],
  ['Invoke-SystemDoctor', ''],
  ['Initialize-EnvFile', "'stub-secret'"],
  ['Invoke-ConnectAiStep', "''"],
  ['Set-SwarmProvider', ''],
  ['Invoke-ImageBuild', ''],
  ['Start-Stack', ''],
  ['Wait-ForController', ''],
  ['Invoke-Verification', '0'],
  ['Open-CockpitFirewallPort', ''],
  ['Show-Summary', ''],
];

/**
 * @description Drives the installer's real MAIN FLOW with every step stubbed to announce itself.
 *
 *   The text after the `# Main` banner is lifted verbatim, so the order of steps under test is
 *   the order the installer ships. Each step becomes a stub that prints `CALLED:<name>`, which
 *   is what lets a case assert that a refusal fired BEFORE the build rather than after it. The
 *   first cut of this fix refused inside Show-Summary, the last step, and built, started,
 *   verified and opened the firewall on the way there. Only `Assert-OffLanPrerequisites` and
 *   `Stop-ForAbsentHeadscale` are real.
 * @param world - Whether -OffLan was passed and whether Headscale is up.
 * @returns The exit status and everything the operator would have seen.
 */
function runMainFlow(
  world: Pick<OffLanWorld, 'offLan' | 'headscaleRunning'>,
): { status: number | null; output: string } {
  const source = fs.readFileSync(INSTALLER, 'utf8');
  const bannerAt = source.search(/^# Main\r?\n/m);
  if (bannerAt < 0) throw new Error('install-swarm.ps1 no longer has a # Main banner');
  const front = extractFunction(source, 'Assert-OffLanPrerequisites');
  const refuse = extractFunction(source, 'Stop-ForAbsentHeadscale');
  if (!front || !refuse) {
    throw new Error('install-swarm.ps1 no longer defines Assert-OffLanPrerequisites / Stop-ForAbsentHeadscale');
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-offlan-main-'));
  scratchDirs.push(dir);
  const probe = path.join(dir, 'probe.ps1');

  // One param block covers every call site: PowerShell leaves a named parameter that was not
  // passed unbound, so the same stub shape serves -RepoRoot/-CockpitPort, -Secret, -Provider
  // and -NonInteractive: alike.
  const stubs = MAIN_FLOW_STEPS.map(([name, returns]) =>
    `function ${name} { param($RepoRoot, $CockpitPort, $Provider, $Secret, [switch]$NonInteractive) `
      + `Write-Host "CALLED:${name}"${returns ? `; return ${returns}` : ''} }`);

  fs.writeFileSync(probe, [
    'Set-StrictMode -Version Latest',
    "$ErrorActionPreference = 'Stop'",
    '. $env:OSHAL_COMMON_PS1',
    '',
    '$Down = $false',
    '$ConnectOnly = $false',
    '$Dev = $false',
    '$WithKeys = $false',
    '$NonInteractive = $true',
    `$OffLan = ${psBool(world.offLan)}`,
    "$RepoRoot = 'C:\\does-not-matter'",
    "$CockpitPort = '35457'",
    '',
    `function Test-HeadscaleRunning { return ${psBool(world.headscaleRunning)} }`,
    ...stubs,
    '',
    refuse,
    '',
    front,
    '',
    source.slice(bannerAt),
    '',
  ].join('\r\n'));

  const result = spawnSync(
    POWERSHELL as string,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
    {
      encoding: 'utf8',
      timeout: 120_000,
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, OSHAL_COMMON_PS1: COMMON },
    },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The `CALLED:` announcements a main-flow run made, in order. */
function stepsReached(output: string): string[] {
  return (output.match(/CALLED:[\w-]+/g) ?? []).map((hit) => hit.slice('CALLED:'.length));
}

/** The installer source, for the static half on a machine with no PowerShell. */
function installerSource(): string {
  return fs.readFileSync(INSTALLER, 'utf8');
}

/** True when the run emitted a join code of either generation. */
function mintedAJoinCode(output: string): boolean {
  return /OSJOIN[12]\./.test(output);
}

describe('an explicit -OffLan request that cannot be honoured', () => {
  it('refuses when Headscale is not running, instead of minting a LAN-only code', () => {
    if (!POWERSHELL) {
      // No PowerShell here: assert the same claim against the source rather than skip. A
      // guard that skips is a guard that does not exist. The defect was an unconditional
      // `return $false` on the not-running branch, so what must be true is that the branch
      // consults $OffLan before returning.
      const source = installerSource();
      const notRunning = /if \(-not \(Test-HeadscaleRunning\)\) \{([\s\S]*?)\n    \}/.exec(source);
      expect(notRunning, 'Test-ShouldGoOffLan no longer has a not-running branch').toBeTruthy();
      expect(notRunning?.[1]).toMatch(/\$OffLan/);
      expect(notRunning?.[1]).toMatch(/Stop-WithError/);
      return;
    }
    const { status, output } = runOffLanDecision({
      offLan: true, nonInteractive: true, headscaleRunning: false,
    });
    // It stops...
    expect(status).not.toBe(0);
    // ...for the right reason, naming the cause and the one command that fixes it...
    expect(output).toMatch(/-OffLan/);
    expect(output).toMatch(/Headscale is not running/i);
    expect(output).toMatch(/headscale-setup\.sh/);
    // ...and — the assertion the whole file exists for — it emitted NO join code. With the
    // old `return $false` in place this run produced a perfectly well-formed OSJOIN1 that
    // could never work off the LAN, and said nothing about it.
    expect(mintedAJoinCode(output), `a join code was minted anyway:\n${output}`).toBe(false);
    expect(output).not.toContain(SECRET);
  }, 180_000);

  it.each([
    ['no server_url', { serverUrl: '', tailnetIp: '100.64.0.1', authKey: PREAUTH_KEY }],
    ['no tailnet address', { serverUrl: 'http://localhost:8085', tailnetIp: '', authKey: PREAUTH_KEY }],
    ['no pre-auth key', { serverUrl: 'http://localhost:8085', tailnetIp: '100.64.0.1', authKey: '' }],
  ])('refuses on a partial success (%s) rather than minting a weaker code', (_label, parts) => {
    if (!POWERSHELL) {
      // The three helpers return '' rather than throwing, so the guard that matters is that
      // the all-three check is still there and that $OffLan turns its failure fatal.
      const source = installerSource();
      expect(source).toMatch(/if \(\$hsUrl -and \$tailnetIp -and \$authKey\)/);
      expect(source).toMatch(/\$missing[\s\S]{0,600}if \(\$OffLan\) \{[\s\S]{0,200}Stop-WithError/);
      return;
    }
    const { status, output } = runOffLanDecision({
      offLan: true, nonInteractive: true, headscaleRunning: true, ...parts,
    });
    expect(status).not.toBe(0);
    expect(output).toMatch(/-OffLan/);
    // Headscale IS up here, so the message must not claim otherwise — it has to name which
    // ingredient was missing or the operator has nothing to act on.
    expect(output).not.toMatch(/Headscale is not running/i);
    expect(mintedAJoinCode(output), `a join code was minted anyway:\n${output}`).toBe(false);
    expect(output).not.toContain(SECRET);
  }, 180_000);
});

describe('the paths that must keep working exactly as they did', () => {
  it('-OffLan with Headscale running still mints an off-LAN OSJOIN2 code', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/if \(\$OffLan\) \{ return \$true \}/);
      return;
    }
    const { status, output } = runOffLanDecision({
      offLan: true,
      nonInteractive: true,
      headscaleRunning: true,
      serverUrl: 'http://localhost:8085',
      tailnetIp: '100.64.0.1',
      authKey: PREAUTH_KEY,
    });
    expect(status, output).toBe(0);
    // v2 specifically: the generation that carries the tailnet credentials. An OSJOIN1 here
    // would be the original defect wearing a different hat.
    expect(output).toMatch(/JOINCODE=OSJOIN2\./);
    expect(output).toMatch(/works from anywhere/i);
    // The refusal is not a blanket refusal: it never fired on the path that can be honoured.
    expect(output).not.toMatch(/\[x\]/);
  }, 180_000);

  it('-NonInteractive without -OffLan still declines silently and mints a LAN code', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/if \(\$NonInteractive\) \{ return \$false \}/);
      return;
    }
    const { status, output } = runOffLanDecision({
      offLan: false,
      nonInteractive: true,
      headscaleRunning: true,
      serverUrl: 'http://localhost:8085',
      tailnetIp: '100.64.0.1',
      authKey: PREAUTH_KEY,
    });
    expect(status, output).toBe(0);
    expect(output).toMatch(/JOINCODE=OSJOIN1\./);
    // "Silently" is the claim, so it is the thing asserted: no prompt (the stubbed Read-Host
    // throws if reached), and no refusal. The GUI passes -NonInteractive; a prompt there
    // hangs the install behind a window nobody can answer.
    expect(output).not.toContain('PROMPTED');
    expect(output).not.toMatch(/\[x\]/);
  }, 180_000);

  it('still asks, and honours the answer, on an interactive run with Headscale up', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/Read-Host "  Make this join code work off-LAN\? \[y\/N\]"/);
      return;
    }
    const world = {
      offLan: false,
      nonInteractive: false,
      headscaleRunning: true,
      serverUrl: 'http://localhost:8085',
      tailnetIp: '100.64.0.1',
      authKey: PREAUTH_KEY,
    };
    const yes = runOffLanDecision({ ...world, promptAnswer: 'y' });
    expect(yes.status, yes.output).toBe(0);
    expect(yes.output).toContain('PROMPTED');
    expect(yes.output).toMatch(/JOINCODE=OSJOIN2\./);

    const no = runOffLanDecision({ ...world, promptAnswer: 'n' });
    expect(no.status, no.output).toBe(0);
    expect(no.output).toContain('PROMPTED');
    expect(no.output).toMatch(/JOINCODE=OSJOIN1\./);
  }, 180_000);

  it('never prompts and never refuses when Headscale is simply absent and nobody asked', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/function Test-ShouldGoOffLan/);
      return;
    }
    // The resting state of the operator's own box, and of every fresh install: Headscale
    // stopped, no -OffLan. It is opt-in, so this must be an ordinary, quiet, successful run.
    const { status, output } = runOffLanDecision({
      offLan: false, nonInteractive: false, headscaleRunning: false,
    });
    expect(status, output).toBe(0);
    expect(output).toMatch(/JOINCODE=OSJOIN1\./);
    expect(output).not.toContain('PROMPTED');
    expect(output).not.toMatch(/\[x\]/);
  }, 180_000);

  it('a yes at the prompt is not the switch: a partial failure warns and falls back', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/Could not build an off-LAN join code; falling back/);
      return;
    }
    // The operator answered the interactive question, so they are watching this run. Ending
    // the install under them over a key that would not mint is a bigger blast radius than
    // the defect; the shipped behaviour is a visible warning and a LAN-only code. This is the
    // one place the two request shapes diverge, and the mutation `if ($OffLan)` -> `if ($true)`
    // in the partial block went unnoticed until this case existed.
    const { status, output } = runOffLanDecision({
      offLan: false,
      nonInteractive: false,
      headscaleRunning: true,
      serverUrl: 'http://localhost:8085',
      tailnetIp: '100.64.0.1',
      authKey: '',
      promptAnswer: 'y',
    });
    expect(status, output).toBe(0);
    expect(output).toContain('PROMPTED');
    expect(output).toMatch(/\[!\]\s+Could not build an off-LAN join code/);
    expect(output).toMatch(/would not mint a pre-auth key/);
    expect(output).toMatch(/JOINCODE=OSJOIN1\./);
    expect(output).not.toMatch(/\[x\]/);
  }, 180_000);
});

describe('an explicit -OffLan that cannot be honoured stops BEFORE anything is built', () => {
  it('refuses right after Docker is confirmed, with no .env write, no login and no build', () => {
    if (!POWERSHELL) {
      // Static half: the check is invoked between Assert-Docker and the first side effect.
      expect(installerSource()).toMatch(
        /\nAssert-Docker\r?\n\s*Assert-OffLanPrerequisites\b[\s\S]*?\n\$sharedSecret = Initialize-EnvFile/,
      );
      return;
    }
    const { status, output } = runMainFlow({ offLan: true, headscaleRunning: false });
    expect(status).not.toBe(0);
    expect(output).toMatch(/Headscale is not running/i);
    expect(output).toMatch(/headscale-setup\.sh/);
    // The flow really ran, and the check waited for Docker to be reachable (it needs
    // `docker ps` to answer) - and then NOTHING else happened. Not the .env write, not the
    // AI-login step that can open a browser, not the build, not the stack. The first cut of
    // this fix reached Show-Summary before refusing, which is every one of these.
    expect(stepsReached(output), output).toEqual(['Assert-Docker']);
  }, 180_000);

  it('is not a blanket refusal: with Headscale up the same request proceeds to the build', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/if \(\$OffLan -and -not \(Test-HeadscaleRunning\)\)/);
      return;
    }
    const { status, output } = runMainFlow({ offLan: true, headscaleRunning: true });
    expect(status, output).toBe(0);
    expect(output).not.toMatch(/\[x\]/);
    const reached = stepsReached(output);
    expect(reached).toContain('Invoke-ImageBuild');
    expect(reached).toContain('Start-Stack');
    expect(reached).toContain('Show-Summary');
  }, 180_000);

  it('does not refuse the resting state: Headscale down and nobody asked still builds', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/function Assert-OffLanPrerequisites/);
      return;
    }
    // Headscale is opt-in. A stopped one with no -OffLan is every fresh install, and the
    // front-check must be invisible to it.
    const { status, output } = runMainFlow({ offLan: false, headscaleRunning: false });
    expect(status, output).toBe(0);
    expect(output).not.toMatch(/\[x\]/);
    expect(stepsReached(output)).toContain('Invoke-ImageBuild');
  }, 180_000);
});

describe('the bring-up says whether off-LAN joining is available at all', () => {
  const UP = path.join(REPO_ROOT, 'scripts', 'oshal-up.sh');

  it('reports Headscale state advisorily, without starting it or failing on it', () => {
    const script = fs.readFileSync(UP, 'utf8');
    // It reports both states, and the down state names the one command that fixes it — the
    // "why can't my laptop join" question answered in the place the operator already looks.
    expect(script).toMatch(/echo "Headscale: running/);
    expect(script).toMatch(/echo "Headscale: not running \(opt-in\)/);
    expect(script).toMatch(/Headscale: not running[^"]*headscale-setup\.sh/);
    // Advisory only: Headscale is opt-in, so a stopped one must not exit, return non-zero,
    // or print the ##-banner this script reserves for real degradation.
    const block = /# .. Headscale:[\s\S]*?\nfi\n/.exec(script)?.[0] ?? '';
    expect(block, 'the Headscale block is no longer identifiable').not.toBe('');
    expect(block).not.toMatch(/\bexit\b/);
    expect(block).not.toMatch(/^##/m);
    // ...and it must never START it. That is the operator's call, not the bring-up's. Naming
    // the script inside an echo is the whole point, so the check is on what the block EXECUTES:
    // its only docker call is a read, and no statement invokes the setup script.
    expect(block).not.toMatch(/docker compose|\bup -d\b/);
    const statements = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('echo '));
    for (const statement of statements) {
      expect(statement, `the Headscale block executes: ${statement}`)
        .not.toMatch(/headscale-setup\.sh/);
    }
    expect(block).toMatch(/docker inspect/);
  });
});
