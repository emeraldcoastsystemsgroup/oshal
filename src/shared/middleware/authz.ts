/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | New shared authorization helpers to close object-level authorization (IDOR) gaps. Provides caller-identity extraction from the OIDC session, an operator (admin) allowlist (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS), and per-resource ownership checks. Object-level handlers must call canAccessResource() and return 404 on failure so resource ids are not oracle-able. Operator-only listing/override routes use requireOperator().
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | requiresOperator: middleware-shaped operator gate for whole mounts (requireOperator is handler-shaped and can't be listed in app.use). First consumer: /api/security — the Security Center exposes the platform's own weak points and redacted secret previews, so it must never be reachable by basic users.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added requireServiceSecret for privileged machine-only control planes. Unlike the compatibility-only requireServiceSecretWhenConfigured helper, the strict gate fails closed when SWARM_SERVICE_SECRET is absent and never falls back to a human session.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Preserve OIDC subjects as exact case-sensitive identifiers in operator checks, and add a canonical base64url trusted-service subject header so whitespace/case survive HTTP transport without aliasing. Legacy plain headers remain readable during rollout but are never normalized.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Expose an independently authenticated user predicate so legacy service credentials can never override an established browser or PAT principal on user-scoped routes.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';

/** Identity of the authenticated caller, derived ONLY from the validated OIDC session. */
export interface CallerIdentity {
  sub: string | null;
  email: string | null;
}

interface OidcUserShape {
  sub?: string;
  email?: string;
  preferred_username?: string;
}

interface AuthenticatedOidcShape {
  isAuthenticated?: () => boolean;
  user?: OidcUserShape;
}

/**
 * @description Extracts the caller's identity from the validated OIDC session.
 * Never trusts request body/query for identity — only req.oidc.user (set by the
 * OIDC middleware or the mock injector). Returns nulls when unauthenticated.
 */
export function getCaller(req: Request): CallerIdentity {
  const user = (req as { oidc?: { user?: OidcUserShape } }).oidc?.user;
  const sub = user?.sub ? String(user.sub) : null;
  const rawEmail = user?.email || user?.preferred_username || '';
  const email = rawEmail ? String(rawEmail).toLowerCase() : null;
  return { sub, email };
}

/**
 * @description Confirms that the request already carries an independently authenticated user
 * principal established by the OIDC, PAT, TV-token, local-auth, or guest middleware. A populated
 * `user` object alone is insufficient: the owning authentication rail must also report success.
 * This predicate lets compatibility machine credentials defer to a real user instead of
 * replacing that user's request identity with an attacker-controlled forwarded subject.
 * @param req - Express request after the global user-authentication middleware.
 * @returns True only for an authenticated request with a non-empty exact subject.
 */
export function hasAuthenticatedUserIdentity(req: Request): boolean {
  const oidc = (req as { oidc?: AuthenticatedOidcShape }).oidc;
  if (oidc?.isAuthenticated?.() !== true) return false;
  return typeof oidc.user?.sub === 'string' && oidc.user.sub.length > 0;
}

function parseSubjectAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function parseEmailAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * @description Operator (admin) check. There is no IdP role claim wired into this
 * deployment, so operator status is an explicit env allowlist matched against the
 * caller's OIDC sub or email. FAIL-CLOSED: an empty allowlist means there are no
 * operators, so operator-gated views simply scope to the caller instead of leaking
 * everyone's data. Configure OSHAL_OPERATOR_EMAILS (comma-separated) to grant it.
 */
export function isOperator(req: Request): boolean {
  const { sub, email } = getCaller(req);
  return isOperatorIdentity(sub, email);
}

/**
 * @description Same operator allowlist as {@link isOperator}, but for code paths that hold only an
 * identity — services and background work with no Express `Request` (e.g. deciding whether a
 * credential import may propagate swarm-wide). Same fail-closed semantics: an empty allowlist means
 * nobody is an operator.
 * @param sub - the caller's OIDC sub, when known
 * @param email - the caller's email, when known
 * @returns true when the identity is on the operator allowlist
 */
export function isOperatorIdentity(sub?: string | null, email?: string | null): boolean {
  const subs = parseSubjectAllowlist(process.env.OSHAL_OPERATOR_SUBS);
  const emails = parseEmailAllowlist(process.env.OSHAL_OPERATOR_EMAILS);
  if (typeof sub === 'string' && sub.length > 0 && subs.has(sub)) return true;
  if (typeof email === 'string' && email.length > 0 && emails.has(email.toLowerCase())) return true;
  return false;
}

/**
 * @description Object-level authorization: may the caller read/mutate a resource
 * owned by `ownerSub`? Allowed when the caller IS the owner, OR is an operator, OR
 * the resource is unowned AND legacy-unowned access is explicitly permitted. The
 * legacy branch is a backfill compatibility switch (default OFF) so new deployments
 * fail closed on the "null owner = anyone" gap. Set OSHAL_ALLOW_LEGACY_UNOWNED=true
 * only while reconciling old local data.
 */
export function canAccessResource(req: Request, ownerSub: string | null | undefined): boolean {
  const { sub } = getCaller(req);
  if (ownerSub && sub && ownerSub === sub) return true;
  if (isOperator(req)) return true;
  if (!ownerSub) {
    return (process.env.OSHAL_ALLOW_LEGACY_UNOWNED ?? 'false').toLowerCase() === 'true';
  }
  return false;
}

/**
 * @description Guard for operator-only routes. Sends 403 and returns false when the
 * caller is not an operator; returns true otherwise. Caller should `return` on false.
 */
export function requireOperator(req: Request, res: Response): boolean {
  if (isOperator(req)) return true;
  res.status(403).json({ error: 'Operator privilege required' });
  return false;
}

/**
 * @description Express-middleware form of the operator gate, for gating a WHOLE mount
 * (`app.use('/api/x', requiresAuth, requiresOperator, routes)`) instead of a single
 * handler. Same fail-closed allowlist as isOperator: an empty OSHAL_OPERATOR_SUBS /
 * OSHAL_OPERATOR_EMAILS means nobody passes. Denies with 403 and never calls next()
 * for non-operators — mount it AFTER requiresAuth so unauthenticated callers still
 * get the normal OIDC 401/redirect rather than a bare 403.
 * @param req - The Express request (identity read from the validated OIDC session).
 * @param res - The Express response.
 * @param next - The next middleware; called only for operators.
 */
export function requiresOperator(req: Request, res: Response, next: NextFunction): void {
  if (isOperator(req)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Operator privilege required' });
}

/**
 * @description True when an internal service call presents the configured shared
 * secret. Service-secret calls are trusted system traffic for RLS request
 * identity stamping, but only when SWARM_SERVICE_SECRET is configured.
 */
export function hasValidServiceSecret(req: Request): boolean {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  const provided = String(req.headers['x-service-secret'] || '').trim();
  return (
    secret.length > 0 &&
    provided.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
  );
}

const MAX_TRUSTED_USER_SUB_BYTES = 512;
const MAX_TRUSTED_USER_SUB_ENCODED_CHARS = Math.ceil(MAX_TRUSTED_USER_SUB_BYTES * 4 / 3);

/**
 * @description Resolves the user identity stamped by a trusted internal service
 * call. Prefers canonical `X-Oshal-User-Sub-B64`; a present malformed encoded header
 * fails closed without consulting the constrained legacy plain header. External callers
 * cannot use this because the identity header is honored only when
 * SWARM_SERVICE_SECRET is configured and the request presents the matching
 * X-Service-Secret value.
 */
export function getTrustedServiceUserSub(req: Request): string | null {
  if (!hasValidServiceSecret(req)) return null;
  const encoded = req.headers['x-oshal-user-sub-b64'];
  if (encoded !== undefined) return decodeTrustedServiceUserSub(encoded);

  // Rollout compatibility for callers that have not adopted the encoded header yet. Never trim
  // or lowercase here: `sub` is a case-sensitive identity, not display text. New kernel callers
  // use trustedServiceUserHeaders(), which is unambiguous even when the subject has HTTP OWS.
  const legacy = req.headers['x-oshal-user-sub'];
  if (typeof legacy !== 'string' || legacy.length === 0 || legacy !== legacy.trim()) return null;
  const bytes = Buffer.from(legacy, 'utf8');
  return bytes.length <= MAX_TRUSTED_USER_SUB_BYTES && bytes.toString('utf8') === legacy ? legacy : null;
}

function decodeTrustedServiceUserSub(value: string | string[]): string | null {
  if (typeof value !== 'string'
    || value.length > MAX_TRUSTED_USER_SUB_ENCODED_CHARS
    || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length === 0 || bytes.length > MAX_TRUSTED_USER_SUB_BYTES) return null;
    if (bytes.toString('base64url') !== value) return null;
    const sub = bytes.toString('utf8');
    return Buffer.from(sub, 'utf8').equals(bytes) ? sub : null;
  } catch {
    return null;
  }
}

function encodeTrustedServiceUserSub(userSub: string): string {
  if (typeof userSub !== 'string' || userSub.length === 0) {
    throw new TypeError('trusted service userSub must be a non-empty string');
  }
  const bytes = Buffer.from(userSub, 'utf8');
  if (bytes.length > MAX_TRUSTED_USER_SUB_BYTES || bytes.toString('utf8') !== userSub) {
    throw new RangeError(`trusted service userSub must be valid UTF-8 up to ${MAX_TRUSTED_USER_SUB_BYTES} bytes`);
  }
  return bytes.toString('base64url');
}

/**
 * @description Builds the outbound header used by internal controller/bot-node calls.
 * Returns an empty object when no secret is configured so callers stay fail-closed:
 * serviceSecretOr() will fall through to normal auth instead of creating a partial bypass.
 */
export function serviceSecretHeaders(): Record<string, string> {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  return secret ? { 'X-Service-Secret': secret } : {};
}

/**
 * @description Builds authenticated internal-service headers carrying an exact user subject.
 * The subject is UTF-8/base64url encoded so HTTP optional whitespace and header parsing cannot
 * trim or reinterpret it. Returns an empty object when the service secret is unconfigured, matching
 * {@link serviceSecretHeaders}; invalid or oversized subjects throw instead of being truncated.
 * @param userSub - Exact, case-sensitive OIDC subject to bind to the machine request.
 * @returns Service-secret plus canonical encoded-sub headers, or an empty object when disabled.
 */
export function trustedServiceUserHeaders(userSub: string): Record<string, string> {
  const encoded = encodeTrustedServiceUserSub(userSub);
  const auth = serviceSecretHeaders();
  if (!auth['X-Service-Secret']) return {};
  return { ...auth, 'X-Oshal-User-Sub-B64': encoded };
}

/**
 * @description Middleware wrapper that allows an internal service call carrying a valid
 * `X-Service-Secret` header (matching SWARM_SERVICE_SECRET, constant-time compared) to pass,
 * and otherwise delegates to `fallback` (normally the OIDC `requiresAuth`). This is how internal
 * bots authenticate to the controller (e.g. POST /api/tools/register) without an OIDC session —
 * the same session-OR-shared-secret pattern used for remote clients. External callers, having no
 * secret, still go through the normal auth wall. No secret configured => always falls through to
 * `fallback` (fail-safe: the bypass simply doesn't exist).
 */
export function serviceSecretOr(fallback: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasValidServiceSecret(req)) {
      next();
      return;
    }
    fallback(req, res, next);
  };
}

/**
 * @description Strict machine-to-machine authorization for privileged control planes.
 * A configured, matching `X-Service-Secret` is always required: an absent deployment
 * secret returns 503 (the control plane is not safely configured), and a missing or
 * incorrect caller secret returns 401. There is deliberately no OIDC fallback because
 * callers of this middleware are controller/node protocols rather than user surfaces.
 *
 * @param req - Express request carrying the machine credential.
 * @param res - Express response used for a generic fail-closed result.
 * @param next - Next middleware, called only after an exact constant-time match.
 */
export function requireServiceSecret(req: Request, res: Response, next: NextFunction): void {
  const configured = String(process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!configured) {
    res.status(503).json({ success: false, error: 'Service unavailable' });
    return;
  }
  if (!hasValidServiceSecret(req)) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * @description Optional service-secret gate for INTERNAL-ONLY endpoints that have no OIDC
 * session to fall back to (e.g. the bot-node's `/api/swarm-execute`). Enforces
 * `SWARM_SERVICE_SECRET` ONLY when it is configured: a valid `X-Service-Secret` header passes,
 * anything else is 401. When the secret is unset it is a NO-OP (fail-open) so it can be rolled
 * out across the fleet without breaking existing controller→bot dispatch. Differs from
 * `serviceSecretOr`, which always requires the secret OR a fallback auth; this one has no
 * fallback and simply opens when unconfigured. Pair the caller with `serviceSecretHeaders()`.
 * @param req - Express request.
 * @param res - Express response.
 * @param next - Next middleware; called when the secret is unset or valid.
 */
export function requireServiceSecretWhenConfigured(req: Request, res: Response, next: NextFunction): void {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  if (!secret) { next(); return; }               // not configured → no-op (fail-open)
  if (hasValidServiceSecret(req)) { next(); return; }
  res.status(401).json({ success: false, error: 'Unauthorized' });
}
