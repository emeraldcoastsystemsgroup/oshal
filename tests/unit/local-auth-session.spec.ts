/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for the local-auth session cookie (ADR-117): signed-cookie round-trip, tamper/expiry rejection, the token_version revocation hook, rolling reissue past half-life, and the 7-day absolute cap that rolling reissue must NOT slide past.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_SESSION_ABSOLUTE_MS,
  LOCAL_SESSION_ROLLING_MS,
  isLocalAuthEnabled,
  mintLocalSession,
  shouldReissueLocalSession,
  verifyLocalSession,
  type LocalSessionIdentity,
} from '@/features/local-auth';

const IDENTITY: LocalSessionIdentity = {
  userSub: 'local-0123456789abcdef',
  email: 'bdo@example.com',
  displayName: 'A BDO',
  tokenVersion: 3,
};

const T0 = 1_800_000_000_000; // fixed clock for determinism

describe('local-auth session cookie', () => {
  const SAVED_KEYS = ['SESSION_SECRET', 'AUTH_SESSION_SECRET', 'KEYCLOAK_CLIENT_SECRET', 'LOCAL_AUTH'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
    process.env.SESSION_SECRET = 'example-session-secret-0000';
  });

  afterEach(() => {
    for (const k of SAVED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('round-trips claims through mint + verify', () => {
    const minted = mintLocalSession(IDENTITY, T0);
    expect(minted).not.toBeNull();
    const claims = verifyLocalSession(minted!.value, T0 + 1000);
    expect(claims).toMatchObject({ sub: IDENTITY.userSub, email: IDENTITY.email, name: 'A BDO', v: 3 });
    expect(claims!.exp - claims!.iat).toBe(LOCAL_SESSION_ROLLING_MS / 1000);
  });

  it('rejects a tampered payload and a truncated signature', () => {
    const minted = mintLocalSession(IDENTITY, T0)!;
    const [payload, sig] = [minted.value.slice(0, minted.value.lastIndexOf('.')), minted.value.slice(minted.value.lastIndexOf('.') + 1)];
    const tamperedPayload = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')),
      sub: 'local-ffffffffffffffff',
    })).toString('base64url');
    expect(verifyLocalSession(`${tamperedPayload}.${sig}`, T0)).toBeNull();
    expect(verifyLocalSession(`${payload}.${sig.slice(0, -2)}`, T0)).toBeNull();
    expect(verifyLocalSession('garbage', T0)).toBeNull();
  });

  it('rejects an expired cookie', () => {
    const minted = mintLocalSession(IDENTITY, T0)!;
    expect(verifyLocalSession(minted.value, T0 + LOCAL_SESSION_ROLLING_MS + 1000)).toBeNull();
  });

  it('refuses to mint past the absolute cap (rolling reissue cannot slide forever)', () => {
    const orgSec = Math.floor(T0 / 1000);
    // A reissue attempt after the absolute window has fully elapsed mints nothing.
    const late = mintLocalSession(IDENTITY, T0 + LOCAL_SESSION_ABSOLUTE_MS + 1000, orgSec);
    expect(late).toBeNull();
    // A reissue NEAR the cap clamps exp to the cap rather than a full rolling window.
    const nearCapNow = T0 + LOCAL_SESSION_ABSOLUTE_MS - 60 * 60 * 1000; // 1h left
    const clamped = mintLocalSession(IDENTITY, nearCapNow, orgSec)!;
    const claims = verifyLocalSession(clamped.value, nearCapNow)!;
    expect(claims.exp).toBe(orgSec + LOCAL_SESSION_ABSOLUTE_MS / 1000);
  });

  it('asks for reissue only past half the rolling window', () => {
    const minted = mintLocalSession(IDENTITY, T0)!;
    const claims = verifyLocalSession(minted.value, T0)!;
    expect(shouldReissueLocalSession(claims, T0 + LOCAL_SESSION_ROLLING_MS / 4)).toBe(false);
    expect(shouldReissueLocalSession(claims, T0 + LOCAL_SESSION_ROLLING_MS / 2 + 1000)).toBe(true);
  });

  it('cannot mint or verify without a signing secret (fail closed)', () => {
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.KEYCLOAK_CLIENT_SECRET;
    expect(mintLocalSession(IDENTITY, T0)).toBeNull();
    process.env.SESSION_SECRET = 'example-session-secret-0000';
    const minted = mintLocalSession(IDENTITY, T0)!;
    delete process.env.SESSION_SECRET;
    expect(verifyLocalSession(minted.value, T0)).toBeNull();
  });

  it('reads the LOCAL_AUTH flag like the other mode flags', () => {
    process.env.LOCAL_AUTH = 'true';
    expect(isLocalAuthEnabled()).toBe(true);
    process.env.LOCAL_AUTH = 'no';
    expect(isLocalAuthEnabled()).toBe(false);
    delete process.env.LOCAL_AUTH;
    expect(isLocalAuthEnabled()).toBe(false);
  });
});
