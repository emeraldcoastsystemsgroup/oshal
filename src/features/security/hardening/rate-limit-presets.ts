/**
 * Rate-limit presets (additive hardening, all DISABLED by default).
 *
 * GROUND TRUTH: today the global limiter in src/app/server.ts is
 *   rateLimit({ windowMs: 60_000, max: 1000, skip: req => !req.headers['x-forwarded-for'] })
 * That deliberately SKIPS any request without an X-Forwarded-For header, so the
 * internal mesh / localhost / health checks are unlimited. That is fine for the
 * swarm's own chatter, but it also means anything that can reach the origin
 * WITHOUT going through cloudflared (the no-XFF path) is never throttled.
 *
 * This module provides opt-in presets that an operator can layer on WITHOUT
 * touching the existing global limiter. Each preset returns a no-op middleware
 * unless its env flag is on, so merging this changes nothing at runtime.
 *
 *  - internalMeshLimiter:  covers the no-XFF gap with a generous cap, so a
 *                          runaway internal caller (or anything reaching the
 *                          origin directly) is still bounded. Enable with
 *                          OSHAL_RATE_LIMIT_INTERNAL.
 *  - expensiveOpLimiter:   a tight per-IP cap for costly routes (LLM calls,
 *                          intake, anything that spends tokens or spawns work).
 *                          Enable with OSHAL_RATE_LIMIT_EXPENSIVE.
 *  - makeLimiter(name, opts): generic factory; returns a no-op unless its own
 *                          flag (OSHAL_RATE_LIMIT_<NAME>) is on.
 *
 * @module features/security/hardening/rate-limit-presets
 */

import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'security:rate-limit-presets' });

/** Read a boolean-ish env flag. Defaults OFF so nothing engages on merge. */
function envOn(name: string): boolean {
  const v = (process.env[name] ?? 'off').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}

/** A pass-through middleware used whenever a preset's flag is off. */
const noop: RequestHandler = (_req, _res, next) => next();

/** Turn a preset name into its env flag, e.g. 'internal' -> OSHAL_RATE_LIMIT_INTERNAL. */
function flagFor(name: string): string {
  return `OSHAL_RATE_LIMIT_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Generic limiter factory. Returns a real express-rate-limit middleware only
 * when the preset's flag (OSHAL_RATE_LIMIT_<NAME>) is on; otherwise a no-op.
 *
 * Optional numeric overrides via env let an operator tune without code:
 *   OSHAL_RATE_LIMIT_<NAME>_MAX, OSHAL_RATE_LIMIT_<NAME>_WINDOW_MS
 */
export function makeLimiter(name: string, opts: Partial<RateLimitOptions> = {}): RequestHandler {
  const flag = flagFor(name);
  if (!envOn(flag)) return noop;

  const maxEnv = Number(process.env[`${flag}_MAX`]);
  const windowEnv = Number(process.env[`${flag}_WINDOW_MS`]);

  const resolved: Partial<RateLimitOptions> = {
    standardHeaders: true,
    legacyHeaders: false,
    // We are NOT behind the global trust-proxy assumptions here; keep the
    // express-rate-limit proxy validation off to match the existing limiter.
    validate: { trustProxy: false },
    ...opts,
  };
  if (Number.isFinite(maxEnv) && maxEnv > 0) resolved.max = maxEnv;
  if (Number.isFinite(windowEnv) && windowEnv > 0) resolved.windowMs = windowEnv;

  logger.info(
    { limiter: name, flag, max: resolved.max, windowMs: resolved.windowMs },
    'rate-limit preset enabled',
  );
  return rateLimit(resolved);
}

/**
 * Internal-mesh limiter: covers the no-XFF gap left by the global limiter.
 * Generous cap so it only catches genuine runaways, not normal swarm chatter.
 * Targets requests WITHOUT an X-Forwarded-For (the path the global limiter skips).
 *
 * Enable with OSHAL_RATE_LIMIT_INTERNAL=on.
 */
export const internalMeshLimiter: RequestHandler = makeLimiter('internal', {
  windowMs: 60_000,
  max: 5000,
  // Only engage on the no-XFF (internal/direct) path; XFF traffic is already
  // handled by the existing global limiter.
  skip: (req) => Boolean(req.headers['x-forwarded-for']),
  message: { error: 'internal rate limit exceeded' },
});

/**
 * Expensive-op limiter: a tight per-IP cap for costly routes (LLM, intake,
 * anything that spends tokens or spawns work). Mount it on those routes only.
 *
 * Enable with OSHAL_RATE_LIMIT_EXPENSIVE=on.
 */
export const expensiveOpLimiter: RequestHandler = makeLimiter('expensive', {
  windowMs: 60_000,
  max: 30,
  message: { error: 'rate limit exceeded for this operation; slow down' },
});
