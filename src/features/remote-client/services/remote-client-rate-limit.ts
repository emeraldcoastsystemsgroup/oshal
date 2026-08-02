/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Make the /api/remote-clients per-caller limit REAL. The limiter shipped through makeLimiter('remote_clients', ...), whose flag defaults OFF (rate-limit-presets.ts envOn), and OSHAL_RATE_LIMIT_REMOTE_CLIENTS is set in NO deployment — not docker-compose.oshal-local.yml, not .env.example, not the running api's env — so the worker plane has been running with the limiter as a pass-through no-op and only the global 1000/min/IP limiter behind it. The generic presets are opt-in ADDITIVE hardening for routes that already sit behind requiresAuth; this router deliberately does not (its own authorizeRemoteClient gate is the wall), and its whole surface is machine-driven task dispatch on a cloudflared-exposed origin, so its limit is a REQUIRED control and belongs on by default. Same env flag, inverted default: unset = ON, and only an explicit OSHAL_RATE_LIMIT_REMOTE_CLIENTS=off disables it (loudly, at WARN, so a disabled control is visible in the boot log). Guard: tests/unit/remote-client-rate-limit.spec.ts.
 */

import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { remoteClientRateLimitKey } from './remote-client-auth';

const logger = createChildLogger({ module: 'remote-client-rate-limit' });

/** Env flag that can DISABLE the limiter. Unset/blank = enabled (secure by default). */
export const REMOTE_CLIENT_RATE_LIMIT_FLAG = 'OSHAL_RATE_LIMIT_REMOTE_CLIENTS';

/**
 * Default ceiling per caller per window. A healthy edge node polls ~35 req/min
 * (2.5s task poll + 10s heartbeat), so 300/min leaves ~8x headroom for bursts
 * (workspace file sync pushes a file per request) while still bounding a runaway
 * daemon or an authenticated-but-abusive node.
 */
export const REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX = 300;

/** Default sliding window. */
export const REMOTE_CLIENT_RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000;

/** Values that turn the limiter OFF. Anything else (including unset) leaves it ON. */
const DISABLE_VALUES = new Set(['off', 'false', '0', 'no']);

/** A pass-through used only when an operator explicitly disables the limiter. */
const passThrough: RequestHandler = (_req, _res, next) => next();

/**
 * @description Read a positive numeric override from the environment. Anything absent,
 * non-numeric, zero or negative falls back to the caller-supplied default rather than
 * silently producing a limiter that admits nothing (max 0) or never resets (window 0).
 * @param env - Environment to read.
 * @param name - Full env var name.
 * @param fallback - Value used when the override is missing or unusable.
 * @returns The resolved positive number.
 */
function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const parsed = Number(env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description Build the per-caller rate limiter mounted on the /api/remote-clients router.
 *
 * WHY it is not `makeLimiter('remote_clients', …)`: the security-hardening presets are
 * opt-in extras layered on routes that are already auth-gated, so they default OFF and
 * merging them changes nothing. This router is the opposite case — it sits outside
 * `requiresAuth` by design, is reachable from the public origin through cloudflared, and
 * every one of its surfaces enqueues or claims real work on someone's machine. A limit
 * that only engages when an operator remembers an env var is not a limit; no deployment
 * ever set the flag, so the control shipped inert. Default ON, with the SAME env var kept
 * as the escape hatch (`=off`) for anyone who has to unblock a hot node in a hurry.
 *
 * Keying is per CALLER (the proven `/:clientId` path segment), never per IP: behind
 * cloudflared/NAT one address can front the whole fleet, and an IP key would pool every
 * node into one bucket so a single busy machine starves its siblings. Non-device surfaces
 * (`/register`, the list) fall back to the IPv6-safe IP key — see remoteClientRateLimitKey.
 *
 * @param env - Environment to read the flag/overrides from (injectable for tests).
 * @returns An express middleware: a real limiter, or a pass-through when explicitly disabled.
 */
export function createRemoteClientRateLimiter(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const raw = (env[REMOTE_CLIENT_RATE_LIMIT_FLAG] ?? '').trim().toLowerCase();
  if (DISABLE_VALUES.has(raw)) {
    logger.warn(
      { flag: REMOTE_CLIENT_RATE_LIMIT_FLAG, value: raw },
      'remote-client per-caller rate limit DISABLED by operator — the worker plane is bounded only by the global per-IP limiter',
    );
    return passThrough;
  }

  const max = positiveNumber(env, `${REMOTE_CLIENT_RATE_LIMIT_FLAG}_MAX`, REMOTE_CLIENT_RATE_LIMIT_DEFAULT_MAX);
  const windowMs = positiveNumber(
    env,
    `${REMOTE_CLIENT_RATE_LIMIT_FLAG}_WINDOW_MS`,
    REMOTE_CLIENT_RATE_LIMIT_DEFAULT_WINDOW_MS,
  );

  const options: Partial<RateLimitOptions> = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Matches the existing global limiter: we do not rely on express-rate-limit's
    // proxy validation, because the key is the clientId, not the client address.
    validate: { trustProxy: false },
    keyGenerator: remoteClientRateLimitKey,
    message: { error: 'remote-client rate limit exceeded; slow down' },
  };

  logger.info({ limiter: 'remote_clients', max, windowMs }, 'remote-client per-caller rate limit enabled');
  return rateLimit(options);
}
