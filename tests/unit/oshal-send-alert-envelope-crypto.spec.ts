/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression guard for the envelope-crypto drift hitting scripts/oshal-send-alert.js — the same v2 per-user-DEK drift already guarded for oshal-gmail.js and oshal-recap-email.js. Every failure-alert caller (trading/stack watchdog, lab-report publish, ci-local, earnings-gate) execs this in-container, so when it died with "Unsupported state or unable to authenticate data" on a v2 token, EVERY alert went silent — which is why the 3-day wrangler deploy pile-up that OOM-crashed the swarm never notified anyone. Pins that the exported decryptToken reads BOTH a v2 per-user-DEK blob and a legacy KEK blob.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Stable test master secret — MUST be set before requiring the CLI so key() derives from it.
process.env.SESSION_SECRET = 'test-session-secret-send-alert-envelope-guard';

const sendAlert = require('../../scripts/oshal-send-alert.js') as {
  key: () => Buffer;
  decryptToken: (pool: unknown, userSub: string | undefined, blob: string) => Promise<string>;
};

/** Encrypt exactly as connector-token-crypto.ts gcmEncrypt does: `iv:tag:enc` (base64), AES-256-GCM. */
function gcmEncrypt(k: Buffer, plain: Buffer | string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** Fake pg pool: returns one oshal_user_deks row (or none for the missing-DEK case). */
function fakePool(wrappedDek: string | null) {
  return {
    query: async (sql: string) => ({
      rows: sql.includes('oshal_user_deks') && wrappedDek ? [{ wrapped_dek: wrappedDek }] : [],
    }),
  };
}

describe('oshal-send-alert.js connector-token decrypt is envelope-aware (v2 + legacy)', () => {
  const KEK = sendAlert.key(); // SHA256(SESSION_SECRET) — same derivation the controller uses
  // Distinct subs per test: the CLI caches a user's unwrapped DEK per process, so reusing one sub
  // would leak test 1's DEK into the missing-DEK case.

  it('decrypts a v2 per-user-DEK envelope blob (the exact case that black-holed alerts)', async () => {
    const dek = crypto.randomBytes(32);                 // the controller wraps the RAW 32-byte DEK
    const wrappedDek = gcmEncrypt(KEK, dek);            // stored in oshal_user_deks, KEK-wrapped
    const token = 'ya29.a0-REAL-LOOKING-ACCESS-TOKEN';
    const v2blob = 'v2:' + gcmEncrypt(dek, token);      // token encrypted under the per-user DEK

    const out = await sendAlert.decryptToken(fakePool(wrappedDek), 'sub-v2-happy', v2blob);
    expect(out).toBe(token);
  });

  it('still decrypts a legacy unprefixed single-KEK blob', async () => {
    const token = 'legacy-refresh-token-placeholder';
    const legacy = gcmEncrypt(KEK, token);
    const out = await sendAlert.decryptToken(fakePool(null), 'sub-legacy', legacy);
    expect(out).toBe(token);
  });

  it('throws a clear error when a v2 blob has no DEK row', async () => {
    const dek = crypto.randomBytes(32);
    const v2blob = 'v2:' + gcmEncrypt(dek, 'x');
    await expect(sendAlert.decryptToken(fakePool(null), 'sub-missing-dek', v2blob)).rejects.toThrow(/DEK/);
  });
});
