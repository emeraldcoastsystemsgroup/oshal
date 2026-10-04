/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Real-boundary guard for the Windows installer's SESSION_SECRET. The installer minted four secrets but not this one, so a fresh install kept the published .env.example placeholder, and SESSION_SECRET signs every login session as well as deriving stored-token keys. The shipped Initialize-SessionSecret / Test-PlaceholderSecret run under real PowerShell against the real common.ps1 and a temp .env: a fresh .env gets a random secret, a real secret is kept, an existing install still on the placeholder is warned and NOT rotated, and an empty value is filled. Without PowerShell the same claims are asserted against the source rather than skipped.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: the contract is mint ONLY into a .env this run created. An existing .env with SESSION_SECRET empty or missing is kept byte for byte (the app is signing with its AUTH_SESSION_SECRET / KEYCLOAK_CLIENT_SECRET fallback, so writing would rotate a working signer), shown with each fallback present; the old case that expected an existing empty value to be filled encoded the bug and is replaced. A fresh .env whose example line is empty is still minted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  extractPowerShellFunction, findPowerShell, INSTALL_SWARM_PS1, INSTALLER_REPO_ROOT, psString, runInstallerProbe,
} from '../helpers/installer-powershell';

const POWERSHELL = findPowerShell();
const SOURCE = fs.readFileSync(INSTALL_SWARM_PS1, 'utf8');
const EXAMPLE_PLACEHOLDER = /^SESSION_SECRET=(.*)$/m.exec(fs.readFileSync(path.join(INSTALLER_REPO_ROOT, '.env.example'), 'utf8'))?.[1].trim() ?? '';
const REAL_SECRET = 'kept-real-secret-value-that-is-not-a-placeholder-0123456789abcdef';
const FALLBACK_SIGNER = 'existing-fallback-signer-already-signing-sessions-0123456789';
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @description Runs the shipped Initialize-SessionSecret against a temp .env.
 * @param envBody - The .env content before the call.
 * @param envCreated - Whether the installer created .env in this run.
 * @returns The output and the SESSION_SECRET value afterwards.
 */
function runSessionSecret(envBody: string, envCreated: boolean): { output: string; secret: string; status: number | null; unchanged: boolean } {
  const placeholder = extractPowerShellFunction(SOURCE, 'Test-PlaceholderSecret');
  const initialize = extractPowerShellFunction(SOURCE, 'Initialize-SessionSecret');
  if (!placeholder || !initialize) throw new Error('install-swarm.ps1 no longer defines Test-PlaceholderSecret / Initialize-SessionSecret');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-session-secret-'));
  scratch.push(dir);
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, envBody);
  const run = runInstallerProbe(POWERSHELL as string, [
    `$EnvFile = ${psString(envFile)}`,
    placeholder,
    initialize,
    `Initialize-SessionSecret -EnvCreated ${envCreated ? '$true' : '$false'}`,
  ]);
  const secret = /^SESSION_SECRET=(.*)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1].trim() ?? '';
  // Byte-identical .env means every key the app's signer chain reads is unchanged, whatever it resolves to.
  return { ...run, secret, unchanged: fs.readFileSync(envFile).equals(Buffer.from(envBody)) };
}

/** @description Without PowerShell: the function's only write sits inside the created-in-this-run branch. */
function expectOnlyFreshEnvWrites(): void {
  const initialize = extractPowerShellFunction(SOURCE, 'Initialize-SessionSecret') ?? '';
  expect(initialize.match(/Set-EnvFileValue/g)?.length).toBe(1);
  expect(initialize).toMatch(/if \(\$EnvCreated\) \{\s*Set-EnvFileValue/);
  expect(initialize).not.toContain('-or -not $existing');
}

describe('the Windows installer SESSION_SECRET', () => {
  it('recognizes the .env.example value as a placeholder (the fixture the other cases depend on)', () => {
    expect(EXAMPLE_PLACEHOLDER).toMatch(/^replace-with-/);
    expect(SOURCE).toContain("'^(replace-with-|dev-only-)'");
  });

  it('mints a random secret on a fresh .env still carrying the placeholder', () => {
    if (!POWERSHELL) {
      expect(SOURCE).toMatch(/if \(\$EnvCreated\) \{\s*Set-EnvFileValue -Path \$EnvFile -Key 'SESSION_SECRET' -Value \(New-JoinSecret\)/);
      return;
    }
    const run = runSessionSecret(`FOO=bar\nSESSION_SECRET=${EXAMPLE_PLACEHOLDER}\n`, true);
    expect(run.status, run.output).toBe(0);
    expect(run.secret).not.toBe(EXAMPLE_PLACEHOLDER);
    expect(run.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(run.output).toContain('Generated a new session secret');
  });

  it('keeps a real existing secret untouched', () => {
    if (!POWERSHELL) {
      expect(SOURCE).toMatch(/if \(\$existing -and -not \(Test-PlaceholderSecret -Value \$existing\)\) \{\s*Write-Ok "Reusing the existing session secret"\s*return/);
      return;
    }
    const run = runSessionSecret(`SESSION_SECRET=${REAL_SECRET}\n`, false);
    expect(run.status, run.output).toBe(0);
    expect(run.secret).toBe(REAL_SECRET);
  });

  it('warns about, and never rotates, a placeholder on an existing install', () => {
    if (!POWERSHELL) {
      const initialize = extractPowerShellFunction(SOURCE, 'Initialize-SessionSecret') ?? '';
      expect(initialize.match(/Set-EnvFileValue/g)?.length).toBe(1);
      expect(initialize).toContain('It was NOT rotated');
      return;
    }
    const run = runSessionSecret(`SESSION_SECRET=${EXAMPLE_PLACEHOLDER}\n`, false);
    expect(run.status, run.output).toBe(0);
    expect(run.secret).toBe(EXAMPLE_PLACEHOLDER);
    expect(run.output).toContain('still the published placeholder');
    expect(run.output).toContain('NOT rotated');
  });

  it('keeps an empty SESSION_SECRET on an existing install byte for byte while AUTH_SESSION_SECRET signs', () => {
    if (!POWERSHELL) {
      expectOnlyFreshEnvWrites();
      return;
    }
    const run = runSessionSecret(`FOO=bar\nSESSION_SECRET=\nAUTH_SESSION_SECRET=${FALLBACK_SIGNER}\n`, false);
    expect(run.status, run.output).toBe(0);
    expect(run.unchanged).toBe(true);
    expect(run.output).toContain('It was NOT set');
    expect(run.output).not.toContain('Generated a new session secret');
  });

  it('keeps a missing SESSION_SECRET on an existing install byte for byte while KEYCLOAK_CLIENT_SECRET signs', () => {
    if (!POWERSHELL) {
      expectOnlyFreshEnvWrites();
      return;
    }
    const run = runSessionSecret(`KEYCLOAK_CLIENT_SECRET=${FALLBACK_SIGNER}\nFOO=bar\n`, false);
    expect(run.status, run.output).toBe(0);
    expect(run.unchanged).toBe(true);
    expect(run.output).toContain('It was NOT set');
  });

  it('still mints into a .env this run created even when the example line is empty', () => {
    if (!POWERSHELL) {
      expectOnlyFreshEnvWrites();
      return;
    }
    const run = runSessionSecret('SESSION_SECRET=\n', true);
    expect(run.status, run.output).toBe(0);
    expect(run.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is wired into the .env step with the created-in-this-run flag', () => {
    const envStep = extractPowerShellFunction(SOURCE, 'Initialize-EnvFile') ?? '';
    expect(envStep).toMatch(/Copy-Item[^\n]*\n\s*\$envCreated = \$true/);
    expect(envStep).toContain('Initialize-SessionSecret -EnvCreated $envCreated');
  });
});
