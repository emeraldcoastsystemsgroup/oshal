/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the installer going DEAD ON ARRIVAL. installer/lib/install-swarm.ps1 shipped `$env$env:FORCE_LLM_PROVIDER = 'noop'` (doubled sigil), which is a HARD PowerShell parse error: the whole script failed to parse, so Install-OpenSwarm.bat could not execute a single step and no Windows user could complete a clean install. Nothing caught it — the installer has no test, no typecheck, and no CI gate, so a one-character corruption sat there silently. This spec parse-checks every installer script (real PowerShell parser on win32; static corruption + brace-balance checks everywhere) and asserts the ADR-085 `--profile little-monsters` reference stays gone, so the front door can never silently stop opening again.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gave the real-parser case an explicit 120s vitest timeout. It inherited the 5s default while costing ~4.6s under full-suite load, so it flapped red on `vitest run tests/unit` and green in isolation — a guard that cries wolf is a guard nobody reads.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/** Every PowerShell file that participates in installing or joining a swarm. */
function installerPowerShellFiles(): string[] {
  const dirs = [path.join(REPO_ROOT, 'installer'), path.join(REPO_ROOT, 'installer', 'lib')];
  const found: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase().endsWith('.ps1')) found.push(path.join(dir, entry));
    }
  }
  // scripts/oshal-install.ps1 is the script Install-OSHAL.bat actually executes — the real front
  // door — and it sat OUTSIDE this guard's reach because the guard only walked installer/.
  // A parse error there is the same dead-on-arrival failure the guard was written for.
  const front = path.join(REPO_ROOT, 'scripts', 'oshal-install.ps1');
  if (fs.existsSync(front)) found.push(front);
  return found;
}

/**
 * Resolve a PowerShell executable WITHOUT spawning one.
 *
 * The first version probed by running `powershell -Command $PSVersionTable`. That made the
 * guard flaky: it passed in isolation but timed out under the full suite (354 files in
 * parallel), and the win32 branch then hard-failed as if PowerShell were missing. A guard
 * that goes red for environmental reasons is worse than no guard — it trains everyone to
 * ignore red. Existence checks are load-insensitive, so resolution is now pure filesystem.
 */
function findPowerShell(): string | null {
  const candidates: string[] = [];
  const sysRoot = process.env.SystemRoot || process.env.windir;
  if (sysRoot) {
    candidates.push(path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  // Anything on PATH, resolved by inspecting the filesystem rather than executing it.
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const base of ['pwsh', 'powershell']) {
      for (const ext of exts) candidates.push(path.join(dir, base + ext));
    }
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* unreadable PATH entry — keep looking */
    }
  }
  return null;
}

/**
 * Strip PowerShell comments so the scans below test CODE, not prose ABOUT the code.
 * Without this the guard flags its own subject: the CHANGE LOG entry that documents the
 * `$env$env:` bug, and the comment explaining why the little-monsters profile is gone.
 * A guard that cannot survive its own fix being documented is a guard people delete.
 */
function codeOnly(text: string): string {
  // Strips ONLY the leading <# ... #> header block (the CHANGE LOG, which necessarily quotes the
  // very bug this guard hunts) plus whole-line `#` comments.
  //
  // Two earlier versions of this helper FAILED OPEN, and the reason is worth keeping: a global
  // `<#[\s\S]*?#>` pairing sweep mis-pairs across the file's many doc blocks and silently ate real
  // code — the static check reported CLEAN on a file that provably contained the bug. Anchoring the
  // block strip to the start of file removes the ambiguity. The checks below are also written to be
  // position-precise so they barely depend on this stripping at all.
  const withoutHeader = text.replace(/^﻿?\s*<#[\s\S]*?#>/, '');
  return withoutHeader
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('installer scripts stay executable', () => {
  const psFiles = installerPowerShellFiles();

  it('finds the installer scripts at all (the guard must not silently cover nothing)', () => {
    expect(psFiles.length).toBeGreaterThan(0);
    expect(psFiles.some((f) => f.endsWith('install-swarm.ps1'))).toBe(true);
  });

  // The exact bug: `$env$env:NAME`. A doubled sigil is never valid PowerShell, and it is the
  // signature of a botched find/replace across these files.
  // Position-precise on purpose: the real defect is a STATEMENT — a line whose first token is the
  // corrupted variable (`    $env$env:FORCE_LLM_PROVIDER = 'noop'`). Prose that documents the bug
  // always mentions it mid-sentence, so this cannot flag its own CHANGE LOG. This is the check that
  // carries the guard on Linux CI, where the PowerShell parser below is unavailable.
  it.each(psFiles)('%s has no doubled-sigil assignment', (file) => {
    const text = codeOnly(fs.readFileSync(file, 'utf8'));
    const offenders = text
      .split(/\r?\n/)
      .filter((line) => /^\s*\$\w*\$\w*:/.test(line) || /^\s*\$\$/.test(line));
    expect(offenders, `doubled sigil in ${path.relative(REPO_ROOT, file)}`).toEqual([]);
  });

  it.each(psFiles)('%s has balanced braces and parens', (file) => {
    // Cheap structural smoke test that works off-Windows too. Strips comments and
    // single-quoted literals so braces inside them do not skew the count.
    const text = codeOnly(fs.readFileSync(file, 'utf8')).replace(/'[^'\n]*'/g, "''");
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    expect(count(/\{/g), `brace balance in ${path.basename(file)}`).toBe(count(/\}/g));
    expect(count(/\(/g), `paren balance in ${path.basename(file)}`).toBe(count(/\)/g));
  });

  // The authoritative check. Only meaningful where PowerShell exists; on win32 its absence is a
  // hard failure rather than a skip, per the "a spec that skips in CI is not a guard" rule.
  it('every installer .ps1 parses under the real PowerShell parser', () => {
    const shell = findPowerShell();
    if (!shell) {
      if (process.platform === 'win32') {
        throw new Error('win32 with no PowerShell available — cannot verify the Windows installer');
      }
      // Off-Windows the static checks above are the guard; there is nothing to parse with.
      expect(psFiles.length).toBeGreaterThan(0);
      return;
    }

    // The target path goes through the ENVIRONMENT, never interpolated into the -Command string:
    // Windows command-line parsing eats the backslashes in an embedded absolute path, which made
    // this check "fail" on a file that parses perfectly.
    const script = [
      '$e = $null;',
      '[System.Management.Automation.Language.Parser]::ParseFile($env:OSHAL_PARSE_TARGET, [ref]$null, [ref]$e) | Out-Null;',
      'if ($e.Count) { $e | ForEach-Object { "L" + $_.Extent.StartLineNumber + ": " + $_.Message } }',
    ].join(' ');

    const failures: string[] = [];
    for (const file of psFiles) {
      const out = execFileSync(shell, ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, OSHAL_PARSE_TARGET: file },
      }).trim();
      if (out) failures.push(`${path.relative(REPO_ROOT, file)} -> ${out}`);
    }
    expect(failures, `PowerShell parse errors:\n${failures.join('\n')}`).toEqual([]);
    // Vitest's own 5s default is the binding limit here, NOT the 120s execFileSync budget above:
    // this spawns a real PowerShell per installer script, which costs ~4.6s under full-suite
    // parallel load and passes in ~2.4s alone. That straddles 5s, so the guard flapped red on the
    // full run and green in isolation — the exact pattern that trains people to ignore red.
    // Matched to the subprocess budget so a failure here always means a real parse error.
  }, 120_000);

  // ADR-085 carved the little-monsters demo out to the oshal-applications store, and the compose
  // profile went with it. Passing a profile that no longer exists is dead config that misleads
  // anyone reading the install path.
  //
  // Matches the PROFILE ACTIVATION, not the word. The earlier `'little-monsters'` pattern keyed on
  // any single-quoted occurrence, which is also how both installers spell a legitimate --bundle
  // NAME (the bundle still exists; it stages store packages). That made the check simultaneously
  // too loud (a valid bundle key trips it) and too quiet (`[little-monsters]="little-monsters"` in
  // the bash installer carried the dead profile for months without matching at all).
  it('no installer script activates the retired little-monsters compose profile', () => {
    const offenders: string[] = [];
    const files = [...psFiles, path.join(REPO_ROOT, 'scripts', 'install.sh'), path.join(REPO_ROOT, 'scripts', 'oshal-install.sh')];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const text = codeOnly(fs.readFileSync(file, 'utf8'));
      // `--profile little-monsters`, `COMPOSE_PROFILES=little-monsters`, and the bundle→profile
      // map entries that feed COMPOSE_PROFILES in either installer.
      if (/--profile\s+little-monsters|COMPOSE_PROFILES\s*=\s*["']?little-monsters|little-monsters\]?['"]?\s*=\s*['"]little-monsters['"]/.test(text)) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  // The front door must ask who the user is. MOCK_OIDC presents NO sign-in page — it fabricates
  // alex@demo.local / mock-user-001 and treats every request as authenticated — so an installer
  // that never captures an identity silently signs the new user in as a shared demo account:
  // not the superadmin, and every connector token they create binds to that shared sub. The
  // operator hit exactly this on a fresh Windows install ("it never had me logon locally").
  it.each([
    ['scripts/oshal-install.ps1', ['MOCK_OIDC_EMAIL', 'MOCK_OIDC_SUB', 'OSHAL_OPERATOR_EMAILS']],
    ['scripts/oshal-install.sh', ['MOCK_OIDC_EMAIL', 'MOCK_OIDC_SUB', 'OSHAL_OPERATOR_EMAILS']],
  ])('%s writes a real local identity into .env', (rel, keys) => {
    const file = path.join(REPO_ROOT, rel);
    expect(fs.existsSync(file), `${rel} is missing`).toBe(true);
    const text = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const key of keys) {
      expect(text, `${rel} never writes ${key}`).toContain(key);
    }
  });

  // Both installers must land the user on the WIZARD. Connecting an AI model is mandatory and is
  // a browser flow, so /cockpit/ is the wrong destination: mid-onboarding it 302s to /welcome
  // anyway (surfaceOnboardingGuard), and pointing at it hid where linking actually happens.
  it.each(['scripts/oshal-install.ps1', 'scripts/oshal-install.sh'])(
    '%s opens the onboarding wizard, not the bare cockpit',
    (rel) => {
      const text = codeOnly(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      const opened = text.match(/https?:\/\/localhost:35457\/\S*/g) ?? [];
      expect(opened.some((u) => u.includes('/welcome')), `${rel} never opens /welcome`).toBe(true);
    },
  );
});
