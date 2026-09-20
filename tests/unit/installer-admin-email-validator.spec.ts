/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The two installer email validators are the only thing standing between the operator's own typo and a command they did not mean to run: oshal-install.ps1 interpolates this value into a `cmd /c "docker exec ... --email $AdminEmail"` string, and both validators admitted &, |, > and " in the DOMAIN - the sh constrained only the local part and the ps1 pattern was [^@\s]+ on both sides. The sh half is EXECUTED in a real bash, because a shell function is text until a shell runs it and case-pattern bracket expressions are exactly where a reading goes wrong (the `-` has to be last, or the range means something else). The ps1 half is its pattern, extracted from the script and run against the same inputs - .NET and JS agree on this pattern class, and the alternative is launching PowerShell per case. Both must still ACCEPT ordinary addresses: a validator that rejects everything would pass a refusal-only suite and break every install.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execSync } from 'node:child_process';

const NEWLINE = String.fromCharCode(10);

const SH = join(process.cwd(), 'scripts/oshal-install.sh');
const PS1 = join(process.cwd(), 'scripts/oshal-install.ps1');

/** Git Bash by path — System32\bash.exe is WSL and would not see this checkout. */
function bashPath(): string {
  for (const candidate of ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash']) {
    try { execSync(`"${candidate}" -c "exit 0"`, { stdio: 'ignore' }); return candidate; } catch { /* next */ }
  }
  throw new Error('no usable bash found — this guard must fail loudly, not skip');
}

/** The real `valid_email` function, lifted out so sourcing does not run the installer. */
function validEmailFunction(): string {
  const text = readFileSync(SH, 'utf8');
  const start = text.indexOf('valid_email() {');
  expect(start, 'valid_email is gone from the installer').toBeGreaterThan(-1);
  const end = text.indexOf('\n}\n', start) + 3;
  return text.slice(start, end);
}

/**
 * Verdicts for MANY addresses in ONE bash invocation. Spawning per address was flaky under load —
 * sixteen processes, and a spawn that loses the race returns empty output, which reads as a
 * verdict. One process, addresses on stdin, one line of output each.
 */
function shVerdicts(addresses: readonly string[]): Map<string, boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-email-'));
  try {
    const file = join(dir, 'check.sh');
    const script = [
      validEmailFunction(),
      'while IFS= read -r line; do',
      '  addr=${line#?}',
      '  if valid_email "$addr"; then echo "ACCEPT"; else echo "REJECT"; fi',
      'done',
      '',
    ].join(NEWLINE);
    writeFileSync(file, script, 'utf8');
    // A leading sentinel keeps leading whitespace intact through `read -r`, which would otherwise
    // strip it — and a leading space is one of the inputs under test.
    const input = addresses.map((a) => `|${a}`).join(NEWLINE) + NEWLINE;
    const res = spawnSync(bashPath(), [file], { encoding: 'utf8', input });
    const lines = String(res.stdout).split(NEWLINE).filter((l) => l === 'ACCEPT' || l === 'REJECT');
    expect(lines.length, `bash returned ${lines.length} verdicts for ${addresses.length} addresses`)
      .toBe(addresses.length);
    return new Map(addresses.map((a, i) => [a, lines[i] === 'ACCEPT']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The ps1's pattern, read out of the script rather than restated here. */
function ps1Pattern(): RegExp {
  const text = readFileSync(PS1, 'utf8');
  const match = /return \$value -match '([^']+)'/.exec(text);
  expect(match, 'Test-EmailShape no longer matches against a pattern literal').toBeTruthy();
  return new RegExp(String(match?.[1]));
}

const ORDINARY = [
  'maintainer@emeraldcoastsystemsgroup.com',
  'admin@localhost.localdomain',
  'first.last+tag@sub.example.co.uk',
  'a_b-c%d@example.org',
];

const HOSTILE = [
  'me@example.com&whoami',
  'me@example.com|calc',
  'me@example.com>out.txt',
  'me@exa"mple.com',
  'me@example.com;shutdown',
  'me@@example.com',
  'me@example.com ',
  ' me@example.com',
  '@example.com',
  'me@',
  'me@example.com$(id)',
  'me@example.com`id`',
];

describe('the installer admin-email validators reject a shell metacharacter', () => {
  it('bash: every ordinary address is still accepted', () => {
    // First, because a validator that rejects everything would pass every case below and break
    // every install. The refusals only mean something beside this.
    const verdicts = shVerdicts(ORDINARY);
    for (const address of ORDINARY) {
      expect(verdicts.get(address), `${address} was rejected — this breaks a normal install`).toBe(true);
    }
  });

  it('bash: a metacharacter anywhere is rejected, DOMAIN included', () => {
    // The old pattern constrained only the local part, so `me@example.com&whoami` passed. This
    // script hands argv to docker exec so it was harmless HERE — the ps1 is where it bites, and
    // lockstep between the two validators is the whole reason they both exist.
    const verdicts = shVerdicts(HOSTILE);
    for (const address of HOSTILE) {
      expect(verdicts.get(address), `${JSON.stringify(address)} was accepted`).toBe(false);
    }
  });

  it('powershell: the same pattern accepts the ordinary and rejects the hostile', () => {
    const pattern = ps1Pattern();
    for (const address of ORDINARY) {
      expect(pattern.test(address), `${address} was rejected by the ps1 pattern`).toBe(true);
    }
    for (const address of HOSTILE) {
      expect(pattern.test(address), `${JSON.stringify(address)} was accepted by the ps1 pattern`).toBe(false);
    }
  });

  it('the ps1 still interpolates the address into a cmd string — which is why the above matters', () => {
    // If this ever stops being true the validator is no longer load-bearing for injection, and
    // this spec should say so rather than quietly guarding nothing.
    const text = readFileSync(PS1, 'utf8');
    expect(text, 'the cmd /c interpolation is gone — revisit why these patterns are this strict')
      .toMatch(/cmd \/c "docker exec[^"]*\$AdminEmail/);
  });
});
