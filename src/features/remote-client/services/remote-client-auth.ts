/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — auth hardening helpers for the remote-client worker plane (docs/backlog/hardening.md #7): timingSafeSecretEquals replaces the timing-oracle `===` shared-secret compare in remote-client-routes (sha256-digest both sides, then crypto.timingSafeEqual — digesting first equalizes length so no length leak and no timingSafeEqual throw), and remoteClientRateLimitKey keys the router-local rate limiter per CALLER (the /:clientId path segment the whole worker plane carries) instead of per IP, so NAT'd nodes behind one address never starve each other; non-device surfaces (/register, the list) fall back to the IPv6-safe ipKeyGenerator. Logic lives here, not in remote-client-routes.ts, which is over the 800-code-line decomposition threshold.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';

/**
 * @description Constant-time comparison of a caller-supplied credential against the
 * configured shared secret. Both sides are sha256-digested first so the buffers
 * always have equal length — `crypto.timingSafeEqual` throws on length mismatch,
 * and comparing raw strings with `===` leaks match-prefix timing on a public
 * origin. A missing/empty candidate or an empty expected secret never matches.
 * @param candidate - The credential presented by the request (header or bearer value).
 * @param expected - The configured secret to compare against.
 * @returns true only when the candidate exactly equals the expected secret.
 */
export function timingSafeSecretEquals(candidate: string | null | undefined, expected: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || expected.length === 0) {
    return false;
  }
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

/** The request fields the rate-limit key derivation reads (a structural subset of express.Request). */
export interface RemoteClientRateLimitRequestLike {
  /** Router-relative path, e.g. `/gabe-pc/tasks/next` or `/register`. */
  path?: string;
  /** Remote address as express resolves it. */
  ip?: string;
}

/** Router-relative first path segments that are NOT a clientId (surface routes, not the worker plane). */
const NON_CLIENT_SEGMENTS = new Set(['register']);

/**
 * @description Per-caller rate-limit key for the /api/remote-clients router. Every
 * worker-plane route rides `/:clientId/...`, so the first path segment IS the
 * caller identity — keying on it means one hot node can be throttled without
 * starving its NAT siblings behind the same IP (behind cloudflared, ALL external
 * traffic can share one address, so an IP key would pool the whole fleet into a
 * single bucket). Non-device surfaces (`/register`, the `/` list) key on the
 * request IP via express-rate-limit's IPv6-safe `ipKeyGenerator` helper.
 * @param req - The inbound request (only `path` and `ip` are read).
 * @returns A stable bucket key, `client:<clientId>` or `ip:<addr>`.
 */
export function remoteClientRateLimitKey(req: RemoteClientRateLimitRequestLike): string {
  const firstSegment = (req.path ?? '').split('/').filter(Boolean)[0] ?? '';
  if (firstSegment && !NON_CLIENT_SEGMENTS.has(firstSegment)) {
    return `client:${firstSegment}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? '', 56)}`;
}
