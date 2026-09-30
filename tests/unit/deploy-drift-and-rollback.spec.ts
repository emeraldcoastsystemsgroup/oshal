/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com | Unit tests for oshal-deploy-drift.sh and oshal-rollback.sh: syntax validation, structural checks, json/human output, and drift detection.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DRIFT_SCRIPT = path.resolve(process.cwd(), 'scripts/oshal-deploy-drift.sh');
const ROLLBACK_SCRIPT = path.resolve(process.cwd(), 'scripts/oshal-rollback.sh');
const BASH_RESOLVER = path.resolve(process.cwd(), 'scripts/lib/windows-git-bash.ps1');

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveHostBash(): string {
  if (process.platform !== 'win32') return 'bash';
  const resolver = quotePowerShellLiteral(BASH_RESOLVER);
  const command = `. ${resolver}; $selected = Resolve-OshalGitBash; `
    + 'if (-not $selected) { Write-Error "No validated Git Bash found"; exit 2 }; '
    + '[Console]::Out.Write($selected)';
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Git Bash resolution failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

const BASH = resolveHostBash();

describe('oshal-deploy-drift.sh contract and behavior', () => {
  it('is syntactically valid bash', () => {
    const res = spawnSync(BASH, ['--noprofile', '--norc', '-n', DRIFT_SCRIPT], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
  });

  it('prints help and exits 0', () => {
    const res = spawnSync(BASH, [DRIFT_SCRIPT, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
  });

  it('reports parity when release-dir matches mock running SHA and origin/main', () => {
    const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const res = spawnSync(BASH, [DRIFT_SCRIPT, '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, OSHAL_MOCK_RUNNING_SHA: gitHead },
    });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.releaseSha).toBe(gitHead);
    expect(parsed.runningSha).toBe(gitHead);
    expect(parsed.inParity).toBe(true);
    expect(parsed.drift).toEqual([]);
  });

  it('detects drift and exits 1 when running SHA diverges from release-dir', () => {
    const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const mockDiverged = '0000000000000000000000000000000000000000';
    const res = spawnSync(BASH, [DRIFT_SCRIPT, '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, OSHAL_MOCK_RUNNING_SHA: mockDiverged },
    });
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.inParity).toBe(false);
    expect(parsed.drift.length).toBeGreaterThan(0);
    expect(parsed.drift.some((d: string) => d.includes('running container differs'))).toBe(true);
  });
});

describe('oshal-rollback.sh contract and structure', () => {
  const src = fs.readFileSync(ROLLBACK_SCRIPT, 'utf8');

  it('is syntactically valid bash', () => {
    const res = spawnSync(BASH, ['--noprofile', '--norc', '-n', ROLLBACK_SCRIPT], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
  });

  it('prints help and exits 0', () => {
    const res = spawnSync(BASH, [ROLLBACK_SCRIPT, '--help'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
  });

  it('contains pre-rollback state snapshot creation', () => {
    expect(src).toContain('rollback-db-snapshot-');
    expect(src).toContain('SNAPSHOT_FILE=');
  });

  it('implements API-first recreate and checks degradation', () => {
    expect(src).toContain('Recreating $API_SERVICE');
    expect(src).toContain('wait_api');
    expect(src).toContain('recreate_bots');
    expect(src).toContain('degraded=1');
    expect(src).toContain('exit 3');
  });

  it('names recovery order for degraded rollback', () => {
    expect(src).toContain('oshal-up.sh');
    expect(src).toContain('api-bounce.sh');
    expect(src).toContain('deploy-parity-check.sh');
  });
});
