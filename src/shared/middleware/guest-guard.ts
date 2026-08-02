/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guest-mode guard (Phase 1). The actual server-side lockdown: a single top-level middleware mounted before all /api route mounts that, for guest requests only, denies Tier-C apps entirely and blocks mutations on Tier-B apps. Keys ONLY on req.oidc.user.is_guest (never on the service-secret header) so a guest cannot escape the guard by forging X-Service-Secret.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Per-sub LIFETIME model-turn cap (GUEST_MODEL_TURN_CAP, default 25) alongside the sliding window. The window limits the RATE; on its own it still let one anonymous visitor spend rateMax() every window for the whole 12h session TTL. Counted only for grants marked spendsModel, so opening a conversation stays free. Returns 429 guest_turn_cap.
 */

import type { Request, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller } from '@/shared/middleware/authz';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { guestDecision, guestSpendsModel } from '@/shared/middleware/guest-capability-matrix';

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

// LIFETIME cap on model-spending turns per guest sub. The sliding window above limits
// the RATE; on its own it still lets one anonymous visitor spend `rateMax()` every
// window for the whole 12h session TTL. This is the total. Counted only for grants
// marked `spendsModel`, so opening a conversation stays free.
const guestTurns = new Map<string, { count: number; first: number }>();
function turnCap(): number {
  const v = Number(process.env.GUEST_MODEL_TURN_CAP);
  return Number.isFinite(v) && v > 0 ? v : 25;
}
/** Entries older than this are dropped — well past the longest guest session TTL. */
const TURN_TTL_MS = 24 * 60 * 60 * 1000;
/** Returns true when the guest has spent their whole session's model-turn budget. */
function overTurnCap(req: Request): boolean {
  const sub = getCaller(req).sub;
  if (!sub) return false;
  const now = Date.now();
  const seen = guestTurns.get(sub);
  const entry = seen && now - seen.first < TURN_TTL_MS ? seen : { count: 0, first: now };
  if (entry.count >= turnCap()) {
    guestTurns.set(sub, entry);
    return true;
  }
  entry.count += 1;
  guestTurns.set(sub, entry);
  // Opportunistic cleanup so the map doesn't grow unbounded across many guests.
  if (guestTurns.size > 5000) {
    for (const [k, v] of guestTurns) {
      if (now - v.first >= TURN_TTL_MS) guestTurns.delete(k);
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
      // Lifetime budget for the routes that actually reach a model. Checked after the
      // rate limit so a burst is throttled before it burns the session's total.
      if (guestSpendsModel(req.path, req.method) && overTurnCap(req)) {
        logger.info({ path: req.path, method: req.method }, 'Guest model turn cap reached');
        res.status(429).json({
          error: 'guest_turn_cap',
          message: 'This guest session has used its free turns. Sign in to keep going.',
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
