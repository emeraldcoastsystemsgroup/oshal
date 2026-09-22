/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gemini connect-state route (Plan E residual). GET /status reports {connected, method, reason, expiresAt?} from the llm-provider probe over GEMINI_API_KEY/GOOGLE_API_KEY + ~/.gemini/oauth_creds.json. Status-ONLY by operator doctrine: the vendor's own CLI login runs host-side (Connect-AI.bat / run `gemini` once) — no /start, no /callback, no Google OAuth client here, ever. Factory takes requiresAuth and applies it per-route (claude-code-auth-routes pattern) so the server.ts mount classifies 'oidc' in the route-auth inventory guard.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | POST /import and POST /signout, the rail Google was missing while Codex and Claude Code both had one. "Status-only" was right about what this route must NEVER do — broker Google's OAuth — and wrong about what the swarm needs: the sign-in still runs on the operator's own machine, in his own browser, through the vendor's CLI; this route only ADOPTS the file that login wrote, pushed from the oshal client under his verified session. Both new routes sit behind the same operator-session guard the claude-code routes use, and /import additionally carries the ADR-127 pair (DEMO_MODE + the exact OSHAL_OPERATOR_SUBS subject) with the identical 409 for every other deployment and caller. GET /status keeps its plain requiresAuth: it exposes no identity and no token, and the Utilities surface polls it for every signed-in tenant. Nothing here ever puts credential material in a response body, a log line, or on Redis.
 */

import { Router, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  adoptOperatorGeminiLogin,
  forgetAdoptedGeminiLogin,
  getGeminiAuthStatus,
} from '@/features/llm-provider';
import { demoModeEnabled, isDeploymentOperatorSub } from '@/shared/deployment-mode';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'gemini-auth-routes' });

/**
 * The SEC-05 refusal shared with the Claude Code import route. The oshal client matches on this
 * exact string to explain "this swarm is not in DEMO_MODE, or you are not its operator", so the
 * two routes must answer with the SAME code — a Gemini-specific spelling would reach the client
 * as an unclassified refusal.
 */
const CREDENTIAL_RAIL_REFUSAL = 'credential_distribution_disabled_pending_versioned_revocation_rail';

/**
 * @description Creates the Gemini auth routes used by the Utilities "Bot LLM access" surface and
 * by the oshal client's "Log in + push".
 *
 * Connecting still happens by running the vendor's own login where a browser is — on the operator's
 * machine (`gemini`, then `/auth`), never here. What this router adds is the other half: the client
 * pushes the `oauth_creds.json` that login wrote, and POST /import adopts it into the mounted path
 * every node reads. No Google OAuth client, redirect, or token exchange exists in this process.
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 * @returns Express router with the Gemini status, import and sign-out endpoints
 */
export function createGeminiAuthRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();
  const operatorSession = createOperatorSessionGuard(requiresAuth);
  registerStatusRoute(router, requiresAuth);
  registerImportRoute(router, operatorSession);
  registerSignOutRoute(router, operatorSession);
  return router;
}

/**
 * @description Composes session authentication with the exact operator allowlist, the same way
 * claude-code-auth-routes does. Authentication runs FIRST so an unauthenticated caller still gets
 * the deployment's normal 401 rather than leaking that the operator allowlist exists.
 * @param requiresAuth - Deployment-specific OIDC/session authentication middleware
 * @returns Middleware that admits authenticated operators only
 */
function createOperatorSessionGuard(requiresAuth: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    requiresAuth(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      requiresOperator(req, res, next);
    });
  };
}

/**
 * @description Registers GET /status, the connect-state probe.
 *
 * Deliberately NOT behind the operator guard: the probe never exposes token material or the account
 * identity, only connected/method/reason/expiry, and the Utilities surface polls it for every
 * signed-in tenant. Narrowing it here would be a behaviour change to an existing surface, not a
 * hardening — the two routes that actually move a credential carry the operator gate instead.
 * @param router - Router instance
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 * @returns Void after route registration
 */
function registerStatusRoute(router: Router, requiresAuth: RequestHandler): void {
  router.get('/status', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ method: req.method, path: req.path }, 'Gemini auth status route invoked');

    try {
      // Shared, host-mounted platform credential (like the Claude Code one):
      // the probe never exposes token material or the account identity —
      // only connected/method/reason/expiry, safe for any signed-in tenant.
      const status = getGeminiAuthStatus();
      res.json({ success: true, ...status });
      logger.info(
        { durationMs: Date.now() - startedAt, connected: status.connected, authMethod: status.method, reason: status.reason },
        'Gemini auth status route completed',
      );
    } catch (error) {
      logger.error({ err: error, stack: (error as Error)?.stack }, 'Gemini auth status route failed');
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * @description Registers POST /import — the ADR-137 amendment A rail for Google, in the shape the
 * Claude Code import already has.
 *
 * Both ADR-127 gates are checked here and nowhere else: a demo deployment AND the exact
 * OSHAL_OPERATOR_SUBS subject. Every other deployment and every other caller keeps the SEC-05 409.
 * The adopted credential is written to the mounted login path the harness reads; it is never put
 * on Redis, never returned in the response, and never logged.
 * @param router - Router instance
 * @param requiresAuth - Operator-session middleware (authentication, then the operator allowlist)
 * @returns Void after route registration
 */
function registerImportRoute(router: Router, requiresAuth: RequestHandler): void {
  router.post('/import', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    const demo = demoModeEnabled();
    if (!demo || !isDeploymentOperatorSub(getCaller(req).sub)) {
      logger.warn({ method: req.method, path: req.path, demo }, 'Gemini raw credential import refused');
      res.status(409).json({ success: false, imported: false, error: CREDENTIAL_RAIL_REFUSAL });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const adoption = adoptOperatorGeminiLogin(body.credentials ?? body.oauthCreds ?? body.loginFile ?? body);
      res.json({ success: true, imported: true, expiresAt: adoption.expiresAt });
      logger.info(
        { durationMs: Date.now() - startedAt, expiresAt: adoption.expiresAt },
        'Gemini login file adopted from an operator device',
      );
    } catch (error) {
      respondToAdoptionFailure(res, error, 'Gemini login file adoption failed');
    }
  });
}

/**
 * @description Registers POST /signout — removes the adopted login from the mounted path so the
 * swarm stops reasoning as that Google identity.
 *
 * Operator-session gated like its Claude Code sibling, and deliberately NOT behind the demo carve:
 * revoking an adopted credential must stay available on a deployment where adopting one no longer
 * is, otherwise turning DEMO_MODE off would strand a credential nobody can remove through the API.
 * @param router - Router instance
 * @param requiresAuth - Operator-session middleware (authentication, then the operator allowlist)
 * @returns Void after route registration
 */
function registerSignOutRoute(router: Router, requiresAuth: RequestHandler): void {
  router.post('/signout', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ method: req.method, path: req.path }, 'Gemini auth sign-out route invoked');

    try {
      const removal = forgetAdoptedGeminiLogin();
      const status = getGeminiAuthStatus();
      res.json({ success: true, signedOut: true, removed: removal.removed, connected: status.connected, method: status.method });
      logger.info(
        { durationMs: Date.now() - startedAt, removed: removal.removed, connected: status.connected },
        'Gemini auth sign-out route completed',
      );
    } catch (error) {
      respondToAdoptionFailure(res, error, 'Gemini auth sign-out route failed');
    }
  });
}

/**
 * @description Maps a coded adoption/removal failure onto the HTTP answer its Claude Code sibling
 * uses for the same condition, so the oshal client's one classifier serves both vendors.
 * @param res - Express response
 * @param error - The thrown error, expected to carry a stable `code`
 * @param message - Log message identifying which route failed
 * @returns Void after the response is sent
 */
function respondToAdoptionFailure(res: Response, error: unknown, message: string): void {
  const code = (error as { code?: string })?.code;
  logger.error({ err: error, stack: (error as Error)?.stack, code }, message);
  if (code === 'GEMINI_CREDENTIALS_PATH_READ_ONLY') {
    res.status(409).json({
      success: false,
      imported: false,
      error: 'gemini_credentials_path_read_only',
      hint: 'This controller mounts its Gemini login read-only. Set GEMINI_AUTH_MOUNT_MODE=rw in .env, recreate the api, then push again.',
    });
    return;
  }
  if (code === 'GEMINI_CREDENTIALS_PATH_UNSET') {
    res.status(409).json({
      success: false,
      imported: false,
      error: 'gemini_credentials_path_unset',
      hint: 'This controller has no Gemini login path. Set GEMINI_OAUTH_CREDS_PATH in .env, recreate the api, then push again.',
    });
    return;
  }
  if (code === 'GEMINI_LOGIN_FILE_INVALID') {
    res.status(400).json({
      success: false,
      imported: false,
      error: 'gemini_login_file_invalid',
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  res.status(500).json({ success: false, imported: false, error: error instanceof Error ? error.message : String(error) });
}
