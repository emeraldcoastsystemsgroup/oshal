/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Multi-provider login registry (ADR-126): per-provider enable flags (GOOGLE_LOGIN / MICROSOFT_LOGIN), request→provider dispatch shared by the OIDC middleware, and the /login chooser page shown when more than one provider is enabled. The legacy single-issuer config (OIDC_ISSUER_URL / Keycloak) stays the "primary" provider on the already-registered /callback; secondaries get /login/<name> + /callback/<name> and their own session cookie.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Third provider: `outlook` (OUTLOOK_LOGIN) — personal outlook.com/hotmail sign-in via the FIXED Entra consumers tenant (9188040d-…), whose issuer is stable and passes strict OIDC validation (live-verified). Credentials default to the MICROSOFT_OIDC_* app (one Azure registration, two doors: org directory + personal MSA — registration was live-verified to accept personal accounts). Chooser buttons now carry inline-SVG provider icons.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'oidc-providers' });

/**
 * @description Known login provider identities. `microsoft` is work/school
 * accounts in a specific Entra directory; `outlook` is personal Microsoft
 * accounts (outlook.com/hotmail) via the fixed consumers tenant. `primary`
 * names a legacy issuer that is none of these (e.g. a Keycloak realm).
 */
export type LoginProviderName = 'google' | 'microsoft' | 'outlook' | 'primary';

/**
 * @description The fixed, global Entra tenant id that holds every personal
 * Microsoft account (outlook.com / hotmail / live). Its issuer is stable, so —
 * unlike `common`/`organizations` — it passes strict OIDC issuer validation.
 */
export const MSA_CONSUMERS_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

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
  // The consumers tenant is personal-account login — sniff it BEFORE the generic
  // microsoftonline test so OUTLOOK_LOGIN (not MICROSOFT_LOGIN) governs it.
  if (issuerBaseURL.toLowerCase().includes(MSA_CONSUMERS_TENANT)) return 'outlook';
  if (/login\.microsoftonline\.com/i.test(issuerBaseURL)) return 'microsoft';
  return 'primary';
}

const PROVIDER_LABELS: Record<LoginProviderName, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  outlook: 'Outlook.com',
  primary: 'SSO',
};

// Inline SVG button icons for the chooser (self-contained — the login page must
// not fetch external assets). Google/Microsoft are their standard sign-in marks;
// Outlook.com is an envelope in Outlook blue; `primary` is a generic key.
const PROVIDER_ICONS: Record<LoginProviderName, string> = {
  google:
    '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>',
  microsoft:
    '<svg viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>',
  outlook:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2" fill="#0F6CBD"/><path d="M2 6.5l10 6.5 10-6.5" stroke="#fff" stroke-width="1.6" fill="none"/></svg>',
  primary:
    '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2m-4 4 3 3"/></svg>',
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
 * @description Builds the Outlook.com (personal Microsoft account) secondary
 * provider: the fixed consumers tenant, so outlook.com/hotmail/live accounts
 * sign in while the `microsoft` provider stays restricted to the org directory.
 * Credentials default to the MICROSOFT_OIDC_* app — one Azure registration
 * serves both doors when its supported-account-types includes personal
 * accounts — and can be overridden with OUTLOOK_OIDC_CLIENT_ID/SECRET.
 *
 * @param env - Environment map (injectable for tests)
 * @returns The Outlook.com provider definition
 */
function buildOutlookProvider(env: NodeJS.ProcessEnv): LoginProvider {
  const clientID = ((env.OUTLOOK_OIDC_CLIENT_ID ?? '').trim() || (env.MICROSOFT_OIDC_CLIENT_ID ?? '').trim());
  const clientSecret =
    (env.OUTLOOK_OIDC_CLIENT_SECRET ?? '').trim() || (env.MICROSOFT_OIDC_CLIENT_SECRET ?? '').trim();

  if (!clientID || !clientSecret) {
    throw new Error(
      'OUTLOOK_LOGIN=true requires client credentials — set OUTLOOK_OIDC_CLIENT_ID and ' +
        'OUTLOOK_OIDC_CLIENT_SECRET (or the MICROSOFT_OIDC_* pair they default to). ' +
        'Refusing to boot with a half-configured login provider.',
    );
  }

  return {
    name: 'outlook',
    label: PROVIDER_LABELS.outlook,
    issuerBaseURL: `https://login.microsoftonline.com/${MSA_CONSUMERS_TENANT}/v2.0`,
    clientID,
    clientSecret,
    isPrimary: false,
    loginPath: '/login/outlook',
    callbackPath: '/callback/outlook',
    cookieName: `${DEFAULT_SESSION_COOKIE}_outlook`,
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
        : name === 'outlook'
          ? envFlag(env.OUTLOOK_LOGIN, dflt)
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
  if (primaryName !== 'outlook' && envFlag(env.OUTLOOK_LOGIN, false)) {
    providers.push(buildOutlookProvider(env));
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
        `${PROVIDER_ICONS[p.name]}<span>Continue with ${escapeHtml(p.label)}</span></a>`,
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
  .btn { display: flex; align-items: center; justify-content: center; gap: .65rem;
         margin: .6rem 0; padding: .7rem 1rem; border-radius: 9px;
         border: 1px solid light-dark(#d4d9e2, #303849); text-decoration: none;
         color: inherit; font-size: .95rem; font-weight: 500; }
  .btn svg { width: 20px; height: 20px; flex: none; }
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
