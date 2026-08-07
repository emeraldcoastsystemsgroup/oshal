/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Multi-provider login registry (ADR-126): per-provider enable flags (GOOGLE_LOGIN / MICROSOFT_LOGIN), request→provider dispatch shared by the OIDC middleware, and the /login chooser page shown when more than one provider is enabled. The legacy single-issuer config (OIDC_ISSUER_URL / Keycloak) stays the "primary" provider on the already-registered /callback; secondaries get /login/<name> + /callback/<name> and their own session cookie.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'oidc-providers' });

/**
 * @description Known login provider identities. `primary` names a legacy issuer
 * that is neither Google nor Microsoft (e.g. a Keycloak realm or LinkedIn).
 */
export type LoginProviderName = 'google' | 'microsoft' | 'primary';

/**
 * @description One configured interactive login provider. The primary provider
 * rides the legacy routes (/callback + the default `appSession` cookie) so the
 * redirect URIs already registered with the IdP keep working; secondaries get
 * provider-suffixed routes and session cookies so several express-openid-connect
 * auth() instances can coexist without fighting over one cookie.
 */
export type LoginProvider = {
  name: LoginProviderName;
  /** Human label for the chooser button ("Continue with <label>"). */
  label: string;
  issuerBaseURL: string;
  clientID: string;
  clientSecret: string;
  /** True for the provider on the legacy /callback + default session cookie. */
  isPrimary: boolean;
  /** Interactive login entry route for this provider (e.g. /login/microsoft). */
  loginPath: string;
  /** OIDC redirect route — must be registered with the IdP for every login host. */
  callbackPath: string;
  /** Session cookie name; undefined keeps the library default (`appSession`). */
  cookieName?: string;
};

/**
 * @description How a request relates to the provider set: an interactive login
 * start, an OIDC callback, a logout, the multi-provider chooser page, or a
 * plain request that should run under whichever provider owns the session.
 */
export type ProviderRouteKind = 'login' | 'callback' | 'logout' | 'chooser' | 'session';

/**
 * @description Dispatch result: which provider's auth() instance must handle
 * this request, and in what role.
 */
export type ProviderRouteMatch = { provider: LoginProvider; kind: ProviderRouteKind };

/**
 * @description The primary provider's settings as resolved by the existing
 * single-issuer env logic (OIDC_ISSUER_URL / Keycloak construction).
 */
export type PrimaryOidcSettings = {
  issuerBaseURL: string;
  clientID: string;
  clientSecret: string;
};

/** Default session cookie name used by express-openid-connect. */
export const DEFAULT_SESSION_COOKIE = 'appSession';

/**
 * @description Parses a boolean env flag ('true'/'1'/'yes' → true,
 * 'false'/'0'/'no' → false, anything else → the default).
 *
 * @param value - Raw env value (may be undefined)
 * @param defaultValue - Result when the flag is unset or unrecognized
 * @returns The parsed flag
 */
export function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  const v = (value ?? '').toLowerCase().trim();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return defaultValue;
}

/**
 * @description Sniffs which provider a legacy issuer URL belongs to, so the
 * per-provider enable flag governs it and no duplicate secondary is added.
 *
 * @param issuerBaseURL - The resolved primary issuer URL
 * @returns The provider name the issuer belongs to
 */
export function sniffProviderName(issuerBaseURL: string): LoginProviderName {
  if (/accounts\.google\.com/i.test(issuerBaseURL)) return 'google';
  if (/login\.microsoftonline\.com/i.test(issuerBaseURL)) return 'microsoft';
  return 'primary';
}

const PROVIDER_LABELS: Record<LoginProviderName, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  primary: 'SSO',
};

/**
 * @description Builds the Microsoft Entra ID secondary provider from env.
 * Issuer must be tenant-specific (https://login.microsoftonline.com/<tenant>/v2.0):
 * the `common`/`organizations` endpoints advertise a templated issuer that fails
 * strict OIDC issuer validation, so they cannot be used here.
 *
 * @param env - Environment map (injectable for tests)
 * @returns The Microsoft provider definition
 */
function buildMicrosoftProvider(env: NodeJS.ProcessEnv): LoginProvider {
  const tenant = (env.MICROSOFT_TENANT_ID ?? '').trim();
  const issuer =
    (env.MICROSOFT_OIDC_ISSUER_URL ?? '').trim() ||
    (tenant ? `https://login.microsoftonline.com/${tenant}/v2.0` : '');
  const clientID = (env.MICROSOFT_OIDC_CLIENT_ID ?? '').trim();
  const clientSecret = (env.MICROSOFT_OIDC_CLIENT_SECRET ?? '').trim();

  if (!issuer || !clientID || !clientSecret) {
    throw new Error(
      'MICROSOFT_LOGIN=true requires MICROSOFT_OIDC_ISSUER_URL (or MICROSOFT_TENANT_ID) plus ' +
        'MICROSOFT_OIDC_CLIENT_ID and MICROSOFT_OIDC_CLIENT_SECRET — refusing to boot with a ' +
        'half-configured login provider.',
    );
  }

  return {
    name: 'microsoft',
    label: PROVIDER_LABELS.microsoft,
    issuerBaseURL: issuer,
    clientID,
    clientSecret,
    isPrimary: false,
    loginPath: '/login/microsoft',
    callbackPath: '/callback/microsoft',
    cookieName: `${DEFAULT_SESSION_COOKIE}_microsoft`,
  };
}

/**
 * @description Builds a Google secondary provider (only used when the legacy
 * primary issuer is NOT Google — e.g. a Keycloak/Entra primary with Google as
 * an additional button). Requires its own client credentials.
 *
 * @param env - Environment map (injectable for tests)
 * @returns The Google provider definition
 */
function buildGoogleSecondaryProvider(env: NodeJS.ProcessEnv): LoginProvider {
  const clientID = (env.GOOGLE_OIDC_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GOOGLE_OIDC_CLIENT_SECRET ?? '').trim();
  if (!clientID || !clientSecret) {
    throw new Error(
      'GOOGLE_LOGIN=true with a non-Google primary issuer requires GOOGLE_OIDC_CLIENT_ID and ' +
        'GOOGLE_OIDC_CLIENT_SECRET — refusing to boot with a half-configured login provider.',
    );
  }
  return {
    name: 'google',
    label: PROVIDER_LABELS.google,
    issuerBaseURL: 'https://accounts.google.com',
    clientID,
    clientSecret,
    isPrimary: false,
    loginPath: '/login/google',
    callbackPath: '/callback/google',
    cookieName: `${DEFAULT_SESSION_COOKIE}_google`,
  };
}

/**
 * @description Resolves the enabled login provider set from env. The legacy
 * single-issuer settings become the primary provider (keeping /callback and the
 * default session cookie so nothing already registered breaks); GOOGLE_LOGIN /
 * MICROSOFT_LOGIN toggle providers on and off. Defaults preserve today's
 * behavior exactly: with no flags set, the result is the primary provider alone.
 * Fail-closed: a flag enabling a provider whose credentials are missing throws,
 * as does disabling every provider.
 *
 * @param primary - Legacy-resolved issuer settings (OIDC_ISSUER_URL / Keycloak)
 * @param env - Environment map (injectable for tests; defaults to process.env)
 * @returns Ordered provider list, primary first
 */
export function resolveLoginProviders(
  primary: PrimaryOidcSettings,
  env: NodeJS.ProcessEnv = process.env,
): LoginProvider[] {
  const primaryName = sniffProviderName(primary.issuerBaseURL);
  const providers: LoginProvider[] = [];

  const flagFor = (name: LoginProviderName, dflt: boolean): boolean =>
    name === 'google'
      ? envFlag(env.GOOGLE_LOGIN, dflt)
      : name === 'microsoft'
        ? envFlag(env.MICROSOFT_LOGIN, dflt)
        : true; // an unrecognized primary issuer has no flag and stays on

  if (flagFor(primaryName, true)) {
    providers.push({
      name: primaryName,
      label: PROVIDER_LABELS[primaryName],
      issuerBaseURL: primary.issuerBaseURL,
      clientID: primary.clientID,
      clientSecret: primary.clientSecret,
      isPrimary: true,
      loginPath: `/login/${primaryName}`,
      callbackPath: '/callback',
      // cookieName stays undefined → default appSession, existing sessions survive.
    });
  }

  if (primaryName !== 'microsoft' && envFlag(env.MICROSOFT_LOGIN, false)) {
    providers.push(buildMicrosoftProvider(env));
  }
  if (primaryName !== 'google' && envFlag(env.GOOGLE_LOGIN, false)) {
    providers.push(buildGoogleSecondaryProvider(env));
  }

  if (providers.length === 0) {
    throw new Error(
      'Every login provider is disabled (GOOGLE_LOGIN/MICROSOFT_LOGIN) — refusing to boot a ' +
        'deployment nobody can sign in to. Enable at least one provider or use LOCAL_AUTH.',
    );
  }

  logger.info(
    { providers: providers.map((p) => ({ name: p.name, isPrimary: p.isPrimary, callbackPath: p.callbackPath })) },
    'Login providers resolved',
  );
  return providers;
}

/**
 * @description Tests whether a session cookie (or one of its `.0`/`.1` chunk
 * cookies — express-openid-connect splits large sessions) is present.
 *
 * @param cookieHeader - Raw Cookie request header ('' when absent)
 * @param cookieName - Base session cookie name
 * @returns true when the cookie or a chunk of it is present
 */
export function hasSessionCookie(cookieHeader: string, cookieName: string): boolean {
  const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|;\\s*)${escaped}(?:\\.\\d+)?=`).test(cookieHeader);
}

/**
 * @description Picks the provider whose session cookie is on the request. The
 * primary provider wins ties (its cookie name is the library default), then
 * secondaries in registry order; a request with no session cookie at all falls
 * back to the primary/first provider.
 *
 * @param providers - Enabled provider list (primary first)
 * @param cookieHeader - Raw Cookie request header
 * @returns The provider owning the request's session
 */
function providerForSession(providers: LoginProvider[], cookieHeader: string): LoginProvider {
  for (const p of providers) {
    if (hasSessionCookie(cookieHeader, p.cookieName ?? DEFAULT_SESSION_COOKIE)) return p;
  }
  return providers[0];
}

/**
 * @description Maps a request path (+ cookies) to the provider auth() instance
 * that must serve it. Exact-matches each provider's login and callback routes,
 * dispatches /logout and everything else by session cookie, and reports the
 * multi-provider chooser for a bare /login when more than one provider is on.
 *
 * @param providers - Enabled provider list (primary first)
 * @param path - Express req.path
 * @param cookieHeader - Raw Cookie request header ('' when absent)
 * @returns The provider and the role this request plays
 */
export function selectRequestProvider(
  providers: LoginProvider[],
  path: string,
  cookieHeader: string,
): ProviderRouteMatch {
  for (const p of providers) {
    if (path === p.callbackPath) return { provider: p, kind: 'callback' };
  }
  if (path === '/login') {
    return providers.length > 1
      ? { provider: providers[0], kind: 'chooser' }
      : { provider: providers[0], kind: 'login' };
  }
  const loginMatch = providers.find((p) => path === p.loginPath);
  if (loginMatch) return { provider: loginMatch, kind: 'login' };
  if (path.startsWith('/login/')) {
    // Unknown provider segment: fall back to the chooser (or the only provider).
    return providers.length > 1
      ? { provider: providers[0], kind: 'chooser' }
      : { provider: providers[0], kind: 'login' };
  }
  if (path === '/logout') {
    return { provider: providerForSession(providers, cookieHeader), kind: 'logout' };
  }
  return { provider: providerForSession(providers, cookieHeader), kind: 'session' };
}

/**
 * @description Maps an OIDC callback path back to the login route that should
 * restart an interrupted flow ('/callback' → '/login', '/callback/<name>' →
 * '/login/<name>'). Returns undefined for paths that are not login callbacks so
 * callers can leave other errors untouched.
 *
 * @param path - Express req.path of the failing request
 * @returns The provider-aware login restart base path, or undefined
 */
export function loginRestartPathForCallbackPath(path: string): string | undefined {
  if (path === '/callback') return '/login';
  const m = /^\/callback\/([a-z][a-z0-9-]*)$/.exec(path);
  return m ? `/login/${m[1]}` : undefined;
}

/**
 * @description Escapes a string for safe embedding in HTML text/attributes.
 *
 * @param value - Raw string
 * @returns HTML-escaped string
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @description Renders the /login chooser page shown when more than one login
 * provider is enabled: one button per provider, each carrying the sanitized
 * returnTo through to /login/<name> so deep links survive the extra hop.
 *
 * @param providers - Enabled provider list (primary first)
 * @param returnTo - Already-sanitized same-origin return path (optional)
 * @returns Full HTML document for the chooser page
 */
export function renderLoginChooser(providers: LoginProvider[], returnTo?: string): string {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
  const buttons = providers
    .map(
      (p) =>
        `<a class="btn" data-provider="${escapeHtml(p.name)}" href="${escapeHtml(p.loginPath + query)}">` +
        `Continue with ${escapeHtml(p.label)}</a>`,
    )
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — oshal</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
         background: light-dark(#f5f6f8, #10131a); color: light-dark(#1a2233, #e7ecf5); }
  .card { width: min(92vw, 380px); padding: 2.2rem 2rem; border-radius: 14px;
          background: light-dark(#ffffff, #1a1f2b); box-shadow: 0 8px 32px rgba(0,0,0,.18);
          text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 .4rem; font-weight: 600; }
  p  { margin: 0 0 1.4rem; font-size: .9rem; opacity: .75; }
  .btn { display: block; margin: .6rem 0; padding: .7rem 1rem; border-radius: 9px;
         border: 1px solid light-dark(#d4d9e2, #303849); text-decoration: none;
         color: inherit; font-size: .95rem; font-weight: 500; }
  .btn:hover { background: light-dark(#eef1f6, #232a3a); }
</style>
</head>
<body>
  <main class="card">
    <h1>Sign in to oshal</h1>
    <p>Choose how you want to sign in.</p>
      ${buttons}
  </main>
</body>
</html>`;
}
