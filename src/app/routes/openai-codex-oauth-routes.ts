/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Passed browser-facing request origin into OpenAI Codex OAuth start so callback state returns to the same runtime instead of a conflicting shared port
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of OpenAI Codex OAuth API routes for sign-in, callback completion, status, and sign-out
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added centralized runtime credential sync on OAuth callback/sign-out to avoid per-chat runtime writes
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Moved OAuth route service construction into the router factory so callback state and runtime-sync paths honor the active environment during repo-root tests and multi-runtime startup
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { OpenAiCodexOAuthService } from '@/features/openai-codex-oauth';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { ClineRuntimeConfigSyncService } from '@/features/llm-provider/services';

const logger = createChildLogger({ module: 'openai-codex-oauth-routes' });

/**
 * @description Runtime dependencies shared by all OpenAI Codex OAuth route handlers.
 */
interface OpenAiCodexOAuthRouteDependencies {
  oauthService: OpenAiCodexOAuthService;
  runtimeSyncService: ClineRuntimeConfigSyncService;
}

/**
 * @description Creates OpenAI Codex OAuth routes used by the settings UI.
 * Protected endpoints require OSHAL authentication; callback remains public and state-bound.
 *
 * @param requiresAuth - Request middleware that enforces authenticated OSHAL sessions
 * @returns Express router for OpenAI Codex OAuth flow management
 */
export function createOpenAiCodexOAuthRoutes(requiresAuth: RequestHandler): Router {
  const dependencies = createOpenAiCodexOAuthRouteDependencies();
  const router = Router();
  registerOpenAiCodexStartRoute(router, requiresAuth, dependencies);
  registerOpenAiCodexStatusRoute(router, requiresAuth, dependencies);
  registerOpenAiCodexSignOutRoute(router, requiresAuth, dependencies);
  registerOpenAiCodexImportRoute(router, requiresAuth, dependencies);
  registerOpenAiCodexCallbackRoute(router, dependencies);

  return router;
}

/**
 * @description Registers the credential-import route used by the first-run wizard and Utilities.
 * Lets a hosted user paste/upload the `~/.codex/auth.json` that `codex login` wrote, bypassing the
 * localhost:1455 OAuth redirect (which only completes with the CLI/remote client running locally).
 *
 * @param router - Express router instance for OpenAI Codex OAuth endpoints
 * @param requiresAuth - Middleware enforcing authenticated OSHAL sessions
 * @param dependencies - Shared OAuth/runtime-sync services for this router instance
 * @returns Void after route registration
 */
function registerOpenAiCodexImportRoute(
  router: Router,
  requiresAuth: RequestHandler,
  dependencies: OpenAiCodexOAuthRouteDependencies,
): void {
  router.post('/import', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ path: req.path, method: req.method }, 'OpenAI Codex credential import route invoked');

    try {
      const userId = getRequiredUserId(req);
      const body = (req.body || {}) as Record<string, unknown>;
      const authJson = body.authJson ?? body.auth_json ?? body;
      const credentials = dependencies.oauthService.importCredentialsFromCodexCli(userId, authJson);
      const selection = dependencies.runtimeSyncService.syncFromPersistedConfig(
        process.env.CLINE_MODEL || process.env.LLM_MODEL || 'gpt-5.3-codex',
        userId,
      );
      res.json({ success: true, authenticated: true, email: credentials.email || null });
      logger.info(
        { durationMs: Date.now() - startedAt, userId, runtimeProvider: selection.provider, runtimeModel: selection.model },
        'OpenAI Codex credentials imported from CLI auth.json',
      );
    } catch (error) {
      logger.error({ err: error }, 'Failed to import OpenAI Codex credentials');
      res.status(400).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Builds the service dependencies used by one router instance so the OAuth state map
 * and runtime-sync filesystem paths are scoped to the current environment at router creation time.
 *
 * @returns OpenAI Codex OAuth route dependency bag
 */
function createOpenAiCodexOAuthRouteDependencies(): OpenAiCodexOAuthRouteDependencies {
  return {
    oauthService: new OpenAiCodexOAuthService(),
    runtimeSyncService: new ClineRuntimeConfigSyncService(),
  };
}

/**
 * @description Registers the OAuth start route that returns a browser authorization URL.
 *
 * @param router - Express router instance for OpenAI Codex OAuth endpoints
 * @param requiresAuth - Middleware enforcing authenticated OSHAL sessions
 * @param dependencies - Shared OAuth/runtime-sync services for this router instance
 * @returns Void after route registration
 */
function registerOpenAiCodexStartRoute(
  router: Router,
  requiresAuth: RequestHandler,
  dependencies: OpenAiCodexOAuthRouteDependencies,
): void {
  router.get('/start', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ path: req.path, method: req.method }, 'OpenAI Codex OAuth start route invoked');

    try {
      const userId = getRequiredUserId(req);
      const authUrl = dependencies.oauthService.startAuthorization(userId);
      res.json({ success: true, authUrl });
      logger.info({ durationMs: Date.now() - startedAt, userId }, 'OpenAI Codex OAuth URL generated');
    } catch (error) {
      logger.error({ err: error }, 'Failed to start OpenAI Codex OAuth flow');
      res.status(400).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers the OAuth status route for checking whether credentials are authenticated.
 *
 * @param router - Express router instance for OpenAI Codex OAuth endpoints
 * @param requiresAuth - Middleware enforcing authenticated OSHAL sessions
 * @param dependencies - Shared OAuth/runtime-sync services for this router instance
 * @returns Void after route registration
 */
function registerOpenAiCodexStatusRoute(
  router: Router,
  requiresAuth: RequestHandler,
  dependencies: OpenAiCodexOAuthRouteDependencies,
): void {
  router.get('/status', requiresAuth, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ path: req.path, method: req.method }, 'OpenAI Codex OAuth status route invoked');

    try {
      const userId = getRequiredUserId(req);
      const status = await dependencies.oauthService.getStatus(userId);
      res.json({ success: true, ...status });
      logger.info({ durationMs: Date.now() - startedAt, userId }, 'OpenAI Codex OAuth status returned');
    } catch (error) {
      logger.error({ err: error }, 'Failed to read OpenAI Codex OAuth status');
      res.status(500).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers the OAuth sign-out route that clears persisted credentials for the active user.
 *
 * @param router - Express router instance for OpenAI Codex OAuth endpoints
 * @param requiresAuth - Middleware enforcing authenticated OSHAL sessions
 * @param dependencies - Shared OAuth/runtime-sync services for this router instance
 * @returns Void after route registration
 */
function registerOpenAiCodexSignOutRoute(
  router: Router,
  requiresAuth: RequestHandler,
  dependencies: OpenAiCodexOAuthRouteDependencies,
): void {
  router.post('/signout', requiresAuth, (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ path: req.path, method: req.method }, 'OpenAI Codex OAuth sign-out route invoked');

    try {
      const userId = getRequiredUserId(req);
      dependencies.oauthService.signOut(userId);
      const removed = dependencies.runtimeSyncService.removeOpenAiCodexCredentials();
      res.json({ success: true, signedOut: true });
      logger.info(
        { durationMs: Date.now() - startedAt, userId, runtimeCredentialsRemoved: removed },
        'OpenAI Codex OAuth credentials removed',
      );
    } catch (error) {
      logger.error({ err: error }, 'Failed to sign out OpenAI Codex OAuth credentials');
      res.status(500).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers the OAuth callback route used by OpenAI redirect completion.
 *
 * @param router - Express router instance for OpenAI Codex OAuth endpoints
 * @param dependencies - Shared OAuth/runtime-sync services for this router instance
 * @returns Void after route registration
 */
function registerOpenAiCodexCallbackRoute(
  router: Router,
  dependencies: OpenAiCodexOAuthRouteDependencies,
): void {
  router.get('/callback', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ path: req.path, method: req.method }, 'OpenAI Codex OAuth callback route invoked');

    const errorParam = asOptionalString(req.query.error);
    const state = asOptionalString(req.query.state);
    const code = asOptionalString(req.query.code);

    if (errorParam) {
      logger.warn({ errorParam }, 'OpenAI Codex OAuth callback returned provider error');
      sendOAuthResultPage(res, 400, 'Authentication Failed', `OpenAI returned: ${errorParam}`, false);
      return;
    }

    if (!state || !code) {
      logger.warn({ hasState: !!state, hasCode: !!code }, 'OpenAI Codex OAuth callback missing required fields');
      sendOAuthResultPage(res, 400, 'Authentication Failed', 'Missing code or state in callback.', false);
      return;
    }

    try {
      const result = await dependencies.oauthService.completeAuthorization(state, code);
      const selection = dependencies.runtimeSyncService.syncFromPersistedConfig(
        process.env.CLINE_MODEL || process.env.LLM_MODEL || 'gpt-5.3-codex',
        result.userId,
      );
      logger.info(
        {
          durationMs: Date.now() - startedAt,
          userId: result.userId,
          runtimeProvider: selection.provider,
          runtimeModel: selection.model,
          runtimeMode: selection.mode,
        },
        'OpenAI Codex OAuth callback completed successfully',
      );
      sendOAuthResultPage(res, 200, 'Authentication Successful', 'You are signed in to OpenAI Codex.', true);
    } catch (error) {
      logger.error({ err: error }, 'OpenAI Codex OAuth callback completion failed');
      sendOAuthResultPage(res, 500, 'Authentication Failed', toErrorMessage(error), false);
    }
  });
}

/**
 * @description Resolves an authenticated OSHAL user id from the OIDC session object.
 *
 * @param req - Express request carrying OIDC context
 * @returns Stable user identifier to scope OAuth credentials
 */
function getRequiredUserId(req: Request): string {
  const rawUserId = (req as any).oidc?.user?.sub;

  if (typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
    throw new Error('Authenticated user identifier not found in request context');
  }

  return rawUserId;
}

/**
 * @description Sends an OAuth completion HTML page for popup/browser callback flows.
 *
 * @param res - Express response object
 * @param statusCode - HTTP status code to return
 * @param title - Result title shown to the user
 * @param message - Result body message shown to the user
 * @param autoClose - Whether to auto-close the page after a short delay
 * @returns Void after writing HTML response body
 */
function sendOAuthResultPage(
  res: Response,
  statusCode: number,
  title: string,
  message: string,
  autoClose: boolean,
): void {
  const closeScript = autoClose ? '<script>setTimeout(() => window.close(), 2000);</script>' : '';
  const closeHint = autoClose ? '<p>You can close this window.</p>' : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${closeHint}${closeScript}</body></html>`;
  res.status(statusCode).type('html').send(html);
}

/**
 * @description Converts unknown values to optional strings for query parameter parsing.
 *
 * @param value - Query parameter value from Express
 * @returns String value when valid; otherwise undefined
 */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * @description Converts unknown error values to safe response/log strings.
 *
 * @param error - Unknown error value
 * @returns Human-readable error message string
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @description Escapes untrusted text for safe embedding in HTML output.
 *
 * @param text - Potentially untrusted text content
 * @returns HTML-escaped string
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
