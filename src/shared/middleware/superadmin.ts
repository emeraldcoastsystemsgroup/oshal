/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Explicit super-admin role for the Developer Console (ADR-077). Double-gated + fail-closed + debuggable decision trace.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | isSuperAdminSub(sub) for QUEUE-side gating (ADR-081): dispatch has no Request, only ticket.ownerSub. Sub-allowlist-only by design — the console capability flag gates the browser console, not the oshal-dev workflow (the manifest's presence is that capability), and the email allowlist can't be checked without a session.
 */

import type { Request, Response, NextFunction } from 'express';
import { getCaller } from './authz';

/**
 * Super-admin is a DISTINCT, more privileged role than operator. Operator can manage
 * tenants/data; super-admin can reach the Developer Console (diagnose, and — in later
 * phases — edit + recover the platform). It is therefore gated TWICE and fail-closed:
 *
 *   1. The capability must be explicitly ENABLED on the deployment
 *      (OSHAL_DEV_CONSOLE_ENABLED=true). Unset ⇒ the console does not exist for anyone,
 *      so an enterprise install that never opts in is not exposed at all.
 *   2. The caller must be on the DEDICATED super-admin allowlist
 *      (OSHAL_SUPERADMIN_SUBS / OSHAL_SUPERADMIN_EMAILS). Empty ⇒ nobody qualifies.
 *
 * Being an operator does NOT grant super-admin — it is a separate, explicit list, so
 * broadening operator access can never silently widen who can touch platform internals.
 */
export interface SuperAdminChecks {
  /** OSHAL_DEV_CONSOLE_ENABLED is truthy — the capability is turned on for this deployment. */
  capabilityEnabled: boolean;
  /** The request carries a validated OIDC identity (a sub). */
  authenticated: boolean;
  /** The caller's sub or email is on the dedicated super-admin allowlist. */
  onAllowlist: boolean;
}

/** A fully-explained authorization decision — the debuggable core of the gate. */
export interface SuperAdminDecision {
  allowed: boolean;
  /** Human-readable reason for the outcome (safe to log AND to return to the caller). */
  reason: string;
  checks: SuperAdminChecks;
  /** The caller's sub (for server-side logs/audit); null when unauthenticated. */
  sub: string | null;
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

/**
 * @description Whether the Developer Console capability is enabled on this deployment.
 * Fail-closed: anything other than an explicit truthy value is treated as disabled.
 * @returns true only when OSHAL_DEV_CONSOLE_ENABLED is one of true/1/yes/on.
 */
export function superAdminEnabled(): boolean {
  return TRUTHY.has((process.env.OSHAL_DEV_CONSOLE_ENABLED ?? '').trim().toLowerCase());
}

function parseAllowlist(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * @description Evaluates the full super-admin decision for a request WITHOUT mutating
 * response state. Pure and side-effect free so it can back both the guard and a
 * caller-facing "am I a super-admin, and why/why not" endpoint.
 * @param req - The Express request (identity read only from the validated OIDC session).
 * @returns A complete, explained decision — never throws.
 */
export function evaluateSuperAdmin(req: Request): SuperAdminDecision {
  const capabilityEnabled = superAdminEnabled();
  const { sub, email } = getCaller(req);
  const authenticated = Boolean(sub);
  const subs = parseAllowlist(process.env.OSHAL_SUPERADMIN_SUBS);
  const emails = parseAllowlist(process.env.OSHAL_SUPERADMIN_EMAILS);
  const onAllowlist =
    (Boolean(sub) && subs.has(String(sub).toLowerCase())) || (Boolean(email) && emails.has(String(email)));

  const checks: SuperAdminChecks = { capabilityEnabled, authenticated, onAllowlist };
  const allowed = capabilityEnabled && authenticated && onAllowlist;

  return { allowed, reason: reasonFor(checks), checks, sub: sub ?? null };
}

/** Reports the FIRST failing gate (or success), so the reason is deterministic + debuggable. */
function reasonFor(checks: SuperAdminChecks): string {
  if (!checks.capabilityEnabled) {
    return 'Developer Console is disabled on this deployment (OSHAL_DEV_CONSOLE_ENABLED is not set).';
  }
  if (!checks.authenticated) {
    return 'Not authenticated.';
  }
  if (!checks.onAllowlist) {
    return 'Caller is not on the super-admin allowlist (OSHAL_SUPERADMIN_SUBS / OSHAL_SUPERADMIN_EMAILS).';
  }
  return 'Granted: caller is an enabled super-admin.';
}

/**
 * @description Boolean shortcut for the super-admin decision.
 * @param req - The Express request.
 * @returns true only when the capability is enabled AND the authenticated caller is allowlisted.
 */
export function isSuperAdmin(req: Request): boolean {
  return evaluateSuperAdmin(req).allowed;
}

/**
 * @description Sub-only super-admin check for contexts with no Request — the queue-side
 * gate on privileged ticket types (ADR-081: only an allowlisted owner's tickets may reach
 * the oshal-developer bot). Fail-closed: an empty allowlist or missing sub denies. This
 * deliberately does NOT require OSHAL_DEV_CONSOLE_ENABLED (that flag gates the browser
 * Developer Console; a privileged workflow's capability gate is its manifest being loaded)
 * and cannot consult OSHAL_SUPERADMIN_EMAILS (no session email exists on a ticket).
 * @param sub - The acting user's sub (e.g. ticket.ownerSub); null/undefined denies.
 * @returns true only when sub is on OSHAL_SUPERADMIN_SUBS.
 */
export function isSuperAdminSub(sub: string | null | undefined): boolean {
  if (!sub || !String(sub).trim()) return false;
  return parseAllowlist(process.env.OSHAL_SUPERADMIN_SUBS).has(String(sub).trim().toLowerCase());
}

/** A request that has passed (or been evaluated by) the super-admin gate. */
export type RequestWithSuperAdmin = Request & { superAdminDecision?: SuperAdminDecision };

/**
 * @description Pure Express guard for super-admin-only routes. Attaches the decision to
 * the request (for downstream handlers/audit), returns 403 with a safe reason when denied,
 * and calls next() only when allowed. Denials are NOT audited here (no DB handle) — use the
 * pool-bound guard in the routes layer when a persisted audit trail is required.
 * @param req - The Express request.
 * @param res - The Express response.
 * @param next - The next middleware.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const decision = evaluateSuperAdmin(req);
  (req as RequestWithSuperAdmin).superAdminDecision = decision;
  if (decision.allowed) {
    next();
    return;
  }
  res.status(403).json({ error: 'Super-admin privilege required', reason: decision.reason });
}
