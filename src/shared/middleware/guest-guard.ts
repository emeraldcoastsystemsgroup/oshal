/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest-mode guard (Phase 1). The actual server-side lockdown: a single top-level middleware mounted before all /api route mounts that, for guest requests only, denies Tier-C apps entirely and blocks mutations on Tier-B apps. Keys ONLY on req.oidc.user.is_guest (never on the service-secret header) so a guest cannot escape the guard by forging X-Service-Secret.
 */

import type { Request, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { guestDecision } from '@/shared/middleware/guest-capability-matrix';

const logger = createChildLogger({ module: 'guest-guard' });

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// In-memory sliding-window rate limiter for guest mutations — the only guest path
// that spends real resources (LLM calls in the Tier-A apps live behind POSTs). Per
// guest sub. Self-contained (no Redis) since guest sessions are ephemeral anyway.
const guestHits = new Map<string, number[]>();
function rateWindowMs(): number {
  const v = Number(process.env.GUEST_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60 * 1000;
}
function rateMax(): number {
  const v = Number(process.env.GUEST_RATE_LIMIT_MAX);
  return Number.isFinite(v) && v > 0 ? v : 40;
}
/** Returns true when the guest is over their mutation budget for the window. */
function overRateLimit(req: Request): boolean {
  const sub = getCaller(req).sub;
  if (!sub) return false;
  const now = Date.now();
  const windowMs = rateWindowMs();
  const hits = (guestHits.get(sub) || []).filter((t) => now - t < windowMs);
  if (hits.length >= rateMax()) {
    guestHits.set(sub, hits);
    return true;
  }
  hits.push(now);
  guestHits.set(sub, hits);
  // Opportunistic cleanup so the map doesn't grow unbounded across many guests.
  if (guestHits.size > 5000) {
    for (const [k, v] of guestHits) {
      const live = v.filter((t) => now - t < windowMs);
      if (live.length === 0) guestHits.delete(k);
      else guestHits.set(k, live);
    }
  }
  return false;
}

/**
 * @description Top-level guard enforcing the guest capability matrix. Non-guest
 * requests pass through with zero cost. Guests get 403 on blocked apps and on
 * mutating calls to read-only apps. Covers serviceSecretOr routes automatically
 * because it runs before those per-route handlers and ignores the secret header.
 */
export function createGuestGuard(): RequestHandler {
  return (req, res, next) => {
    if (!isGuestRequest(req)) return next();

    const decision = guestDecision(req.path, req.method);
    if (decision === 'allow') {
      // Throttle the resource-spending path (Tier-A writes / LLM calls).
      if (MUTATING.has(req.method.toUpperCase()) && overRateLimit(req)) {
        logger.info({ path: req.path, method: req.method }, 'Guest rate limit exceeded');
        res.status(429).json({
          error: 'guest_rate_limited',
          message: 'Guest mode has a usage limit. Please slow down or sign in.',
          guest: true,
        });
        return;
      }
      return next();
    }

    logger.info({ path: req.path, method: req.method, decision }, 'Guest request denied');
    res.status(403).json({
      error: decision, // 'guest_blocked' | 'guest_readonly'
      message:
        decision === 'guest_blocked'
          ? 'This app is not available in guest mode.'
          : 'Guest mode is read-only. Sign in to make changes.',
      guest: true,
    });
  };
}
