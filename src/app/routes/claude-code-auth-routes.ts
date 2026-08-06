/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Claude Code auth API routes for status, login start, and sign-out
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added GET /callback OAuth route to close PKCE auth loop; updated /start to derive redirectUri from request origin
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added GET /credentials and POST /import routes for cross-bot credential propagation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | /start route now passes buildCallbackUri(req) to startLogin() for auto-callback OAuth — no copy/paste required
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fixed OAuth redirect URI to use root /callback (Claude only allows localhost:{port}/callback); removed swarm propagation; each bot owns its own auth
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Restricted every controller credential operation to exact operators, kept machine import directional on authenticated bot-node targets only, and removed raw credential reads
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: replace controller credential import with a stable no-op denial and derive redacted diagnostics from auth status without exporting token material.
 */

import { Router, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { ClaudeCodeAuthService } from '@/features/claude-code-auth';
import { requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'claude-code-auth-routes' });
const authService = new ClaudeCodeAuthService();

/**
 * @description Creates Claude Code auth routes used by the API configuration UI.
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 * @returns Express router with Claude Code auth endpoints
 */
/**
 * @description Standalone Claude Code OAuth callback handler for root-level /callback route.
 * Claude OAuth only allows redirect_uri = http://localhost:{port}/callback — no deep paths.
 * Each bot registers this handler at GET / on its own port to receive the OAuth redirect.
 */
export async function handleClaudeCodeOAuthCallback(req: Request, res: Response): Promise<boolean> {
  const state = readOptionalString(req.query.state);
  const code = readOptionalString(req.query.code);
  const errorParam = readOptionalString(req.query.error);
  const errorDescription = readOptionalString(req.query.error_description);

  // Only handle requests that look like OAuth callbacks (have state or code or error params)
  if (!state && !code && !errorParam) {
    return false; // Not an OAuth callback — let other handlers deal with it
  }

  logger.info({ hasState: !!state, hasCode: !!code, hasError: !!errorParam }, 'Root /callback: Claude Code OAuth callback invoked');

  if (errorParam) {
    logger.warn({ errorParam, errorDescription }, 'Root /callback: Claude Code OAuth received authorization error');
    res.status(400).send(buildCallbackHtml(false, errorDescription || errorParam));
    return true;
  }

  if (!state || !code) {
    logger.warn({ hasState: !!state, hasCode: !!code }, 'Root /callback: Claude Code OAuth missing required parameters');
    res.status(400).send(buildCallbackHtml(false, 'Missing state or code parameter'));
    return true;
  }

  try {
    const result = await authService.handleOAuthCallback(state, code);
    logger.info({ authenticated: result.authenticated, email: result.email }, 'Root /callback: Claude Code OAuth completed successfully');
    res.send(buildCallbackHtml(true, null, result.email || undefined));
    return true;
  } catch (error) {
    logger.error({ err: error }, 'Root /callback: Claude Code OAuth handler failed');
    res.status(400).send(buildCallbackHtml(false, toErrorMessage(error)));
    return true;
  }
}

export { handleClaudeCodeOAuthCallback as default_handler };

/**
 * @description Assembles the Express router exposing the Claude Code auth API surface
 * (status, login start, OAuth callback, code submission, sign-out, and cross-bot credential
 * read/import) by wiring each individual route registrar onto a fresh router.
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context, applied to the protected routes
 * @returns Express router with all Claude Code auth endpoints registered
 */
export function createClaudeCodeAuthRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();
  const operatorSession = createOperatorSessionGuard(requiresAuth);
  registerStatusRoute(router, operatorSession);
  registerStartRoute(router, operatorSession);
  registerCallbackRoute(router);
  registerSubmitCodeRoute(router, operatorSession);
  registerSignOutRoute(router, operatorSession);
  registerCredentialsRoute(router, operatorSession);
  registerImportRoute(router, operatorSession);
  return router;
}

/**
 * @description Composes session authentication with the exact operator allowlist. Authentication
 * runs first so unauthenticated browser callers retain the deployment's normal 401 behavior.
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
 * @description Registers GET status endpoint for Claude Code authentication state.
 * @param router - Router instance
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 */
function registerStatusRoute(router: Router, requiresAuth: RequestHandler): void {
  router.get('/status', requiresAuth, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ method: req.method, path: req.path }, 'Claude Code auth status route invoked');

    try {
      const status = await authService.getStatus();
      // Claude Code OAuth is a SHARED, host-mounted platform credential (not per-user).
      // Never expose its account identity to tenants — strip the email so other users
      // only ever see "connected", never whose account it is. (Per-user BYO creds keep
      // their own identity via the connectors store.)
      const safeStatus = { ...status };
      delete (safeStatus as { email?: string }).email;
      res.json({ success: true, ...safeStatus });
      logger.info({ durationMs: Date.now() - startedAt, authenticated: status.authenticated }, 'Claude Code auth status route completed');
    } catch (error) {
      logger.error({ err: error }, 'Claude Code auth status route failed');
      res.status(500).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers GET start endpoint to launch Claude Code browser login flow.
 * Derives the OAuth redirect URI from the incoming request so the PKCE callback
 * lands on the same origin as the request.
 * @param router - Router instance
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 */
function registerStartRoute(router: Router, requiresAuth: RequestHandler): void {
  router.get('/start', requiresAuth, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const email = readOptionalString(req.query.email) || readOptionalString(process.env.CLAUDE_CODE_AUTH_EMAIL);
    logger.info({ method: req.method, path: req.path, email: email || null }, 'Claude Code auth start route invoked');

    try {
      const derivedRedirectUri = buildCallbackUri(req);
      logger.info({ derivedRedirectUri }, 'Claude Code auth start: derived callback URI for PKCE flow');
      const result = await authService.startLogin(email || undefined, derivedRedirectUri || undefined);
      res.json({ success: true, ...result });
      logger.info({ durationMs: Date.now() - startedAt, loginInProgress: result.loginInProgress, oauthMode: result.oauthMode }, 'Claude Code auth start route completed');
    } catch (error) {
      logger.error({ err: error }, 'Claude Code auth start route failed');
      res.status(500).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers GET /callback OAuth redirect endpoint (no session auth required —
 * this is the public endpoint that Anthropic redirects the browser back to after authorization).
 * Exchanges the authorization code for credentials and serves an HTML result page that
 * auto-closes the popup window.
 * @param router - Router instance
 */
function registerCallbackRoute(router: Router): void {
  router.get('/callback', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const state = readOptionalString(req.query.state);
    const code = readOptionalString(req.query.code);
    const errorParam = readOptionalString(req.query.error);
    const errorDescription = readOptionalString(req.query.error_description);

    logger.info({ hasState: !!state, hasCode: !!code, hasError: !!errorParam }, 'Claude Code OAuth callback route invoked');

    if (errorParam) {
      logger.warn({ errorParam, errorDescription }, 'Claude Code OAuth callback received authorization error');
      res.status(400).send(buildCallbackHtml(false, errorDescription || errorParam));
      return;
    }

    if (!state || !code) {
      logger.warn({ hasState: !!state, hasCode: !!code }, 'Claude Code OAuth callback missing required parameters');
      res.status(400).send(buildCallbackHtml(false, 'Missing state or code parameter'));
      return;
    }

    try {
      const result = await authService.handleOAuthCallback(state, code);
      logger.info({ durationMs: Date.now() - startedAt, authenticated: result.authenticated, email: result.email }, 'Claude Code OAuth callback completed successfully');
      res.send(buildCallbackHtml(true, null, result.email || undefined));

      // Each bot manages its own auth — no swarm propagation needed.
    } catch (error) {
      logger.error({ err: error }, 'Claude Code OAuth callback handler failed');
      res.status(400).send(buildCallbackHtml(false, toErrorMessage(error)));
    }
  });
}

/**
 * @description Registers POST sign-out endpoint for Claude Code authentication.
 * @param router - Router instance
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 */
/**
 * @description Registers POST /submit-code endpoint to pipe the auth code from the browser
 * back into the running `claude auth login` CLI process.
 */
function registerSubmitCodeRoute(router: Router, requiresAuth: RequestHandler): void {
  router.post('/submit-code', requiresAuth, async (req: Request, res: Response) => {
    const code = readOptionalString(req.body?.code);
    if (!code) {
      res.status(400).json({ success: false, error: 'Missing code parameter' });
      return;
    }

    try {
      const result = await authService.submitAuthCode(code);
      res.json({ success: true, ...result });

      // Each bot manages its own auth — no swarm propagation needed.
    } catch (error) {
      logger.error({ err: error }, 'Failed to submit auth code');
      res.status(400).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

function registerSignOutRoute(router: Router, requiresAuth: RequestHandler): void {
  router.post('/signout', requiresAuth, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    logger.info({ method: req.method, path: req.path }, 'Claude Code auth sign-out route invoked');

    try {
      const status = await authService.signOut();
      res.json({ success: true, signedOut: !status.authenticated, ...status });
      logger.info({ durationMs: Date.now() - startedAt, authenticated: status.authenticated }, 'Claude Code auth sign-out route completed');
    } catch (error) {
      logger.error({ err: error }, 'Claude Code auth sign-out route failed');
      res.status(500).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers GET /credentials endpoint for redacted platform credential diagnostics.
 * @param router - Router instance
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 */
function registerCredentialsRoute(router: Router, requiresAuth: RequestHandler): void {
  router.get('/credentials', requiresAuth, async (req: Request, res: Response) => {
    logger.info({ method: req.method, path: req.path }, 'Claude Code credentials read route invoked');
    try {
      const status = await authService.getStatus();
      if (!status.authenticated) {
        res.status(404).json({ success: false, error: 'No valid credentials found' });
        return;
      }
      res.json({
        success: true,
        credentials: {
          configured: true,
          auth_method: status.authMethod,
          has_access_token: true,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Claude Code credentials read route failed');
      res.status(500).json({ success: false, error: toErrorMessage(error) });
    }
  });
}

/**
 * @description Registers a stable no-op POST /import endpoint; raw distribution is retired.
 * @param router - Router instance
 * @param requiresAuth - Session middleware requiring authenticated OSHAL user context
 */
function registerImportRoute(router: Router, requiresAuth: RequestHandler): void {
  router.post('/import', requiresAuth, (req: Request, res: Response) => {
    logger.warn({ method: req.method, path: req.path }, 'Claude Code raw credential import refused');
    res.status(409).json({
      success: false,
      imported: false,
      error: 'credential_distribution_disabled_pending_versioned_revocation_rail',
    });
  });
}

/**
 * @description Builds the OAuth callback URI.
 *
 * In swarm mode all OAuth callbacks route through the project-manager (port 3010)
 * because only one redirect URI can be registered with the Anthropic OAuth client.
 * PM handles the callback and auto-propagates credentials to all other bots.
 *
 * @param req - Incoming Express request (used for protocol/hostname fallback)
 * @returns Callback URI string or null when origin cannot be determined
 */
function buildCallbackUri(req: Request): string | null {
  const explicit = process.env.CLAUDE_CODE_OAUTH_REDIRECT_URI;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  // Claude OAuth only accepts redirect URIs in the format http://localhost:{port}/callback
  // — no deep paths allowed. Each bot uses its own external port with root /callback.
  const host = req.get('host') || 'localhost:3456';
  const hostname = host.split(':')[0];
  const port = host.split(':')[1] || '3456';
  const resolvedHost = (hostname === '0.0.0.0' || hostname === '127.0.0.1') ? 'localhost' : hostname;
  return `http://${resolvedHost}:${port}/callback`;
}

/**
 * @description Builds an HTML page that displays the auth result and auto-closes the popup.
 * @param success - Whether authentication succeeded
 * @param errorMessage - Error message when success is false
 * @param email - Authenticated email when success is true
 * @returns HTML string
 */
function buildCallbackHtml(success: boolean, errorMessage?: string | null, email?: string): string {
  if (success) {
    const userLabel = email ? `Signed in as <strong>${escapeHtml(email)}</strong>` : 'Authentication successful';
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Claude Code — Signed In</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}
.card{background:#fff;border-radius:12px;padding:32px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:400px}
h2{color:#166534;margin:0 0 8px}p{color:#4b5563;margin:0 0 20px}.close-btn{background:#16a34a;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:15px;cursor:pointer}</style>
</head>
<body><div class="card">
<h2>✓ Signed In</h2>
<p>${userLabel}</p>
<p style="font-size:13px;color:#6b7280">You can close this window.</p>
<button class="close-btn" onclick="window.close()">Close</button>
</div>
<script>setTimeout(()=>window.close(),3000)</script>
</body></html>`;
  }

  const safeError = escapeHtml(errorMessage || 'An unknown error occurred');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Claude Code — Sign In Failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fef2f2}
.card{background:#fff;border-radius:12px;padding:32px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:400px}
h2{color:#991b1b;margin:0 0 8px}p{color:#4b5563;margin:0 0 20px}.close-btn{background:#dc2626;color:#fff;border:none;border-radius:8px;padding:10px 24px;font-size:15px;cursor:pointer}</style>
</head>
<body><div class="card">
<h2>✗ Sign In Failed</h2>
<p>${safeError}</p>
<p style="font-size:13px;color:#6b7280">You can close this window and try again.</p>
<button class="close-btn" onclick="window.close()">Close</button>
</div>
<script>setTimeout(()=>window.close(),8000)</script>
</body></html>`;
}

/**
 * @description Escapes special HTML characters to prevent XSS in inline HTML strings.
 * @param text - Raw text to escape
 * @returns HTML-safe string
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * @description Converts unknown errors into stable response text.
 * @param error - Unknown error payload
 * @returns Human-readable error message
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @description Reads an optional non-empty string from unknown values.
 * @param value - Unknown candidate input
 * @returns Trimmed string when present; otherwise null
 */
function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
