/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the enrolment guard that RUNS the installer instead of reading it. The one-click file was refused at registration because installer/lib/install-node.ps1 still configured a node with the retired swarm-wide secret, and a freshly installed node never came back after a reboot because nothing registered it to start with Windows. Both halves are proven here by executing real PowerShell: the refusals are observed from a real run of the script, and the startup registration the download emits is executed against a temporary Startup folder and read back THROUGH the shortcut it wrote.
 */

/**
 * Real-boundary guards for node enrolment.
 *
 * The lesson this file exists for: every earlier test of this path exercised the RENDERER,
 * none ran the installer, and the feature failed three times on a real machine anyway. So
 * these cases spawn PowerShell and judge what the script actually does - a refusal is a
 * refusal only if the process really stops there, and a shortcut exists only if reading it
 * back returns the launcher it claims to point at.
 *
 * @module node-enrolment-installer.spec
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderNodeInstaller } from '@/app/routes/node-installer-routes';

const REPO_ROOT = process.cwd();
const INSTALLER = path.join(REPO_ROOT, 'installer', 'lib', 'install-node.ps1');

/**
 * An address nothing listens on, so the reachability probe fails immediately.
 *
 * It is deliberately NOT a service port: only the cases that are SUPPOSED to get past
 * credential resolution reach it at all, and when they do the connection is refused by the
 * kernel rather than answered by something that happens to be running.
 */
const UNREACHABLE = 'http://127.0.0.1:9';

/** A stand-in for the swarm-wide secret. If it appears in any output, it was accepted. */
const SWARM_WIDE = 'swarm-wide-secret-value';

const VALID_DOWNLOAD = {
  controlPlaneUrl: 'http://192.168.1.5:35457',
  token: 'test-token',
  clientId: 'node-2f1c9e2a-0000-4a1b-9c3d-5e6f70819200',
  nodeName: 'roger-laptop',
  nodePackage: '@oshal/chat',
};

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
 * @description Runs the checkout installer for real and returns how it ended.
 * @param args - Arguments passed to install-node.ps1.
 * @returns The exit status and the combined output the operator would have seen.
 */
function runInstaller(args: string[]): { status: number | null; output: string } {
  const result = spawnSync(
    POWERSHELL as string,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, ...args],
    { encoding: 'utf8', timeout: 120_000, cwd: REPO_ROOT, windowsHide: true },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** The installer source, for the static half on a machine with no PowerShell. */
function installerSource(): string {
  return fs.readFileSync(INSTALLER, 'utf8');
}

/**
 * @description Cuts one whole `function Name { ... }` block out of an emitted script.
 *
 *   Brace-counted rather than regex-matched so the extracted text is the COMPLETE function
 *   the download ships - which is the point: the guard executes that text, it does not
 *   assert that something resembling it is present.
 * @param script - The rendered installer.
 * @param name - The PowerShell function to cut out.
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

describe('the checkout installer and the retired swarm-wide secret', () => {
  it('refuses -SharedSecret outright, instead of configuring a node that cannot register', () => {
    if (!POWERSHELL) {
      // No PowerShell here: assert the same claim against the source rather than skip. A
      // guard that skips is a guard that does not exist.
      const source = installerSource();
      expect(source).not.toMatch(/\$ControlPlaneUrl -and \$SharedSecret/);
      expect(source).toMatch(/shared secret is no longer/i);
      return;
    }
    const { status, output } = runInstaller([
      '-ControlPlaneUrl', UNREACHABLE, '-SharedSecret', SWARM_WIDE,
    ]);
    // It stops, and it stops for the RIGHT reason...
    expect(status).not.toBe(0);
    expect(output).toMatch(/shared secret/i);
    // ...names the way out, so the dead end is escapable...
    expect(output).toMatch(/enrol/i);
    // ...and never got as far as configuring a node. This is the assertion that matters:
    // with the swarm-wide branch still in place the script sails past resolution and the
    // only thing that stops it is the network probe.
    expect(output).not.toContain('Checking the swarm at');
    expect(output).not.toContain(SWARM_WIDE);
  }, 180_000);

  it('refuses a join code with no device token: the code carries the swarm-wide secret', () => {
    if (!POWERSHELL) {
      const source = installerSource();
      expect(source).toMatch(/\$JoinCode[\s\S]{0,400}\$EnrollmentToken/);
      return;
    }
    const joinCode = 'OSJOIN1.' + Buffer.from(`${UNREACHABLE}|${SWARM_WIDE}`, 'utf8')
      .toString('base64url');
    const { status, output } = runInstaller(['-JoinCode', joinCode]);
    expect(status).not.toBe(0);
    expect(output).toMatch(/enrol/i);
    expect(output).not.toContain('Checking the swarm at');
    expect(output).not.toContain(SWARM_WIDE);
  }, 180_000);

  it('still takes a URL plus a device-bound token as a complete target', () => {
    if (!POWERSHELL) {
      expect(installerSource()).toMatch(/SharedSecret\s*=\s*\$EnrollmentToken/);
      return;
    }
    const { status, output } = runInstaller([
      '-ControlPlaneUrl', UNREACHABLE, '-EnrollmentToken', 'enrolment-token-placeholder', '-NoLaunch',
    ]);
    // Resolution accepted it - the refusal above is not a blanket refusal of every input.
    expect(output).toContain('Checking the swarm at');
    // ...and then it failed on the probe, which is what SHOULD stop a run against an
    // address with no swarm behind it.
    expect(output).toMatch(/Could not reach the swarm/);
    expect(status).not.toBe(0);
  }, 180_000);
});

describe('the one-click download and surviving a reboot', () => {
  it('emits a startup registration that really writes a shortcut Windows will run', () => {
    const script = renderNodeInstaller(VALID_DOWNLOAD);
    const emitted = extractFunction(script, 'New-OshalStartupShortcut');
    expect(emitted, 'the download emits no startup registration').toBeTruthy();
    // The call site must hand it the real per-user Startup folder and the launcher npm
    // actually created - not a guess at either.
    expect(script).toMatch(/New-OshalStartupShortcut[\s\S]{0,300}GetFolderPath\("Startup"\)/);
    expect(script).toMatch(/New-OshalStartupShortcut[\s\S]{0,300}\$launcher/);

    if (!POWERSHELL) {
      // Static half: the emitted text must at least verify its own write, since a .lnk that
      // saved without error can still point nowhere.
      expect(emitted).toMatch(/CreateShortcut/);
      expect(emitted).toMatch(/TargetPath/);
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-node-startup-'));
    scratchDirs.push(dir);
    const startupDir = path.join(dir, 'Startup');
    const launcher = path.join(dir, 'oshal-chat.cmd');
    fs.writeFileSync(launcher, '@echo off\r\nrem test launcher\r\n');
    const probe = path.join(dir, 'probe.ps1');
    fs.writeFileSync(probe, [
      '$ErrorActionPreference = "Stop"',
      emitted as string,
      `$link = New-OshalStartupShortcut -Launcher '${launcher}' -StartupDir '${startupDir}'`
        + " -LinkName 'OSHAL Node'",
      'Write-Output ("LINK=" + $link)',
      // Read it back THROUGH the shortcut in a fresh COM object. Windows link creation
      // lies: a Save() that returned can still have recorded nothing.
      `$read = (New-Object -ComObject WScript.Shell).CreateShortcut($link)`,
      'Write-Output ("TARGET=" + $read.TargetPath)',
      '',
    ].join('\r\n'));

    const result = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe],
      { encoding: 'utf8', timeout: 120_000, cwd: REPO_ROOT, windowsHide: true },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, output).toBe(0);
    const link = /LINK=(.+)/.exec(output)?.[1]?.trim();
    expect(link).toBeTruthy();
    expect(fs.existsSync(link as string)).toBe(true);
    expect(path.dirname(link as string)).toBe(startupDir);
    expect(output).toContain(`TARGET=${launcher}`);
  }, 180_000);

  it('is still a script PowerShell can parse, startup registration and all', () => {
    // A .cmd whose PowerShell half does not parse is dead on arrival: cmd runs the header,
    // Invoke-Expression fails on the whole body, and the person sees a wall of red having
    // installed nothing. Nothing else parses the EMITTED script - the on-disk .ps1 guard
    // only walks installer/ - so the text this route generates is checked here.
    const script = renderNodeInstaller(VALID_DOWNLOAD);
    const marker = script.split('\r\n').find((line) => line.startsWith('#___'));
    expect(marker).toBeTruthy();
    const body = script.slice(script.indexOf(marker as string) + (marker as string).length);
    if (!POWERSHELL) {
      // Off-Windows: the balance check the on-disk installers get, rather than nothing.
      const braces = (body.match(/\{/g) ?? []).length - (body.match(/\}/g) ?? []).length;
      expect(braces).toBe(0);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-node-parse-'));
    scratchDirs.push(dir);
    const target = path.join(dir, 'install-oshal-node.ps1');
    fs.writeFileSync(target, body);
    // The path travels in the ENVIRONMENT, never interpolated into -Command: Windows
    // command-line parsing eats the backslashes of an embedded absolute path.
    const result = spawnSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', [
        '$e = $null;',
        '[System.Management.Automation.Language.Parser]::ParseFile('
          + '$env:OSHAL_PARSE_TARGET, [ref]$null, [ref]$e) | Out-Null;',
        'if ($e.Count) { $e | ForEach-Object'
          + ' { "L" + $_.Extent.StartLineNumber + ": " + $_.Message } }',
      ].join(' ')],
      {
        encoding: 'utf8', timeout: 120_000, windowsHide: true,
        env: { ...process.env, OSHAL_PARSE_TARGET: target },
      },
    );
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()).toBe('');
  }, 180_000);

  it('never puts the retired swarm-wide secret in the download', () => {
    const script = renderNodeInstaller(VALID_DOWNLOAD);
    expect(script).not.toContain('OSJOIN1');
    expect(script).not.toMatch(/REMOTE_CLIENT_SHARED_SECRET/);
    // The token it does carry is bound to one device and is the node's steady-state
    // credential, so the file must say the node registers with it.
    expect(script).toContain('OSHAL_ENROLLMENT_TOKEN');
    expect(script).toContain('OSHAL_CLIENT_ID');
  });
});
