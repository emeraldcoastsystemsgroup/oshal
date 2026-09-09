/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the SEC-05 seeding deadlock. EncryptedConfigManager refuses EVERY secret read/write while a plaintext secrets.json exists; POST /api/config/migrate removes it, and bot-entrypoint.sh's copy-if-missing seed then restored it on the next container start, so a migrated controller silently went back to refusing credential imports (observed live 2026-09-08 — a Codex import that had just succeeded failed again after one restart). This spec EXECUTES the seeding block out of the real script under a real shell against temp directories, rather than asserting on its text: the defect was in what the loop DID, and a substring check would have passed against the broken version.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ENTRYPOINT = path.join(process.cwd(), 'scripts/bot-entrypoint.sh');

/** A POSIX shell to run the extracted block with. */
function findShell(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    '/bin/sh',
    '/bin/bash',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const base of process.platform === 'win32' ? ['bash.exe', 'sh.exe'] : ['bash', 'sh']) {
      const p = path.join(dir, base);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Pull the real "Step 1b" seeding block out of the shipped entrypoint. */
function seedingBlock(): string {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const start = src.indexOf('SEED_DIR="/app/config-seed"');
  const end = src.indexOf('# ── Step 1c', start);
  expect(start, 'Step 1b seeding block not found').toBeGreaterThan(-1);
  expect(end, 'Step 1c marker not found').toBeGreaterThan(start);
  // Point the block at the temp dirs the test controls instead of /app.
  return src.slice(start, end).replace('SEED_DIR="/app/config-seed"', 'SEED_DIR="$TEST_SEED"');
}

/**
 * @description Runs the real seeding block with a seed dir holding all three files.
 * @param encryptedPresent - Whether the config dir already has secrets.enc.json.
 * @returns Which files exist in the config dir afterwards, plus the block's output.
 */
function runSeed(encryptedPresent: boolean): { seeded: string[]; out: string } {
  const shell = findShell();
  if (!shell) throw new Error('no POSIX shell available — cannot verify the entrypoint seeding block');
  const root = mkdtempSync(path.join(tmpdir(), 'oshal-seed-'));
  try {
    const seed = path.join(root, 'seed');
    const config = path.join(root, 'output');
    mkdirSync(seed);
    mkdirSync(config);
    for (const f of ['global-config.json', 'secrets.json', 'llm-config.json']) {
      writeFileSync(path.join(seed, f), '{"from":"seed"}');
    }
    if (encryptedPresent) writeFileSync(path.join(config, 'secrets.enc.json'), '{"v":1}');

    const script = `set -e\nTEST_SEED="$1"\nCONFIG_DIR="$2"\n${seedingBlock()}`;
    const out = execFileSync(shell, ['-c', script, 'sh', seed, config], { encoding: 'utf8' });
    const seeded = ['global-config.json', 'secrets.json', 'llm-config.json']
      .filter((f) => existsSync(path.join(config, f)));
    return { seeded, out };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('bot-entrypoint config seed — must not undo an encrypted migration', () => {
  it('seeds every file on a fresh volume, so bot nodes still get their plaintext config', () => {
    // Bot nodes deliberately never receive ENCRYPTION_KEY (compose keeps it API-only), so the
    // plaintext seed is the ONLY way they get provider config. This path must not change.
    const { seeded } = runSeed(false);
    expect(seeded.sort()).toEqual(['global-config.json', 'llm-config.json', 'secrets.json']);
  });

  it('skips the plaintext secrets seed once an encrypted envelope exists', () => {
    // The controller has ENCRYPTION_KEY and therefore secrets.enc.json. Restoring the plaintext
    // beside it makes EncryptedConfigManager throw LEGACY_PLAINTEXT_SECRETS_PRESENT on every
    // secret operation — which is exactly how a migrated box silently un-migrated on restart.
    const { seeded, out } = runSeed(true);
    expect(seeded).not.toContain('secrets.json');
    expect(seeded.sort()).toEqual(['global-config.json', 'llm-config.json']);
    expect(out).toMatch(/Skipping secrets\.json seed/);
  });

  it('still says out loud what it skipped, so a silent no-op is not mistaken for seeding', () => {
    expect(runSeed(true).out).toContain('encrypted secrets.enc.json is already present');
  });
});

describe('compose controller seed — the path that actually re-broke the controller', () => {
  it('guards the api command copy on the encrypted envelope', () => {
    // The api does NOT run bot-entrypoint.sh: its command is inline in compose, and its own
    // `cp -n ... secrets.json` is what restored the plaintext after the migration.
    const compose = readFileSync(path.join(process.cwd(), 'docker-compose.oshal-local.yml'), 'utf8');
    const line = compose.split(/\r?\n/).find((l) => l.includes('cp -n /app/config-seed/secrets.json'));
    expect(line, 'the controller seed copy disappeared — re-check this guard').toBeTruthy();
    expect(line).toContain('[ -f /app/output/secrets.enc.json ] ||');
  });
});
