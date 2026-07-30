/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the TOTP second factor. The load-bearing cases are the RFC 6238 APPENDIX-B VECTORS: a home-grown TOTP that only agrees with itself will produce codes no authenticator app accepts, and a round-trip test would pass anyway. Verifying against the published vectors is the only assertion that proves interoperability with Google Authenticator / Authy / 1Password without a phone in the loop. The other three are the mistakes that turn 2FA into either a breach or a lockout: a code must not be replayable inside its own 30-second window, a recovery code must be single-use, and a rotated SESSION_SECRET must degrade to "unreadable" rather than crash the login path. One case here was FAKE on first writing and mutation testing found it: the 64-bit counter test asserted that the RFC's T=20000000000 vector exercises the high word, which it does not — that timestamp divided by the 30-second step is only ~667 million, so hard-coding the high word to zero left all six vectors green. It is now a differential check (the code for 2^32+n must differ from the code for n), which needs no published vector and does go red.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'crypto';
import {
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  currentStep,
  decryptSecret,
  encryptSecret,
  formatSecretForDisplay,
  generateRecoveryCodes,
  hashRecoveryCode,
  otpauthUri,
  totpCodeForStep,
  verifyTotpCode,
  getTotpState,
  confirmTotpEnrolment,
} from '@/features/local-auth/services/local-totp';

/** RFC 6238 Appendix B uses this ASCII secret for the SHA-1 vectors. */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

beforeAll(() => {
  // encryptSecret/decryptSecret derive their key from the session secret; without one they
  // must refuse rather than fall back to a fixed key.
  process.env.SESSION_SECRET = 'test-session-secret-for-totp-guards';
});

describe('base32', () => {
  it('encodes the RFC 6238 secret to the value every authenticator app expects', () => {
    // If this constant ever changes, enrolled phones stop working — it is not arbitrary.
    expect(RFC_SECRET_B32).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('round-trips arbitrary bytes and emits no padding', () => {
    for (const len of [1, 2, 3, 4, 5, 10, 20, 32]) {
      const buf = crypto.randomBytes(len);
      const enc = base32Encode(buf);
      expect(enc).not.toContain('=');
      expect(base32Decode(enc).equals(buf)).toBe(true);
    }
  });

  it('accepts the spaced form shown on the enrolment screen', () => {
    expect(base32Decode(formatSecretForDisplay(RFC_SECRET_B32)).toString('ascii')).toBe(RFC_SECRET_ASCII);
  });

  it('rejects a character outside the alphabet rather than decoding garbage', () => {
    expect(() => base32Decode('ABC!')).toThrow(/invalid base32/);
  });
});

describe('RFC 6238 Appendix B vectors (SHA-1)', () => {
  // The published table gives 8-digit codes; a 6-digit implementation yields the last six,
  // because the truncation is `binary % 10^digits` on the same dynamic offset.
  const VECTORS: Array<{ unixSeconds: number; eightDigit: string }> = [
    { unixSeconds: 59, eightDigit: '94287082' },
    { unixSeconds: 1111111109, eightDigit: '07081804' },
    { unixSeconds: 1111111111, eightDigit: '14050471' },
    { unixSeconds: 1234567890, eightDigit: '89005924' },
    { unixSeconds: 2000000000, eightDigit: '69279037' },
    { unixSeconds: 20000000000, eightDigit: '65353130' },
  ];

  it.each(VECTORS)('matches the published code at T=$unixSeconds', ({ unixSeconds, eightDigit }) => {
    const secret = Buffer.from(RFC_SECRET_ASCII, 'ascii');
    const step = Math.floor(unixSeconds / TOTP_STEP_SECONDS);
    expect(totpCodeForStep(secret, step, 8)).toBe(eightDigit);
    expect(totpCodeForStep(secret, step, TOTP_DIGITS)).toBe(eightDigit.slice(-TOTP_DIGITS));
  });

  it('writes a genuine 64-bit counter, proven by difference not by assertion', () => {
    // A previous version of this test claimed the T=20000000000 vector exercised the high
    // 32 bits. It does not: 20000000000 / 30 is ~667 million, which fits in 32 bits, so
    // hard-coding the high word to zero left every published vector passing. Mutation
    // testing caught it. The counter's high word is only reached above 2^32 STEPS, which is
    // past year 6000 and therefore has no published vector at all.
    //
    // So assert it differentially instead: if the high word were dropped, the code for
    // (2^32 + n) would be identical to the code for n. Requiring them to differ is a real
    // check with no external vector needed.
    const secret = Buffer.from(RFC_SECRET_ASCII, 'ascii');
    const low = 12345;
    const high = 0x100000000 + low;
    expect(totpCodeForStep(secret, high, 8)).not.toBe(totpCodeForStep(secret, low, 8));
    // And two distinct high words must not collapse onto each other either.
    expect(totpCodeForStep(secret, high, 8)).not.toBe(totpCodeForStep(secret, 0x200000000 + low, 8));
  });
});

describe('verifyTotpCode', () => {
  const at = (unixSeconds: number) => unixSeconds * 1000;
  const codeAt = (unixSeconds: number) => totpCodeForStep(
    Buffer.from(RFC_SECRET_ASCII, 'ascii'), Math.floor(unixSeconds / TOTP_STEP_SECONDS), TOTP_DIGITS,
  );

  it('accepts the current code and returns the step it matched', () => {
    const now = 1111111111;
    expect(verifyTotpCode(RFC_SECRET_B32, codeAt(now), at(now))).toBe(
      Math.floor(now / TOTP_STEP_SECONDS),
    );
  });

  it('tolerates one step of drift either side, and no more', () => {
    const now = 1111111111;
    const step = Math.floor(now / TOTP_STEP_SECONDS);
    const codeFor = (s: number) => totpCodeForStep(Buffer.from(RFC_SECRET_ASCII, 'ascii'), s, TOTP_DIGITS);
    expect(verifyTotpCode(RFC_SECRET_B32, codeFor(step - 1), at(now))).toBe(step - 1);
    expect(verifyTotpCode(RFC_SECRET_B32, codeFor(step + 1), at(now))).toBe(step + 1);
    // Two steps out must fail: the window is a drift allowance, not a validity extension.
    expect(verifyTotpCode(RFC_SECRET_B32, codeFor(step - 2), at(now))).toBeNull();
    expect(verifyTotpCode(RFC_SECRET_B32, codeFor(step + 2), at(now))).toBeNull();
  });

  it('REFUSES A REPLAY of a step already used', () => {
    // The whole reason verify returns the step. Without this, a code seen in transit stays
    // usable for the remainder of its window.
    const now = 1111111111;
    const step = Math.floor(now / TOTP_STEP_SECONDS);
    const code = codeAt(now);
    expect(verifyTotpCode(RFC_SECRET_B32, code, at(now), null)).toBe(step);
    expect(verifyTotpCode(RFC_SECRET_B32, code, at(now), step)).toBeNull();
    // ...and an older step is refused too, not just the exact one.
    expect(verifyTotpCode(RFC_SECRET_B32, code, at(now), step + 5)).toBeNull();
  });

  it('rejects anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ', '000000x']) {
      expect(verifyTotpCode(RFC_SECRET_B32, bad, at(1111111111))).toBeNull();
    }
  });

  it('returns null on an unparseable secret instead of throwing into the login path', () => {
    expect(verifyTotpCode('not-base32!!', '123456', at(1111111111))).toBeNull();
  });

  it('currentStep tracks the 30-second period', () => {
    expect(currentStep(0)).toBe(0);
    expect(currentStep(29_999)).toBe(0);
    expect(currentStep(30_000)).toBe(1);
  });
});

describe('otpauth URI', () => {
  it('carries the parameters an app needs, and escapes the account label', () => {
    const uri = otpauthUri('oshal · G-Squared', 'liz+crm@example.com', RFC_SECRET_B32);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET_B32}`);
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain(`digits=${TOTP_DIGITS}`);
    expect(uri).toContain(`period=${TOTP_STEP_SECONDS}`);
    // A raw '+' in the label would decode to a space and mislabel the account.
    expect(uri).not.toContain('liz+crm@example.com');
    expect(uri).toContain('liz%2Bcrm%40example.com');
  });
});

describe('secret at rest', () => {
  it('round-trips through AES-GCM and does not store the secret in the clear', () => {
    const enc = encryptSecret(RFC_SECRET_B32);
    expect(enc).not.toContain(RFC_SECRET_B32);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc)).toBe(RFC_SECRET_B32);
  });

  it('produces a different ciphertext each time (fresh IV)', () => {
    expect(encryptSecret(RFC_SECRET_B32)).not.toBe(encryptSecret(RFC_SECRET_B32));
  });

  it('returns null — never throws — on tampered, malformed or foreign ciphertext', () => {
    const enc = encryptSecret(RFC_SECRET_B32);
    const parts = enc.split('.');
    const tampered = `v1.${parts[1]}.${parts[2]}.${Buffer.from('nonsense').toString('base64url')}`;
    expect(decryptSecret(tampered)).toBeNull();
    expect(decryptSecret('v2.a.b.c')).toBeNull();
    expect(decryptSecret('garbage')).toBeNull();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret('')).toBeNull();
  });

  it('a rotated SESSION_SECRET degrades to unreadable rather than crashing', () => {
    const enc = encryptSecret(RFC_SECRET_B32);
    const original = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'a-different-secret-entirely';
    expect(decryptSecret(enc)).toBeNull();
    process.env.SESSION_SECRET = original;
    expect(decryptSecret(enc)).toBe(RFC_SECRET_B32);
  });

  it('refuses to store a secret at all when no SESSION_SECRET is configured (fail closed)', () => {
    const original = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.KEYCLOAK_CLIENT_SECRET;
    expect(() => encryptSecret(RFC_SECRET_B32)).toThrow(/SESSION_SECRET is required/);
    process.env.SESSION_SECRET = original;
  });
});

describe('confirmTotpEnrolment', () => {
  /** Captures the SQL and params a call issues, so we can assert what was WRITTEN. */
  function capturingPool(secretEnc: string) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT totp_secret_enc')) return { rows: [{ totp_secret_enc: secretEnc }] };
        return { rows: [] };
      },
    };
    return { pool: pool as unknown as Parameters<typeof confirmTotpEnrolment>[0], calls };
  }

  it('does NOT consume the time step, so the code on screen still signs you in', async () => {
    // The regression this guards: recording the step at confirmation meant the very code the
    // user had just typed was spent, and signing in seconds later was refused. First-run
    // failure, found by a browser walk of the live deployment rather than by any unit test.
    const secret = base32Encode(crypto.randomBytes(20));
    const now = 1111111111000;
    const code = totpCodeForStep(base32Decode(secret), currentStep(now));
    const { pool, calls } = capturingPool(encryptSecret(secret));

    expect(await confirmTotpEnrolment(pool, 'local-abc', code, now)).toBe(true);

    const update = calls.find((c) => /UPDATE oshal_local_users/.test(c.sql));
    expect(update, 'confirmation must write the enabled flag').toBeTruthy();
    expect(update!.sql).toMatch(/totp_enabled = TRUE/);
    expect(update!.sql).toMatch(/totp_last_step = NULL/);
    // Nothing may smuggle the step in as a bound value either.
    expect(update!.params).toEqual(['local-abc']);
  });

  it('still refuses a code that does not verify', async () => {
    const secret = base32Encode(crypto.randomBytes(20));
    const { pool, calls } = capturingPool(encryptSecret(secret));
    expect(await confirmTotpEnrolment(pool, 'local-abc', '000000', 1111111111000)).toBe(false);
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });
});

describe('getTotpState resilience', () => {
  const throwingPool = (err: unknown) => (
    { query: async () => { throw err; } } as unknown as Parameters<typeof getTotpState>[0]
  );

  it('reports "no factor" when the columns do not exist yet, instead of breaking every login', async () => {
    // A box that has never run ensureTotpSchema has no such columns, and nobody on it has a
    // second factor. Letting the error through would 500 every sign-in on that deployment —
    // locking a whole company out over a feature they do not use.
    const undefinedColumn = Object.assign(new Error('column totp_enabled does not exist'), { code: '42703' });
    await expect(getTotpState(throwingPool(undefinedColumn), 'local-abc')).resolves.toBeNull();
  });

  it('recognises the pre-migration case from the message when no SQLSTATE is passed through', async () => {
    const wrapped = new Error('column oshal_local_users.totp_required does not exist');
    await expect(getTotpState(throwingPool(wrapped), 'local-abc')).resolves.toBeNull();
  });

  it('RETHROWS any other database error — a read fault must never become a 2FA bypass', async () => {
    // The dangerous case is the columns DO exist, the account HAS a factor, and the read
    // fails. Swallowing that would wave the caller through on a password alone.
    await expect(getTotpState(throwingPool(new Error('connection terminated unexpectedly')), 'local-abc'))
      .rejects.toThrow(/connection terminated/);
    const denied = Object.assign(new Error('permission denied for table oshal_local_users'), { code: '42501' });
    await expect(getTotpState(throwingPool(denied), 'local-abc')).rejects.toThrow(/permission denied/);
  });
});

describe('recovery codes', () => {
  it('mints the advertised count, all distinct and transcribable', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });

  it('hashes case- and whitespace-insensitively, so a typed code still matches', () => {
    const [code] = generateRecoveryCodes();
    expect(hashRecoveryCode(code.toUpperCase())).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(`  ${code}  `)).toBe(hashRecoveryCode(code));
    expect(hashRecoveryCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not collide across separate mints', () => {
    const all = [...generateRecoveryCodes(), ...generateRecoveryCodes()].map(hashRecoveryCode);
    expect(new Set(all).size).toBe(all.length);
  });
});
