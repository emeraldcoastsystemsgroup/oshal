/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Regression lock for the ATS site-credential secret handling (scripts/oshal-site-creds.js). These hold real employer-portal logins, so three properties are load-bearing: the AES-256-GCM envelope must round-trip and must NOT be plaintext at rest; a tampered envelope must THROW (auth tag verified) rather than silently return garbage; and the minted password must satisfy the usual ATS class rules without the modulo bias that would quietly shrink the keyspace.
 */

import { describe, expect, it } from 'vitest';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-site-creds-spec';
const { generatePassword, encrypt, decrypt } = require('../../scripts/oshal-site-creds.js');

describe('site-credential envelope', () => {
  // Fixtures are deliberately NOT password-shaped: the repo's pre-commit secret guard flags
  // credential-looking literals, and it should — a test is not a reason to weaken that.
  it('round-trips a value through AES-256-GCM, symbols and spaces intact', () => {
    const plaintext = 'fixture-value #with symbols & spaces';
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('does not store the plaintext (envelope is iv:tag:ciphertext)', () => {
    const plaintext = 'fixture-value-not-a-credential';
    const blob = encrypt(plaintext);
    expect(blob).not.toContain(plaintext);
    expect(blob.split(':')).toHaveLength(3);
  });

  it('produces a different envelope each time (random IV, no ECB-style leak)', () => {
    expect(encrypt('same-input')).not.toBe(encrypt('same-input'));
  });

  it('THROWS on a tampered envelope rather than returning garbage', () => {
    const [iv, tag, ct] = encrypt('tamper-me').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 0xff; // corrupt the ciphertext — the GCM auth tag must catch it
    expect(() => decrypt(`${iv}:${tag}:${flipped.toString('base64')}`)).toThrow();
  });
});

describe('generatePassword', () => {
  it('meets the usual ATS rules: length + one of each character class', () => {
    for (let i = 0; i < 40; i++) {
      const p = generatePassword(20);
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%*?\-_]/);
    }
  });

  it('enforces a 12-char floor even when asked for less', () => {
    expect(generatePassword(4).length).toBe(12);
  });

  it('does not emit look-alike characters support desks misread (I/O/l/0/1)', () => {
    for (let i = 0; i < 40; i++) expect(generatePassword(20)).not.toMatch(/[IOl01]/);
  });

  it('is not positionally predictable (the guaranteed classes are shuffled)', () => {
    // Without the shuffle, index 0 would ALWAYS be uppercase across every sample.
    const firsts = new Set(Array.from({ length: 60 }, () => generatePassword(20)[0]));
    expect(firsts.size).toBeGreaterThan(3);
  });

  it('generates unique passwords (no repeat across a sample)', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword(20)));
    expect(seen.size).toBe(100);
  });
});
