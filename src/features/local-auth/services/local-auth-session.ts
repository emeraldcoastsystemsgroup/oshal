/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Local-auth session cookies (ADR-117). Self-contained HMAC-signed `oshal_local` cookie mirroring the guest-session shape (`<payload>.<hmac>`, SESSION_SECRET-signed, constant-time verify — no server-side session store). Claims carry token_version so a password change or account disable kills existing sessions at the injector's next store snapshot, and `org` (original issue time) so rolling reissue slides the 24h window while the 7-day absolute cap still ends it. Pure logic — no Express, no DB — so every rule here is unit-testable.
 */

import crypto from 'crypto';

/** Cookie name for the local-auth session. */
export const LOCAL_SESSION_COOKIE = 'oshal_local';
/** A session idles out this long after its last reissue. */
export const LOCAL_SESSION_ROLLING_MS = 24 * 60 * 60 * 1000;
/** No session survives past this, however active (mirrors the OIDC rolling/absolute pair). */
export const LOCAL_SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

/** Claims carried inside the signed cookie. */
export interface LocalSessionClaims {
  /** The deterministic `local-…` platform sub. */
  sub: string;
  email: string;
  name: string;
  /** token_version at mint time — mismatch with the store means the session is dead. */
  v: number;
  /** Issue time of THIS cookie (seconds). */
  iat: number;
  /** Original issue time of the session (seconds) — survives rolling reissue. */
  org: number;
  /** Expiry (seconds). */
  exp: number;
}

/**
 * @description True when LOCAL_AUTH mode is enabled — the platform runs its own
 * invited-user login instead of an external OIDC IdP or the open MOCK_OIDC mode.
 *
 * @returns true if LOCAL_AUTH is set to a truthy value ('true', '1', 'yes').
 */
export function isLocalAuthEnabled(): boolean {
  const val = (process.env.LOCAL_AUTH ?? '').toLowerCase().trim();
  return val === 'true' || val === '1' || val === 'yes';
}

/**
 * @description The signing secret — the same resolution chain the OIDC session and guest
 * cookies use (SESSION_SECRET → AUTH_SESSION_SECRET → KEYCLOAK_CLIENT_SECRET), so no new
 * key to manage. Empty means local auth cannot sign and must refuse to boot (fail closed).
 *
 * @returns The secret, or '' when unset.
 */
export function localAuthSigningSecret(): string {
  return (process.env.SESSION_SECRET || process.env.AUTH_SESSION_SECRET || process.env.KEYCLOAK_CLIENT_SECRET || '').trim();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(payloadB64: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

/** Identity fields a session is minted from. */
export interface LocalSessionIdentity {
  userSub: string;
  email: string;
  displayName: string | null;
  tokenVersion: number;
}

/**
 * @description Mints a signed session cookie value for a local user. `priorOrg` preserves
 * the session's original issue time across a rolling reissue so the absolute cap holds.
 *
 * @param user - Identity to encode.
 * @param nowMs - Clock override for tests.
 * @param priorOrg - Original issue time (seconds) when reissuing; omitted on first mint.
 * @returns The cookie value, or null when no signing secret is configured.
 */
export function mintLocalSession(
  user: LocalSessionIdentity, nowMs: number = Date.now(), priorOrg?: number,
): { value: string; maxAgeMs: number } | null {
  const secret = localAuthSigningSecret();
  if (!secret) return null;
  const iat = Math.floor(nowMs / 1000);
  const org = priorOrg ?? iat;
  const absoluteEnd = org + Math.floor(LOCAL_SESSION_ABSOLUTE_MS / 1000);
  const exp = Math.min(iat + Math.floor(LOCAL_SESSION_ROLLING_MS / 1000), absoluteEnd);
  if (exp <= iat) return null; // absolute cap already passed — nothing to mint
  const claims: LocalSessionClaims = {
    sub: user.userSub, email: user.email, name: user.displayName || user.email,
    v: user.tokenVersion, iat, org, exp,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return { value: `${payload}.${hmac(payload, secret)}`, maxAgeMs: (exp - iat) * 1000 };
}

/**
 * @description Verifies a session cookie value: signature (constant-time), shape, expiry,
 * and the absolute cap (belt-and-braces — exp already respects it at mint).
 *
 * @param value - Raw cookie value.
 * @param nowMs - Clock override for tests.
 * @returns The claims, or null when invalid/expired.
 */
export function verifyLocalSession(value: string | undefined | null, nowMs: number = Date.now()): LocalSessionClaims | null {
  if (!value || typeof value !== 'string') return null;
  const secret = localAuthSigningSecret();
  if (!secret) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = hmac(payload, secret);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as LocalSessionClaims;
    if (typeof claims?.sub !== 'string' || !claims.sub.startsWith('local-')) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < nowMs) return null;
    if (typeof claims.org !== 'number' || (claims.org * 1000) + LOCAL_SESSION_ABSOLUTE_MS < nowMs) return null;
    if (typeof claims.v !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * @description True when a verified session is past half its rolling window and a fresh
 * cookie should be issued (sliding session). Reissue is refused past the absolute cap by
 * mintLocalSession returning null.
 *
 * @param claims - Verified claims.
 * @param nowMs - Clock override for tests.
 * @returns true when the injector should reissue.
 */
export function shouldReissueLocalSession(claims: LocalSessionClaims, nowMs: number = Date.now()): boolean {
  const ageMs = nowMs - claims.iat * 1000;
  return ageMs > LOCAL_SESSION_ROLLING_MS / 2;
}
