/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | OAuth start now requests scopes from FACEBOOK_SCOPES (default public_profile) and supports FACEBOOK_CONFIG_ID for Login-for-Business config-driven auth instead of a raw scope list
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Capture + unref the CSRF-state cleanup interval (2026-07-05 leak audit)
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
 * Credentials are stored via the existing EncryptedConfigManager so they
 * persist across restarts and are encrypted at rest.
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'facebook-auth-routes' });

const GRAPH_API_VERSION = 'v18.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const OAUTH_BASE = 'https://www.facebook.com';

// In-memory state store for CSRF protection (short-lived, 10-minute TTL)
const pendingStates = new Map<string, { createdAt: number; redirectUri: string }>();

// Clean up expired states every 5 minutes (unref so the module-level timer never pins the process)
const stateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingStates.entries()) {
    if (now - value.createdAt > 10 * 60 * 1000) {
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
 * Build a self-closing HTML page for the OAuth popup.
 */
function buildCallbackHtml(success: boolean, error?: string | null, pageName?: string): string {
  const title = success ? 'Facebook Connected' : 'Facebook Connection Failed';
  const body = success
    ? `<h2>Connected to Facebook</h2><p>Page: <strong>${pageName || 'Unknown'}</strong></p><p>You can close this window.</p>`
    : `<h2>Connection Failed</h2><p>${error || 'Unknown error'}</p>`;

  return `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#eee;}
.card{text-align:center;padding:2rem;border-radius:12px;background:#222;max-width:400px;}</style></head>
<body><div class="card">${body}</div>
<script>setTimeout(()=>window.close(),3000)</script></body></html>`;
}

/**
 * Resolve the EncryptedConfigManager from the app context.
 */
function getConfigManager(): any {
  try {
    const path = require('path');
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
    const encryptionKey = process.env.ENCRYPTION_KEY || null;
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
 * Facebook integration endpoints (login, credentials, status, OAuth start/callback,
 * disconnect, page listing and page switching). Centralizing route creation in a
 * factory lets the host application inject its own authentication middleware so
 * sensitive page-management routes can be protected without hard-coding auth here.
 * @param requiresAuth Express middleware used to gate the protected routes
 * (currently /pages and /switch-page) behind the application's authentication.
 * @returns A configured Express Router ready to be mounted under the
 * facebook-auth path prefix.
 */
export function createFacebookAuthRoutes(requiresAuth: RequestHandler): Router {
  const router = Router();

  // ── GET /app ─────────────────────────────────────────────────────────
  // Self-contained login/settings page served as static HTML.
  // Embedded by the cockpit ribbon when the facebook-bot registers its tool UI.
  router.get('/app', (_req: Request, res: Response) => {
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
  // Browser-based Facebook login — uses Playwright to log in, saves session.
  // No Facebook App registration required.
  router.post('/login', async (req: Request, res: Response) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ success: false, error: 'Email and password are required' });
      return;
    }
    try {
      const path = require('path');
      const sessionMgr = require(path.resolve(process.cwd(), 'any-bot/server/services/tools/facebook/facebookBrowserSession'));
      const result = await sessionMgr.login(email, password);
      res.json(result);
    } catch (err: any) {
      logger.error({ err }, 'Facebook login failed');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── POST /credentials ─────────────────────────────────────────────────
  // Save Facebook App ID and App Secret from the login form.
  router.post('/credentials', async (req: Request, res: Response) => {
    const { appId, appSecret } = req.body || {};
    if (!appId || !appSecret) {
      res.status(400).json({ success: false, error: 'appId and appSecret are required' });
      return;
    }
    try {
      const mgr = getConfigManager();
      if (!mgr) {
        res.status(500).json({ success: false, error: 'Config manager unavailable' });
        return;
      }
      const secrets = mgr.loadSecrets();
      secrets.facebookAppId = appId;
      secrets.facebookAppSecret = appSecret;
      mgr.saveSecrets(secrets);
      logger.info('Facebook App credentials saved via login form');
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, 'Failed to save Facebook credentials');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── GET /status ──────────────────────────────────────────────────────
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      // Check browser session first (the simple login path)
      try {
        const path = require('path');
        const sessionMgr = require(path.resolve(process.cwd(), 'any-bot/server/services/tools/facebook/facebookBrowserSession'));
        const session = sessionMgr.getSessionStatus();
        if (session.connected) {
          res.json({
            connected: true,
            tokenValid: true,
            userName: session.userName,
            userId: session.userId,
            pageName: session.userName,
            pages: session.pages || [],
            loginTime: session.loginTime,
          });
          return;
        }
      } catch { /* browser session module not available, fall through to OAuth path */ }

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
  router.get('/start', async (req: Request, res: Response) => {
    const { appId } = loadAppCredentials();
    if (!appId) {
      res.status(400).json({ success: false, error: 'Enter your Facebook App ID and App Secret first' });
      return;
    }

    const state = crypto.randomBytes(32).toString('hex');
    const redirectUri = buildCallbackUri(req);

    pendingStates.set(state, { createdAt: Date.now(), redirectUri });

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

    logger.info({ redirectUri, scopes: configId ? undefined : scopes, usesConfigId: Boolean(configId) }, 'Facebook OAuth flow started');
    res.json({ success: true, authUrl });
  });

  // ── GET /callback ────────────────────────────────────────────────────
  router.get('/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const errorParam = req.query.error as string | undefined;
    const errorDescription = req.query.error_description as string | undefined;

    if (errorParam) {
      logger.warn({ errorParam, errorDescription }, 'Facebook OAuth error');
      res.status(400).send(buildCallbackHtml(false, errorDescription || errorParam));
      return;
    }

    if (!state || !code) {
      res.status(400).send(buildCallbackHtml(false, 'Missing state or code parameter'));
      return;
    }

    // Verify CSRF state
    const pending = pendingStates.get(state);
    if (!pending) {
      res.status(400).send(buildCallbackHtml(false, 'Invalid or expired state token'));
      return;
    }
    pendingStates.delete(state);

    const { appId, appSecret } = loadAppCredentials();

    if (!appId || !appSecret) {
      res.status(500).send(buildCallbackHtml(false, 'Facebook App ID and Secret not configured'));
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
        res.status(400).send(buildCallbackHtml(false, 'No Facebook pages found. You need to manage at least one Facebook page.'));
        return;
      }

      // Use first page (or the page matching FACEBOOK_PAGE_ID env var)
      const targetPageId = process.env.FACEBOOK_PAGE_ID;
      const selectedPage = targetPageId
        ? pages.find((p: any) => p.id === targetPageId) || pages[0]
        : pages[0];

      // Step 4: Store credentials
      const mgr = getConfigManager();
      if (!mgr) {
        res.status(500).send(buildCallbackHtml(false, 'Config manager unavailable'));
        return;
      }

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

      logger.info({ pageId: selectedPage.id, pageName: selectedPage.name }, 'Facebook OAuth: credentials stored');

      // Step 5: Broadcast to bot nodes via Redis (if available)
      try {
        const redis = require('../../shared/redis-client');
        if (redis?.getClient) {
          const client = redis.getClient();
          await client.publish('facebook.credentials.update', JSON.stringify({
            facebookPageAccessToken: selectedPage.access_token,
            facebookPageId: selectedPage.id,
            facebookPageName: selectedPage.name,
            facebookTokenExpiresAt: tokenExpiresAt,
            facebookConnectedAt: Date.now(),
          }));
          logger.info('Facebook credentials broadcast via Redis pubsub');
        }
      } catch {
        logger.debug('Redis broadcast skipped (not available)');
      }

      res.send(buildCallbackHtml(true, null, selectedPage.name));
    } catch (err: any) {
      const msg = err.response?.data?.error?.message || err.message || 'Unknown error';
      logger.error({ err: msg }, 'Facebook OAuth callback failed');
      res.status(400).send(buildCallbackHtml(false, msg));
    }
  });

  // ── POST /disconnect ─────────────────────────────────────────────────
  router.post('/disconnect', async (_req: Request, res: Response) => {
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

      // Broadcast disconnect to bot nodes
      try {
        const redis = require('../../shared/redis-client');
        if (redis?.getClient) {
          await redis.getClient().publish('facebook.credentials.update', JSON.stringify(null));
        }
      } catch {
        // Redis not available
      }

      logger.info('Facebook credentials disconnected');
      res.json({ success: true, message: 'Facebook disconnected' });
    } catch (err) {
      logger.error({ err }, 'Facebook disconnect failed');
      res.status(500).json({ success: false, error: 'Internal error' });
    }
  });

  // ── GET /pages ────────────────────────────────────────────────────────
  router.get('/pages', requiresAuth, async (_req: Request, res: Response) => {
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
  router.post('/switch-page', requiresAuth, async (req: Request, res: Response) => {
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

      // Broadcast update
      try {
        const redis = require('../../shared/redis-client');
        if (redis?.getClient) {
          await redis.getClient().publish('facebook.credentials.update', JSON.stringify({
            facebookPageAccessToken: page.access_token,
            facebookPageId: page.id,
            facebookPageName: page.name,
            facebookTokenExpiresAt: secrets.facebookTokenExpiresAt,
            facebookConnectedAt: secrets.facebookConnectedAt,
          }));
        }
      } catch {
        // Redis not available
      }

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
