/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — guard-per-fix for the installer going DEAD ON ARRIVAL. installer/lib/install-swarm.ps1 shipped `$env$env:FORCE_LLM_PROVIDER = 'noop'` (doubled sigil), which is a HARD PowerShell parse error: the whole script failed to parse, so Install-OpenSwarm.bat could not execute a single step and no Windows user could complete a clean install. Nothing caught it — the installer has no test, no typecheck, and no CI gate, so a one-character corruption sat there silently. This spec parse-checks every installer script (real PowerShell parser on win32; static corruption + brace-balance checks everywhere) and asserts the ADR-085 `--profile little-monsters` reference stays gone, so the front door can never silently stop opening again.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Gave the real-parser case an explicit 120s vitest timeout. It inherited the 5s default while costing ~4.6s under full-suite load, so it flapped red on `vitest run tests/unit` and green in isolation — a guard that cries wolf is a guard nobody reads.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The wizard-open case stops pinning port 35457. It matched a regex hardcoding that port and went red the moment oshal-install.sh built its URL from $COCKPIT_PORT - no defect, just a port that became configurable, which is the same shape as the pool-ceiling guard that pinned a file path. It now asserts the LINK that actually matters: a variable is assigned a .../welcome destination, and a browser-open line uses that variable. A dropped /welcome or an open that stops using it still fails.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added the standalone-product-name guard. Every string a Windows installer showed a person — the GUI window title, the join-code refusal, the busy-port advice, the "look for the … window" line, the Desktop/Startup shortcut, the firewall rule, the launcher's console title — still read the retired standalone name, and nothing would have gone red if the next one did too. The guard scans installer code for the space-separated display form, permitting it only where a `$legacy…` assignment feeds the one-time upgrade removal, and a second case asserts that the upgrade actually removes the old firewall rule and the old shortcut instead of leaving an upgraded box carrying both names.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdCodeOnly, findStandaloneNameUses, isLegacyNameLookup } from '../helpers/retired-product-name';

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

      // Structural, not port-pinned. This used to match /localhost:35457\/\S*/, which broke the
      // moment the sh built its URL from $COCKPIT_PORT — a guard that a rename breaks and a
      // deletion also breaks cannot tell you which happened. What actually matters is the LINK:
      // some variable is assigned a .../welcome value, and the browser-open uses that variable.
      const welcomeVars = [...text.matchAll(/\$?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["'][^"'\n]*\/welcome["']/g)]
        .map((m) => m[1]);
      expect(welcomeVars.length, `${rel} assigns no .../welcome destination`).toBeGreaterThan(0);

      const openLines = text.split('\n').filter((line) => /\b(start|xdg-open|Start-Process)\b/.test(line));
      expect(openLines.length, `${rel} has no browser-open at all`).toBeGreaterThan(0);
      expect(
        openLines.some((line) => welcomeVars.some((v) => line.includes(`$${v}`) || line.includes(`$\{${v}}`))),
        `${rel} opens a browser but not the .../welcome destination it built (${welcomeVars.join(', ')})`,
      ).toBe(true);
    },
  );
});

// The installer is where a person meets the product for the first time, and every string it showed
// them still carried the retired standalone name long after the rename — a window title, a refusal,
// a Desktop shortcut, a firewall rule. None of it was covered by anything, so the next one would
// have shipped the same way. CLAUDE.md sanctions "oshal" and "open swarm oshal" only, and
// grandfathers identifiers; these cases hold that line on the files a Windows user actually runs.
describe('installer strings name the product as it is called today', () => {
  /** The installer scripts a person executes: PowerShell plus the launcher the shortcut points at. */
  const userFacingInstallerFiles = (): string[] => [
    ...installerPowerShellFiles(),
    ...[
      path.join(REPO_ROOT, 'installer', 'Open-Swarm-Node.cmd'),
      path.join(REPO_ROOT, 'scripts', 'oshal-install.sh'),
      path.join(REPO_ROOT, 'scripts', 'install.sh'),
    ].filter((f) => fs.existsSync(f)),
  ];

  /** Comments are stripped per language: a change log records what something USED to be called. */
  const strip = (file: string, text: string) =>
    (file.toLowerCase().endsWith('.cmd') ? cmdCodeOnly(text) : codeOnly(text));

  it('covers the installer files a Windows user actually runs', () => {
    const files = userFacingInstallerFiles().map((f) => path.basename(f));
    // Pinning the set is what stops this guard from silently covering nothing — the failure mode
    // that let a naming drift live in install-swarm.ps1 for months with a green suite.
    for (const required of ['install.ps1', 'common.ps1', 'install-node.ps1', 'install-swarm.ps1', 'Open-Swarm-Node.cmd']) {
      expect(files, `${required} is not being scanned`).toContain(required);
    }
  });

  // Too loud is as expensive as too quiet, and this project has paid for both: the little-monsters
  // check above flagged a legitimate bundle name while missing the dead profile entirely. CLAUDE.md
  // sanctions the attached acronym expansion and the attached mark, and grandfathers identifiers —
  // a guard that flagged any of those three would be "fixed" by deleting correct copy or renaming
  // a filename an installed box points at.
  it('tells a standalone use apart from the forms that are allowed to stay', () => {
    expect(findStandaloneNameUses("$form.Text = 'Open Swarm - Install'")).toHaveLength(1);
    expect(findStandaloneNameUses('OSHAL - Open Swarm Harness Agent LLM')).toEqual([]);
    expect(findStandaloneNameUses('oshal (open swarm oshal)')).toEqual([]);
    expect(findStandaloneNameUses('Re-run Install-OpenSwarm.bat to install it.')).toEqual([]);
    expect(findStandaloneNameUses("Join-Path $RepoRoot 'installer\\Open-Swarm-Node.cmd'")).toEqual([]);
  });

  it.each(userFacingInstallerFiles())('%s uses no standalone retired product name', (file) => {
    const offenders = findStandaloneNameUses(strip(file, fs.readFileSync(file, 'utf8')))
      // The ONE exception, and it is structural rather than a per-file allowlist: the operator's
      // 2026-09-20 decision is "rename in place on upgrade", so the installer still has to FIND
      // what an older install left behind. Such a lookup assigns a `$legacy…` variable, and the
      // case below proves each one is consumed by a removal rather than merely declared.
      .filter((line) => !isLegacyNameLookup(line));
    expect(offenders, `standalone retired product name in ${path.relative(REPO_ROOT, file)}`).toEqual([]);
  });

  // The decision the backlog entry was blocked on, expressed as behaviour: an upgraded box ends
  // with ONE firewall rule and ONE shortcut. Windows matches a firewall rule by DisplayName and a
  // shortcut by filename, so renaming the string without removing the old artifact leaves both
  // behind — two rules opening the same port, and two Startup entries launching the node twice.
  it('an upgrade REMOVES what an older install left under the old name', () => {
    const swarm = codeOnly(fs.readFileSync(path.join(REPO_ROOT, 'installer', 'lib', 'install-swarm.ps1'), 'utf8'));
    expect(swarm, 'the cockpit firewall rule is not oshal-named').toMatch(/\$ruleName\s*=\s*"oshal cockpit \(\$CockpitPort\)"/);
    // Declared AND consumed. A legacy constant nobody removes is a rename that forgot half its job.
    expect(swarm, 'the old firewall rule is never looked up').toMatch(/\$legacyRuleName\s*=/);
    expect(swarm, 'the old firewall rule is looked up but never removed')
      .toMatch(/Remove-NetFirewallRule\s+-DisplayName\s+\$legacyRuleName/);
    // Order is the point: remove the old rule before deciding the new one already exists, or a
    // re-install returns early and the old rule outlives the upgrade.
    expect(swarm.indexOf('Remove-NetFirewallRule -DisplayName $legacyRuleName'))
      .toBeLessThan(swarm.indexOf('New-NetFirewallRule -DisplayName $ruleName'));

    const node = codeOnly(fs.readFileSync(path.join(REPO_ROOT, 'installer', 'lib', 'install-node.ps1'), 'utf8'));
    expect(node, 'the launcher shortcut is not oshal-named').toMatch(/New-LauncherShortcut\s+-Directory\s+\$\w+\s+-Name\s+'oshal Node'/);
    expect(node, 'nothing deletes the old .lnk').toMatch(/Remove-Item\s+-LiteralPath\s+\$legacyPath/);
    // BOTH folders: the Desktop copy is the one a person sees, the Startup copy is the one that
    // would silently start a second node at every sign-in.
    for (const dir of ['$desktopDir', '$startupDir']) {
      expect(node, `the old shortcut is never removed from ${dir}`)
        .toContain(`Remove-LegacyLauncherShortcut -Directory ${dir}`);
    }
    expect(node.indexOf('Remove-LegacyLauncherShortcut -Directory $desktopDir'))
      .toBeLessThan(node.indexOf("New-LauncherShortcut -Directory $desktopDir -Name 'oshal Node'"));
  });
});

// A fresh Windows box is the install this project keeps losing. Both regressions below were
// found on the same remote install (2026-09-16) and neither was visible from the installer's
// own output: Docker was blamed for a Windows feature being off, and a 52-day-old image was
// reported as missing features. These hold the wiring, not the wording.
describe('installers survive a fresh Windows box', () => {
  const read = (rel: string) => codeOnly(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));

  it('the ps1 CALLS the WSL2 preflight before it looks for docker, not after', () => {
    const lines = read('scripts/oshal-install.ps1').split(/\r?\n/);
    // The CALL SITE, not the definition. An earlier version of this guard searched for the
    // bare name and matched `function Invoke-Wsl2Preflight {`, which sits above the docker
    // gate wherever the call goes -- so deleting the call left the test GREEN. A guard that
    // still passes with the fix removed is not a guard; this one was caught by mutating it.
    const callSite = lines.findIndex((l) => l.trim() === 'Invoke-Wsl2Preflight');
    const dockerGate = lines.findIndex((l) => l.includes('$docker = Get-Command docker'));
    expect(callSite, 'the ps1 never CALLS Invoke-Wsl2Preflight').toBeGreaterThan(-1);
    expect(dockerGate, 'the ps1 no longer runs the compose-path docker gate').toBeGreaterThan(-1);
    // Order is the whole point: running it afterwards reports "install Docker Desktop" on a
    // machine where installing Docker Desktop cannot help.
    expect(callSite).toBeLessThan(dockerGate);
  });

  it('the ps1 detects WSL by exit code, never by parsing wsl.exe output', () => {
    const text = read('scripts/oshal-install.ps1');
    expect(text).toContain('$LASTEXITCODE -eq 0');
    // wsl.exe emits UTF-16LE, so matching on its TEXT is a check that silently stops working.
    // Guard the shape rather than the wording: no wsl.exe output may be piped or -match'd.
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('wsl.exe')) continue;
      expect(line, `wsl.exe output is being parsed: ${line.trim()}`).not.toContain('Select-String');
      expect(line, `wsl.exe output is being parsed: ${line.trim()}`).not.toContain('-match');
    }
  });

  it('both installers name WSL2 when the engine is down, instead of only blaming docker', () => {
    const ps1 = read('scripts/oshal-install.ps1');
    const sh = read('scripts/oshal-install.sh');
    expect(ps1, 'the ps1 engine-down path never mentions WSL2').toContain('WSL2');
    expect(sh, 'the sh installer never calls wsl_guidance').toContain('wsl_guidance');
    // BOTH docker preflight failures, not just one — the client hit the "not running" branch.
    // (definition + the two call sites)
    expect((sh.match(/wsl_guidance/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('both installers gate on image freshness after pulling from the registry', () => {
    const ps1 = read('scripts/oshal-install.ps1');
    const sh = read('scripts/oshal-install.sh');
    expect(ps1.indexOf('docker pull')).toBeLessThan(ps1.indexOf('Test-ImageFreshness $Image'));
    expect(sh.indexOf('docker pull')).toBeLessThan(sh.indexOf('check_image_freshness "$IMAGE"'));
    // The override has to exist, or a deliberately-pinned old image becomes uninstallable.
    expect(ps1).toContain('AllowStaleImage');
    expect(sh).toContain('--allow-stale-image');
  });

  it('the freshness module the installers shell out to is baked into the image', () => {
    // Mode 1 has no repository on the host and no guaranteed node, so the check runs INSIDE
    // the pulled image. Without the COPY it degrades to a skip on the exact path it protects.
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile.oshal'), 'utf8');
    expect(dockerfile).toContain('COPY scripts/image-freshness.js');
    expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'image-freshness.js'))).toBe(true);
  });
});
