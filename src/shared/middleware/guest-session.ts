/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest-mode session (Phase 1). A self-contained, HMAC-signed `oshal_guest` cookie carrying a per-browser `guest-<uuid>` sub so anonymous visitors get an isolated, capability-restricted identity on the public tenant WITHOUT a Google login. The injector mirrors createTvTokenAuthMiddleware: it only fills req.oidc when there is no real OIDC session, so a real login always wins. Gated by ENABLE_GUEST_MODE (default off).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | createGuestWelcomeMat: pages that opt in (the /applications app-store preview) send an ANONYMOUS visitor to the /guest landing (carrying the deep link via ?next=) instead of straight to Google OAuth, so a shared link lands on "Continue as guest / Sign in" rather than a login wall. Guest mode off, non-GET, or any existing session (guest or real) falls through to requiresAuth unchanged.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Guest cookie writes now validate SESSION_COOKIE_DOMAIN before passing it to Express/cookie. A malformed deployment value no longer turns /api/guest/start into HTTP 500; guest mode logs the bad config and falls back to a host-only cookie.
 */

import crypto from 'crypto';
import type { Request, Response, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { hasValidServiceSecret } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'guest-session' });

export const GUEST_COOKIE = 'oshal_guest';
export const GUEST_SUB_PREFIX = 'guest-';
const COOKIE_DOMAIN_RE = /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** True when guest mode is enabled (master switch, default OFF). */
export function isGuestModeEnabled(): boolean {
  const v = (process.env.ENABLE_GUEST_MODE ?? '').toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes';
}

function ttlMs(): number {
  const hours = Number(process.env.GUEST_SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

/**
 * The signing secret. Reuses the same secret the OIDC session uses so we don't
 * introduce a new key to manage. Returns '' when unset (callers treat that as
 * "guest disabled" — fail closed).
 */
function signingSecret(): string {
  return (process.env.SESSION_SECRET || process.env.AUTH_SESSION_SECRET || process.env.KEYCLOAK_CLIENT_SECRET || '').trim();
}

function sessionCookieDomain(): string | undefined {
  const domain = (process.env.SESSION_COOKIE_DOMAIN || '').trim();
  if (!domain) return undefined;
  if (!COOKIE_DOMAIN_RE.test(domain)) {
    logger.warn('Ignoring invalid SESSION_COOKIE_DOMAIN for guest cookie');
    return undefined;
  }
  return domain;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmac(payloadB64: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

interface GuestClaims {
  sub: string;
  iat: number;
  exp: number;
}

/**
 * @description Builds a fresh guest identity and its signed cookie value. The
 * cookie is self-contained (`<payload>.<hmac>`) — no server-side session store.
 * @returns the cookie value + the guest sub, or null when guest mode can't sign.
 */
export function mintGuestCookie(): { value: string; sub: string; maxAgeMs: number } | null {
  const secret = signingSecret();
  if (!secret) {
    logger.warn('Cannot mint guest cookie: no SESSION_SECRET configured');
    return null;
  }
  const now = Date.now();
  const maxAgeMs = ttlMs();
  const claims: GuestClaims = {
    sub: `${GUEST_SUB_PREFIX}${crypto.randomUUID()}`,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + maxAgeMs) / 1000),
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return { value: `${payload}.${hmac(payload, secret)}`, sub: claims.sub, maxAgeMs };
}

/** @description Verifies a guest cookie value and returns its claims, or null. */
export function verifyGuestCookie(value: string | undefined | null): GuestClaims | null {
  if (!value || typeof value !== 'string') return null;
  const secret = signingSecret();
  if (!secret) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = hmac(payload, secret);
  // Constant-time compare; length-guard first since timingSafeEqual throws on mismatch.
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as GuestClaims;
    if (!claims?.sub?.startsWith(GUEST_SUB_PREFIX)) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/** @description Sets the signed guest cookie on the response. */
export function setGuestCookie(req: Request, res: Response): string | null {
  const minted = mintGuestCookie();
  if (!minted) return null;
  const domain = sessionCookieDomain();
  res.cookie(GUEST_COOKIE, minted.value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: minted.maxAgeMs,
    ...(domain ? { domain } : {}),
  });
  return minted.sub;
}

/** @description Clears the guest cookie. */
export function clearGuestCookie(res: Response): void {
  const domain = sessionCookieDomain();
  res.clearCookie(GUEST_COOKIE, {
    path: '/',
    ...(domain ? { domain } : {}),
  });
}

/**
 * @description Middleware that injects an authenticated guest `req.oidc` when a
 * valid guest cookie is present AND there is no real session. Mirrors the TV
 * token injector pattern (tv-pairing-routes.ts). A real OIDC session or a valid
 * service-secret call always wins — the guest cookie is ignored in those cases,
 * so we never shadow a real user's identity into the RLS GUC. No-op entirely
 * when guest mode is disabled.
 */
export function createGuestSessionInjector(): RequestHandler {
  return (req, _res, next) => {
    if (!isGuestModeEnabled()) return next();
    try {
      const existing = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc;
      if (existing?.isAuthenticated?.()) return next(); // real login wins
      if (hasValidServiceSecret(req)) return next(); // internal service call, not a guest
      const cookie = (req as { cookies?: Record<string, string> }).cookies?.[GUEST_COOKIE];
      const claims = verifyGuestCookie(cookie);
      if (!claims) return next();
      (req as { oidc?: unknown }).oidc = {
        isAuthenticated: () => true,
        user: {
          sub: claims.sub,
          name: 'Guest',
          email: `${claims.sub}@guest.local`,
          preferred_username: 'guest',
          roles: ['guest'],
          is_guest: true,
        },
        idToken: 'guest-token',
        accessToken: 'guest-token',
      };
    } catch (err) {
      logger.error({ err }, 'Guest session injector failed');
    }
    next();
  };
}

/**
 * @description Wraps a page's auth so an ANONYMOUS visitor is welcomed through the
 * guest gate instead of bounced to the OIDC provider. When guest mode is enabled and
 * a GET arrives with no session at all (no real OIDC login, no injected guest), the
 * visitor is 302'd to `/guest?next=<originalUrl>` — the landing card offers
 * "Continue as guest" AND "Sign in", and its sanitized `next` returns them here.
 * Every other case (guest mode off, non-GET, or any authenticated session) falls
 * through to the wrapped requiresAuth unchanged, so signed-in behavior is identical.
 *
 * Used by UI surfaces that double as public previews (the /applications app store).
 * Never mount this on an API route: the redirect target is a human landing page.
 *
 * @param requiresAuth - The real auth middleware to delegate to.
 * @returns Middleware that redirects cold visitors to /guest, else defers to auth.
 */
export function createGuestWelcomeMat(requiresAuth: RequestHandler): RequestHandler {
  return (req, res, next) => {
    const authed = (req as { oidc?: { isAuthenticated?: () => boolean } }).oidc?.isAuthenticated?.();
    if (!authed && isGuestModeEnabled() && req.method === 'GET') {
      res.redirect(302, `/guest?next=${encodeURIComponent(req.originalUrl || '/')}`);
      return;
    }
    requiresAuth(req, res, next);
  };
}

/** @description True when the request is acting as a guest (set by the injector). */
export function isGuestRequest(req: Request): boolean {
  const user = (req as { oidc?: { user?: { is_guest?: boolean } } }).oidc?.user;
  return user?.is_guest === true;
}
