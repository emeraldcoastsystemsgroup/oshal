/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OAuth start now requests scopes from FACEBOOK_SCOPES (default public_profile) and supports FACEBOOK_CONFIG_ID for Login-for-Business config-driven auth instead of a raw scope list
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Capture + unref the CSRF-state cleanup interval (2026-07-05 leak audit)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Operator-gate every non-callback surface, bind single-use OAuth state to the exact initiating browser/operator, retire browser password/App-Secret writes and raw Redis token publication, and render fixed escaped callback HTML.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Fail Facebook token persistence closed unless ENCRYPTION_KEY is configured, reject OAuth start before state/provider activity when secure storage is unavailable, and prove the deployment prerequisite in focused tests.
 */

/**
 * Facebook OAuth Routes
 *
 * Handles the Facebook OAuth flow for the facebook-bot integration.
 * Follows the same pattern as claude-code-auth-routes.ts:
 *   /start    → generate Facebook OAuth URL and return to UI
 *   /callback → receive authorization code, exchange for tokens, persist
 *   /status   → check if Facebook is connected and token is valid
 *   /disconnect → remove stored credentials
 *   /pages    → list pages the user manages (for page selection)
 *
 * Credentials are stored via the existing EncryptedConfigManager. This route
 * refuses to create or read its credential store unless encryption is enabled.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'facebook-auth-routes' });

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const OAUTH_BASE = 'https://www.facebook.com';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingFacebookState {
  createdAt: number;
  redirectUri: string;
  operatorSub: string;
  bindingDigest: string;
}

// A state is useful once, for ten minutes, and only from the initiating operator's browser.
const pendingStates = new Map<string, PendingFacebookState>();

// Clean up expired states every 5 minutes (unref so the module-level timer never pins the process)
const stateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingStates.entries()) {
    if (now - value.createdAt > OAUTH_STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}, 5 * 60 * 1000);
stateCleanupTimer.unref();

/**
 * Build the OAuth callback URI from the incoming request.
 */
function buildCallbackUri(req: Request): string {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:35457';
  return `${protocol}://${host}/api/facebook-auth/callback`;
}

/**
 * Escape provider-owned display data before embedding it in callback HTML.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Build a fixed callback page. Provider error text is deliberately never reflected.
 */
function buildCallbackHtml(success: boolean, pageName?: string): string {
  const title = success ? 'Facebook Connected' : 'Facebook Connection Failed';
  const body = success
    ? `<h2>Connected to Facebook</h2><p>Page: <strong>${escapeHtml(String(pageName || 'Unknown'))}</strong></p><p>You can close this window.</p>`
    : '<h2>Connection Failed</h2><p>The authorization could not be completed. Close this window and start again.</p>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;}
.card{text-align:center;padding:2rem;border-radius:12px;background:#222;max-width:400px;}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

/** Send callback HTML with a deny-by-default document policy and no cache. */
function sendCallbackHtml(res: Response, status: number, success: boolean, pageName?: string): void {
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
    .set('X-Content-Type-Options', 'nosniff')
    .type('html')
    .send(buildCallbackHtml(success, pageName));
}

function stateBindingCookieName(state: string): string {
  return `oshal_fb_oauth_${state}`;
}

/** Read a cookie with or without cookie-parser; malformed values fail closed. */
function readCookie(req: Request, name: string): string {
  const parsed = (req as Request & { cookies?: Record<string, unknown> }).cookies?.[name];
  if (typeof parsed === 'string') return parsed;
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return '';
    }
  }
  return '';
}

function bindingDigest(binding: string): string {
  return crypto.createHash('sha256').update(binding, 'utf8').digest('hex');
}

function bindingMatches(expectedDigest: string, binding: string): boolean {
  if (!binding) return false;
  const actual = Buffer.from(bindingDigest(binding), 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isHttpsRequest(req: Request): boolean {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || forwarded === 'https';
}

function bindingCookieOptions(req: Request): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttpsRequest(req),
    path: '/api/facebook-auth',
    maxAge: OAUTH_STATE_TTL_MS,
  };
}

/**
 * Resolve the EncryptedConfigManager from the app context.
 */
function getConfigManager(): any {
  try {
    const path = require('path');
    const encryptionKey = process.env.ENCRYPTION_KEY?.trim();
    if (!encryptionKey) {
      logger.warn('Facebook credential storage unavailable: ENCRYPTION_KEY is required');
      return null;
    }
    // Try multiple require paths — dist/ layout differs from source layout
    let ECM: any;
    for (const tryPath of [
      '../../api/encrypted-config-manager',
      path.resolve(process.cwd(), 'src/api/encrypted-config-manager'),
    ]) {
      try {
        const mod = require(tryPath);
        ECM = mod.EncryptedConfigManager || mod;
        if (typeof ECM === 'function') break;
      } catch { continue; }
    }
    if (typeof ECM !== 'function') {
      logger.warn('EncryptedConfigManager not found at any known path');
      return null;
    }
    const outputDir = process.env.OUTPUT_DIR || path.join(process.cwd(), 'output');
    return new ECM(outputDir, encryptionKey);
  } catch (err) {
    logger.error({ err }, 'Failed to load EncryptedConfigManager');
    return null;
  }
}

/**
 * Load Facebook App ID and App Secret from config store, falling back to env vars.
 */
function loadAppCredentials(): { appId: string | null; appSecret: string | null } {
  const mgr = getConfigManager();
  if (mgr) {
    try {
      const secrets = mgr.loadSecrets();
      const appId = secrets.facebookAppId || process.env.FACEBOOK_APP_ID || null;
      const appSecret = secrets.facebookAppSecret || process.env.FACEBOOK_APP_SECRET || null;
      return { appId, appSecret };
    } catch { /* fall through */ }
  }
  return {
    appId: process.env.FACEBOOK_APP_ID || null,
    appSecret: process.env.FACEBOOK_APP_SECRET || null,
  };
}

function loadRequestedScopes(): string[] {
  return (process.env.FACEBOOK_SCOPES || 'public_profile')
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * @description Factory that builds and returns the Express router exposing the
 * Facebook integration endpoints (status, OAuth start/callback, disconnect, page
 * listing and page switching). Every route except the provider callback is guarded
 * by both the injected authentication middleware and the shared operator allowlist.
 * Browser password login and App-Secret writes remain registered only as stable 410s.
 * @param requiresAuth Express middleware used before the operator gate.
 * @returns A configured Express Router ready to be mounted under the
 * facebook-auth path prefix.
 */
export function createFacebookAuthRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();

  // ── GET /app ─────────────────────────────────────────────────────────
  // Self-contained login/settings page served as static HTML.
  // Embedded by the cockpit ribbon when the facebook-bot registers its tool UI.
  router.get('/app', requiresAuth, requiresOperator, (_req: Request, res: Response) => {
    const path = require('path');
    const appPath = path.resolve(process.cwd(), 'any-bot/server/services/tools/facebook/facebook-app.html');
    res.sendFile(appPath, (err: any) => {
      if (err) {
        logger.error({ err }, 'Failed to serve facebook-app.html');
        res.status(404).send('Facebook app page not found');
      }
    });
  });

  // ── POST /login ───────────────────────────────────────────────────────
  // Retired compatibility endpoint: never reads email/password and never starts Playwright.
  router.post('/login', requiresAuth, requiresOperator, (_req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      error: 'browser_password_login_disabled',
    });
  });

  // ── POST /credentials ─────────────────────────────────────────────────
  // Retired compatibility endpoint: App credentials are deployment-managed secrets.
  router.post('/credentials', requiresAuth, requiresOperator, (_req: Request, res: Response) => {
    res.status(410).json({
      success: false,
      error: 'browser_app_secret_write_disabled',
    });
  });

  // ── GET /status ──────────────────────────────────────────────────────
  router.get('/status', requiresAuth, requiresOperator, async (_req: Request, res: Response) => {
    try {
      // OAuth path — check encrypted config for page token
      const mgr = getConfigManager();
      if (!mgr) {
        res.json({ connected: false });
        return;
      }

      const secrets = mgr.loadSecrets();
      const pageToken = secrets.facebookPageAccessToken;
      const { appId, appSecret } = loadAppCredentials();

      if (!pageToken) {
        res.json({ connected: false, appId: appId || null });
        return;
      }

      // Validate token with Facebook
      let tokenValid = false;
      let scopes: string[] = [];

      if (appId && appSecret) {
        try {
          const debugRes = await axios.get(`${GRAPH_API_BASE}/debug_token`, {
            params: { input_token: pageToken, access_token: `${appId}|${appSecret}` },
          });
          tokenValid = debugRes.data.data?.is_valid || false;
          scopes = debugRes.data.data?.scopes || [];
        } catch {
          tokenValid = false;
        }
      }

      res.json({
        connected: true,
        tokenValid,
        pageId: secrets.facebookPageId || null,
        pageName: secrets.facebookPageName || null,
        connectedAt: secrets.facebookConnectedAt || null,
        tokenExpiresAt: secrets.facebookTokenExpiresAt || null,
        scopes,
      });
    } catch (err) {
      logger.error({ err }, 'Facebook auth status failed');
      res.status(500).json({ connected: false, error: 'Internal error' });
    }
  });

  // ── GET /start ───────────────────────────────────────────────────────
  router.get('/start', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    if (!getConfigManager()) {
      res.status(503).json({
        success: false,
        error: 'facebook_encrypted_storage_required',
      });
      return;
    }
    const { appId } = loadAppCredentials();
    if (!appId) {
      res.status(400).json({
        success: false,
        error: 'Facebook deployment credentials are not configured',
      });
      return;
    }

    const operatorSub = getCaller(req).sub;
    if (!operatorSub) {
      res.status(401).json({ success: false, error: 'Authenticated operator identity required' });
      return;
    }

    const state = crypto.randomBytes(32).toString('hex');
    const binding = crypto.randomBytes(32).toString('base64url');
    const redirectUri = buildCallbackUri(req);

    pendingStates.set(state, {
      createdAt: Date.now(),
      redirectUri,
      operatorSub,
      bindingDigest: bindingDigest(binding),
    });
    res.cookie(stateBindingCookieName(state), binding, bindingCookieOptions(req));

    const scopes = loadRequestedScopes();
    const configId = process.env.FACEBOOK_CONFIG_ID?.trim();
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
    });

    // Consumer Login uses scope=. Login for Business apps can require a Meta
    // dashboard Login Configuration instead of a raw scope list.
    if (configId) {
      params.set('config_id', configId);
    } else if (scopes.length > 0) {
      params.set('scope', scopes.join(','));
    }

    const authUrl = `${OAUTH_BASE}/${GRAPH_API_VERSION}/dialog/oauth?${params.toString()}`;

    logger.info({
      redirectUri,
      operatorSub,
      scopes: configId ? undefined : scopes,
      usesConfigId: Boolean(configId),
    }, 'Facebook OAuth flow started');
    res.json({ success: true, authUrl });
  });

  // ── GET /callback ────────────────────────────────────────────────────
  router.get('/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!/^[a-f0-9]{64}$/.test(state)) {
      sendCallbackHtml(res, 400, false);
      return;
    }

    // Consume before any provider-error/code branch: every callback attempt is single use.
    const pending = pendingStates.get(state);
    if (!pending) {
      sendCallbackHtml(res, 400, false);
      return;
    }
    pendingStates.delete(state);

    const cookieName = stateBindingCookieName(state);
    const binding = readCookie(req, cookieName);
    const { maxAge: _maxAge, ...clearOptions } = bindingCookieOptions(req);
    res.clearCookie(cookieName, clearOptions);

    const callbackSub = getCaller(req).sub;
    if (Date.now() - pending.createdAt > OAUTH_STATE_TTL_MS
      || !bindingMatches(pending.bindingDigest, binding)
      || (callbackSub !== null && callbackSub !== pending.operatorSub)) {
      logger.warn({ operatorSub: pending.operatorSub }, 'Facebook OAuth callback browser binding rejected');
      sendCallbackHtml(res, 400, false);
      return;
    }

    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    if (errorParam) {
      logger.warn({
        operatorSub: pending.operatorSub,
        providerError: errorParam.slice(0, 128),
        hasDescription: typeof req.query.error_description === 'string',
      }, 'Facebook OAuth provider returned an error');
      sendCallbackHtml(res, 400, false);
      return;
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || code.length > 4096) {
      sendCallbackHtml(res, 400, false);
      return;
    }

    const mgr = getConfigManager();
    if (!mgr) {
      sendCallbackHtml(res, 503, false);
      return;
    }
    const { appId, appSecret } = loadAppCredentials();

    if (!appId || !appSecret) {
      sendCallbackHtml(res, 500, false);
      return;
    }

    try {
      // Step 1: Exchange code for short-lived user token
      const tokenRes = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: pending.redirectUri,
          code,
        },
      });
      const shortLivedToken = tokenRes.data.access_token;
      logger.info('Facebook OAuth: exchanged code for short-lived token');

      // Step 2: Exchange short-lived for long-lived user token
      const longLivedRes = await axios.get(`${GRAPH_API_BASE}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortLivedToken,
        },
      });
      const longLivedToken = longLivedRes.data.access_token;
      const expiresIn = longLivedRes.data.expires_in;
      const tokenExpiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
      logger.info({ expiresIn }, 'Facebook OAuth: exchanged for long-lived token');

      // Step 3: Get user's managed pages
      const pagesRes = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
        params: { access_token: longLivedToken, fields: 'id,name,access_token,category' },
      });
      const pages = pagesRes.data.data || [];

      if (pages.length === 0) {
        sendCallbackHtml(res, 400, false);
        return;
      }

      // Use first page (or the page matching FACEBOOK_PAGE_ID env var)
      const targetPageId = process.env.FACEBOOK_PAGE_ID;
      const selectedPage = targetPageId
        ? pages.find((p: any) => p.id === targetPageId) || pages[0]
        : pages[0];

      // Step 4: Store credentials
      const secrets = mgr.loadSecrets();
      Object.assign(secrets, {
        facebookPageAccessToken: selectedPage.access_token,
        facebookPageId: selectedPage.id,
        facebookPageName: selectedPage.name,
        facebookUserAccessToken: longLivedToken,
        facebookTokenExpiresAt: tokenExpiresAt,
        facebookConnectedAt: Date.now(),
      });
      mgr.saveSecrets(secrets);

      logger.info({
        operatorSub: pending.operatorSub,
        pageId: selectedPage.id,
        pageName: selectedPage.name,
      }, 'Facebook OAuth: credentials stored locally without raw token publication');

      sendCallbackHtml(res, 200, true, selectedPage.name);
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message || 'Unknown error';
      logger.error({ err: msg }, 'Facebook OAuth callback failed');
      sendCallbackHtml(res, 400, false);
    }
  });

  // ── POST /disconnect ─────────────────────────────────────────────────
  router.post('/disconnect', requiresAuth, requiresOperator, async (_req: Request, res: Response) => {
    try {
      // Clear browser session
      try {
        const path = require('path');
        const sessionMgr = require(path.resolve(process.cwd(), 'any-bot/server/services/tools/facebook/facebookBrowserSession'));
        sessionMgr.clearSession();
      } catch { /* not available */ }

      const mgr = getConfigManager();
      if (!mgr) {
        res.json({ success: true, message: 'Disconnected' });
        return;
      }

      const secrets = mgr.loadSecrets();
      const keysToRemove = [
        'facebookPageAccessToken', 'facebookPageId', 'facebookPageName',
        'facebookUserAccessToken', 'facebookUserId', 'facebookTokenExpiresAt',
        'facebookConnectedAt',
      ];
      for (const key of keysToRemove) {
        delete secrets[key];
      }
      mgr.saveSecrets(secrets);

      logger.info('Facebook credentials disconnected');
      res.json({ success: true, message: 'Facebook disconnected' });
    } catch (err) {
      logger.error({ err }, 'Facebook disconnect failed');
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  // ── GET /pages ────────────────────────────────────────────────────────
  router.get('/pages', requiresAuth, requiresOperator, async (_req: Request, res: Response) => {
    try {
      const mgr = getConfigManager();
      if (!mgr) {
        res.status(500).json({ success: false, error: 'Config manager unavailable' });
        return;
      }

      const secrets = mgr.loadSecrets();
      const userToken = secrets.facebookUserAccessToken;
      if (!userToken) {
        res.status(400).json({ success: false, error: 'Not connected — no user token available' });
        return;
      }

      const pagesRes = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
        params: { access_token: userToken, fields: 'id,name,category,access_token' },
      });

      const pages = (pagesRes.data.data || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        category: p.category,
      }));

      res.json({ success: true, pages, activePage: secrets.facebookPageId || null });
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error({ err: msg }, 'Failed to list Facebook pages');
      res.status(400).json({ success: false, error: msg });
    }
  });

  // ── POST /switch-page ─────────────────────────────────────────────────
  router.post('/switch-page', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const { pageId } = req.body || {};
    if (!pageId) {
      res.status(400).json({ success: false, error: 'pageId is required' });
      return;
    }

    try {
      const mgr = getConfigManager();
      if (!mgr) {
        res.status(500).json({ success: false, error: 'Config manager unavailable' });
        return;
      }

      const secrets = mgr.loadSecrets();
      const userToken = secrets.facebookUserAccessToken;
      if (!userToken) {
        res.status(400).json({ success: false, error: 'Not connected' });
        return;
      }

      // Get page token for the requested page
      const pagesRes = await axios.get(`${GRAPH_API_BASE}/me/accounts`, {
        params: { access_token: userToken, fields: 'id,name,access_token' },
      });
      const page = (pagesRes.data.data || []).find((p: any) => p.id === pageId);
      if (!page) {
        res.status(404).json({ success: false, error: `Page ${pageId} not found or not managed by this account` });
        return;
      }

      // Update stored credentials
      secrets.facebookPageAccessToken = page.access_token;
      secrets.facebookPageId = page.id;
      secrets.facebookPageName = page.name;
      mgr.saveSecrets(secrets);

      logger.info({ pageId: page.id, pageName: page.name }, 'Switched active Facebook page');
      res.json({ success: true, pageId: page.id, pageName: page.name });
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message;
      logger.error({ err: msg }, 'Failed to switch Facebook page');
      res.status(400).json({ success: false, error: msg });
    }
  });

  return router;
}
