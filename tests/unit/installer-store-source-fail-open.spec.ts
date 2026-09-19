/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Executes oshal-install.sh's store-source check in a real bash under `set -euo pipefail`, because an installer is text until a shell runs it and every defect here was a shell behaviour no reading catches. Three shapes, each of which stopped a working install dead: a probe that could not be taken (no curl, offline, proxy, transient blip) was treated as "the store is private" and demanded a read token for the PUBLIC default store; --from-archive, the documented ZERO-NETWORK path, ran that network probe anyway because it resolves to MODE=1 and the check runs before the mode dispatch; and the advertised "Enter to skip" ended the function on a `[ -n "$_st" ]` test returning 1, which under set -e killed the installer with no message at all. The function is extracted and sourced rather than the whole script, which would run the installer.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { execSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'scripts/oshal-install.sh');

/** Git Bash by path — System32\bash.exe is WSL and would not see this checkout. */
function bashPath(): string {
  for (const candidate of ['C:/Program Files/Git/bin/bash.exe', '/usr/bin/bash', '/bin/bash']) {
    try { execSync(`"${candidate}" -c "exit 0"`, { stdio: 'ignore' }); return candidate; } catch { /* next */ }
  }
  throw new Error('no usable bash found — this guard must fail loudly, not skip');
}

/** Pull just the two function definitions out, so sourcing does not run the installer. */
function extractFunctions(): string {
  const text = readFileSync(SCRIPT, 'utf8');
  const start = text.indexOf('store_probe_status() {');
  const endMarker = '\nrequire_store_source\n';
  const end = text.indexOf(endMarker, start);
  expect(start, 'store_probe_status is gone from the installer').toBeGreaterThan(-1);
  expect(end, 'require_store_source is no longer invoked at top level').toBeGreaterThan(start);
  return text.slice(start, end);
}

/** Run the extracted check under the installer's own `set -euo pipefail`, with stdin closed. */
function runCheck(env: Record<string, string>, extra = ''): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oshal-store-'));
  try {
    const harness = [
      'set -euo pipefail',
      'MODE=1',
      `FROM_ARCHIVE="${env.FROM_ARCHIVE ?? ''}"`,
      'STORE_REPO="https://github.com/emeraldcoastsystemsgroup/oshal-apps"',
      'STORE_REPO_DEFAULT="$STORE_REPO"',
      'STORE_REPO_NAMED=1',
      extractFunctions(),
      extra,
      'require_store_source',
      'echo REACHED_THE_END',
    ].join('\n');
    const file = join(dir, 'harness.sh');
    writeFileSync(file, harness, 'utf8');
    const res = spawnSync(bashPath(), [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the installer store-source check fails open', () => {
  it('--from-archive never runs the network probe — the zero-network install must not need one', () => {
    // A probe that would exit 2 if it ran at all, so reaching the end proves it was skipped.
    const r = runCheck({ FROM_ARCHIVE: '/tmp/oshal.tar' }, 'store_probe_status() { echo 403; }');
    expect(r.out, 'the offline install was gated on a network probe').toContain('REACHED_THE_END');
    expect(r.code).toBe(0);
  });

  it('a probe that could not be taken proceeds instead of demanding a token', () => {
    // 000 is no curl, no network, DNS, a proxy, or a timeout. None of those means "private".
    const r = runCheck({}, 'store_probe_status() { echo 000; }');
    expect(r.out, 'a box that simply could not probe was told to supply a read token').toContain('REACHED_THE_END');
    expect(r.code).toBe(0);
  });

  it('a server-side failure proceeds too', () => {
    const r = runCheck({}, 'store_probe_status() { echo 503; }');
    expect(r.out).toContain('REACHED_THE_END');
    expect(r.code).toBe(0);
  });

  it('a public store proceeds', () => {
    const r = runCheck({}, 'store_probe_status() { echo 200; }');
    expect(r.out).toContain('REACHED_THE_END');
    expect(r.code).toBe(0);
  });

  it('a DEFINITE refusal on a non-interactive host still stops, and says the status', () => {
    // The refusal must survive: failing open everywhere would just delete the check.
    for (const status of ['401', '403', '404']) {
      const r = runCheck({}, `store_probe_status() { echo ${status}; }`);
      expect(r.out, `HTTP ${status} should have stopped the install`).not.toContain('REACHED_THE_END');
      expect(r.code, `HTTP ${status} should exit 2`).toBe(2);
      expect(r.out).toContain(status);
    }
  });

  it('the "Enter to skip" shape aborts under set -e, and the real function no longer ends on it', () => {
    // The interactive branch cannot be driven here: `[ -t 0 ]` reads the real stdin and `[` is a
    // builtin bash will not let a test redefine. So this proves the two halves separately —
    // the MECHANISM by executing it, and the function's SHAPE by reading it. Named for what it
    // is: the mechanism half is real evidence, the shape half is a wiring pin.
    const run = (body: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'oshal-sete-'));
      try {
        const file = join(dir, 'h.sh');
        writeFileSync(file, `set -euo pipefail\n${body}\necho REACHED_THE_END\n`, 'utf8');
        const res = spawnSync(bashPath(), [file], { encoding: 'utf8' });
        return `${res.stdout}${res.stderr}`;
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };

    // The shape the installer used to end on, executed: it kills the run, silently.
    const before = run('f() { _st=""; [ -n "$_st" ] && export OSHAL_STORE_TOKEN="$_st"; }\nf');
    expect(before, 'the old shape did NOT abort — this control is what makes the fix meaningful')
      .not.toContain('REACHED_THE_END');

    // The same function with the trailing `return 0` the fix adds.
    const after = run('f() { _st=""; [ -n "$_st" ] && export OSHAL_STORE_TOKEN="$_st"; return 0; }\nf');
    expect(after).toContain('REACHED_THE_END');

    // And the real function ends that way.
    const fn = extractFunctions();
    const body = fn.slice(fn.indexOf('require_store_source() {'));
    const statements = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(statements[statements.length - 1], 'require_store_source no longer closes on }').toBe('}');
    expect(statements[statements.length - 2], 'require_store_source does not end with `return 0`')
      .toBe('return 0');
  });
});
