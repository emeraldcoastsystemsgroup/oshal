/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the plaintext re-seed regression (SEC-05 deadlock, observed 2026-09-08/09): the encrypted-secrets migration deletes /app/output/secrets.json BY DESIGN, and Step 1b's copy-if-missing then restored the stale seed on the next container start, re-tripping LEGACY_PLAINTEXT_SECRETS_PRESENT on every secret operation — which killed codex OAuth login. Runs the REAL Step-1b block from scripts/bot-entrypoint.sh under real sh against a real temp filesystem (integration-boundary corollary: the defect lived in the shell script, so a mocked shell proves nothing): with secrets.enc.json present the plaintext seed must NOT come back while non-secret seeds still copy; without it, seeding behaves as before.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENTRYPOINT = join(__dirname, '..', '..', 'scripts', 'bot-entrypoint.sh');

/**
 * Extracts the real Step-1b seeding block (SEED_DIR assignment through its closing `fi`)
 * from bot-entrypoint.sh. Failing loudly when the anchors move keeps this guard honest —
 * a silently-empty extraction would pass every assertion.
 */
function extractSeedBlock(): string {
  const source = readFileSync(ENTRYPOINT, 'utf8');
  const start = source.indexOf('SEED_DIR="/app/config-seed"');
  const endAnchor = 'Step 1c';
  const end = source.indexOf(endAnchor, start);
  if (start < 0 || end < 0) {
    throw new Error('bot-entrypoint.sh Step-1b anchors not found — update this guard alongside the script');
  }
  const block = source.slice(start, end);
  const lastFi = block.lastIndexOf('fi');
  if (lastFi < 0) {
    throw new Error('bot-entrypoint.sh Step-1b block has no closing fi — update this guard');
  }
  return block.slice(0, lastFi + 2);
}

/** Runs the real block under sh with SEED_DIR/CONFIG_DIR pointed at temp dirs. */
function runSeedStep(seedDir: string, configDir: string): void {
  // Forward slashes: a backslashed Windows temp path inside a double-quoted sh
  // string is eaten as escapes; Git Bash sh accepts C:/... paths as-is.
  const seed = seedDir.replace(/\\/g, '/');
  const config = configDir.replace(/\\/g, '/');
  const block = extractSeedBlock().replace('SEED_DIR="/app/config-seed"', `SEED_DIR="${seed}"`);
  const script = `set -eu\nCONFIG_DIR="${config}"\n${block}\n`;
  // sh is the entrypoint's real interpreter (POSIX, per its shebang); Git Bash provides
  // it on Windows dev boxes and CI is Linux. A missing shell FAILS the guard — a spec
  // that skips is a guard that does not exist.
  const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`seed step failed: ${result.error?.message ?? result.stderr}`);
  }
}

function sandbox(): { seedDir: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'oshal-seed-spec-'));
  const seedDir = join(root, 'config-seed');
  const configDir = join(root, 'output');
  mkdirSync(seedDir);
  mkdirSync(configDir);
  writeFileSync(join(seedDir, 'secrets.json'), '{"seed":"plaintext"}');
  writeFileSync(join(seedDir, 'global-config.json'), '{"seed":"global"}');
  return { seedDir, configDir };
}

describe('bot-entrypoint Step 1b secrets seeding', () => {
  it('seeds secrets.json into a fresh output dir when no encrypted store exists', () => {
    const { seedDir, configDir } = sandbox();
    runSeedStep(seedDir, configDir);
    expect(existsSync(join(configDir, 'secrets.json'))).toBe(true);
    expect(existsSync(join(configDir, 'global-config.json'))).toBe(true);
  });

  it('NEVER re-seeds plaintext secrets.json once secrets.enc.json exists — the SEC-05 regression', () => {
    const { seedDir, configDir } = sandbox();
    writeFileSync(join(configDir, 'secrets.enc.json'), '{"v":1,"envelopes":{}}');
    runSeedStep(seedDir, configDir);
    expect(existsSync(join(configDir, 'secrets.json'))).toBe(false);
    // Non-secret seeds are unaffected by the encrypted store.
    expect(existsSync(join(configDir, 'global-config.json'))).toBe(true);
  });

  it('leaves an existing runtime secrets.json untouched (copy-if-missing contract)', () => {
    const { seedDir, configDir } = sandbox();
    writeFileSync(join(configDir, 'secrets.json'), '{"runtime":"edited"}');
    runSeedStep(seedDir, configDir);
    expect(readFileSync(join(configDir, 'secrets.json'), 'utf8')).toBe('{"runtime":"edited"}');
  });
});
