/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of OIDC middleware using express-openid-connect
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed redirect_uri override and used default callback route handling
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Initialized auth() once per app to preserve sessions across requests
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Used browser issuer URL for OIDC discovery in containerized networking
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed OIDC middleware construction into sub-50-line functions
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added HTTP request patching for localhost to keycloak docker routing
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Removed unused openid-client Issuer import
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added MOCK_OIDC mode for local development without Keycloak
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log attribution/timestamps per governance rules
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Returned 401 for unauthenticated API/fetch requests to avoid concurrent OIDC state overwrites during login redirects
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Generic OIDC issuer support: set OIDC_ISSUER_URL (+ OIDC_CLIENT_ID/SECRET) to use ANY OIDC IdP — primarily Microsoft Entra ID for K-12 (https://login.microsoftonline.com/{tenant}/v2.0). Falls back to the Keycloak realm construction when unset. No Docker http-patching for cloud issuers.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Per-host OIDC baseURL (OIDC_BASE_URLS): run one auth() instance per sibling subdomain keyed on req.hostname, so each host logs in against its own /callback. Fixes the cross-host login loop where the mid-login state cookie was set on one host (e.g. oshal) but the callback landed on the APP_URL host (littlemonster). Unset = single-host (APP_URL), prior behavior.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | SESSION_COOKIE_DOMAIN is now resolved PER HOST (resolveCookieDomainForHost, comma-separated list supported): a fixed domain was applied to every per-host auth instance, so on a host outside that domain (dnd.oshal.ai vs .agenticfederal.us) the browser rejected the transient state cookie (express-openid-connect's transientHandler inherits session cookie domain) and every login died at /callback with "checks.state argument is missing". A host that matches no configured domain now gets a host-only cookie.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Harden /callback: a failed token exchange (reused single-use auth code from a replayed/stale callback URL, lost transient cookie, or clock skew) used to escape as an unhandled Express 500 ('id_token not present in TokenSet') and show users a broken page. Now caught in authMiddleware → restart a clean interactive login once (cookie-guarded against loops); a second failure falls through to the normal handler.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Raise OIDC httpTimeout to 15s (default 5s). A transient slow response from the issuer's discovery endpoint (Issuer.discover) surfaced to satellite users as a raw "Timeout awaiting request for 5000ms" white page on /login. Override via OIDC_HTTP_TIMEOUT_MS.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Deep links survive login recovery: the stock /login route hardcodes returnTo=baseURL, so every recovery path that restarts a login (guardedCallback retry, state-mismatch restart, the cockpit 401 guard) forgot the original URL — a /cockpit/?app=<name> shortcut double-logged-in and landed on the bare cockpit. routes.login=false disables the stock route; createOidcMiddleware now returns a loginHandler honoring a sanitized same-origin ?returnTo (mock mode included), guardedCallback re-derives returnTo from the callback state, and the state-decode helpers move here from server-auth-helpers so both layers share one implementation.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Export shouldReturnUnauthorizedResponse so the LOCAL_AUTH middleware set (ADR-117, src/app/routes/local-auth-routes.ts) answers API/fetch vs browser-document requests with the SAME 401-JSON/redirect split as this wrapper — one discrimination rule, not two drifting copies.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Stamp MOCK_OIDC identities with an explicit synthetic issuer so downstream account binding uses the same verified (issuer, subject) namespace as real OIDC instead of app-specific fallback logic.
 */

import { auth, requiresAuth, ConfigParams } from 'express-openid-connect';
import { type Request, type RequestHandler } from 'express';
import http from 'http';
import { createChildLogger } from '@/shared/logger';
import { MOCK_OIDC_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';

const logger = createChildLogger({ module: 'oidc-middleware' });

/**
 * @description Checks if Mock OIDC mode is enabled via the MOCK_OIDC env var.
 *
 * @returns true if MOCK_OIDC is set to a truthy value ('true', '1', 'yes')
 */
export function isMockOidcEnabled(): boolean {
  const val = (process.env.MOCK_OIDC ?? '').toLowerCase().trim();
  return val === 'true' || val === '1' || val === 'yes';
}

/**
 * @description Checks if mock OIDC may read x-mock-oidc-* headers. This is
 * only honored inside MOCK_OIDC mode so production OIDC never trusts test
 * identity headers.
 */
export function isMockOidcHeaderOverrideEnabled(): boolean {
  const val = (process.env.MOCK_OIDC_ALLOW_HEADER ?? '').toLowerCase().trim();
  return val === 'true' || val === '1' || val === 'yes';
}

type MockOidcUser = {
  iss: string;
  sub: string;
  name: string;
  email: string;
  preferred_username: string;
};

/**
 * @description The middleware set both OIDC modes hand back to the server: the global
 * session middleware, the route-level auth guard, and the /login route handler (the
 * stock express-openid-connect login route is disabled so ?returnTo can be honored).
 */
export type OidcMiddlewareSet = {
  authMiddleware: RequestHandler;
  requiresAuth: RequestHandler;
  loginHandler: RequestHandler;
};

/**
 * @description Validates a login returnTo candidate as a safe same-origin relative path.
 * Anything else — absolute URLs, protocol-relative //host, backslash tricks, header-splitting
 * control characters — resolves to undefined so login falls back to the default landing.
 * This is the open-redirect gate for every /login?returnTo= consumer; keep it strict.
 *
 * @param value - Raw returnTo candidate (query param or decoded OIDC state value)
 * @returns The path when it is a same-origin relative path; otherwise undefined
 */
export function sanitizeLoginReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) {
    return undefined;
  }
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * @description Decodes an OIDC callback state payload to recover the returnTo path the
 * interrupted login was carrying (express-openid-connect base64url-encodes {returnTo} there).
 *
 * @param stateValue - Raw `state` query parameter from a callback request
 * @returns Decoded returnTo path when present and valid
 */
function decodeOidcReturnToState(stateValue: unknown): string | undefined {
  if (typeof stateValue !== 'string' || stateValue.length === 0) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(stateValue, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as { returnTo?: unknown };

    if (typeof parsed.returnTo !== 'string' || parsed.returnTo.length === 0) {
      return undefined;
    }

    return parsed.returnTo;
  } catch (error) {
    logger.warn({ err: error, stateLength: stateValue.length }, 'Failed to decode OIDC callback state payload');
    return undefined;
  }
}

/**
 * @description Builds a login restart path that preserves the interrupted login's returnTo
 * (recovered from the callback state and sanitized), so a recovery relogin lands the user
 * back on the URL they originally asked for instead of the bare landing surface.
 *
 * @param stateValue - Raw `state` query parameter from the failed callback request
 * @returns Login URL with an encoded returnTo query parameter when one can be recovered
 */
export function buildOidcLoginRestartPath(stateValue: unknown): string {
  const returnTo = sanitizeLoginReturnTo(decodeOidcReturnToState(stateValue));
  if (!returnTo) {
    return '/login';
  }

  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * @description Creates a mock OIDC middleware pair that bypasses real Keycloak
 * authentication. Injects a fake user session so all protected routes work
 * without a running identity provider. Only for local development.
 *
 * @returns Object with authMiddleware (no-op session injector), requiresAuth (pass-through), and loginHandler (returnTo redirect)
 */
function createMockOidcMiddleware(): OidcMiddlewareSet {
  if (isMockOidcHeaderOverrideEnabled()) {
    logger.warn('MOCK_OIDC_ALLOW_HEADER enabled: x-mock-oidc-* request headers can select the mock user.');
  }
  logger.warn('🔓 MOCK OIDC MODE ENABLED — authentication is bypassed. Do NOT use in production.');

  // Generic demo identity for MOCK_OIDC mode (values are asserted by several specs —
  // keep stable). Override with MOCK_OIDC_EMAIL/NAME/SUB.
  const mockEmail = process.env.MOCK_OIDC_EMAIL || 'alex@demo.local';
  const mockUser: MockOidcUser = {
    iss: MOCK_OIDC_PRINCIPAL_ISSUER,
    sub: process.env.MOCK_OIDC_SUB || 'mock-user-001',
    name: process.env.MOCK_OIDC_NAME || 'Alex Monster',
    email: mockEmail,
    preferred_username: mockEmail,
  };

  const authMiddleware: RequestHandler = (req, _res, next) => {
    // Inject a fake oidc object that mimics express-openid-connect's req.oidc
    (req as any).oidc = {
      isAuthenticated: () => true,
      user: resolveMockOidcUser(req, mockUser),
      idToken: 'mock-id-token',
      accessToken: 'mock-access-token',
    };
    next();
  };

  const mockRequiresAuth: RequestHandler = (_req, _res, next) => {
    // In mock mode, all requests are considered authenticated
    next();
  };

  // Mock mode has no IdP round-trip — /login just honors the same sanitized returnTo
  // contract as the real handler so deep-link specs exercise the identical route shape.
  const mockLoginHandler: RequestHandler = (req, res) => {
    res.redirect(302, sanitizeLoginReturnTo(req.query.returnTo) ?? '/');
  };

  return { authMiddleware, requiresAuth: mockRequiresAuth, loginHandler: mockLoginHandler };
}

function resolveMockOidcUser(req: Request, fallback: MockOidcUser): MockOidcUser {
  if (!isMockOidcHeaderOverrideEnabled()) {
    return fallback;
  }
  const sub = readMockOidcHeader(req, 'x-mock-oidc-sub');
  if (!sub) {
    return fallback;
  }
  const email = readMockOidcHeader(req, 'x-mock-oidc-email') ?? `${sanitizeMockSubForEmail(sub)}@mock.local`;
  return {
    iss: fallback.iss,
    sub,
    email,
    name: readMockOidcHeader(req, 'x-mock-oidc-name') ?? email,
    preferred_username: email,
  };
}

function readMockOidcHeader(req: Request, name: string): string | undefined {
  const value = req.header(name);
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeMockSubForEmail(sub: string): string {
  return sub.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'mock-user';
}

/**
 * @description Reads OIDC-related environment variables and computes
 * the internal and browser-facing issuer URLs for Keycloak.
 *
 * @returns Object with all resolved OIDC environment settings
 */
function resolveOidcEnv() {
  const {
    // Generic OIDC issuer (Microsoft Entra ID, Okta, Auth0, …). When set, this
    // takes precedence over the Keycloak-specific construction below.
    OIDC_ISSUER_URL,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    KEYCLOAK_URL = 'http://localhost:8080',
    KEYCLOAK_EXTERNAL_URL,
    KEYCLOAK_REALM = 'oshal',
    KEYCLOAK_CLIENT_ID = 'oshal-swarm',
    KEYCLOAK_CLIENT_SECRET = '',
    SESSION_SECRET = process.env.AUTH_SESSION_SECRET || '',
    APP_URL = 'http://localhost:3456',
  } = process.env;

  // ── Generic issuer path (Microsoft Entra ID for K-12) ──────────────────────
  // Entra issuer: https://login.microsoftonline.com/{tenantId}/v2.0
  if (OIDC_ISSUER_URL && OIDC_ISSUER_URL.trim().length > 0) {
    logger.info({ issuerBaseURL: OIDC_ISSUER_URL }, 'OIDC middleware config: generic issuer (e.g. Microsoft Entra)');
    return {
      browserIssuerBaseURL: OIDC_ISSUER_URL.trim(),
      internalKeycloakHost: 'localhost', // cloud issuer — no Docker split-horizon patching
      KEYCLOAK_CLIENT_ID: OIDC_CLIENT_ID || '',
      KEYCLOAK_CLIENT_SECRET: OIDC_CLIENT_SECRET || '',
      SESSION_SECRET,
      APP_URL,
    };
  }

  // ── Keycloak path (self-hosted IdP) ────────────────────────────────────────
  const browserKeycloakUrl = KEYCLOAK_EXTERNAL_URL || KEYCLOAK_URL;
  const browserIssuerBaseURL = `${browserKeycloakUrl}/realms/${KEYCLOAK_REALM}`;

  // Extract internal Keycloak hostname for Docker routing
  const internalKeycloakHost = new URL(KEYCLOAK_URL).hostname;

  logger.info(
    {
      KEYCLOAK_URL,
      KEYCLOAK_EXTERNAL_URL,
      internalKeycloakHost,
      issuerBaseURL: browserIssuerBaseURL,
    },
    'OIDC middleware config: resolved URLs',
  );

  return {
    browserIssuerBaseURL,
    internalKeycloakHost,
    KEYCLOAK_CLIENT_ID,
    KEYCLOAK_CLIENT_SECRET,
    SESSION_SECRET,
    APP_URL,
  };
}

/**
 * @description Patches Node.js http.request to transparently route requests
 * from localhost:<port> to an internal Docker hostname. This solves the
 * Docker split-horizon DNS problem where Keycloak's OIDC discovery returns
 * localhost URLs that containers can't reach directly.
 *
 * @param internalHost - The Docker-internal hostname (e.g., 'keycloak')
 * @param port - The port to intercept (e.g., 8080)
 */
function patchHttpForDockerRouting(internalHost: string, port: number): void {
  if (internalHost === 'localhost') {
    return; // No patching needed in local dev
  }

  const originalRequest = http.request;
  const pattern = `http://localhost:${port}`;
  const replacement = `http://${internalHost}:${port}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (http as any).request = function patchedRequest(...args: any[]): http.ClientRequest {
    const first = args[0];

    if (typeof first === 'string' && first.includes(pattern)) {
      args[0] = first.replace(pattern, replacement);
      logger.debug({ original: first, rewritten: args[0] }, 'HTTP routed to internal host');
    } else if (first instanceof URL && first.hostname === 'localhost' && first.port === String(port)) {
      args[0] = new URL(first.href.replace(pattern, replacement));
      logger.debug({ original: first.href, rewritten: (args[0] as URL).href }, 'HTTP routed to internal host');
    } else if (first && typeof first === 'object' && !(first instanceof URL)) {
      const opts = first as Record<string, any>;
      if (opts.hostname === 'localhost' && (opts.port === port || opts.port === String(port))) {
        opts.hostname = internalHost;
        opts.host = `${internalHost}:${port}`;
        logger.debug({ internalHost, port }, 'HTTP options routed to internal host');
      }
    }

    return originalRequest.apply(http, args as any);
  };

  logger.info({ internalHost, port }, 'HTTP request patching enabled for Docker routing');
}

/**
 * @description Builds the express-openid-connect ConfigParams object
 * from the resolved environment settings.
 *
 * @param env - Resolved OIDC environment settings from resolveOidcEnv()
 * @param baseURL - The host origin this auth instance serves (its /callback +
 *   postLogoutRedirect are built from it). Lets one deployment run a separate
 *   auth instance per sibling subdomain so each logs in against itself.
 * @returns ConfigParams for the auth() middleware
 */
/**
 * @description Resolves which configured session-cookie domain (if any) applies to the
 * host an auth instance serves. SESSION_COOKIE_DOMAIN accepts a comma-separated list of
 * domains (e.g. ".agenticfederal.us,.oshal.ai"); the instance's hostname is matched
 * against each (exact or dot-suffix, case-insensitive) and the first hit wins. No match
 * returns undefined — a HOST-ONLY cookie — because a Set-Cookie whose Domain does not
 * cover the serving host is silently rejected by the browser, which also kills the OIDC
 * transient state cookie (transientHandler inherits the session cookie's domain) and
 * fails every login on that host at /callback with "checks.state argument is missing".
 * @param configured - Raw SESSION_COOKIE_DOMAIN value (single domain or comma-separated list)
 * @param baseURL - The origin the auth instance serves (its hostname is matched)
 * @returns The matching cookie domain to set, or undefined for a host-only cookie
 */
export function resolveCookieDomainForHost(configured: string | undefined, baseURL: string): string | undefined {
  if (!configured) return undefined;
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const raw of configured.split(',')) {
    const domain = raw.trim().toLowerCase();
    if (!domain) continue;
    const bare = domain.startsWith('.') ? domain.slice(1) : domain;
    if (hostname === bare || hostname.endsWith(`.${bare}`)) return domain;
  }
  return undefined;
}

function buildOidcConfig(env: ReturnType<typeof resolveOidcEnv>, baseURL: string): ConfigParams {
  const { browserIssuerBaseURL, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET, SESSION_SECRET } = env;
  const hasClientSecret = KEYCLOAK_CLIENT_SECRET.length > 0;
  const sessionSecret = SESSION_SECRET || KEYCLOAK_CLIENT_SECRET;

  if (!sessionSecret) {
    throw new Error('SESSION_SECRET or KEYCLOAK_CLIENT_SECRET must be set for OIDC session encryption.');
  }

  // RP-initiated (IdP) logout needs the issuer to publish an `end_session_endpoint`.
  // Google does NOT (its discovery omits it), so /logout throws "end_session_endpoint
  // must be configured on the issuer". Keycloak and Microsoft Entra DO publish it.
  // Enable IdP logout only for issuers that support it; for Google we fall back to a
  // local session clear (the user stays signed into Google, the app session ends).
  const idpSupportsLogout = !/accounts\.google\.com/i.test(browserIssuerBaseURL || '');

  // Discovery + token calls to the issuer time out at 5s by default; a momentary
  // slow response from Google then showed satellite users a raw "Timeout awaiting
  // request for 5000ms" page on /login. Give the issuer more room (override via env).
  const httpTimeout = Math.max(1000, Number(process.env.OIDC_HTTP_TIMEOUT_MS) || 15000);

  return {
    issuerBaseURL: browserIssuerBaseURL,
    baseURL,
    clientID: KEYCLOAK_CLIENT_ID,
    ...(hasClientSecret ? { clientSecret: KEYCLOAK_CLIENT_SECRET } : {}),
    secret: sessionSecret,
    httpTimeout,
    idpLogout: idpSupportsLogout,
    authRequired: false,
    clientAuthMethod: hasClientSecret ? 'client_secret_basic' : 'none',
    authorizationParams: {
      response_type: 'code',
      scope: 'openid profile email',
    },
    routes: {
      callback: '/callback',
      // The stock login route hardcodes returnTo=baseURL, silently discarding any
      // ?returnTo= a recovery path passes. Disabled — server.ts registers the
      // loginHandler returned below, which honors a sanitized same-origin returnTo.
      login: false,
      logout: '/logout',
      postLogoutRedirect: baseURL,
    },
    session: {
      rolling: true,
      rollingDuration: 60 * 60,
      absoluteDuration: 24 * 60 * 60,
      // Share the login session across sibling subdomains (e.g. littlemonster +
      // oshal under .agenticfederal.us, or the *.oshal.ai app bundles) so one
      // sign-in covers each family. Resolved PER HOST: a domain that does not
      // cover this instance's hostname must not be set at all — the browser
      // rejects the cookie AND the transient state cookie that inherits it,
      // which breaks login outright. Host-only when nothing matches.
      ...(() => {
        const domain = resolveCookieDomainForHost(process.env.SESSION_COOKIE_DOMAIN, baseURL);
        return domain ? { cookie: { domain } } : {};
      })(),
    },
  };
}

/**
 * @description Detects API/programmatic requests that should receive HTTP 401
 * instead of triggering OIDC login redirects.
 *
 * @param req - Express request evaluated by auth guard
 * @returns true when request should return 401 JSON on unauthenticated access
 */
export function shouldReturnUnauthorizedResponse(req: Parameters<RequestHandler>[0]): boolean {
  const requestPath = typeof req.path === 'string' ? req.path : '';
  const requestBaseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const requestOriginalUrl = typeof req.originalUrl === 'string' ? req.originalUrl : '';
  const acceptHeader = typeof req.headers.accept === 'string' ? req.headers.accept : '';
  const fetchDestination = typeof req.headers['sec-fetch-dest'] === 'string' ? req.headers['sec-fetch-dest'] : '';

  if (
    requestPath === '/api' ||
    requestPath.startsWith('/api/') ||
    requestBaseUrl === '/api' ||
    requestBaseUrl.startsWith('/api/') ||
    requestOriginalUrl === '/api' ||
    requestOriginalUrl.startsWith('/api/')
  ) {
    return true;
  }

  if (acceptHeader.includes('application/json')) {
    return true;
  }

  return fetchDestination === 'empty';
}

/**
 * @description Wraps the requiresAuth() middleware with structured logging
 * for authentication success/failure tracking.
 *
 * @returns Express RequestHandler that enforces authentication with logging
 */
function createRequiresAuthWrapper(): RequestHandler {
  const handler = requiresAuth();

  return (req, res, next) => {
    logger.info({ path: req.path, method: req.method }, 'requiresAuth invoked');

    if (req.oidc && req.oidc.isAuthenticated()) {
      logger.info({ path: req.path, method: req.method, user: req.oidc.user }, 'Authenticated request');
      next();
      return;
    }

    if (shouldReturnUnauthorizedResponse(req)) {
      logger.warn({ path: req.path, method: req.method }, 'Unauthenticated API/fetch request rejected without redirect');
      res.status(401).json({
        authenticated: false,
        error: 'unauthorized',
        loginPath: '/login',
      });
      return;
    }

    handler(req, res, (err?: any) => {
      if (err) {
        logger.warn({ path: req.path, method: req.method, error: err }, 'Authentication failed');
        return next(err);
      }
      if (req.oidc && req.oidc.isAuthenticated()) {
        logger.info({ path: req.path, method: req.method, user: req.oidc.user }, 'Authenticated request');
      } else {
        logger.warn({ path: req.path, method: req.method }, 'Unauthenticated request');
      }
      next();
    });
  };
}

/**
 * @description Resolves the distinct host origins allowed to complete an OIDC
 * login. `OIDC_BASE_URLS` (comma-separated full origins) enables per-host login
 * for a deployment served on multiple sibling subdomains; unset falls back to
 * `[appUrl]` (single-host, prior behavior). The APP_URL origin is always included
 * and used as the default for unmatched hosts.
 *
 * @param appUrl - The default base URL (APP_URL).
 * @returns Ordered, de-duplicated array of origin strings.
 */
function resolveBaseUrls(appUrl: string): string[] {
  const configured = (process.env.OIDC_BASE_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origins = configured.length > 0 ? [appUrl, ...configured] : [appUrl];
  return Array.from(new Set(origins));
}

/**
 * @description True when the request targets the OIDC redirect callback route,
 * where a token-exchange failure must restart login rather than crash with a 500.
 *
 * @param req - Express request flowing through the OIDC auth middleware.
 * @returns true if the path is the /callback route.
 */
function isOidcCallbackRequest(req: Parameters<RequestHandler>[0]): boolean {
  const path = typeof req.path === 'string' ? req.path : '';
  return path === '/callback' || path.endsWith('/callback');
}

/**
 * @description Runs the per-host auth() instance for a /callback request and
 * recovers from token-exchange failures instead of surfacing an unhandled 500.
 * The usual trigger is a reused single-use authorization code (a replayed/stale
 * callback URL); also covers lost transient cookies and clock skew. Restarts a
 * clean interactive login once — a short-lived cookie guards against a redirect
 * loop, so a second consecutive failure falls through to the normal handler.
 *
 * @param instance - The host's express-openid-connect auth() middleware.
 * @returns Express RequestHandler that wraps the callback with recovery.
 */
function guardedCallback(instance: RequestHandler): RequestHandler {
  return (req, res, next) =>
    instance(req, res, (err?: unknown) => {
      if (!err) return next();
      const alreadyRetried = (req.headers.cookie ?? '').includes('oidc_login_retry=1');
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), host: req.hostname, alreadyRetried },
        'OIDC callback failed — recovering instead of 500',
      );
      if (alreadyRetried) {
        res.setHeader('Set-Cookie', 'oidc_login_retry=; Path=/; Max-Age=0');
        return next(err);
      }
      res.setHeader('Set-Cookie', 'oidc_login_retry=1; Path=/; Max-Age=120; HttpOnly; SameSite=Lax');
      // Recover the interrupted login's destination from the callback state — a bare
      // /login restart forgot it, so a /cockpit/?app=<name> deep link double-logged-in
      // and stranded the user on the bare landing surface.
      return res.redirect(buildOidcLoginRestartPath(req.query.state));
    });
}

/**
 * @description Creates the OIDC middleware pair for Express: a global auth
 * middleware (session management) and a route-level requiresAuth guard. When
 * `OIDC_BASE_URLS` lists multiple origins, one auth() instance is built per host
 * and dispatched by `req.hostname` so each subdomain logs in against its own
 * /callback — the shared session cookie (SESSION_COOKIE_DOMAIN) then covers all.
 *
 * @returns Object with authMiddleware (global), requiresAuth (route guard), and loginHandler (/login route)
 */
export function createOidcMiddleware(): OidcMiddlewareSet {
  if (isMockOidcEnabled()) {
    return createMockOidcMiddleware();
  }

  const env = resolveOidcEnv();
  // Patch http.request once (no-op for cloud issuers / local dev) before building
  // any auth instances, so it isn't re-applied per host.
  patchHttpForDockerRouting(env.internalKeycloakHost, 8080);

  const baseUrls = resolveBaseUrls(env.APP_URL);
  const defaultHost = new URL(env.APP_URL).hostname;
  const byHost = new Map<string, RequestHandler>();
  for (const origin of baseUrls) {
    byHost.set(new URL(origin).hostname, auth(buildOidcConfig(env, origin)));
  }
  if (byHost.size > 1) {
    logger.info({ hosts: Array.from(byHost.keys()), defaultHost }, 'OIDC per-host login enabled');
  }

  const authMiddleware: RequestHandler = (req, res, next) => {
    const instance = byHost.get(req.hostname) ?? byHost.get(defaultHost)!;
    logger.debug({ path: req.path, method: req.method, host: req.hostname }, 'OIDC middleware invoked');
    if (isOidcCallbackRequest(req)) {
      return guardedCallback(instance)(req, res, next);
    }
    return instance(req, res, next);
  };

  // Replaces the disabled stock login route. Runs after authMiddleware (which attaches
  // res.oidc), starts an interactive login, and — unlike the stock route — carries a
  // sanitized same-origin ?returnTo through the IdP round-trip so deep links survive.
  const loginHandler: RequestHandler = (req, res, next) => {
    if (!res.oidc || typeof res.oidc.login !== 'function') {
      // authMiddleware did not attach a context (unexpected) — fall through rather than crash.
      logger.error({ path: req.path, host: req.hostname }, 'Login route reached without an OIDC response context');
      next();
      return;
    }
    const returnTo = sanitizeLoginReturnTo(req.query.returnTo) ?? '/';
    logger.info({ returnTo, host: req.hostname }, 'Interactive login starting');
    void res.oidc.login({ returnTo });
  };

  return {
    authMiddleware,
    requiresAuth: createRequiresAuthWrapper(),
    loginHandler,
  };
}
