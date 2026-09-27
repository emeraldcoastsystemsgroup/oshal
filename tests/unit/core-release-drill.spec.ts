/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-167 guard for scripts/operations/core-release-drill.sh, the live acceptance drill of the core release pipeline. The shipped drill runs in Git Bash beside a recording stand-in for promote.sh. Pins the step sequence (staging promote, status, rollback, promote again, status, then production promote and status), that --bootstrap reaches the promote steps only, that production is never rolled back, and that the first failing step stops the drill by name with exit 1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, readOr, runScript, scratchDir, writeExec, posix } from '../helpers/core-release-harness';

/** Each case spawns Git Bash: slow on a loaded Windows host. */
const SHELL_CASE_TIMEOUT_MS = 120_000;
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });

const RELEASE = 'core-2026.09.28';

function drill(args: string[], failAt = 0): { status: number | null; out: string; calls: string[] } {
  const root = scratchDir('oshal-drill-', cleanup);
  const script = path.join(root, 'scripts/operations/core-release-drill.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/operations/core-release-drill.sh'), script);
  writeExec(path.join(root, 'scripts/core-promote/promote.sh'), [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$*" >>"$DRILL_LOG"',
    'n=$(wc -l <"$DRILL_LOG" | tr -d " ")',
    '[ "$n" = "${DRILL_FAIL_AT:-0}" ] && exit 1',
    'exit 0',
  ]);
  const log = path.join(root, 'calls.log');
  const r = runScript(script, args, path.join(root, 'bin'), { DRILL_LOG: posix(log), DRILL_FAIL_AT: String(failAt) });
  return { ...r, calls: readOr(log).split('\n').filter(Boolean) };
}

describe('core-release-drill.sh — the live acceptance run of the release pipeline', { timeout: SHELL_CASE_TIMEOUT_MS }, () => {
  it('runs staging promote/status/rollback/promote/status, then production promote/status, and passes', () => {
    const r = drill(['--release', RELEASE, '--staging', 'gs-staging', '--production', 'gs-production', '--bootstrap']);
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toEqual([
      `--target gs-staging --release ${RELEASE} --bootstrap`,
      '--target gs-staging --status',
      '--target gs-staging --rollback',
      `--target gs-staging --release ${RELEASE} --bootstrap`,
      '--target gs-staging --status',
      `--target gs-production --release ${RELEASE} --bootstrap`,
      '--target gs-production --status',
    ]);
    expect(r.calls.filter((c) => c.includes('gs-production') && c.includes('--rollback'))).toEqual([]);
    expect(r.out).toContain('[drill] PASSED');
  });

  it('stops at the first failing step, names it, and runs nothing after it', () => {
    const r = drill(['--release', RELEASE, '--staging', 'gs-staging', '--production', 'gs-production'], 3);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('FAILED at step 3 (roll staging back)');
    expect(r.calls).toHaveLength(3);
    expect(r.calls.some((c) => c.includes('gs-production'))).toBe(false);
  });

  it('refuses one box as both staging and production', () => {
    const r = drill(['--release', RELEASE, '--staging', 'gs', '--production', 'gs']);
    expect(r.status, r.out).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
