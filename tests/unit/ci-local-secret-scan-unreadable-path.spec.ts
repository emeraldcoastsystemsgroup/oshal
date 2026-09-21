/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The partial-scan half of the secret-scan gate, proven against the REAL scanner. tests/unit/ci-local-secret-scan.spec.ts replays recorded stderr from a stand-in `docker`, and tests/unit/ci-local-secret-scan-planted-fixture.spec.ts runs the real image but only over readable trees, so nothing had ever made zricethezav/gitleaks:latest actually skip a path and exit 0 - the defect the gate exists to catch (2026-09-10: 5 of 5077 exported files unread, secret-scan PASSED). This denies read on one file of a real `git archive` export, runs the production scan line over it, and requires the gate to answer FAIL unread=1 while the scanner's own rc is 0, then restores the file and requires PASS - so the red is the unreadable path and nothing else. It is also the standing check that the FLOATING `:latest` tag still writes a wording GITLEAKS_UNREAD_PATTERN matches: a reworded skip line counts zero unread, passes, and turns this guard red.
 */

/**
 * @description
 * Real-boundary proof for the partial-scan verdict of the `secret-scan` gate in
 * `scripts/ci-local.sh`.
 *
 * The boundary is the scanner image itself. `zricethezav/gitleaks:latest` really runs, under the
 * production `gitleaks_container_scan` arguments sliced out of `scripts/ci-local.sh`, over an
 * export built by the production `git archive | tar -x` line out of `gate_secrets`, and its
 * verdict is decided by the production `run_secret_scan` sourced from `scripts/ci/ci-secret-scan.sh`.
 * No stand-in `docker` is placed on PATH and no stderr is replayed.
 *
 * What stands in for production is the SCANNED TREE: a four-file disposable export carrying this
 * repository's real `.gitleaks.toml`, rather than the ~5,900-file nightly export. That is what
 * lets the denied file be the only difference between the RED run and the GREEN runs either side
 * of it. `gate_secrets`' own `purge_tree` wrapper is covered by the two sibling guards; this one
 * owns the two production lines that turn a partial scan into a verdict.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireFixtureSlot, type FixtureSlot } from '../helpers/fixture-slots';

const ROOT = resolve(__dirname, '../..');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const PURGE_HELPER = join(ROOT, 'scripts', 'ci', 'ci-purge.sh').replaceAll('\\', '/');
const SCAN_HELPER = join(ROOT, 'scripts', 'ci', 'ci-secret-scan.sh').replaceAll('\\', '/');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-secret-scan-unread-'));
const REPO = join(SCRATCH, 'repo');
const EXPORT_DIR = join(SCRATCH, 'ci-scan-src');
/** The one export path this guard makes unreadable. Every other exported file stays readable. */
const DENIED_FILE = join(EXPORT_DIR, 'src', 'unreadable.ts');

/** One scan of the export: what the production verdict line returned and everything it wrote. */
interface ScanRun {
  status: number | null;
  output: string;
}

let slot: FixtureSlot;
const runs = new Map<string, ScanRun>();

/** @description Locate Git Bash without falling into Windows' WSL launcher.
 * @returns Absolute path to a bash that understands this repository's shell scripts.
 */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up += 1) {
    for (const rel of ['bin/bash.exe', 'usr/bin/bash.exe']) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Git Bash not found; refusing the WSL bash on PATH');
}

const BASH = resolveBash();
const toBash = (p: string): string => p.replaceAll('\\', '/');

/** @description Run Git against the disposable repository with prompts and inherited hooks disabled.
 * @param args - Git arguments, run with `-C` at the fixture repository.
 * @returns Git's trimmed stdout.
 */
function git(...args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

/**
 * @description Slice one production shell function out of `scripts/ci-local.sh`, so this guard
 * runs what the nightly runs instead of a paraphrase of it.
 * @param name - The shell function to extract.
 * @returns The function's source text, braces included.
 */
function ciFunction(name: string): string {
  const start = CI_SOURCE.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} is no longer in scripts/ci-local.sh`);
  return CI_SOURCE.slice(start, CI_SOURCE.indexOf('\n}\n', start) + 3);
}

/**
 * @description Slice one line out of the production `gate_secrets` body. The two lines this guard
 * needs - the export build and the scan - are taken from the gate rather than retyped, so an edit
 * to either one is executed here rather than drifting away from it.
 * @param fragment - Text that identifies exactly one line of `gate_secrets`.
 * @returns That line, trimmed.
 */
function gateLine(fragment: string): string {
  const hits = ciFunction('gate_secrets').split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .filter((line) => line.includes(fragment));
  if (hits.length !== 1) throw new Error(`gate_secrets has ${hits.length} lines containing ${fragment}`);
  return hits[0].trim();
}

/**
 * @description Build the disposable repository the gate exports: this repository's real
 * `.gitleaks.toml` plus three files, one of which is the path that will be made unreadable.
 * @returns The commit SHA the export is taken from.
 */
function createRepo(): string {
  mkdirSync(join(REPO, 'src'), { recursive: true });
  mkdirSync(join(SCRATCH, 'no-hooks'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', REPO]);
  git('config', 'user.name', 'OSHAL Maintainer');
  git('config', 'user.email', 'maintainer@emeraldcoastsystemsgroup.com');
  git('config', 'core.hooksPath', toBash(join(SCRATCH, 'no-hooks')));
  copyFileSync(join(ROOT, '.gitleaks.toml'), join(REPO, '.gitleaks.toml'));
  writeFileSync(join(REPO, 'README.md'), '# secret-scan unreadable-path fixture\n');
  writeFileSync(join(REPO, 'src', 'app.ts'), 'export const ok = true;\n');
  writeFileSync(join(REPO, 'src', 'unreadable.ts'), 'export const alsoOk = true;\n');
  git('add', '--', '.gitleaks.toml', 'README.md', 'src/app.ts', 'src/unreadable.ts');
  git('commit', '-q', '-m', 'unreadable-path fixture');
  return git('rev-parse', 'HEAD');
}

/**
 * @description Extract the export with the production `git archive | tar -x` line out of
 * `gate_secrets`, into a directory this file owns.
 * @param sha - The fixture commit to export.
 * @returns Nothing; throws with the shell's output when the extraction fails.
 */
function buildExport(sha: string): void {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const script = join(SCRATCH, 'extract.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'REPO_DIR="$1"; SOURCE_SHA="$2"; exp="$3"', '. "$4"',
    'extract() {', `  ${gateLine('git archive')}`, '}',
    'extract', '',
  ].join('\n'));
  const result = spawnSync(
    BASH,
    [toBash(script), toBash(REPO), sha, toBash(EXPORT_DIR), PURGE_HELPER],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (result.status !== 0) {
    throw new Error(`export failed (${result.status}): ${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
}

/**
 * @description Run the production scan line - the real image plus the real verdict function -
 * over the export as it currently stands on disk.
 * @param label - Stage name, recorded so each assertion can name the run it reads.
 * @returns The line's exit status and its combined stdout/stderr.
 */
function scanExport(label: string): ScanRun {
  const script = join(SCRATCH, `scan-${label}.sh`);
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'exp="$1"; rc=0',
    'log() { printf \'LOG:%s\\n\' "$*"; }',
    'if ! command -v timeout >/dev/null 2>&1; then timeout() { shift; "$@"; }; fi',
    '. "$2"',
    ciFunction('gitleaks_container_scan'),
    gateLine('run_secret_scan "$exp"'),
    'exit $rc', '',
  ].join('\n'));
  const result = spawnSync(BASH, [toBash(script), toBash(EXPORT_DIR), SCAN_HELPER], {
    encoding: 'utf8', timeout: 600_000,
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * @description Deny read on one exported file for the account the container file-share runs as,
 * and prove on the host that it worked. A guard that quietly failed to create the condition it
 * tests would pass for the wrong reason, so this throws instead of skipping.
 * @param file - The exported path to make unreadable.
 * @returns Nothing.
 */
function denyRead(file: string): void {
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/deny', '*S-1-1-0:(R)'], { encoding: 'utf8' });
  } else {
    chmodSync(file, 0o000);
  }
  let readable = true;
  try { readFileSync(file); } catch { readable = false; }
  if (readable) {
    throw new Error(`could not make ${file} unreadable on this host - the guard cannot prove its claim`);
  }
}

/**
 * @description Give the read back and prove it, so the GREEN run after the RED one differs from it
 * in exactly this one permission.
 * @param file - The exported path to restore.
 * @returns Nothing.
 */
function restoreRead(file: string): void {
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' });
  } else {
    chmodSync(file, 0o644);
  }
  readFileSync(file);
}

/** @description Read one recorded stage, failing loudly rather than returning undefined.
 * @param label - The stage name.
 * @returns That stage's run.
 */
function stage(label: string): ScanRun {
  const run = runs.get(label);
  if (!run) throw new Error(`stage ${label} did not run`);
  return run;
}

beforeAll(async () => {
  // One slot for the whole file: the scans run one at a time inside it, so this file contributes
  // at most one container to the machine-wide ceiling however the suite schedules it.
  slot = await acquireFixtureSlot('ci-local secret-scan unreadable-path proof');
  buildExport(createRepo());
  runs.set('readable', scanExport('readable'));
  denyRead(DENIED_FILE);
  runs.set('denied', scanExport('denied'));
  restoreRead(DENIED_FILE);
  runs.set('restored', scanExport('restored'));
}, 900_000);

afterAll(() => {
  slot?.release();
  try { restoreRead(DENIED_FILE); } catch { /* already restored, or never created */ }
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('secret-scan gate against the real gitleaks image: a partial scan is not a PASS', () => {
  it('passes while every exported file is readable', () => {
    const run = stage('readable');
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)');
  });

  it('goes RED when one exported path cannot be read, and says how many were missed', () => {
    const run = stage('denied');
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('secret-scan: FAIL unread=1 of 4 exported files (scanner rc=0)');
  });

  it('is red for the defect itself: the real image reported no leaks and exited 0 on the partial scan', () => {
    const run = stage('denied');
    // "(scanner rc=0)" is run_secret_scan quoting the image's own exit code: the scanner called the
    // partial scan a success. That is the 2026-09-10 failure, reproduced rather than described.
    expect(run.output).toContain('(scanner rc=0)');
    expect(run.output, 'the image must have believed the tree was clean').toContain('no leaks found');
    expect(run.output).not.toContain('secret-scan: FAIL scanner rc=');
  });

  it('still recognises the wording the FLOATING :latest tag writes for a path it did not read', () => {
    const run = stage('denied');
    // GITLEAKS_UNREAD_PATTERN was calibrated against v8.30.1; the gate pulls :latest. If the image
    // rewords this line the count above returns to 0, the gate passes a partial scan again, and
    // this is the assertion that goes red first.
    expect(run.output).toMatch(/skipping file: permission denied/);
    const pattern = /^GITLEAKS_UNREAD_PATTERN='(.+)'$/m.exec(readFileSync(SCAN_HELPER, 'utf8'));
    if (!pattern) throw new Error('GITLEAKS_UNREAD_PATTERN is no longer in scripts/ci/ci-secret-scan.sh');
    const skipped = run.output.split('\n')
      // eslint-disable-next-line no-control-regex
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
      .filter((line) => line.includes('/scan/src/unreadable.ts'));
    expect(skipped.length, run.output).toBeGreaterThan(0);
    expect(skipped.some((line) => new RegExp(pattern[1], 'i').test(line)), skipped.join('\n')).toBe(true);
  });

  it('returns to GREEN once the read is given back, so the RED is that one path', () => {
    const run = stage('restored');
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('secret-scan: PASS unread=0 of 4 exported files (scanner rc=0)');
  });

  it('ran the real scanner in every stage, not a stand-in', () => {
    for (const label of ['readable', 'denied', 'restored']) {
      expect(stage(label).output, `${label} has no gitleaks scan line`).toMatch(/scanned ~\d+ bytes/);
    }
  });
});
