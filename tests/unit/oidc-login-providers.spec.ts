/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guards for multi-provider login (ADR-126): flag/credential resolution stays fail-closed (a half-configured provider or an all-disabled set throws at boot), default env reproduces the legacy single-Google behavior exactly, request→provider dispatch routes provider-suffixed login/callback paths and cookie-owned sessions to the right auth() instance (chunked cookies included, suffixed names never shadow the primary), and the /login chooser escapes hostile returnTo values.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Third provider guards: `outlook` (OUTLOOK_LOGIN — personal MSA via the fixed consumers tenant) resolves with MICROSOFT_OIDC_* credential fallback and explicit OUTLOOK_OIDC_* override, fails closed with neither, dispatches on its own routes/cookie beside the other two, the consumers-tenant issuer sniffs to `outlook` (not `microsoft`), the chooser renders one SVG icon per provider, and the construction smoke now builds hosts × three providers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasSessionCookie,
  loginRestartPathForCallbackPath,
  MSA_CONSUMERS_TENANT,
  renderLoginChooser,
  resolveLoginProviders,
  selectRequestProvider,
  sniffProviderName,
  type LoginProvider,
} from '@/shared/middleware/oidc-providers';
import { buildOidcLoginRestartPath, createOidcMiddleware } from '@/shared/middleware/oidc';

const GOOGLE_PRIMARY = {
  issuerBaseURL: 'https://accounts.google.com',
  clientID: 'google-client',
  clientSecret: 'google-secret',
};

const MS_ENV = {
  MICROSOFT_LOGIN: 'true',
  MICROSOFT_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  MICROSOFT_OIDC_CLIENT_ID: 'ms-client',
  MICROSOFT_OIDC_CLIENT_SECRET: 'ms-secret',
};

describe('resolveLoginProviders', () => {
  it('reproduces legacy single-Google behavior with no flags set', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, {});
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      name: 'google',
      isPrimary: true,
      callbackPath: '/callback',
      loginPath: '/login/google',
      clientID: 'google-client',
    });
    // Primary must keep the library-default cookie so pre-existing sessions survive.
    expect(providers[0].cookieName).toBeUndefined();
  });

  it('adds Microsoft as a secondary with tenant-constructed issuer and suffixed routes/cookie', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, MS_ENV);
    expect(providers.map((p) => p.name)).toEqual(['google', 'microsoft']);
    const ms = providers[1];
    expect(ms).toMatchObject({
      isPrimary: false,
      issuerBaseURL: `https://login.microsoftonline.com/${MS_ENV.MICROSOFT_TENANT_ID}/v2.0`,
      clientID: 'ms-client',
      clientSecret: 'ms-secret',
      loginPath: '/login/microsoft',
      callbackPath: '/callback/microsoft',
      cookieName: 'appSession_microsoft',
    });
  });

  it('lets an explicit MICROSOFT_OIDC_ISSUER_URL override the tenant construction', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, {
      ...MS_ENV,
      MICROSOFT_OIDC_ISSUER_URL: 'https://login.microsoftonline.com/other-tenant/v2.0',
    });
    expect(providers[1].issuerBaseURL).toBe('https://login.microsoftonline.com/other-tenant/v2.0');
  });

  it('fails closed when MICROSOFT_LOGIN is on but credentials are incomplete', () => {
    expect(() =>
      resolveLoginProviders(GOOGLE_PRIMARY, { MICROSOFT_LOGIN: 'true', MICROSOFT_TENANT_ID: 't' }),
    ).toThrow(/MICROSOFT_OIDC_CLIENT_ID/);
    expect(() =>
      resolveLoginProviders(GOOGLE_PRIMARY, {
        MICROSOFT_LOGIN: 'true',
        MICROSOFT_OIDC_CLIENT_ID: 'x',
        MICROSOFT_OIDC_CLIENT_SECRET: 'y',
      }),
    ).toThrow(/MICROSOFT_OIDC_ISSUER_URL/);
  });

  it('GOOGLE_LOGIN=false leaves Microsoft as the only (still non-primary-routed) provider', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, { ...MS_ENV, GOOGLE_LOGIN: 'false' });
    expect(providers.map((p) => p.name)).toEqual(['microsoft']);
    expect(providers[0].callbackPath).toBe('/callback/microsoft');
  });

  it('fails closed when every provider is disabled', () => {
    expect(() => resolveLoginProviders(GOOGLE_PRIMARY, { GOOGLE_LOGIN: 'false' })).toThrow(/disabled/);
  });

  it('governs an Entra primary with MICROSOFT_LOGIN and never duplicates it as a secondary', () => {
    const entraPrimary = {
      issuerBaseURL: 'https://login.microsoftonline.com/tenant-id/v2.0',
      clientID: 'entra-client',
      clientSecret: 'entra-secret',
    };
    expect(sniffProviderName(entraPrimary.issuerBaseURL)).toBe('microsoft');
    const providers = resolveLoginProviders(entraPrimary, { MICROSOFT_LOGIN: 'true' });
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({ name: 'microsoft', isPrimary: true, callbackPath: '/callback' });
    // Google as a secondary next to an Entra primary needs its own credentials.
    expect(() => resolveLoginProviders(entraPrimary, { GOOGLE_LOGIN: 'true' })).toThrow(/GOOGLE_OIDC_CLIENT_ID/);
    const both = resolveLoginProviders(entraPrimary, {
      GOOGLE_LOGIN: 'true',
      GOOGLE_OIDC_CLIENT_ID: 'g',
      GOOGLE_OIDC_CLIENT_SECRET: 's',
    });
    expect(both.map((p) => p.name)).toEqual(['microsoft', 'google']);
    expect(both[1].callbackPath).toBe('/callback/google');
  });

  it('adds Outlook.com (personal MSA) on the consumers tenant, credentials falling back to the Microsoft app', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, { ...MS_ENV, OUTLOOK_LOGIN: 'true' });
    expect(providers.map((p) => p.name)).toEqual(['google', 'microsoft', 'outlook']);
    const outlook = providers[2];
    expect(outlook).toMatchObject({
      isPrimary: false,
      issuerBaseURL: `https://login.microsoftonline.com/${MSA_CONSUMERS_TENANT}/v2.0`,
      clientID: 'ms-client',
      clientSecret: 'ms-secret',
      loginPath: '/login/outlook',
      callbackPath: '/callback/outlook',
      cookieName: 'appSession_outlook',
    });
  });

  it('lets explicit OUTLOOK_OIDC_* credentials override the Microsoft fallback', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, {
      ...MS_ENV,
      OUTLOOK_LOGIN: 'true',
      OUTLOOK_OIDC_CLIENT_ID: 'own-client',
      OUTLOOK_OIDC_CLIENT_SECRET: 'own-secret',
    });
    expect(providers[2]).toMatchObject({ name: 'outlook', clientID: 'own-client', clientSecret: 'own-secret' });
  });

  it('works without MICROSOFT_LOGIN — outlook alone next to Google', () => {
    const providers = resolveLoginProviders(GOOGLE_PRIMARY, {
      OUTLOOK_LOGIN: 'true',
      MICROSOFT_OIDC_CLIENT_ID: 'ms-client',
      MICROSOFT_OIDC_CLIENT_SECRET: 'ms-secret',
    });
    expect(providers.map((p) => p.name)).toEqual(['google', 'outlook']);
  });

  it('fails closed when OUTLOOK_LOGIN is on with no credentials anywhere', () => {
    expect(() => resolveLoginProviders(GOOGLE_PRIMARY, { OUTLOOK_LOGIN: 'true' })).toThrow(/OUTLOOK_OIDC_CLIENT_ID/);
  });

  it('sniffs the consumers-tenant issuer to outlook, not microsoft', () => {
    expect(sniffProviderName(`https://login.microsoftonline.com/${MSA_CONSUMERS_TENANT}/v2.0`)).toBe('outlook');
  });

  it('keeps an unrecognized primary issuer (Keycloak) always on — it has no flag', () => {
    const providers = resolveLoginProviders(
      { issuerBaseURL: 'http://localhost:8080/realms/oshal', clientID: 'kc', clientSecret: 'kcs' },
      { GOOGLE_LOGIN: 'false', MICROSOFT_LOGIN: 'false' },
    );
    expect(providers.map((p) => p.name)).toEqual(['primary']);
  });
});

function twoProviders(): LoginProvider[] {
  return resolveLoginProviders(GOOGLE_PRIMARY, MS_ENV);
}

describe('selectRequestProvider', () => {
  it('runs everything under the only provider when a single one is enabled', () => {
    const only = resolveLoginProviders(GOOGLE_PRIMARY, {});
    expect(selectRequestProvider(only, '/login', '')).toMatchObject({ kind: 'login', provider: { name: 'google' } });
    expect(selectRequestProvider(only, '/callback', '')).toMatchObject({ kind: 'callback' });
    expect(selectRequestProvider(only, '/api/user', '')).toMatchObject({ kind: 'session' });
  });

  it('shows the chooser on bare /login (and unknown /login/<x>) only with several providers', () => {
    const providers = twoProviders();
    expect(selectRequestProvider(providers, '/login', '').kind).toBe('chooser');
    expect(selectRequestProvider(providers, '/login/doesnotexist', '').kind).toBe('chooser');
  });

  it('routes provider-suffixed login and callback paths to their provider', () => {
    const providers = twoProviders();
    expect(selectRequestProvider(providers, '/login/microsoft', '')).toMatchObject({
      kind: 'login',
      provider: { name: 'microsoft' },
    });
    expect(selectRequestProvider(providers, '/login/google', '')).toMatchObject({
      kind: 'login',
      provider: { name: 'google' },
    });
    expect(selectRequestProvider(providers, '/callback', '')).toMatchObject({
      kind: 'callback',
      provider: { name: 'google' },
    });
    expect(selectRequestProvider(providers, '/callback/microsoft', '')).toMatchObject({
      kind: 'callback',
      provider: { name: 'microsoft' },
    });
  });

  it('routes the outlook provider beside the other two on its own routes and cookie', () => {
    const three = resolveLoginProviders(GOOGLE_PRIMARY, { ...MS_ENV, OUTLOOK_LOGIN: 'true' });
    expect(selectRequestProvider(three, '/login/outlook', '')).toMatchObject({
      kind: 'login',
      provider: { name: 'outlook' },
    });
    expect(selectRequestProvider(three, '/callback/outlook', '')).toMatchObject({
      kind: 'callback',
      provider: { name: 'outlook' },
    });
    expect(selectRequestProvider(three, '/api/user', 'appSession_outlook.0=x')).toMatchObject({
      kind: 'session',
      provider: { name: 'outlook' },
    });
    expect(selectRequestProvider(three, '/logout', 'appSession_outlook=x')).toMatchObject({
      kind: 'logout',
      provider: { name: 'outlook' },
    });
  });

  it('dispatches /logout and plain requests by which session cookie is present', () => {
    const providers = twoProviders();
    expect(selectRequestProvider(providers, '/logout', 'appSession_microsoft=abc')).toMatchObject({
      kind: 'logout',
      provider: { name: 'microsoft' },
    });
    expect(selectRequestProvider(providers, '/logout', 'appSession=abc')).toMatchObject({
      kind: 'logout',
      provider: { name: 'google' },
    });
    // Chunked session cookies (appSession_microsoft.0) still identify their owner.
    expect(selectRequestProvider(providers, '/api/user', 'appSession_microsoft.0=x')).toMatchObject({
      kind: 'session',
      provider: { name: 'microsoft' },
    });
    // Primary wins when both sessions are present; no cookie falls back to primary.
    expect(selectRequestProvider(providers, '/api/user', 'appSession=a; appSession_microsoft=b').provider.name).toBe(
      'google',
    );
    expect(selectRequestProvider(providers, '/api/user', '').provider.name).toBe('google');
  });
});

describe('hasSessionCookie', () => {
  it('matches base and chunked cookies but never a suffixed sibling name', () => {
    expect(hasSessionCookie('appSession=x', 'appSession')).toBe(true);
    expect(hasSessionCookie('other=1; appSession.0=x', 'appSession')).toBe(true);
    // The primary cookie regex must NOT treat appSession_microsoft as its own.
    expect(hasSessionCookie('appSession_microsoft=x', 'appSession')).toBe(false);
    expect(hasSessionCookie('xappSession=1', 'appSession')).toBe(false);
  });
});

describe('loginRestartPathForCallbackPath', () => {
  it('maps login callbacks to their login route and ignores non-login callbacks', () => {
    expect(loginRestartPathForCallbackPath('/callback')).toBe('/login');
    expect(loginRestartPathForCallbackPath('/callback/microsoft')).toBe('/login/microsoft');
    expect(loginRestartPathForCallbackPath('/api/connect/outlook/callback')).toBeUndefined();
    expect(loginRestartPathForCallbackPath('/callbacks')).toBeUndefined();
  });

  it('feeds buildOidcLoginRestartPath so a failed provider callback restarts its own flow', () => {
    const state = Buffer.from(JSON.stringify({ returnTo: '/cockpit/?app=dnd' }), 'utf8').toString('base64url');
    expect(buildOidcLoginRestartPath(state, '/login/microsoft')).toBe(
      `/login/microsoft?returnTo=${encodeURIComponent('/cockpit/?app=dnd')}`,
    );
    expect(buildOidcLoginRestartPath(undefined, '/login/microsoft')).toBe('/login/microsoft');
  });
});

describe('renderLoginChooser', () => {
  it('renders one link per provider carrying the encoded returnTo', () => {
    const html = renderLoginChooser(twoProviders(), '/cockpit/?app=dnd');
    expect(html).toContain(`href="/login/google?returnTo=${encodeURIComponent('/cockpit/?app=dnd')}"`);
    expect(html).toContain(`href="/login/microsoft?returnTo=${encodeURIComponent('/cockpit/?app=dnd')}"`);
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Microsoft');
  });

  it('renders bare login links without a returnTo', () => {
    const html = renderLoginChooser(twoProviders());
    expect(html).toContain('href="/login/google"');
    expect(html).toContain('href="/login/microsoft"');
  });

  it('renders one provider icon per button (Google G, Microsoft squares, Outlook envelope)', () => {
    const three = resolveLoginProviders(GOOGLE_PRIMARY, { ...MS_ENV, OUTLOOK_LOGIN: 'true' });
    const html = renderLoginChooser(three);
    expect(html.match(/<svg /g)).toHaveLength(3);
    expect(html).toContain('#4285F4'); // Google G blue segment
    expect(html).toContain('#f25022'); // Microsoft top-left square
    expect(html).toContain('#0F6CBD'); // Outlook envelope blue
    expect(html).toContain('href="/login/outlook"');
    expect(html).toContain('Continue with Outlook.com');
  });

  it('escapes hostile returnTo values instead of reflecting markup', () => {
    const hostile = '/"/><script>alert(1)</script>';
    const html = renderLoginChooser(twoProviders(), hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('createOidcMiddleware construction with two providers', () => {
  // Crosses the real express-openid-connect config boundary: auth() Joi-validates the
  // suffixed session cookie name and /callback/<provider> routes at construction time
  // (discovery is lazy, so no network happens). A schema regression fails HERE, not in prod boot.
  const KEYS = [
    'MOCK_OIDC',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'SESSION_SECRET',
    'APP_URL',
    'OIDC_BASE_URLS',
    'MICROSOFT_LOGIN',
    'MICROSOFT_TENANT_ID',
    'MICROSOFT_OIDC_CLIENT_ID',
    'MICROSOFT_OIDC_CLIENT_SECRET',
    'OUTLOOK_LOGIN',
    'OUTLOOK_OIDC_CLIENT_ID',
    'OUTLOOK_OIDC_CLIENT_SECRET',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    process.env.MOCK_OIDC = 'false';
    process.env.OIDC_ISSUER_URL = 'https://accounts.google.com';
    process.env.OIDC_CLIENT_ID = 'google-client';
    process.env.OIDC_CLIENT_SECRET = 'google-secret';
    process.env.SESSION_SECRET = 'a'.repeat(64);
    process.env.APP_URL = 'https://oshal.example.com';
    process.env.OIDC_BASE_URLS = 'https://oshal.example.com,https://apps.example.com';
    process.env.MICROSOFT_LOGIN = 'true';
    process.env.MICROSOFT_TENANT_ID = '11111111-2222-3333-4444-555555555555';
    process.env.MICROSOFT_OIDC_CLIENT_ID = 'ms-client';
    process.env.MICROSOFT_OIDC_CLIENT_SECRET = 'ms-secret';
    process.env.OUTLOOK_LOGIN = 'true';
    delete process.env.OUTLOOK_OIDC_CLIENT_ID;
    delete process.env.OUTLOOK_OIDC_CLIENT_SECRET;
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('builds the middleware set for hosts × {google, microsoft, outlook} without throwing', () => {
    const set = createOidcMiddleware();
    expect(typeof set.authMiddleware).toBe('function');
    expect(typeof set.requiresAuth).toBe('function');
    expect(typeof set.loginHandler).toBe('function');
  });

  it('still fails closed at construction when Microsoft credentials are incomplete', () => {
    delete process.env.MICROSOFT_OIDC_CLIENT_SECRET;
    expect(() => createOidcMiddleware()).toThrow(/MICROSOFT_OIDC_CLIENT_ID/);
  });
});
