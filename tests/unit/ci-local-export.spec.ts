/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the bounded export step: prove export_tree succeeds on a valid commit, times out loud with export: FAIL when hung (preventing indefinite lock retention without an outcome line), and pin that ci-local.sh runs both of its exports through export_tree rather than a bare git archive.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const HELPER = join(ROOT, 'scripts', 'ci', 'ci-export.sh').replaceAll('\\', '/');
const CI_SOURCE = readFileSync(join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const SCRATCH = mkdtempSync(join(tmpdir(), 'oshal-ci-export-'));

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** @description Locate Git Bash without falling into Windows' WSL launcher. */
function resolveBash(): string {
  if (process.platform !== 'win32') return 'bash';
  let dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  for (let up = 0; up < 6; up++) {
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

function posix(p: string): string {
  return p.replaceAll('\\', '/');
}

function runShell(script: string, args: string[] = []): { status: number; output: string } {
  const file = join(SCRATCH, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const full = [
    'set -uo pipefail',
    `. "${HELPER}"`,
    script,
  ].join('\n');
  writeFileSync(file, full, 'utf8');
  const run = spawnSync(BASH, [posix(file), ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

describe('export_tree exports commit trees with timeout boundaries', () => {
  it('successfully exports HEAD to destination and reports OK', () => {
    const dest = join(SCRATCH, 'real-export');
    const body = [
      'export_tree "$1" "$2" "$3" 60',
      'echo "export_rc=$?"',
    ].join('\n');
    const run = runShell(body, [posix(ROOT), 'HEAD', posix(dest)]);
    expect(run.output).toContain('export_rc=0');
    expect(run.output).toMatch(/export: OK/);
    expect(existsSync(join(dest, 'package.json'))).toBe(true);
  }, 30_000);

  it('fails loudly when the export operation hangs past its limit', () => {
    const dest = join(SCRATCH, 'hung-export');
    const body = [
      // Override archive primitive to simulate a hung tar or git process
      'export_tree_archive() { sleep 20; }',
      'export_tree "$1" "$2" "$3" 2',
      'echo "export_rc=$?"',
    ].join('\n');
    const run = runShell(body, [posix(ROOT), 'HEAD', posix(dest)]);
    expect(run.output).toContain('export_rc=1');
    expect(run.output).toContain('export: FAIL');
    expect(run.output).toContain('timeout after 2s');
  }, 30_000);

  it('fails cleanly on missing arguments or non-existent repo', () => {
    const run = runShell('export_tree "" "" "" 10');
    expect(run.output).toContain('export: FAIL (missing arguments');

    const runBadRepo = runShell('export_tree "/nonexistent/repo" "HEAD" "/tmp/dest" 10');
    expect(runBadRepo.output).toContain('repo directory does not exist');
  });
});

describe('ci-local.sh exports its trees through the bounded helper', () => {
  it('sources scripts/ci/ci-export.sh before any gate runs', () => {
    expect(CI_SOURCE).toMatch(/^\. "\$REPO_DIR\/scripts\/ci\/ci-export\.sh"$/m);
  });

  it('prepare_head_src exports GATE_SRC via export_tree, never a bare git archive pipe', () => {
    expect(CI_SOURCE).toContain('export_tree "$REPO_DIR" "$SOURCE_SHA" "$GATE_SRC" || return 1');
  });

  it('gate_secrets exports ci-scan-src via export_tree, never a bare git archive pipe', () => {
    expect(CI_SOURCE).toContain('export_tree "$REPO_DIR" "$SOURCE_SHA" "$exp" || { purge_tree "$exp"; return 1; }');
  });
});
