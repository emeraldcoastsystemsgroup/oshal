/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | One read-only join over the three authorization axes. Swarm administration (ADR-148), governance permissions and per-application assignments (ADR-149) each answered correctly in isolation, so "why can't I open this?" cost three surfaces and an environment file. This joins them for one identity and names the source of every grant. It reads the existing stores only: no new grant path, no write, no decision of its own.
 */

/**
 * GET /api/access-review — the joined answer to "what am I allowed to do".
 *
 * The three axes STAY separate authorities — folding per-app access into swarm administration
 * would make "may use the photo app" and "may administer the swarm" one decision. This route
 * joins their ANSWERS for a single identity and nothing more:
 *
 *   - swarm role + provenance  <- features/governance (swarm_roles, IdP claims, break-glass .env)
 *   - governance permissions   <- ROLE_PERMISSIONS for the resolved role
 *   - per-app standing         <- the ADR-149 authorization authority, one effective() per app
 *
 * Any authenticated caller may read their own. Only an admin may name another subject, and that
 * read still runs through the authorization service's own management checks — this route grants
 * nothing it could not already read.
 *
 * @module app/routes/access-review-routes
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import {
  callerFromRequest,
  resolveSwarmRoleGrant,
  isEnforcementEnabled,
  ROLE_PERMISSIONS,
  Role,
  type GrantSource,
  type SwarmRoleGrant,
} from '@/features/governance';
import type { AuthorizationActor, AuthorizationEffective } from '@/shared/application-authorization';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'access-review-routes' });

/** The longest subject/issuer identifier the authorization authority itself accepts. */
const MAX_IDENTIFIER_BYTES = 512;

/** The read-only slice of the ADR-149 authority this view needs. No write member is reachable. */
export interface AccessReviewAuthority {
  /** Names of every registered application, so a DENIED app is visible too. */
  listApps(): string[];
  /** The subject's standing on one application, under the authority's own management checks. */
  effective(
    actor: AuthorizationActor,
    target: { app: string; targetSub?: string; targetIssuer?: string },
  ): Promise<AuthorizationEffective>;
}

/** Registration dependencies. `authority` is optional so the view degrades instead of 500ing. */
export interface AccessReviewRouteOptions {
  requiresAuth: RequestHandler;
  /** Authentication composition resolves this afresh; a request body never constructs an actor. */
  resolveActor(request: Request): Promise<AuthorizationActor>;
  authority?: AccessReviewAuthority;
}

/** One application row in the joined answer. */
export interface AccessReviewApp {
  app: string;
  tier: AuthorizationEffective['tier'];
  status: AuthorizationEffective['status'];
  denied: boolean;
  roles: string[];
  grants: string[];
  managementRoles: string[];
  /**
   * Why the subject stands where they do: `app-assignment` when an assignment names a role for
   * them, `app-default` when the application's own default tier carries them, `none` when nothing
   * grants them access.
   */
  source: Extract<GrantSource, 'app-assignment' | 'none'> | 'app-default';
}

/** The joined answer for one identity. */
export interface AccessReview {
  subject: { sub: string; issuer: string; email: string | null; self: boolean };
  canChooseSubject: boolean;
  swarm: SwarmRoleGrant & { enforcement: boolean };
  permissions: string[];
  apps: AccessReviewApp[];
  /** Applications whose standing this caller may not read for this subject, with the refusal code. */
  unreadable: Array<{ app: string; reason: string }>;
  /** False when no authorization authority is wired; the app axis is unknown, not empty. */
  appsAvailable: boolean;
  generatedAt: string;
}

/** @description Read one bounded identifier from the query string.
 * @param value - The raw query value. @returns The trimmed identifier, or '' when absent.
 */
function identifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** @description Reject identifiers the authorization authority would itself refuse.
 * @param value - A trimmed identifier. @returns True when the value is safe to look up.
 */
function validIdentifier(value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES) return false;
  // No control characters: the authority itself refuses them, and this view must not be the one
  // place a terminal escape reaches an operator's screen.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** @description Name why a subject stands where they do on one application.
 * @param effective - The authority's own answer for this subject and application.
 * @returns The provenance label for this application row.
 */
function appSource(effective: AuthorizationEffective): AccessReviewApp['source'] {
  if (effective.roles.length > 0) return 'app-assignment';
  // tier 'deny' without an explicit deny row is the same lived fact as denied: nothing carries
  // this subject into the application. Reporting it as a default would read as a grant.
  if (effective.denied || effective.tier === 'deny') return 'none';
  return 'app-default';
}

/** @description The refusal code an authority error carries, without leaking a stack.
 * @param error - Anything the authority threw. @returns A short, stable reason code.
 */
function refusal(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'authorization_unavailable';
}

/** @description Ask the authority for the subject's standing on every registered application.
 * Each application is asked separately and under the authority's own management checks, so a
 * caller who may not read one application loses that row and nothing else.
 *
 * @param authority - The read-only authorization slice.
 * @param actor - The verified calling identity.
 * @param target - The subject to report on, or undefined for the caller themselves.
 * @returns The readable application rows and the refusals, both sorted by application name.
 */
async function reviewApps(
  authority: AccessReviewAuthority,
  actor: AuthorizationActor,
  target: { targetSub: string; targetIssuer: string } | undefined,
): Promise<Pick<AccessReview, 'apps' | 'unreadable'>> {
  const apps: AccessReviewApp[] = [];
  const unreadable: AccessReview['unreadable'] = [];
  for (const app of [...authority.listApps()].sort()) {
    try {
      const effective = await authority.effective(actor, { app, ...(target ?? {}) });
      apps.push({
        app: effective.app,
        tier: effective.tier,
        status: effective.status,
        denied: effective.denied,
        roles: [...effective.roles].sort(),
        grants: [...new Set(effective.permissions.map((grant) => grant.permission))].sort(),
        managementRoles: [...(effective.managementRoles ?? [])].sort(),
        source: appSource(effective),
      });
    } catch (error) {
      unreadable.push({ app, reason: refusal(error) });
    }
  }
  return { apps, unreadable };
}

/**
 * @description Mount the joined, read-only access review.
 *
 * @param options - Auth middleware, the actor resolver, and the optional authorization authority.
 * @returns A router exposing GET / (self, or `?sub=&issuer=` for an admin).
 */
export function createAccessReviewRoutes(options: AccessReviewRouteOptions): Router {
  const router = Router();
  router.use(options.requiresAuth);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  router.get('/', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const requestedSub = identifier(req.query.sub);
    const requestedIssuer = identifier(req.query.issuer);
    logger.info({ subjectRequested: requestedSub.length > 0 }, 'Access review requested');
    if (!validIdentifier(requestedSub) || !validIdentifier(requestedIssuer)) {
      res.status(400).json({ error: 'invalid_access_review_subject' });
      return;
    }

    let actor: AuthorizationActor;
    try {
      actor = await options.resolveActor(req);
    } catch (error) {
      logger.error({ err: error }, 'Access review identity could not be resolved');
      res.status(401).json({ error: 'access_review_identity_required' });
      return;
    }

    const caller = callerFromRequest(req);
    const callerGrant = resolveSwarmRoleGrant(caller);
    const isAdmin = callerGrant.role === Role.Admin;
    const self = requestedSub.length === 0
      || (requestedSub === actor.sub && (requestedIssuer.length === 0 || requestedIssuer === actor.issuer));
    if (!self && !isAdmin) {
      logger.warn({ durationMs: Date.now() - startedAt }, 'Access review refused: subject review is admin-only');
      res.status(403).json({ error: 'access_review_subject_denied' });
      return;
    }

    const subject = self
      ? { sub: actor.sub, issuer: actor.issuer, email: caller.email }
      : { sub: requestedSub, issuer: requestedIssuer || actor.issuer, email: null };
    // Another subject is described from their SUBJECT IDENTIFIER alone. They have no session here,
    // so no IdP claim and no email is available, and `emailEvaluated: false` says so rather than
    // letting the surface imply an email-only break-glass entry was checked and found absent.
    const swarm = self ? callerGrant : resolveSwarmRoleGrant({ sub: subject.sub, email: null, roles: [] });

    try {
      const { apps, unreadable } = options.authority
        ? await reviewApps(options.authority, actor, self ? undefined : { targetSub: subject.sub, targetIssuer: subject.issuer })
        : { apps: [], unreadable: [] as AccessReview['unreadable'] };
      const review: AccessReview = {
        subject: { ...subject, self },
        canChooseSubject: isAdmin,
        swarm: { ...swarm, enforcement: isEnforcementEnabled() },
        permissions: [...(ROLE_PERMISSIONS[swarm.role] ?? [])],
        apps,
        unreadable,
        appsAvailable: Boolean(options.authority),
        generatedAt: new Date().toISOString(),
      };
      logger.info({ durationMs: Date.now() - startedAt, apps: apps.length, unreadable: unreadable.length, self },
        'Access review completed');
      res.json(review);
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'Access review failed');
      res.status(500).json({ error: 'access_review_unavailable' });
    }
  });

  return router;
}
