/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the local-auth credential primitives (ADR-117): scrypt hash/verify, the deterministic installer-compatible sub formula, and invite-token minting. The sub-formula case is the load-bearing one — it pins localSubForEmail to the EXACT LocalSub construction scripts/oshal-install.ps1 writes into MOCK_OIDC_SUB, so switching a deployment from mock to gated login keeps every sub-keyed row.
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import {
  INVITE_TOKEN_PREFIX,
  PASSWORD_MIN_LENGTH,
  generateInviteToken,
  hashInviteToken,
  hashPassword,
  localSubForEmail,
  looksLikeEmail,
  normalizeEmail,
  verifyPassword,
} from '@/features/local-auth';

describe('local-auth password hashing', () => {
  it('round-trips a password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', stored)).toBe(true);
    expect(verifyPassword('correct horse batterx', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('stores a self-describing scrypt string, unique per salt', () => {
    const a = hashPassword('same password');
    const b = hashPassword('same password');
    expect(a).toMatch(/^scrypt\$14\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b); // fresh salt every time
  });

  it('treats malformed stored material as no-match, never a throw', () => {
    expect(verifyPassword('anything', null)).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'bcrypt$whatever')).toBe(false);
    expect(verifyPassword('anything', 'scrypt$14$8$1$!!!notbase64!!!')).toBe(false);
  });

  it('enforces a real minimum length constant', () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(10);
  });
});

describe('local-auth deterministic sub (installer LocalSub compatibility)', () => {
  it("matches the installer's formula: 'local-' + sha256(lowercase(email)).hex[0..16]", () => {
    const email = 'the operator.Murphy@EmeraldCoastSystemsGroup.com ';
    const expected = `local-${crypto.createHash('sha256')
      .update(email.trim().toLowerCase())
      .digest('hex')
      .slice(0, 16)}`;
    expect(localSubForEmail(email)).toBe(expected);
  });

  it('is case- and whitespace-insensitive (one identity per mailbox)', () => {
    expect(localSubForEmail('USER@X.COM')).toBe(localSubForEmail('  user@x.com'));
    expect(localSubForEmail('a@x.com')).not.toBe(localSubForEmail('b@x.com'));
    expect(localSubForEmail('a@x.com')).toMatch(/^local-[0-9a-f]{16}$/);
  });
});

describe('local-auth invite tokens', () => {
  it('mints prefixed 48-hex tokens and hashes with sha256 for storage', () => {
    const token = generateInviteToken();
    expect(token).toMatch(new RegExp(`^${INVITE_TOKEN_PREFIX}[0-9a-f]{48}$`));
    expect(generateInviteToken()).not.toBe(token);
    expect(hashInviteToken(token)).toBe(crypto.createHash('sha256').update(token).digest('hex'));
  });
});

describe('local-auth email normalization', () => {
  it('lowercases and trims, and screens obvious non-addresses', () => {
    expect(normalizeEmail('  A@B.Co ')).toBe('a@b.co');
    expect(looksLikeEmail('a@b.co')).toBe(true);
    expect(looksLikeEmail('not-an-email')).toBe(false);
    expect(looksLikeEmail('a b@c.co')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });
});
