/**
 * Connector provider registry and OAuth client credential resolution.
 *
 * This module owns the declarative provider catalog, product categories, optional
 * platform-key markers, account-chooser hints, and the existing environment-to-client
 * credential mappings. It contains no route handlers and never exposes user tokens.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the provider registry and credential resolver from connectors-routes.ts without adding or changing any credential environment path; retained the SEC-05 Twilio fixed-controller-only boundary inline.
 * -----------------------------------------------------------------------------
 *
 * @module connector-provider-registry
 */

/**
 * @description Declarative authorization and presentation contract for one connector provider.
 */
export interface ProviderDef {
  label: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
  /** Extra auth params (Google needs offline + consent to return a refresh token). */
  authParams: Record<string, string>;
  /** OAuth dialect for token exchange / account lookup. */
  flavor: 'google' | 'facebook' | 'linkedin' | 'microsoft' | 'twitter' | 'github' | 'dropbox' | 'smartthings' | 'square' | 'paypal' | 'walmart' | 'uber' | 'slack' | 'spotify' | 'tmdb' | 'duffel' | 'schwab' | 'plaid' | 'generic';
  /** How scopes are joined in the auth URL (Google: space, Facebook: comma). */
  scopeSep: string;
  /** Redirect path (Facebook registers /auth/facebook/callback per the app config). */
  redirectPath: string;
  /** PKCE (code_challenge/S256) on the auth request — Twitter OAuth 2.0 requires it. */
  pkce?: boolean;
  /** Token-endpoint client auth: 'basic' = HTTP Basic (Twitter confidential client). */
  tokenAuth?: 'basic';
  /**
   * Authorization model. 'oauth' (default) = the redirect/consent flow. 'token' =
   * the user pastes a Personal Access Token (no partner OAuth app to register),
   * stored via POST /:provider/token. 'link' = a client-side widget yields a
   * short-lived token the server exchanges (Plaid) — served by its own routes
   * (connector-plaid-link.ts), not the generic /start + /callback. Kept for
   * providers that do not offer a redirect OAuth handshake.
   */
  auth?: 'oauth' | 'token' | 'link';
  /** Where the user generates a Personal Access Token (shown on the connect card for auth:'token'). */
  tokenHelpUrl?: string;
  /**
   * For an OAuth connector that ALSO accepts a pasted Personal Access Token as a
   * fallback (SmartThings): the /utilities card shows the friendly Connect button when
   * the OAuth client is configured, and a paste-a-token field when it isn't — so the
   * connector is usable before the OAuth app is registered. POST /:provider/token works.
   */
  allowTokenFallback?: boolean;
}

// Google Nest Device Access project id — the partner-connections authorize URL is
// project-scoped (https://nestservices.google.com/partnerconnections/{id}/auth).
// Created (one-time, $5) at console.nest.google.com/device-access.
const GOOGLE_HOME_PROJECT_ID = process.env.GOOGLE_HOME_PROJECT_ID || '';

const FB_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
// Microsoft tenant for the Outlook/M365 connector. 'common' = any account; a
// directory id = that org only. Accepts the user's typo'd var names too.
const MS_TENANT = process.env.OUTLOOK_TENANT_ID || process.env.AZURE_EMAIL_TENANT || process.env.AZURE_EMAIL_DIRECTORY_ID || 'common';

// Square / PayPal payment connectors are environment-selectable (sandbox by default so
// the whole connect→charge flow is testable without real money or merchant onboarding).
const SQUARE_SANDBOX = (process.env.SQUARE_ENV || 'sandbox') !== 'production';
const SQUARE_WEB = SQUARE_SANDBOX ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
const PAYPAL_SANDBOX = (process.env.PAYPAL_ENV || 'sandbox') !== 'production';
const PAYPAL_SIGNIN = PAYPAL_SANDBOX ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
const PAYPAL_API = PAYPAL_SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
/** @description Square API version pin (date-based), sent on every Square call. */
export const SQUARE_VERSION = process.env.SQUARE_VERSION || '2024-12-18';

/** @description Provider registry; add a provider here and map its OAuth client credentials below. */
export const PROVIDERS: Record<string, ProviderDef> = {
  google: {
    label: 'Google (Gmail + Calendar)',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    // Override with GOOGLE_CONNECT_SCOPES (space- or comma-separated) to expand
    // access — e.g. add calendar.events so bots can act, not just read.
    // gmail.send is included by default so "email me a copy" (POST /api/email/send) works after a
    // (re)connect. drive.file (added 2026-07-06 for Creative Studio story delivery, ADR-080) is the
    // MINIMAL Drive scope: per-file access to files THIS app creates — it cannot read the user's
    // existing Drive. Sensitive/restricted scopes need Google verification before NON-OWNER users; the
    // owner's own account is granted immediately. Existing connections must RECONNECT to gain new scopes.
    scopes: (process.env.GOOGLE_CONNECT_SCOPES || 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.file').split(/[\s,]+/).filter(Boolean),
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    flavor: 'google',
    scopeSep: ' ',
    redirectPath: '/api/connect/google/callback',
  },
  gcp: {
    label: 'Google Cloud (GCP)',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    // DevOps / cloud-ops connector: the token drives the Cloud Resource Manager,
    // Compute, Billing, etc. REST APIs (e.g. GET cloudresourcemanager.googleapis.com
    // /v1/projects) on the connected account. Default is READ-ONLY (least privilege);
    // expand to the full 'https://www.googleapis.com/auth/cloud-platform' via GCP_SCOPES
    // to let a bot create/modify resources, not just read. openid+email = account label.
    // NOTE: cloud-platform is a Google "restricted" scope — it works immediately for the
    // app owner + added test users; non-owner users need Google app verification first.
    scopes: (process.env.GCP_SCOPES || 'openid email https://www.googleapis.com/auth/cloud-platform.read-only')
      .split(/[\s,]+/).filter(Boolean),
    // select_account forces Google's account chooser so the user can connect a DIFFERENT
    // Google account than they signed into OSHAL with (e.g. the COMPANY GCP account) — the
    // multi-account flow: same client/redirect, different account → different token →
    // separate labeled connection (ADR-042). consent = always return a refresh token.
    authParams: { access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true' },
    flavor: 'google', // reuse the Google token-exchange + userinfo account lookup
    scopeSep: ' ',
    redirectPath: '/api/connect/gcp/callback',
  },
  // TWO distinct Facebook connectors, intentionally separate:
  //  • 'facebook' (here) — the public_profile/email LOGIN app. Low-data (name + id +
  //    avatar), but it's the identity/auth-validation connector and drives the profile
  //    surface (GET /api/email/social/profile). Grouped under "Sign-in & Identity".
  //  • 'meta-business' (below) — the Pages/Business app you administer; this is the
  //    PUBLISHING connector (post to a Page), grouped under social. Great for the Studio.
  // They use different apps (FACEBOOK_APP_ID vs META_*_OSHAL_BUSINESS) + different
  // callbacks, so they never collide. Keep BOTH.
  facebook: {
    label: 'Facebook (login)',
    authUrl: `https://www.facebook.com/${FB_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
    // Override with FACEBOOK_SCOPES (comma-separated). Set to just 'public_profile'
    // if your app type rejects email ("Invalid Scopes: email").
    scopes: (process.env.FACEBOOK_SCOPES || 'public_profile,email').split(',').map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'facebook',
    scopeSep: ',',
    redirectPath: '/auth/facebook/callback',
  },
  linkedin: {
    label: 'LinkedIn',
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    // openid+profile+email = identity (Sign In with LinkedIn); w_member_social = post (Share on LinkedIn).
    scopes: (process.env.LINKEDIN_SCOPES || 'openid,profile,email,w_member_social').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'linkedin',
    scopeSep: ' ', // LinkedIn wants space-separated scopes
    redirectPath: '/api/connect/linkedin/callback',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    authUrl: `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
    // offline_access -> refresh token; Mail.Read + Calendars.Read for the email swarm;
    // Mail.Send for the send leg (POST /me/sendMail via scripts/oshal-outlook.js).
    // Tolerate space- OR comma-separated (Microsoft scopes are space-separated by
    // convention, e.g. "openid profile https://outlook.office.com/IMAP.AccessAsUser.All").
    scopes: (process.env.OUTLOOK_SCOPES || 'openid,profile,email,offline_access,Mail.Read,Mail.Send,Calendars.Read')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    authParams: { response_mode: 'query' },
    flavor: 'microsoft',
    scopeSep: ' ',
    redirectPath: '/api/connect/outlook/callback',
  },
  twitter: {
    label: 'X / Twitter',
    // X retired the twitter.com consent host — its /i/oauth2/authorize page 400s on the
    // consent-metadata fetch. The x.com host works (verified 2026-06-18). Keep authUrl on
    // x.com; the token endpoint still resolves on api.twitter.com server-side.
    authUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    // tweet.write = post; tweet.read/users.read = read+identity; offline.access = refresh token.
    scopes: (process.env.TWITTER_SCOPES || 'tweet.read,users.read,tweet.write,offline.access')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'twitter',
    scopeSep: ' ',
    redirectPath: '/api/connect/twitter/callback',
    pkce: true,          // Twitter OAuth 2.0 mandates PKCE (S256)
    tokenAuth: 'basic',  // confidential client: HTTP Basic on the token endpoint
  },
  github: {
    label: 'GitHub',
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    // repo = push/pull code (the code-generating swarm output target); read:user = identity.
    scopes: (process.env.GITHUB_SCOPES || 'repo,read:user').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'github',
    scopeSep: ' ', // GitHub joins scopes with spaces in the auth URL
    redirectPath: '/api/connect/github/callback',
    // GitHub OAuth-App tokens don't expire/refresh; token endpoint returns form-encoded
    // unless Accept: application/json — handled in the exchange (see acceptJson).
  },
  slack: {
    label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // USER-token scopes (sent as `user_scope` in /start — see the slack block there) so the
    // connection reads the user's OWN channels, DMs, and group DMs (the personal feed), not a
    // bot's. Add chat:write via SLACK_SCOPES to also post as the user.
    scopes: (process.env.SLACK_SCOPES || 'channels:history,groups:history,im:history,mpim:history,channels:read,groups:read,im:read,mpim:read,users:read')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'slack',
    scopeSep: ',',
    redirectPath: '/api/connect/slack/callback',
    // Slack user tokens don't expire and issue no refresh token (rotation off) → expiry/refresh null.
  },
  spotify: {
    // Music connector for the Spotify concierge: the user connects their own Spotify
    // account and OSHAL searches their catalog, reads now-playing + their playlists, and
    // BUILDS playlists on their behalf via the Web API. Playback is a DEEP-LINK HANDOFF
    // (open.spotify.com) — controlling playback needs Premium + the Web Playback SDK, so
    // the app opens the track/playlist in the user's own Spotify app to press play there.
    label: 'Spotify',
    authUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
    // user-read-email/private = identity + product (free vs premium); top/library = taste;
    // playlist-read-* = list their playlists; playlist-modify-* = build a playlist for them;
    // currently-playing/playback-state = the now-playing strip. Space-separated (scopeSep).
    scopes: (process.env.SPOTIFY_SCOPES || 'user-read-email user-read-private user-top-read user-library-read playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-read-currently-playing user-read-playback-state')
      .split(/[\s,]+/).filter(Boolean),
    authParams: {},
    flavor: 'spotify',          // generic OAuth code exchange/refresh; own account-lookup branch
    scopeSep: ' ',
    redirectPath: '/api/connect/spotify/callback',
    tokenAuth: 'basic',         // Spotify token endpoint uses HTTP Basic (client_id:secret)
  },
  schwab: {
    // Brokerage connector (ADR-052 LIVE rail): the user authorizes their OWN Charles Schwab
    // account and OSHAL reads balances/positions and places orders on their behalf via the
    // Trader API with their brokered token. Schwab has NO paper/sandbox trading account (the
    // developer sandbox only exercises auth), so this is the LIVE rail — Alpaca stays paper +
    // autopilot. Registered as an INDIVIDUAL Schwab app matching the brokerage identity
    // (deliberate exception to the business-email rule; see the Schwab developer-access note).
    // NOTE: Schwab refresh tokens live ~7 days and cannot be renewed — the user re-connects
    // weekly. The generic Basic-auth exchange + refresh path handles the daily access-token cycle.
    label: 'Charles Schwab (Trading)',
    authUrl: 'https://api.schwabapi.com/v1/oauth/authorize',
    tokenUrl: 'https://api.schwabapi.com/v1/oauth/token',
    // Schwab's retail Trader API has no user-selectable OAuth scopes — access is governed by
    // what the app is approved for (Accounts & Trading, Market Data). Empty scopes → /start
    // omits the scope param (Schwab 400s on a bare empty scope=).
    scopes: [],
    authParams: {},
    flavor: 'schwab',
    scopeSep: ' ',
    redirectPath: '/api/connect/schwab/callback',
    tokenAuth: 'basic', // token endpoint uses HTTP Basic (App Key : App Secret)
  },
  // Account-aggregation connector (ADR-048 Finance): one Plaid app reaches ~12,000 banks +
  // brokerages. NOT a redirect-OAuth provider — auth:'link' uses the Plaid Link widget, served
  // by connector-plaid-link.ts (POST /plaid/link-token + /plaid/exchange). The OAuth fields below
  // are unused stubs (like the token-paste connectors); /start + /callback are not used for Plaid.
  // Tokens still land in oshal_connections (per-user AES-GCM) and read back via the standard broker.
  plaid: {
    label: 'Plaid (Banks & Brokerages)',
    auth: 'link',
    flavor: 'plaid',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/plaid/callback',
    tokenHelpUrl: 'https://dashboard.plaid.com',
  },
  dropbox: {
    label: 'Dropbox',
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    // account_info.read = identity; files.* = read/write the user's Dropbox (the
    // per-user file-space backend — swarm artifacts save to the user's own storage).
    scopes: (process.env.DROPBOX_SCOPES || 'account_info.read files.metadata.read files.content.read files.content.write')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    // token_access_type=offline → Dropbox returns a refresh_token (its access tokens
    // are short-lived, ~4h); the generic refresh path keeps the connection alive.
    authParams: { token_access_type: 'offline' },
    flavor: 'dropbox',
    scopeSep: ' ',
    redirectPath: '/api/connect/dropbox/callback',
  },
  smartthings: {
    label: 'SmartThings',
    // OAuth-In SmartApp connector: each signed-in OSHAL user authorizes their own
    // SmartThings account and we store that user's access + refresh token pair.
    authUrl: 'https://api.smartthings.com/oauth/authorize',
    tokenUrl: 'https://api.smartthings.com/oauth/token',
    scopes: (process.env.SMARTTHINGS_SCOPES || 'r:devices:* x:devices:* r:scenes:* x:scenes:* r:locations:*')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'smartthings',
    scopeSep: ' ',
    redirectPath: '/api/connect/smartthings/callback',
    tokenAuth: 'basic',
    // Until the OAuth-In app is registered (SMARTTHINGS_CLIENT_ID/SECRET set), the card
    // accepts a pasted Personal Access Token so the connector is usable immediately.
    allowTokenFallback: true,
    tokenHelpUrl: 'https://account.smartthings.com/tokens',
  },
  jira: {
    // Jira Cloud connector: each user pastes their OWN Atlassian email + API token (no
    // partner OAuth app to register). The two values are stored as a single "email:token"
    // secret (encrypted) and consumed as HTTP Basic by the declarative jira.yaml spec
    // (connector.auth.type: basic) — see connector-spec-routes.resolveCreds. The Jira SITE
    // is fixed per deployment (CONNECTOR_JIRA_BASE_URL + jira.yaml baseUrl); per-user here
    // means same site, each person's own credentials.
    label: 'Jira',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'generic',
    redirectPath: '/api/connect/jira/callback',
    tokenHelpUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  twilio: {
    // Phone + text (Intelligent Communication swarm): each user pastes their OWN Twilio
    // Account SID + Auth Token (BYO account — per the BACKLOG ownership caveat, Twilio is
    // a chosen paid pipe, never a platform-owned key). Same two-value shape as Jira: the
    // card sends the SID as `email`, stored as one "SID:AuthToken" secret (encrypted),
    // consumed as HTTP Basic only inside authenticated, schema-bounded controller operations;
    // it is never brokered into a model, bot process, task workspace, or generic CLI.
    label: 'Twilio (SMS & Voice)',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'generic',
    redirectPath: '/api/connect/twilio/callback',
    tokenHelpUrl: 'https://console.twilio.com/',
  },
  'google-home': {
    label: 'Google Nest (Home)',
    // Device Access uses a PROJECT-SCOPED authorize URL on nestservices.google.com,
    // NOT accounts.google.com — the project id is the Device Access project ($5 one-time).
    authUrl: `https://nestservices.google.com/partnerconnections/${GOOGLE_HOME_PROJECT_ID}/auth`,
    tokenUrl: 'https://oauth2.googleapis.com/token', // standard Google token exchange + refresh
    // sdm.service = the Smart Device Management API (Nest thermostats/cameras/doorbells).
    // NOTE: this controls Nest devices only — Google has no public API for generic
    // "Works with Google Home" gear. SmartThings is the broad-coverage connector.
    scopes: (process.env.GOOGLE_HOME_SCOPES || 'https://www.googleapis.com/auth/sdm.service')
      .split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    // offline + consent → a refresh token (Device Access access tokens are ~1h).
    authParams: { access_type: 'offline', prompt: 'consent' },
    flavor: 'google',
    scopeSep: ' ',
    redirectPath: '/api/connect/google-home/callback',
  },
  'meta-business': {
    label: 'Facebook (Business / Pages)',
    authUrl: `https://www.facebook.com/${FB_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
    // Social-media PUBLISHING (separate from the login app): pages_show_list +
    // pages_read_engagement + pages_manage_posts let the social swarm post to a Page.
    // Uses its OWN Business app (META_*_OSHAL_BUSINESS) + OWN callback, so it never
    // collides with the public_profile/email login app on FACEBOOK_APP_ID.
    scopes: (process.env.META_BUSINESS_SCOPES || 'public_profile,pages_show_list,pages_read_engagement,pages_manage_posts')
      .split(',').map((s) => s.trim()).filter(Boolean),
    authParams: {},
    flavor: 'facebook',   // reuse the Facebook token-exchange + account dialect
    scopeSep: ',',
    redirectPath: '/api/connect/meta-business/callback',
  },
  square: {
    // Payments connector: the MERCHANT connects their own Square account; OSHAL then
    // takes card payments on their behalf via /v2/payments with their access token.
    label: 'Square',
    authUrl: `${SQUARE_WEB}/oauth2/authorize`,
    tokenUrl: `${SQUARE_WEB}/oauth2/token`,
    revokeUrl: `${SQUARE_WEB}/oauth2/revoke`,
    // PAYMENTS_WRITE = create payments; READ = list them; MERCHANT_PROFILE_READ = business name.
    scopes: (process.env.SQUARE_SCOPES || 'PAYMENTS_WRITE PAYMENTS_READ MERCHANT_PROFILE_READ').split(/[\s,]+/).filter(Boolean),
    authParams: {},
    flavor: 'square',
    scopeSep: ' ',
    redirectPath: '/api/connect/square/callback',
  },
  paypal: {
    // Payments connector: the MERCHANT connects their PayPal account; OSHAL creates +
    // sends invoices the customer pays (the rail-appropriate "take a payment" for PayPal).
    label: 'PayPal',
    authUrl: `${PAYPAL_SIGNIN}/signin/authorize`,
    tokenUrl: `${PAYPAL_API}/v1/oauth2/token`,
    // openid+email identifies the account; the invoicing service scope lets us bill.
    scopes: (process.env.PAYPAL_SCOPES || 'openid email https://uri.paypal.com/services/invoicing').split(/[\s,]+/).filter(Boolean),
    authParams: {},
    flavor: 'paypal',
    scopeSep: ' ',
    redirectPath: '/api/connect/paypal/callback',
    tokenAuth: 'basic', // PayPal token endpoint uses HTTP Basic (client_id:secret)
  },
  walmart: {
    // Shopping connector: the OPERATOR connects the business Walmart I/O affiliate
    // credential ONCE by pasting a JSON blob {consumerId, keyVersion, privateKeyPem,
    // publisherId?}. OSHAL searches + assembles carts; ORDERING is a deep link the
    // shopper completes on their OWN Walmart login. Paste-only (no partner OAuth app).
    label: 'Walmart',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'walmart',
    redirectPath: '/api/connect/walmart/callback',
    tokenHelpUrl: 'https://walmart.io/',
  },
  uber: {
    // Food-delivery connector: the OPERATOR connects an Uber Eats affiliate/marketing
    // config ONCE by pasting a JSON blob {affiliateId?, marketUrl?, baseUrl?} (or just an
    // affiliate id string). Uber has NO consumer API to place an Eats order on a third
    // party's behalf, so this is a DEEP-LINK HANDOFF (same model as Walmart): the bot
    // assembles the order and hands off a ubereats.com link the person opens + completes
    // on their OWN Uber login + payment. Paste-only (no partner OAuth app); the blob is
    // optional tracking metadata — the deep link works without it.
    label: 'Uber Eats',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'uber',
    redirectPath: '/api/connect/uber/callback',
    tokenHelpUrl: 'https://merchants.ubereats.com/us/en/services/marketing/',
  },
  'uber-rides': {
    // Transportation connector: the OPERATOR connects an OPTIONAL Uber Rides config by
    // pasting {clientId?, baseUrl?} (or a bare client-id string). Requesting a ride ON a
    // third party's behalf needs Uber for Business; the personal path is a UNIVERSAL DEEP
    // LINK (m.uber.com/ul/) the rider confirms + pays in their OWN Uber app. Paste-only.
    label: 'Uber Rides',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'uber', // reuse the uber account-lookup dialect (accepts a pasted blob)
    redirectPath: '/api/connect/uber-rides/callback',
    tokenHelpUrl: 'https://developer.uber.com/docs/riders/ride-requests/tutorials/deep-links/introduction',
  },
  tmdb: {
    // Media connector for the Movies & TV concierge: the OPERATOR connects a free TMDB
    // API key ONCE (paste-only — TMDB issues an app key, not per-user OAuth). It powers
    // discovery (search, trending, details, trailers, where-to-watch via JustWatch data).
    // Streaming + ticket links are DEEP-LINK HANDOFFS the viewer opens themselves. The key
    // can be a v3 API key OR a v4 read access token (Bearer) — the client detects which.
    // A shared/tenant connection (or the TMDB_API_KEY env fallback) serves all users.
    label: 'TMDB (Movies & TV)',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'tmdb',
    redirectPath: '/api/connect/tmdb/callback',
    tokenHelpUrl: 'https://www.themoviedb.org/settings/api',
  },
  duffel: {
    // Travel connector for the Travel concierge (ADR-059): the traveller/operator connects a
    // Duffel access token ONCE (paste-only — Duffel issues an access token, not per-user OAuth).
    // It powers REAL flight search (offer requests); hotels/cars are demo + deep-link handoffs.
    // A test token (duffel_test_…) returns sandbox data; a live token (duffel_live_…) is real.
    // A shared/tenant connection (or the DUFFEL_ACCESS_TOKEN env fallback) can serve all users.
    label: 'Duffel (Travel)',
    auth: 'token',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    flavor: 'duffel',
    redirectPath: '/api/connect/duffel/callback',
    tokenHelpUrl: 'https://app.duffel.com/join',
  },
  // ADR-065 token-paste connectors (flavor 'generic'): the user pastes a Personal Access Token / API
  // key, validated against the provider's whoami endpoint (connector-account-lookup GENERIC_VERIFY)
  // then stored encrypted. Drives the declarative /api/connectors/<provider> routes. No partner OAuth
  // app to register — the fastest path to a connected provider.
  gitlab: {
    label: 'GitLab', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/gitlab/callback', tokenHelpUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  },
  zoom: {
    label: 'Zoom', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/zoom/callback', tokenHelpUrl: 'https://marketplace.zoom.us/',
  },
  calendly: {
    label: 'Calendly', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/calendly/callback', tokenHelpUrl: 'https://calendly.com/integrations/api_webhooks',
  },
  hubspot: {
    label: 'HubSpot', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/hubspot/callback', tokenHelpUrl: 'https://app.hubspot.com/private-apps',
  },
  asana: {
    label: 'Asana', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/asana/callback', tokenHelpUrl: 'https://app.asana.com/0/my-apps',
  },
  airtable: {
    label: 'Airtable', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/airtable/callback', tokenHelpUrl: 'https://airtable.com/create/tokens',
  },
  stripe: {
    label: 'Stripe', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/stripe/callback', tokenHelpUrl: 'https://dashboard.stripe.com/apikeys',
  },
  sendgrid: {
    label: 'SendGrid', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/sendgrid/callback', tokenHelpUrl: 'https://app.sendgrid.com/settings/api_keys',
  },
  openai: {
    label: 'OpenAI', auth: 'token', flavor: 'generic',
    authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ',
    redirectPath: '/api/connect/openai/callback', tokenHelpUrl: 'https://platform.openai.com/api-keys',
  },
  // ADR-065 "connect your world" batch — token-paste (flavor 'generic'); validated via GENERIC_VERIFY.
  strava: { label: 'Strava', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/strava/callback', tokenHelpUrl: 'https://www.strava.com/settings/api' },
  oura: { label: 'Oura Ring', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/oura/callback', tokenHelpUrl: 'https://cloud.ouraring.com/personal-access-tokens' },
  fitbit: { label: 'Fitbit', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/fitbit/callback', tokenHelpUrl: 'https://dev.fitbit.com/apps' },
  whoop: { label: 'WHOOP', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/whoop/callback', tokenHelpUrl: 'https://developer.whoop.com/' },
  vercel: { label: 'Vercel', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/vercel/callback', tokenHelpUrl: 'https://vercel.com/account/tokens' },
  netlify: { label: 'Netlify', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/netlify/callback', tokenHelpUrl: 'https://app.netlify.com/user/applications#personal-access-tokens' },
  sentry: { label: 'Sentry', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/sentry/callback', tokenHelpUrl: 'https://sentry.io/settings/account/api/auth-tokens/' },
  bitbucket: { label: 'Bitbucket', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/bitbucket/callback', tokenHelpUrl: 'https://bitbucket.org/account/settings/app-passwords/' },
  coinbase: { label: 'Coinbase', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/coinbase/callback', tokenHelpUrl: 'https://www.coinbase.com/settings/api' },
  discord: { label: 'Discord', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/discord/callback', tokenHelpUrl: 'https://discord.com/developers/applications' },
  intercom: { label: 'Intercom', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/intercom/callback', tokenHelpUrl: 'https://app.intercom.com/a/apps/_/developer-hub' },
  clickup: { label: 'ClickUp', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/clickup/callback', tokenHelpUrl: 'https://app.clickup.com/settings/apps' },
  figma: { label: 'Figma', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/figma/callback', tokenHelpUrl: 'https://www.figma.com/developers/api#access-tokens' },
  todoist: { label: 'Todoist', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/todoist/callback', tokenHelpUrl: 'https://todoist.com/app/settings/integrations/developer' },
  wakatime: { label: 'WakaTime', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/wakatime/callback', tokenHelpUrl: 'https://wakatime.com/settings/api-key' },
  pinterest: { label: 'Pinterest', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/pinterest/callback', tokenHelpUrl: 'https://developers.pinterest.com/apps/' },
  gumroad: { label: 'Gumroad', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/gumroad/callback', tokenHelpUrl: 'https://app.gumroad.com/settings/advanced' },
  pagerduty: { label: 'PagerDuty', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/pagerduty/callback', tokenHelpUrl: 'https://support.pagerduty.com/main/docs/api-access-keys' },
  shippo: { label: 'Shippo', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/shippo/callback', tokenHelpUrl: 'https://apps.goshippo.com/settings/api' },
  raindrop: { label: 'Raindrop.io', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/raindrop/callback', tokenHelpUrl: 'https://app.raindrop.io/settings/integrations' },
  monzo: { label: 'Monzo', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/monzo/callback', tokenHelpUrl: 'https://developers.monzo.com/' },
  buttondown: { label: 'Buttondown', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/buttondown/callback', tokenHelpUrl: 'https://buttondown.com/settings/api' },
  postmark: { label: 'Postmark', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/postmark/callback', tokenHelpUrl: 'https://postmarkapp.com/support/article/1008-what-are-the-account-and-server-api-tokens' },
  unsplash: { label: 'Unsplash', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/unsplash/callback', tokenHelpUrl: 'https://unsplash.com/oauth/applications' },
  // Kalshi (prediction markets, ?app=kalshi): two-value paste — API Key ID + the downloaded RSA
  // private-key PEM (stored "keyId:PEM"; PEM has no ':' so the first-colon split is safe). No
  // bearer token exists — validation SIGNS a real /portfolio/balance call (bespoke fetchAccount).
  kalshi: { label: 'Kalshi (Prediction Markets)', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/kalshi/callback', tokenHelpUrl: 'https://kalshi.com/account/api-keys' },
  // Finnhub: a plain API key (NO OAuth, NO redirect URL) that drives the fundamental event overlay —
  // /stock/earnings gives actual-vs-consensus surprises, the deterministic input the overlay needs.
  // Free-tier key from the dashboard; validated on paste against /quote before storing (BYO account).
  finnhub: { label: 'Finnhub (Market Data / Earnings)', auth: 'token', flavor: 'generic', authUrl: '', tokenUrl: '', scopes: [], authParams: {}, scopeSep: ' ', redirectPath: '/api/connect/finnhub/callback', tokenHelpUrl: 'https://finnhub.io/dashboard' },
};

/** Connector → hub category, for grouping the Utilities page by purpose.
 *  (OIDC sign-in identity lives in the page's "Your account" box, separate from these.) */
/**
 * @description Product category exposed for each connector card.
 */
export const CONNECTOR_CATEGORY: Record<string, string> = {
  // Facebook LOGIN is an identity/auth connector (it shows your profile + avatar) →
  // groups with sign-in, per the operator's "put it under your account" intent.
  facebook: 'identity',
  linkedin: 'social', twitter: 'social', 'meta-business': 'social',
  google: 'email', outlook: 'email',
  github: 'storage', dropbox: 'storage',
  // DevOps / cloud connectors (operator-grade cloud-platform access).
  gcp: 'devops', jira: 'devops',
  // Market-data connector (Finnhub) — earnings surprises for the trading fundamental overlay.
  finnhub: 'finance',
  // IoT / smart-home connectors group under their own category on /utilities.
  smartthings: 'iot', 'google-home': 'iot',
  // Payment-acceptance connectors (merchant accounts) for the Payments app.
  square: 'payments', paypal: 'payments',
  // Shopping connector (the operator's Walmart affiliate API) for the Purchasing app.
  walmart: 'shopping',
  // Food-delivery connector (Uber Eats deep-link handoff) for the Eats concierge.
  uber: 'food',
  // Transportation connector (Uber Rides deep-link handoff) for the Rides concierge.
  'uber-rides': 'transportation',
  // Messaging connector — pulls the user's own Slack channels/DMs into the feed.
  slack: 'communication',
  // Music connector (Spotify Web API) for the Spotify concierge.
  spotify: 'music',
  // Media connector (TMDB) for the Movies & TV concierge.
  tmdb: 'media',
  // Travel connector (Duffel flight search) for the Travel concierge.
  duffel: 'travel',
  // Brokerage connector (Charles Schwab Trader API) for the Trading app's LIVE rail (ADR-052).
  schwab: 'finance',
  // Account-aggregation connector (Plaid Link) for the Finance app (ADR-048): balances,
  // investment holdings, transactions across the user's linked banks + brokerages.
  plaid: 'finance',
  // Prediction-markets connector (Kalshi event contracts) for the ?app=kalshi edge scanner.
  kalshi: 'finance',
};

/**
 * @description Connectors that have a SHARED platform key via env (a read-only catalog the operator configures
 * once for everyone), keyed to the env vars that, if set, mean per-user connect is OPTIONAL. The
 * /list entry exposes `platformDefault: true` so the UI can label the card "Optional — shared key
 * active" instead of looking like a required setup step. TMDB resolution: see movies-routes
 * getOperatorTmdbKey(). Add an entry here when a connector gains an env-key default.
 */
export const PLATFORM_DEFAULT_ENV: Record<string, string[]> = {
  // Movies & TV — shared read-only catalog (see movies-routes getOperatorTmdbKey).
  tmdb: ['TMDB_API_KEY', 'THEMOVIEDB_API_READ_ACCESS_TOKEN', 'THEMOVIEDB_API_KEY'],
  // Travel — Duffel flight SEARCH runs on one operator token; booking is the user's own handoff
  // (connectors-routes tmdb/duffel notes + connector-token-broker). Shared key serves search for all.
  duffel: ['DUFFEL_ACCESS_TOKEN'],
};

/**
 * Extra authorize-URL params that force the provider's ACCOUNT CHOOSER, keyed by OAuth dialect.
 * Needed to reach the second account of a provider: Google's default `prompt=consent` re-authorises
 * whichever account the browser is already signed into, so a user with one Gmail connected could
 * never add a second one from the UI regardless of what the schema allowed. Applied only when the
 * caller ALREADY holds a connection for that provider (or asks explicitly with `?another=1`), so
 * the first-time connect keeps its current one-tap behaviour. Dialects with no account-chooser
 * parameter are simply absent — the flow is unchanged for them.
 */
const ACCOUNT_CHOOSER_PARAMS: Partial<Record<ProviderDef['flavor'], Record<string, string>>> = {
  // 'select_account consent' = show the chooser AND always return a refresh token for the picked one.
  google: { prompt: 'select_account consent' },
  microsoft: { prompt: 'select_account' },
};

/**
 * @description The authorize-URL params to ADD when the consent flow is about to connect an
 * ADDITIONAL account of a provider the caller already uses. Pure + exported so the multi-account
 * behaviour is testable without driving an OAuth redirect: without these, Google re-authorises the
 * already-signed-in account and the second Gmail silently becomes an update of the first.
 * @param flavor - the provider's OAuth dialect
 * @param alreadyConnected - how many accounts of this provider the caller already holds
 * @param wantsAnother - the caller asked explicitly (`?another=1`) even with none connected
 * @returns params to merge into the authorize URL; empty when the flow should stay unchanged
 */
export function additionalAccountAuthParams(
  flavor: ProviderDef['flavor'], alreadyConnected: number, wantsAnother = false,
): Record<string, string> {
  if (alreadyConnected <= 0 && !wantsAnother) return {};
  return { ...(ACCOUNT_CHOOSER_PARAMS[flavor] ?? {}) };
}

/**
 * @description Resolve the existing platform OAuth client credentials for a provider.
 * Google reuses the login client by default; token-paste providers resolve empty values.
 * @param provider - stable connector provider id
 * @returns the configured OAuth client id and secret, or empty strings when unavailable
 */
export function providerCreds(provider: string): { clientId: string; clientSecret: string } {
  if (provider === 'google') {
    return {
      clientId: process.env.GOOGLE_CONNECT_CLIENT_ID || process.env.OIDC_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CONNECT_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '',
    };
  }
  if (provider === 'gcp') {
    // Reuses the EXISTING Google OAuth client (the OIDC login / Google connector client,
    // 90751380448-…) by default — no new client needed. OAuth scopes are requested
    // per-flow (this connector asks for cloud-platform), so one client serves login,
    // Gmail, AND GCP. Just add the gcp callback to that client's redirect URIs + allow
    // the cloud-platform scope on the consent screen. Set GCP_CLIENT_ID/SECRET only to
    // use a SEPARATE client (e.g. to isolate cloud-platform's restricted-scope review
    // from the login app for a public launch). See docs/partner-app-registration.md.
    return {
      clientId: process.env.GCP_CLIENT_ID || process.env.OIDC_CLIENT_ID || '',
      clientSecret: process.env.GCP_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET || '',
    };
  }
  if (provider === 'facebook') {
    return { clientId: process.env.FACEBOOK_APP_ID || '', clientSecret: process.env.FACEBOOK_APP_SECRET || '' };
  }
  if (provider === 'square') {
    // Square dashboard names these "Application ID" + "OAuth Application secret".
    return { clientId: process.env.SQUARE_CLIENT_ID || process.env.SQUARE_APPLICATION_ID || '', clientSecret: process.env.SQUARE_CLIENT_SECRET || '' };
  }
  if (provider === 'paypal') {
    return { clientId: process.env.PAYPAL_CLIENT_ID || '', clientSecret: process.env.PAYPAL_CLIENT_SECRET || '' };
  }
  if (provider === 'meta-business') {
    // The Business app (Pages publishing) — DISTINCT creds from the login app, so
    // the two Facebook integrations never share an app id. Tolerate the lowercase
    // names too in case .env wasn't upper-cased.
    return {
      clientId: process.env.META_APPID_OSHAL_BUSINESS || process.env.META_APP_ID_OSHAL_BUSINESS
        || process.env.meta_appid_oshal_business || '',
      clientSecret: process.env.META_APPSECRET_OSHAL_BUSINESS || process.env.META_APP_SECRET_OSHAL_BUSINESS
        || process.env.meta_appsecret_oshal_business || '',
    };
  }
  if (provider === 'linkedin') {
    return {
      clientId: process.env.LINKEDIN_CLIENT_ID || '',
      clientSecret: process.env.LINKEDIN_PRIMARY_CLIENT_SECRET || process.env.LINKEDIN_CLIENT_SECRET || '',
    };
  }
  if (provider === 'outlook') {
    // The client SECRET is the Azure secret *value* — OUTLOOK_CLIENT_VALUE (the only one
    // compose passes through) — NOT OUTLOOK_CLIENT_SECRET, which is the secret *id* (a GUID).
    // Tolerates the user's typo'd var names (APPLICCATION).
    return {
      clientId: process.env.AZURE_EMAIL_APPLICATION_ID || process.env.AZURE_EMAIL_APPLICCATION_ID || '',
      clientSecret: process.env.OUTLOOK_CLIENT_VALUE || process.env.AZURE_EMAIL_CLIENT_SECRET || process.env.OUTLOOK_CLIENT_SECRET || '',
    };
  }
  if (provider === 'twitter') {
    // OAuth 2.0 Client ID/Secret (NOT the OAuth 1.0a consumer/access keys). Tolerate
    // the user's X_* var names + the X_CLIENT_SECRECT typo.
    return {
      clientId: process.env.TWITTER_CLIENT_ID || process.env.X_CLIENT_ID || '',
      clientSecret: process.env.TWITTER_CLIENT_SECRET || process.env.X_CLIENT_SECRET || process.env.X_CLIENT_SECRECT || '',
    };
  }
  if (provider === 'github') {
    return { clientId: process.env.GITHUB_CLIENT_ID || '', clientSecret: process.env.GITHUB_CLIENT_SECRET || '' };
  }
  if (provider === 'dropbox') {
    // Dropbox calls these the "App key" / "App secret"; tolerate either naming.
    return {
      clientId: process.env.DROPBOX_CLIENT_ID || process.env.DROPBOX_APP_KEY || '',
      clientSecret: process.env.DROPBOX_CLIENT_SECRET || process.env.DROPBOX_APP_SECRET || '',
    };
  }
  if (provider === 'google-home') {
    // Device Access OAuth client — its OWN GCP OAuth client (NOT the login client),
    // because its consent screen + redirect are registered under the Device Access project.
    return {
      clientId: process.env.GOOGLE_HOME_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_HOME_CLIENT_SECRET || '',
    };
  }
  if (provider === 'smartthings') {
    return {
      clientId: process.env.SMARTTHINGS_CLIENT_ID || process.env.SMARTTHINGS_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.SMARTTHINGS_CLIENT_SECRET || process.env.SMARTTHINGS_OAUTH_CLIENT_SECRET || '',
    };
  }
  if (provider === 'slack') {
    // Slack app "Basic Information → App Credentials": Client ID + Client Secret. Tolerate
    // the SLACK_CLINET_ID typo so a misnamed env still resolves.
    return {
      clientId: process.env.SLACK_CLIENT_ID || process.env.SLACK_CLINET_ID || '',
      clientSecret: process.env.SLACK_CLIENT_SECRET || '',
    };
  }
  if (provider === 'spotify') {
    // Spotify dashboard "Settings": Client ID + Client Secret. Callback
    // /api/connect/spotify/callback must be in the app's Redirect URIs.
    return {
      clientId: process.env.SPOTIFY_CLIENT_ID || '',
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
    };
  }
  if (provider === 'schwab') {
    // Schwab developer dashboard names these the "App Key" (client id) + "Secret". The
    // operator pastes the APPROVED production app's credentials as SCHWAB_CLIENT_ID_PRD /
    // SCHWAB_CLIENT_SECRET_PRD; plain SCHWAB_CLIENT_ID/SECRET (+ APP_KEY/SECRET) resolve too.
    return {
      clientId: process.env.SCHWAB_CLIENT_ID_PRD || process.env.SCHWAB_CLIENT_ID || process.env.SCHWAB_APP_KEY || '',
      clientSecret: process.env.SCHWAB_CLIENT_SECRET_PRD || process.env.SCHWAB_CLIENT_SECRET || process.env.SCHWAB_APP_SECRET || '',
    };
  }
  return { clientId: '', clientSecret: '' };
}


