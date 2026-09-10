/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148): the /api/swarm/roles surface behind the Users page. Every mutating route is operator-gated, and the ONE deliberately un-gated-by-requiresOperator route is the root claim — it has to be reachable by a signed-in caller while root is unclaimed, or a fresh LOCAL_AUTH box where OSHAL_OPERATOR_SUBS was never set could never establish an operator at all (the exact bootstrap deadlock this feature exists to end). That claim carries its own fail-closed conditions instead: authenticated caller, root genuinely unclaimed, and either the store is empty of roles or the caller already passes break-glass.
 */

import type { Router, Request, Response, RequestHandler } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator, isOperatorIdentity, isBreakGlassOnlyOperator } from '@/shared/middleware/authz';
import { getRootSub, privilegedIdentityStatus } from '@/shared/middleware/privileged-identities';
import {
  ensureSwarmRoleSchema, refreshPrivilegedCache,
  listRoles, getRole, getRootSubFromStore, claimRoot, grantRole, revokeRole, transferRoot,
  SwarmRoleError, type SwarmRole,
} from '@/features/swarm-roles';

const logger = createChildLogger({ module: 'swarm-roles-routes' });

/**
 * @description Boot step: create the role table if absent and load root/admin into the
 * synchronous privileged-identity cache that isOperatorIdentity reads.
 *
 * Deliberately NON-FATAL. A swarm whose role table cannot be reached must still start, because
 * the env break-glass allowlist is precisely the recovery path for that situation — refusing to
 * boot would turn a degraded role store into a total outage, with no way in to fix it.
 *
 * @param pool - Postgres pool.
 * @returns Resolves when roles are loaded, or when the failure has been logged.
 */
export async function initializeSwarmRoles(pool: Pool): Promise<void> {
  try {
    await ensureSwarmRoleSchema(pool);
    const count = await refreshPrivilegedCache(pool);
    const rootSub = await getRootSubFromStore(pool);
    if (!rootSub) {
      logger.warn('SWARM ROOT IS UNCLAIMED — no identity holds root yet. Operator access is currently break-glass only (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS). Claim root from the Users page to make it a managed role.');
    }
    logger.info({ privilegedCount: count, rootClaimed: Boolean(rootSub) }, 'swarm roles initialized');
  } catch (err) {
    logger.error({ err }, 'swarm role initialization FAILED — operator access falls back to the env break-glass allowlist');
  }
}

/** Maps a SwarmRoleError to its status; anything else is a 500 with no internals leaked. */
function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof SwarmRoleError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err, context }, 'swarm-roles route failed');
  res.status(500).json({ error: 'role operation failed' });
}

/**
 * @description Builds the swarm-role router.
 *
 * Route gating, and each choice is load-bearing:
 *  - `GET /me`       — any authenticated caller. Everyone may learn their OWN role; it is what
 *                      lets a surface say "you are not an admin" instead of rendering an empty
 *                      page that looks broken.
 *  - `GET /status`   — any authenticated caller. Reports whether root is claimed and whether the
 *                      caller's privilege is break-glass only. No identities are disclosed.
 *  - `POST /claim-root` — authenticated + the claim conditions below. NOT requiresOperator, by
 *                      design: on a fresh box nobody passes that gate yet.
 *  - everything else — requiresOperator (root or admin).
 *
 * @param pool - Postgres pool.
 * @param requiresAuth - the deployment's auth middleware, injected (never imported) so this
 *   module works identically under OIDC, LOCAL_AUTH and mock modes.
 * @returns The configured router.
 */
export function createSwarmRolesRoutes(pool: Pool, requiresAuth: RequestHandler): Router {
  const router = createRouter();

  router.get('/me', requiresAuth, async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    try {
      const row = sub ? await getRole(pool, sub) : null;
      res.json({
        sub,
        email,
        role: row?.role ?? 'user',
        isOperator: isOperatorIdentity(sub, email),
        breakGlassOnly: isBreakGlassOnlyOperator(sub, email),
        isRoot: Boolean(sub) && getRootSub() === sub,
      });
    } catch (err) { fail(res, err, 'GET /me'); }
  });

  router.get('/status', requiresAuth, async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    try {
      const rootSub = await getRootSubFromStore(pool);
      const cache = privilegedIdentityStatus();
      res.json({
        rootClaimed: Boolean(rootSub),
        // Only ever tells the CALLER about themselves — never who root is.
        callerIsRoot: Boolean(sub) && rootSub === sub,
        callerIsOperator: isOperatorIdentity(sub, email),
        callerBreakGlassOnly: isBreakGlassOnlyOperator(sub, email),
        rolesLoaded: cache.loaded,
        privilegedCount: cache.count,
      });
    } catch (err) { fail(res, err, 'GET /status'); }
  });

  router.get('/', requiresAuth, requiresOperator, async (_req: Request, res: Response) => {
    try {
      res.json({ roles: await listRoles(pool) });
    } catch (err) { fail(res, err, 'GET /'); }
  });

  /**
   * Claiming root. Reachable without requiresOperator ON PURPOSE — see the router JSDoc — so the
   * conditions here ARE the gate:
   *   1. the caller is authenticated (requiresAuth), and
   *   2. root is genuinely unclaimed, and
   *   3. either no roles exist at all (a virgin swarm — the first-run case), or the caller
   *      already passes the env break-glass allowlist (an existing box adopting roles).
   * Condition 3 is what stops a later invited user on an established swarm from walking up and
   * claiming root because the incumbent never got around to it.
   */
  router.post('/claim-root', requiresAuth, async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'sign in to claim swarm root' }); return; }
    try {
      const existingRoles = await listRoles(pool);
      const virginSwarm = existingRoles.length === 0;
      if (!virginSwarm && !isOperatorIdentity(sub, email)) {
        logger.warn({ sub }, 'root claim REFUSED — swarm already has roles and caller is not privileged');
        res.status(403).json({
          error: 'swarm root can only be claimed on a swarm with no roles yet, or by an existing operator',
        });
        return;
      }
      const row = await claimRoot(pool, {
        userSub: sub,
        email,
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : null,
        note: virginSwarm ? 'claimed at first run' : 'claimed by break-glass operator',
      });
      logger.warn({ sub, virginSwarm }, 'swarm root claimed');
      res.status(201).json({ root: row });
    } catch (err) { fail(res, err, 'POST /claim-root'); }
  });

  router.post('/', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const caller = getCaller(req);
    const userSub = typeof req.body?.userSub === 'string' ? req.body.userSub.trim() : '';
    const role = String(req.body?.role ?? '') as SwarmRole;
    try {
      const row = await grantRole(pool, {
        userSub,
        email: typeof req.body?.email === 'string' ? req.body.email : null,
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : null,
        role,
        grantedBySub: caller.sub,
        note: typeof req.body?.note === 'string' ? req.body.note : null,
      });
      res.status(201).json({ role: row });
    } catch (err) { fail(res, err, 'POST /'); }
  });

  router.delete('/:userSub', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const caller = getCaller(req);
    try {
      const removed = await revokeRole(pool, String(req.params.userSub), caller.sub);
      res.json({ removed });
    } catch (err) { fail(res, err, 'DELETE /:userSub'); }
  });

  /** Transferring root is ROOT-ONLY — an admin must not be able to hand the swarm to themselves. */
  router.post('/transfer-root', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const caller = getCaller(req);
    try {
      const currentRoot = await getRootSubFromStore(pool);
      if (!currentRoot || currentRoot !== caller.sub) {
        res.status(403).json({ error: 'only the current swarm root may transfer root' });
        return;
      }
      const row = await transferRoot(pool, {
        toSub: typeof req.body?.toSub === 'string' ? req.body.toSub.trim() : '',
        toEmail: typeof req.body?.toEmail === 'string' ? req.body.toEmail : null,
        toDisplayName: typeof req.body?.toDisplayName === 'string' ? req.body.toDisplayName : null,
        bySub: caller.sub,
      });
      res.json({ root: row });
    } catch (err) { fail(res, err, 'POST /transfer-root'); }
  });

  return router;
}
