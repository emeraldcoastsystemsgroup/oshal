/**
 * Connector token crypto — envelope (per-user DEK) encryption tests.
 *
 * Proves the safety properties the rollout depends on:
 *  - flag OFF: versioned shared-HKDF format, round-trips without touching the DEK table;
 *  - flag ON: v2 envelope, round-trips, per-user isolation (user A can't read user B);
 *  - format-aware decrypt: a legacy blob still decrypts when the flag is ON, so the
 *    flag can be flipped without stranding existing tokens.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unit tests for connector-token-crypto envelope encryption (flag on/off, per-user isolation, legacy compatibility).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto default ON flip: default (no env) now round-trips a v2 envelope; a pre-existing legacy single-key blob STILL decrypts under the default (no already-connected user stranded); OSHAL_ENVELOPE_CRYPTO=false is the explicit rollback to the legacy path; and key absence (SESSION_SECRET unset while crypto ON) FAILS LOUD at both encrypt and decrypt (never a silent plaintext/weak-key downgrade). afterEach clears the env so tests don't leak the flag under the new ON default.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reconcile the stale crypto-off expectation with SECURITY-HARDENING 3.1/9: SESSION_SECRET absence fails closed in every mode, including the legacy-format rollback, so the suite cannot bless encryption under a repository-known development key.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Cover k2/hkdf1 format versioning, legacy read-and-rewrap, missing-DEK fail-closed behavior, and the explicit-only shared-hkdf DEK-store break-glass.
 */
import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import {
  CONNECTOR_TOKEN_ENVELOPE_V2,
  CONNECTOR_TOKEN_SHARED_HKDF_V2,
  CONNECTOR_WRAPPED_DEK_HKDF_V1,
  encryptToken,
  decryptToken,
  ensureDekSchema,
  envelopeEnabled,
} from '@/app/routes/connector-token-crypto';

/** Build an authentic pre-versioning raw-SHA256 AES-GCM fixture. */
function legacyEncrypt(value: string | Buffer): string {
  const key = crypto.createHash('sha256').update(String(process.env.SESSION_SECRET)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join(':');
}

/** Encrypt a token directly with a fixture DEK to exercise legacy wrapper migration. */
function envelopeWithDek(dek: Buffer, value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return CONNECTOR_TOKEN_ENVELOPE_V2
    + [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join(':');
}

/** In-memory stand-in for the pg pool — backs only the oshal_user_deks table. */
function fakePool() {
  const deks = new Map<string, string>();
  return {
    deks,
    async query(text: string, params: unknown[] = []) {
      if (/CREATE TABLE/i.test(text)) return { rows: [] };
      if (/SELECT wrapped_dek/i.test(text)) {
        const sub = String(params[0]);
        return deks.has(sub) ? { rows: [{ wrapped_dek: deks.get(sub) }] } : { rows: [] };
      }
      if (/INSERT INTO oshal_user_deks/i.test(text)) {
        const [sub, wrapped] = params as [string, string];
        if (!deks.has(sub)) deks.set(sub, wrapped); // ON CONFLICT DO NOTHING
        return { rows: [] };
      }
      if (/UPDATE oshal_user_deks/i.test(text)) {
        const [sub, wrapped, expected] = params as [string, string, string];
        if (deks.get(sub) === expected) deks.set(sub, wrapped);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test.beforeEach(() => {
  process.env.SESSION_SECRET = 'test-master-secret-for-crypto-spec';
  delete process.env.OSHAL_ENVELOPE_CRYPTO; // start each test from the (new) ON default
  delete process.env.OSHAL_ENVELOPE_DEK_FAILURE;
});
test.afterEach(() => {
  delete process.env.OSHAL_ENVELOPE_CRYPTO; // never leak the flag between tests
  delete process.env.OSHAL_ENVELOPE_DEK_FAILURE;
});

test('default (no env): envelope crypto is ON', () => {
  expect(envelopeEnabled()).toBe(true);
});

test('default (no env): v2 envelope round-trips and mints a per-user DEK', async () => {
  const pool = fakePool();
  const blob = await encryptToken(pool, 'user-a', 'default-on-token');
  expect(blob.startsWith('v2:')).toBe(true); // default now envelope-encrypts
  expect(await decryptToken(pool, 'user-a', blob)).toBe('default-on-token');
  expect(pool.deks.has('user-a')).toBe(true);
});

test('flag OFF (explicit rollback): versioned shared-HKDF blob round-trips without a DEK', async () => {
  process.env.OSHAL_ENVELOPE_CRYPTO = 'false';
  expect(envelopeEnabled()).toBe(false);
  const pool = fakePool();
  await ensureDekSchema(pool);
  const blob = await encryptToken(pool, 'user-a', 'secret-token-123');
  expect(blob.startsWith(CONNECTOR_TOKEN_SHARED_HKDF_V2)).toBe(true);
  expect(blob.slice(CONNECTOR_TOKEN_SHARED_HKDF_V2.length).split(':')).toHaveLength(3);
  expect(await decryptToken(pool, 'user-a', blob)).toBe('secret-token-123');
  expect(pool.deks.size).toBe(0); // legacy path never touches the DEK table
});

test('flag ON: v2 envelope, round-trips, mints a per-user DEK', async () => {
  process.env.OSHAL_ENVELOPE_CRYPTO = 'true';
  expect(envelopeEnabled()).toBe(true);
  const pool = fakePool();
  const blob = await encryptToken(pool, 'user-a', 'gmail-refresh-xyz');
  expect(blob.startsWith('v2:')).toBe(true);
  expect(await decryptToken(pool, 'user-a', blob)).toBe('gmail-refresh-xyz');
  expect(pool.deks.has('user-a')).toBe(true);
});

test('flag ON: per-user isolation — user B cannot decrypt user A token', async () => {
  process.env.OSHAL_ENVELOPE_CRYPTO = 'true';
  const pool = fakePool();
  const aBlob = await encryptToken(pool, 'user-a', 'A-only-secret');
  await encryptToken(pool, 'user-b', 'B-only-secret'); // mint B's DEK too
  expect(pool.deks.get('user-a')).not.toBe(pool.deks.get('user-b')); // distinct DEKs
  // Decrypting A's v2 blob under B's DEK must fail the GCM auth tag.
  await expect(decryptToken(pool, 'user-b', aBlob)).rejects.toThrow();
});

test('legacy compat: a pre-migration single-key blob still decrypts under the ON default', async () => {
  const pool = fakePool();
  const legacy = legacyEncrypt('pre-migration-token');
  expect(legacy.startsWith('v2:')).toBe(false);
  // The default flips ON — the already-connected user's legacy token MUST keep reading
  // (format-aware decrypt on the SAME SESSION_SECRET). This is the no-brick requirement.
  delete process.env.OSHAL_ENVELOPE_CRYPTO;
  expect(envelopeEnabled()).toBe(true);
  expect(await decryptToken(pool, 'user-a', legacy)).toBe('pre-migration-token');
});

test('legacy DEK wrapper is read and compare-and-set upgraded to hkdf1', async () => {
  const pool = fakePool();
  const dek = crypto.randomBytes(32);
  pool.deks.set('user-a', legacyEncrypt(dek));
  const token = envelopeWithDek(dek, 'wrapped-legacy-token');
  expect(await decryptToken(pool, 'user-a', token)).toBe('wrapped-legacy-token');
  expect(pool.deks.get('user-a')?.startsWith(CONNECTOR_WRAPPED_DEK_HKDF_V1)).toBe(true);
});

test('v2 decrypt with a missing DEK fails without minting a replacement', async () => {
  const pool = fakePool();
  await expect(decryptToken(pool, 'missing-user', 'v2:aaa:bbb:ccc')).rejects.toThrow(/no DEK row/);
  expect(pool.deks.size).toBe(0);
});

test('DEK-store failure denies by default and falls back only under explicit shared-hkdf', async () => {
  const brokenPool = { async query() { throw new Error('database unavailable'); } };
  await expect(encryptToken(brokenPool, 'user-a', 'deny-me')).rejects.toThrow(/token write denied/);

  process.env.OSHAL_ENVELOPE_DEK_FAILURE = 'shared-hkdf';
  const blob = await encryptToken(brokenPool, 'user-a', 'break-glass-token');
  expect(blob.startsWith(CONNECTOR_TOKEN_SHARED_HKDF_V2)).toBe(true);
  expect(await decryptToken(brokenPool, 'user-a', blob)).toBe('break-glass-token');
});

test('key absent: crypto ON + SESSION_SECRET unset FAILS LOUD (never silent downgrade)', async () => {
  delete process.env.SESSION_SECRET; // no master key; crypto stays ON (default)
  const pool = fakePool();
  // Encrypt must throw at the kek() boundary rather than derive a weak/dev key or write plaintext.
  await expect(encryptToken(pool, 'user-a', 'x')).rejects.toThrow(/SESSION_SECRET/);
  // Decrypt of a v2 blob must also fail loud — the DEK can't be unwrapped without the KEK.
  await expect(decryptToken(pool, 'user-a', 'v2:aaa:bbb:ccc')).rejects.toThrow(/SESSION_SECRET/);
});

test('key absent: crypto OFF still fails loud rather than using a public legacy key', async () => {
  process.env.OSHAL_ENVELOPE_CRYPTO = 'false';
  delete process.env.SESSION_SECRET;
  const pool = fakePool();
  // The envelope-off rollback changes the blob format, not the master-key requirement.
  // A repository-known fallback key would provide no at-rest protection.
  await expect(encryptToken(pool, 'user-a', 'legacy-dev-token')).rejects.toThrow(/SESSION_SECRET/);
});
