/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Short-lived signed delete-confirmation token for the two-step account-data delete. Deliberately mirrors the platform's existing self-contained HMAC token (shared/middleware/guest-session.ts): same b64url(payload).b64url(hmac-sha256) shape, same SESSION_SECRET-family signing key (no new key to manage), same constant-time verify. Purpose- and sub-bound so a token minted for one user/action can never confirm anything else; 15-minute TTL, fail-closed when no secret is configured.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: length-guard before timingSafeEqual now compares UTF-8 BYTE lengths, not JS string lengths. A crafted sig with a multibyte char (same char count, different byte count) previously made timingSafeEqual throw a RangeError that escaped as a 500; it is now an ordinary detail-free rejection (403 at the route).
 */

/**
 * Two-step delete, step 1 artifact: POST /api/me/delete-request mints this token; step 2
 * (POST /api/me/delete-confirm) must present it back within the TTL. The token is
 * self-contained (`<payload>.<hmac>`), so no server-side state is needed; single-use is
 * approximated by the short TTL — acceptable because the token only ever authorizes deleting
 * the SAME caller's own data (it is bound to the authenticated sub on both mint and verify).
 *
 * @module features/data-lifecycle/services/delete-token
 */

import crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'data-lifecycle:delete-token' });

/** Purpose claim baked into every token — a token minted here can only confirm this action. */
export const DELETE_TOKEN_PURPOSE = 'account-data-delete';

/** Default validity window. Short on purpose: this is a confirmation nonce, not a session. */
export const DELETE_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Claims carried inside the signed payload. */
export interface DeleteTokenClaims {
  /** The user whose data the token authorizes deleting — must match the confirming caller. */
  sub: string;
  /** Always {@link DELETE_TOKEN_PURPOSE}; anything else is rejected. */
  purpose: string;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Random nonce so two mints in the same second still differ. */
  nonce: string;
}

/** Options for mint/verify — injectable secret + clock so unit tests need no env mutation. */
export interface DeleteTokenOptions {
  /** Signing secret override; defaults to the platform session-secret family. */
  secret?: string;
  /** Validity window override in ms (mint only). */
  ttlMs?: number;
  /** Clock override in epoch ms. */
  nowMs?: number;
}

/**
 * @description The signing secret. Reuses the exact resolution the guest-session token uses
 * (SESSION_SECRET → AUTH_SESSION_SECRET → KEYCLOAK_CLIENT_SECRET) so no new key is introduced.
 * Empty string = cannot sign — callers must fail closed (503), never fall back to unsigned.
 * @returns The configured secret, or '' when none is set.
 */
function signingSecret(): string {
  return (process.env.SESSION_SECRET || process.env.AUTH_SESSION_SECRET || process.env.KEYCLOAK_CLIENT_SECRET || '').trim();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(payloadB64: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * @description Mint a short-lived, purpose+sub-bound delete-confirmation token for step 1 of
 * the two-step delete. Fail-closed: returns null (route answers 503) when no signing secret is
 * configured, because an unsigned confirmation would make account deletion forgeable.
 * @param userSub - The authenticated caller whose data the token will authorize deleting.
 * @param opts - Test seams: secret / TTL / clock overrides.
 * @returns The token + its expiry, or null when signing is impossible.
 */
export function mintDeleteToken(userSub: string, opts: DeleteTokenOptions = {}): { token: string; expiresAt: string } | null {
  const secret = opts.secret ?? signingSecret();
  if (!secret) {
    logger.error('cannot mint delete token: no SESSION_SECRET-family signing secret configured');
    return null;
  }
  const now = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? DELETE_TOKEN_TTL_MS;
  const claims: DeleteTokenClaims = {
    sub: userSub,
    purpose: DELETE_TOKEN_PURPOSE,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttl) / 1000),
    nonce: crypto.randomUUID(),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return { token: `${payload}.${hmac(payload, secret)}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

/**
 * @description Verify a delete-confirmation token for step 2. Checks — in order — signature
 * (constant-time), payload shape, purpose, expiry, and that the token's sub MATCHES the
 * confirming caller (a stolen token can never delete someone else's account). Every rejection
 * returns null; the route turns that into a 403 without detail (no oracle).
 * @param token - The `<payload>.<hmac>` value from POST /api/me/delete-confirm.
 * @param userSub - The authenticated caller — must equal the token's sub claim.
 * @param opts - Test seams: secret / clock overrides.
 * @returns The verified claims, or null when the token is invalid for this caller.
 */
export function verifyDeleteToken(token: string | undefined | null, userSub: string, opts: DeleteTokenOptions = {}): DeleteTokenClaims | null {
  if (!token || typeof token !== 'string') return null;
  const secret = opts.secret ?? signingSecret();
  if (!secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = hmac(payload, secret);
  // Constant-time compare; length-guard first since timingSafeEqual throws on length mismatch.
  // The guard MUST compare BYTE lengths (Buffer.length), not JS string lengths: a sig containing
  // a multibyte character can match the expected CHAR count while differing in UTF-8 byte count,
  // and timingSafeEqual would then throw instead of returning false.
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as DeleteTokenClaims;
    if (claims?.purpose !== DELETE_TOKEN_PURPOSE) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < (opts.nowMs ?? Date.now())) return null;
    if (!claims.sub || claims.sub !== userSub) return null;
    return claims;
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack }, 'delete token payload unparsable');
    return null;
  }
}
