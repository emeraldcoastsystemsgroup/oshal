/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Swarm root (ADR-148): the /api/swarm/roles surface behind the Users page. Every mutating route is operator-gated, and the ONE deliberately un-gated-by-requiresOperator route is the root claim — it has to be reachable by a signed-in caller while root is unclaimed, or a fresh LOCAL_AUTH box where OSHAL_OPERATOR_SUBS was never set could never establish an operator at all (the exact bootstrap deadlock this feature exists to end). That claim carries its own fail-closed conditions instead: authenticated caller, root genuinely unclaimed, and either the store is empty of roles or the caller already passes break-glass.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Remove empty-table public root election; retain authenticated existing-operator recovery.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | AUTH-03: POST /installer-root completes an identity-provider installation's first root from the local installer's one-use proof, bound to one exact issuer and subject and presented from the bound origin by that verified session; mock sign-in is refused. /status also tells the caller their own verified issuer and subject, the two values the installer binds.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | ADR-174 Amendment A: /me, /status and /claim-root check the caller with the issuer isOperator binds to (authz operatorRequestIssuer), so a local principal, or one whose request carries no verified issuer, whose unverified email is on OSHAL_OPERATOR_EMAILS or a role row is reported, and admitted to the recovery claim, exactly as isOperator decides; and the root row such a caller claims stores no email, so the typed address never becomes a key for another issuer's principal. initializeSwarmRoles retries a failed boot-time load a bounded number of times (about a minute), because the admin console admits only the break-glass allowlist until the first successful load.
 */

import type { Router, Request, Response, RequestHandler } from 'express';
import { Router as createRouter } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator, isOperatorIdentity, isBreakGlassOnlyOperator, operatorRequestIssuer } from '@/shared/middleware/authz';
import { getRootSub, privilegedIdentityStatus } from '@/shared/middleware/privileged-identities';
import { getAuthenticatedPrincipalIssuer, isMockOidcEnabled, LOCAL_AUTH_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { completeOidcInstallerRootSetup } from '@/app/composition/installer-root-bootstrap';
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
 * boot would turn a degraded role store into a total outage, with no way in to fix it. A failed
 * load is retried a bounded number of times (about a minute in all), because until the first
 * successful load the admin console admits only the break-glass allowlist (ADR-174 Amendment A),
 * and a transient database hiccup at boot must not become a lockout that lasts until a restart.
 *
 * @param pool - Postgres pool.
 * @param options - Retry delays and the sleep to use between attempts (tests pass zeros and a no-op).
 * @returns Resolves when roles are loaded, or when the last failure has been logged.
 */
export async function initializeSwarmRoles(
  pool: Pool,
  options: { retryDelaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const delays = options.retryDelaysMs ?? ROLE_LOAD_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await ensureSwarmRoleSchema(pool);
      const count = await refreshPrivilegedCache(pool);
      const rootSub = await getRootSubFromStore(pool);
      if (!rootSub) {
        logger.warn('SWARM ROOT IS UNCLAIMED — no identity holds root yet. Operator access is currently break-glass only (OSHAL_OPERATOR_SUBS / OSHAL_OPERATOR_EMAILS). Claim root from the Users page to make it a managed role.');
      }
      logger.info({ privilegedCount: count, rootClaimed: Boolean(rootSub), attempt: attempt + 1 }, 'swarm roles initialized');
      return;
    } catch (err) {
      if (attempt >= delays.length) {
        logger.error({ err, attempts: attempt + 1 }, 'swarm role initialization FAILED — operator access falls back to the env break-glass allowlist, and the admin console stays restricted to it until the api restarts');
        return;
      }
      logger.warn({ err, attempt: attempt + 1, retryInMs: delays[attempt] }, 'swarm role initialization failed — retrying; operator access is break-glass only until roles load');
      await sleep(delays[attempt]);
    }
  }
}

/** Delays between boot-time role-load attempts: six tries over about a minute. */
const ROLE_LOAD_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 32_000];

/** Maps a SwarmRoleError to its status; anything else is a 500 with no internals leaked. */
function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof SwarmRoleError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error({ err, context }, 'swarm-roles route failed');
  res.status(500).json({ error: 'role operation failed' });
}

/** Maps an installer ceremony refusal (status 4xx) to its response; anything else is a logged 500. */
function failInstaller(res: Response, err: unknown): void {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: (err as Error).message });
    return;
  }
  logger.error({ err }, 'installer root election failed');
  res.status(500).json({ error: 'root setup failed' });
}

/**
 * @description POST /installer-root handler: the verified session identity presents the proof the local installer
 * bound to it. The origin must be this server's own and the request same-site, like the local-account ceremony.
 * @param pool - Postgres pool. @returns Express handler.
 */
function installerRootHandler(pool: Pool): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    const origin = req.get('origin');
    if (!origin || origin !== `${req.protocol}://${req.get('host')}` || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: 'installer setup requires the original browser origin' }); return;
    }
    if (isMockOidcEnabled()) { res.status(403).json({ error: 'mock sign-in cannot establish swarm root' }); return; }
    const issuer = getAuthenticatedPrincipalIssuer(req);
    const { sub, email } = getCaller(req);
    if (!issuer || !sub) { res.status(401).json({ error: 'sign in with the identity the installer bound' }); return; }
    try {
      await completeOidcInstallerRootSetup(pool, { token: String(req.body?.setupToken ?? ''), origin, issuer, subject: sub, email,
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : null });
      res.status(201).json({ rootClaimed: true, callerIsRoot: true });
    } catch (err) { failInstaller(res, err); }
  };
}

/**
 * @description Builds the swarm-role router.
 *
 * Route gating, and each choice is load-bearing:
 *  - `GET /me`       — any authenticated caller. Everyone may learn their OWN role; it is what
 *                      lets a surface say "you are not an admin" instead of rendering an empty
 *                      page that looks broken.
 *  - `GET /status`   — any authenticated caller. Reports whether root is claimed and whether the
 *                      caller's privilege is break-glass only, plus the caller's OWN verified issuer and subject.
 *                      No other identity is disclosed.
 *  - `POST /claim-root` — authenticated existing operator recovery. Fresh local installation
 *                      uses the separately proof-bound account/root ceremony.
 *  - `POST /installer-root` — authenticated; the local installer's one-use proof bound to the
 *                      caller's exact identity-provider issuer and subject. Never an empty-table election.
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
    const issuer = operatorRequestIssuer(req);
    try {
      const row = sub ? await getRole(pool, sub) : null;
      res.json({
        sub,
        email,
        role: row?.role ?? 'user',
        isOperator: isOperatorIdentity(sub, email, issuer),
        breakGlassOnly: isBreakGlassOnlyOperator(sub, email, issuer),
        isRoot: Boolean(sub) && getRootSub() === sub,
      });
    } catch (err) { fail(res, err, 'GET /me'); }
  });

  router.get('/status', requiresAuth, async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    const issuer = operatorRequestIssuer(req);
    try {
      const rootSub = await getRootSubFromStore(pool);
      const cache = privilegedIdentityStatus();
      res.json({
        rootClaimed: Boolean(rootSub),
        // Only ever tells the CALLER about themselves — never who root is.
        callerIsRoot: Boolean(sub) && rootSub === sub,
        // The caller's OWN verified identity: the exact issuer and subject an installer binds a setup proof to.
        callerSub: sub ?? null,
        callerIssuer: getAuthenticatedPrincipalIssuer(req),
        callerIsOperator: isOperatorIdentity(sub, email, issuer),
        callerBreakGlassOnly: isBreakGlassOnlyOperator(sub, email, issuer),
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
   * Recovery requires an authenticated existing operator and genuinely unclaimed root.
   * An empty role table is not installer authority and never elects the first public caller.
   */
  router.post('/claim-root', requiresAuth, async (req: Request, res: Response) => {
    const { sub, email } = getCaller(req);
    if (!sub) { res.status(401).json({ error: 'sign in to claim swarm root' }); return; }
    const issuer = operatorRequestIssuer(req);
    try {
      if (!isOperatorIdentity(sub, email, issuer)) {
        logger.warn({ sub }, 'root claim REFUSED — installer proof or existing operator is required');
        res.status(403).json({
          error: 'root claim requires an existing operator; use the local installer setup for a fresh installation',
        });
        return;
      }
      const row = await claimRoot(pool, {
        userSub: sub,
        // A local or issuer-less caller's email was never verified: the row binds it by subject (operatorMatchKeys).
        email: issuer === null || issuer === LOCAL_AUTH_PRINCIPAL_ISSUER ? null : email,
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : null,
        note: 'claimed by existing operator recovery',
      });
      logger.warn({ sub }, 'swarm root claimed by existing operator');
      res.status(201).json({ root: row });
    } catch (err) { fail(res, err, 'POST /claim-root'); }
  });

  router.post('/installer-root', requiresAuth, installerRootHandler(pool));

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
