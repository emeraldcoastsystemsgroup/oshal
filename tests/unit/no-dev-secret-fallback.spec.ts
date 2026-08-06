/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9 guard: the hardcoded dev-key fallback ("oshal-dev" + "-secret") is REMOVED everywhere — a constant in a public repo is a key everyone holds, so it silently voided the at-rest crypto for connector tokens, PKCE/state, digests, and every self-decrypting scripts/oshal-*.js CLI on any box that forgot SESSION_SECRET. Two layers: (1) BEHAVIOR — connector-token-crypto's encryptToken/decryptToken reject on a missing SESSION_SECRET in BOTH envelope modes (the crypto-OFF break-glass used to fall back to the dev key) and still round-trip correctly when the secret exists; (2) EXISTENCE — a tree scan proves the literal is gone from src/, scripts/, and any-bot/ (the correct guard shape for "this constant must not exist" — the behavioral cases above are what make it mutation-proof).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Give the disk-walking existence guard its own bounded 30-second budget. On a 500+ file parallel unit run, Windows/NTFS contention can exceed Vitest's 5-second default even though the same guard completes immediately in isolation; keeping the exception local preserves the strict global budget and keeps this security check mandatory.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CORE-06 timeout containment: cap the sole source-tree scan at the specified 20 seconds; behavioral crypto cases keep the global budget.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Track the explicit DEK-failure posture and assert that shared fallback writes use the versioned k2 HKDF format, never an unprefixed legacy blob.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { decryptToken, encryptToken } from '../../src/app/routes/connector-token-crypto';

// Built from parts so this spec never trips its own scan.
const DEV_SECRET_LITERAL = 'oshal-dev' + '-secret';
const DISK_SCAN_TIMEOUT_MS = 20_000;

const ENV_KEYS = ['SESSION_SECRET', 'AUTH_SESSION_SECRET', 'OSHAL_ENVELOPE_CRYPTO', 'OSHAL_ENVELOPE_DEK_FAILURE'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Minimal in-memory oshal_user_deks so the per-user DEK path runs for real. */
function fakeDekPool() {
  const deks = new Map<string, string>();
  return {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
      if (sql.includes('SELECT wrapped_dek')) {
        const row = deks.get(String(params[0]));
        return { rows: row ? [{ wrapped_dek: row }] : [] };
      }
      if (sql.includes('INSERT INTO oshal_user_deks')) {
        if (!deks.has(String(params[0]))) deks.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      throw new Error(`fake DEK pool has no handler for: ${sql.slice(0, 60)}`);
    },
  };
}

describe('connector-token crypto refuses to run without SESSION_SECRET (no dev-key fallback)', () => {
  it('rejects with envelope crypto ON (the default)', async () => {
    const pool = fakeDekPool();
    await expect(encryptToken(pool, 'user-a', 'tok')).rejects.toThrow(/SESSION_SECRET/);
    await expect(decryptToken(pool, 'user-a', 'aaaa:bbbb:cccc')).rejects.toThrow(/SESSION_SECRET/);
  });

  it('rejects with envelope crypto explicitly OFF — the break-glass branch no longer derives a well-known key', async () => {
    process.env.OSHAL_ENVELOPE_CRYPTO = 'false';
    const pool = fakeDekPool();
    await expect(encryptToken(pool, 'user-a', 'tok')).rejects.toThrow(/SESSION_SECRET/);
    await expect(encryptToken(pool, undefined, 'tok')).rejects.toThrow(/SESSION_SECRET/);
  });

  it('still round-trips (envelope v2 AND legacy) when SESSION_SECRET is set — fail-loud did not break the working path', async () => {
    process.env.SESSION_SECRET = 'example-session-secret-guard-0001';
    const pool = fakeDekPool();
    // Envelope path (default ON): per-user DEK blob.
    const v2 = await encryptToken(pool, 'user-a', 'token-value-123');
    expect(v2.startsWith('v2:')).toBe(true);
    expect(await decryptToken(pool, 'user-a', v2)).toBe('token-value-123');
    // Unowned/shared path is versioned k2 HKDF and remains readable.
    const shared = await encryptToken(pool, undefined, 'token-value-456');
    expect(shared.startsWith('k2:')).toBe(true);
    expect(await decryptToken(pool, undefined, shared)).toBe('token-value-456');
  });
});

describe('the dev-key literal is gone from the tree', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const SCAN_DIRS = ['src', 'scripts', 'any-bot'];
  const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sh', '.sql', '.yml', '.yaml', '.json']);

  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (CODE_EXT.has(path.extname(entry.name))) yield full;
    }
  }

  it('no source/script/config file contains the hardcoded dev key', () => {
    const hits: string[] = [];
    for (const dir of SCAN_DIRS) {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        if (fs.readFileSync(file, 'utf8').includes(DEV_SECRET_LITERAL)) {
          hits.push(path.relative(ROOT, file));
        }
      }
    }
    expect(
      hits,
      'the hardcoded dev-key fallback resurfaced — it silently voids at-rest crypto on any box without SESSION_SECRET (SECURITY-HARDENING 3.1/9)',
    ).toEqual([]);
  }, DISK_SCAN_TIMEOUT_MS);
});
