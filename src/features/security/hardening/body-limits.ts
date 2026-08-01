/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the global JSON body parser as ONE testable unit (docs/security/SECURITY-HARDENING.md §4 "express.json({ limit })"). server.ts previously inlined `express.json()` with its implicit 100kb default and a hand-written path-reservation ternary, so the limit was real but unstated and unprovable. createGlobalJsonParser owns both: an explicit, env-tunable limit and the reserved-prefix list, exported so the guard spec drives the exact middleware the server mounts.
 */

/**
 * Global JSON body-parser policy for the control plane.
 *
 * WHY EXPLICIT. `express.json()` defaults to a 100kb limit and answers 413 past it, so the
 * control plane was never actually unbounded. But an implicit default is a control nobody can
 * point at, nobody tuned per deployment, and nobody tested — which is how the hardening
 * backlog came to list `express.json({ limit })` as open. Stating it here makes the value
 * reviewable, tunable without a code edit (`OSHAL_JSON_BODY_LIMIT`), and testable.
 *
 * WHY SOME PATHS ARE RESERVED. Three mounts legitimately need something other than the tight
 * global limit and install their own parser at their own mount:
 *   - `/api/remote-clients` — a node's task-complete body carries a screen capture (~1-2MB PNG);
 *   - `/api/vision`         — base64 images for the describe/read-doc calls;
 *   - `/api/hooks`          — signed connector webhooks must keep the EXACT request bytes until
 *                             their route-local HMAC verifier has run, so nothing may parse first.
 * Reserving them here (rather than raising the global limit) is what keeps every other route on
 * the tight bound.
 *
 * @module features/security/hardening/body-limits
 */

import express, { type RequestHandler } from 'express';

/** The tight default. Matches express.json()'s own historical default, so nothing loosens. */
export const DEFAULT_JSON_BODY_LIMIT = '100kb';

/**
 * Mount prefixes that install their own body parser and must NOT be pre-parsed by the global
 * one. Order is irrelevant; matching is by path prefix, exactly as the server did inline.
 */
export const RESERVED_BODY_PARSER_PREFIXES: readonly string[] = [
  '/api/remote-clients',
  '/api/vision',
  '/api/hooks',
];

/**
 * @description Resolves the global JSON body limit. Any non-empty `OSHAL_JSON_BODY_LIMIT`
 * wins (byte counts or a size string like '256kb' — whatever body-parser's `bytes` accepts);
 * absent/blank falls back to the tight default. A deployment that needs a larger surface tunes
 * this rather than editing the reserved-prefix list.
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns The limit to hand express.json().
 */
export function jsonBodyLimit(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.OSHAL_JSON_BODY_LIMIT ?? '').trim();
  return raw.length > 0 ? raw : DEFAULT_JSON_BODY_LIMIT;
}

/**
 * @description True when a request path belongs to a mount that owns its own body parser.
 * @param path - Request path (`req.path`).
 * @returns True when the global parser must skip this request.
 */
export function isReservedBodyParserPath(path: string): boolean {
  const value = String(path ?? '');
  return RESERVED_BODY_PARSER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * @description Builds the global JSON body parser the control plane mounts: an explicit,
 * env-tunable limit applied to every route EXCEPT the reserved prefixes above. Oversized
 * bodies get body-parser's 413 `entity.too.large`, which is the enforcement — there is no
 * separate check to keep in sync.
 * @param env - Environment map (process.env by default; injectable for tests).
 * @returns The middleware to `app.use()` once, early.
 */
export function createGlobalJsonParser(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const parser = express.json({ limit: jsonBodyLimit(env) });
  return (req, res, next) => (isReservedBodyParserPath(req.path) ? next() : parser(req, res, next));
}
