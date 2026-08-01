/**
 * Connectors (Utilities Hub) — per-user provider authorization.
 *
 * Lets a signed-in user connect external accounts (Google now; Facebook/Yahoo/etc.
 * slot in via the PROVIDERS registry) so OSHAL bots can act on their behalf. This
 * is incremental authorization, SEPARATE from sign-in: the user explicitly grants
 * API scopes (e.g. Gmail/Calendar read) and we persist the encrypted refresh token
 * keyed to their identity. Reusing the same Google OAuth *client* as login is fine
 * — this is a distinct consent flow, not the login flow.
 *
 * Security: refresh/access tokens are encrypted at rest (AES-256-GCM, key derived
 * from SESSION_SECRET). The CSRF `state` is an HMAC-signed, time-boxed token, so no
 * server-side state store is needed.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial connectors hub: GET /list, /:provider/start, /:provider/callback, DELETE /:provider. Google connector (Gmail+Calendar read, offline). Encrypted token store (oshal_connections).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Make Google connector scopes env-overridable via GOOGLE_CONNECT_SCOPES (parity with FACEBOOK_SCOPES) so access can be expanded (gmail.send/calendar.events) without a code change.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | LinkedIn connector (social swarm, ADR-038): OIDC sign-in + w_member_social posting. Standard OAuth code exchange; userinfo sub is the person id used as the post author URN. LINKEDIN_CLIENT_ID + LINKEDIN_PRIMARY_CLIENT_SECRET; redirect /api/connect/linkedin/callback.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Outlook / Microsoft 365 connector (email swarm): Microsoft Graph OAuth (login.microsoftonline.com/{tenant}), scopes Mail.Read+Calendars.Read+offline_access (refresh token). AZURE_EMAIL_APPLICATION_ID + AZURE_EMAIL_CLIENT_SECRET; tenant from AZURE_EMAIL_TENANT/DIRECTORY_ID. /me via Graph for account. Tolerates typo'd env names.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Outlook/LinkedIn scope parser now splits on whitespace OR comma (was comma-only), so a space-separated Microsoft scope string (e.g. "openid profile https://outlook.office.com/IMAP.AccessAsUser.All") can't collapse into one malformed scope. Matches the Google connector's tolerant parsing. Verified the live 302 builds the correct redirect_uri + 5 scopes against real container env.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | X / Twitter connector (social swarm, OAuth 2.0): adds PKCE (S256 challenge; verifier carried encrypted in the signed state for the stateless flow), HTTP Basic token-endpoint auth (confidential client), refresh-token rotation persistence, and /2/users/me identity. New ProviderDef flags pkce + tokenAuth keep the four existing providers untouched. Creds TWITTER_CLIENT_ID/SECRET (X_* + X_CLIENT_SECRECT typo tolerated); scopes tweet.read/users.read/tweet.write/offline.access.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | PKCE verifier moved from the `state` param to a short-lived cookie (oshalpkce_<provider>, HttpOnly/Secure/Lax, 10 min). X's /2/oauth2/authorize was returning 400 on the consent-metadata fetch with an over-long state (the encrypted verifier bloated it); the state is now just {provider,sub,ts}+sig. Verifier read back via readPkceVerifier() at callback, cookie cleared after.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Fix Outlook "not configured": providerCreds(outlook) now reads OUTLOOK_CLIENT_VALUE (the Azure secret VALUE, and the only secret var compose passes through) as the client secret, ahead of AZURE_EMAIL_CLIENT_SECRET/OUTLOOK_CLIENT_SECRET. It was resolving empty → /list reported configured:false → the Connect button was greyed out despite the secret being set in .env.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Dropbox connector (per-user file-space backend, ADR-038 storage): standard OAuth code flow with token_access_type=offline (refresh token; Dropbox access tokens are short-lived). Scopes account_info.read + files.metadata/content read/write; account via /2/users/get_current_account. Creds DROPBOX_CLIENT_ID/SECRET (App key/secret). Generic exchange + refresh paths apply — only a new flavor + fetchAccount branch needed.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Facebook Pages (Business) connector 'meta-business' — SEPARATE from the public_profile/email login app: its own Business app creds (META_APP_ID/SECRET_OSHAL_BUSINESS), pages_show_list/pages_read_engagement/pages_manage_posts scopes, and its own callback /api/connect/meta-business/callback. Reuses the facebook token-exchange + /me account dialect. Keeps the pages scopes off the login app (which would 400 "Invalid Scopes") and avoids the shared FACEBOOK_APP_ID/FACEBOOK_REDIRECT_URI collision. Enables social-media publishing to a Page (Page-token POST is the next build step).
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Smart-home (home) bundle connectors (ADR-038, BACKLOG smart-home swarm): (1) 'smartthings' — a TOKEN-PASTE connector (auth:'token'): the user pastes a SmartThings Personal Access Token (no partner OAuth app); new POST /:provider/token validates it against /v1/locations and stores it encrypted. (2) 'google-home' — Google Nest Device Access OAuth (sdm.service scope) via the nestservices.google.com partner-connections authorize URL (needs the Device Access project id); standard Google token exchange + refresh. New 'home' category. Alexa is intentionally NOT wired — third-party Alexa device control needs a certified Smart Home Skill, not a public REST API (see docs/partner-app-registration.md), so an OAuth-only connector would be a no-op.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Migrated SmartThings to OAuth-In authorization code flow with refresh-token storage and per-user brokered access for the home bot.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Restore the 'facebook' (public_profile login) connector that was dropped in the "one Facebook connector" consolidation — it's the identity/auth-validation connector + profile surface, now grouped under 'identity' ("Sign-in & Identity"). Relabel the publishing connector 'Facebook (Business / Pages)' and the login one 'Facebook (login)' so the two are unambiguous on /utilities. Both kept, distinct apps + callbacks.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | GCP connector 'gcp' (new 'devops' category): Google-flavor OAuth, scopes openid+email+cloud-platform.read-only (env GCP_SCOPES expands to full cloud-platform). Reuses the Google token-exchange + userinfo account lookup (fetchAccount google branch now also handles gcp); own OAuth client GCP_CLIENT_ID/SECRET (created in the GCP project, owned by the personal gmail — deliberate Rule 0 exception). Drives the Cloud Resource Manager/Compute/Billing REST APIs via the per-user access token. Click-to-login parallel to the gcloud operator CLI login.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Payment-acceptance connectors (new 'payments' category) for the Payments app: 'square' (square flavor — JSON token exchange + Square-Version header, JSON refresh keyed on expires_at, /v2/merchants account label; scopes PAYMENTS_WRITE/READ + MERCHANT_PROFILE_READ; SQUARE_CLIENT_ID/SECRET, sandbox by default via SQUARE_ENV) and 'paypal' (paypal flavor — Basic-auth token endpoint via the existing tokenAuth path, /v1/identity userinfo account label; scopes openid+email+invoicing; PAYPAL_CLIENT_ID/SECRET, sandbox by default via PAYPAL_ENV). The merchant connects their own account; the Payments app charges with their brokered token.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Uber Eats connector 'uber' (new 'food' category) for the Eats concierge: token-paste (auth:'token', flavor 'uber') — the operator pastes an optional affiliate/marketing JSON blob {affiliateId?, marketUrl?, baseUrl?}. Uber has NO consumer API to place an Eats order on a third party's behalf, so ordering is a DEEP-LINK HANDOFF (same model as 'walmart'): the bot assembles the order, the person completes it on their own Uber login + payment. fetchAccount('uber') labels the connection from the blob; no live API call. Drives scripts/oshal-uber.js (brokered via OSHAL_CRED_UBER) + uberToolKit.js.
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Charles Schwab brokerage connector 'schwab' (new 'finance' category, flavor 'schwab') — the LIVE trade-execution rail for the Trading app (ADR-052). Standard OAuth code flow with HTTP Basic token auth (tokenAuth:'basic'); no user-selectable scopes (scopes:[] → /start omits the scope param, which Schwab 400s on when empty; login_hint also suppressed for Schwab). Creds SCHWAB_CLIENT_ID_PRD/SCHWAB_CLIENT_SECRET_PRD (the approved production App Key/Secret; SCHWAB_CLIENT_ID/SECRET + APP_KEY/SECRET tolerated); redirect override SCHWAB_CLIENT_CALL_BACK (the exact callback registered in the Schwab portal). Per-user access+refresh tokens stored encrypted; the generic Basic refresh path renews the 30-min access token (Schwab refresh tokens live ~7 days, no renewal → weekly reconnect). Drives SchwabBrokerAdapter via getValidAccessToken.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Add drive.file to the default Google connector scopes (ADR-080 Creative Studio): the MINIMAL Drive scope — per-file access to files the app creates, cannot read existing Drive content — so finished story videos upload via the Drive API instead of the fragile browser-session path. Existing Google connections must RECONNECT to gain it (live DB check confirmed no current connection has any drive scope).
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Twilio connector (Intelligent Communication swarm — phone + text): per-user pasted Account SID + Auth Token in the Jira two-value shape ("SID:AuthToken" combined secret), validated against the Twilio Accounts API before persisting. BYO account only; gives the communications-bot its SMS/voice leg via the token broker + scripts/oshal-twilio.js.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Outlook default scopes += Mail.Send (ADR-037 email-swarm parity with Gmail's send leg): scripts/oshal-outlook.js now sends via POST /me/sendMail, which needs the delegated Mail.Send permission. Existing Outlook connections must RECONNECT at /utilities to pick up the new scope; the Azure app registration needs Mail.Send added under API permissions (docs/partner-app-registration.md, Communications bundle).
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Plaid becomes a first-class hub connector (new auth:'link' mode) instead of the app-private oshal_finance_items store ADR-048 gave Finance. Adds the 'plaid' PROVIDERS entry (finance category, stub OAuth fields — its ceremony is the Link widget), the 'link' auth-model + 'plaid' flavor union members, the /list `configured` link-branch (isPlaidConfigured), and registers the Plaid Link routes (connector-plaid-link.ts) before the generic /:provider/* handlers. Tokens land in oshal_connections (per-user AES-GCM) and read back via getValidAccessToken's no-refresh_token branch, so an app REFERENCES Plaid via the broker rather than forking its own store. NB: file at the decomposition threshold — all substantive Plaid logic lives in connector-plaid-link.ts, this is a small wiring seam only.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the key derivation - SESSION_SECRET unset now throws at the call site instead of silently deriving a well-known AES key any reader of this public repo can compute. Guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto default-ON boot posture: after ensureDekSchema, log LOUD (error) when OSHAL_ENVELOPE_CRYPTO is on (now the default) but SESSION_SECRET is unset — connector token crypto will throw at the kek() boundary, so surface the misconfig at boot rather than on the first connect. Imported envelopeEnabled for the check.
 * -----------------------------------------------------------------------------
 *
 * @module connectors-routes
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import type { AppContext } from '@/app/composition/app-context';
import { ensureDekSchema, encryptToken, decryptToken, envelopeEnabled } from './connector-token-crypto';
import {
  ensureTenancySchema, accessibleConnections, resolveConnectionRow, upsertConnection,
  isTenantMember, ownerSub, relabelConnection, type ConnectionRow, type ConnectionSelector,
} from './connector-tenancy';
import { buildAnyLlmListEntry } from './byo-llm-routes';
import { fetchAccount } from './connector-account-lookup';
import { registerPlaidLinkRoutes, isPlaidConfigured } from './connector-plaid-link';

const logger = createChildLogger({ module: 'connectors-routes' });

interface ProviderDef {
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
/** Square API version pin (date-based). Sent on every Square call. */
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2024-12-18';

/** Provider registry — add a provider here + its OAuth client creds to extend the hub. */
const PROVIDERS: Record<string, ProviderDef> = {
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
    // consumed as HTTP Basic by the declarative twilio.yaml spec AND brokered to the
    // communications-bot (OSHAL_CRED_TWILIO) for scripts/oshal-twilio.js.
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
const CONNECTOR_CATEGORY: Record<string, string> = {
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
 * Connectors that have a SHARED platform key via env (a read-only catalog the operator configures
 * once for everyone), keyed to the env vars that, if set, mean per-user connect is OPTIONAL. The
 * /list entry exposes `platformDefault: true` so the UI can label the card "Optional — shared key
 * active" instead of looking like a required setup step. TMDB resolution: see movies-routes
 * getOperatorTmdbKey(). Add an entry here when a connector gains an env-key default.
 */
const PLATFORM_DEFAULT_ENV: Record<string, string[]> = {
  // Movies & TV — shared read-only catalog (see movies-routes getOperatorTmdbKey).
  tmdb: ['TMDB_API_KEY', 'THEMOVIEDB_API_READ_ACCESS_TOKEN', 'THEMOVIEDB_API_KEY'],
  // Travel — Duffel flight SEARCH runs on one operator token; booking is the user's own handoff
  // (connectors-routes tmdb/duffel notes + connector-token-broker). Shared key serves search for all.
  duffel: ['DUFFEL_ACCESS_TOKEN'],
};

/** OAuth client creds per provider. Google reuses the login client by default. */
function providerCreds(provider: string): { clientId: string; clientSecret: string } {
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

function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:35457').replace(/\/$/, '');
}
/** The registered redirect URI. Per-provider env override (e.g. FACEBOOK_REDIRECT_URI)
 *  lets Facebook live on oshal.example.com before APP_URL is flipped there. */
function redirectUri(provider: string): string {
  // Hyphenated provider ids (e.g. meta-business) → underscore env key (META_BUSINESS_REDIRECT_URI).
  // Schwab additionally honors SCHWAB_CLIENT_CALL_BACK (the exact callback registered in the
  // Schwab developer portal) — the OAuth redirect_uri MUST match that registration byte-for-byte.
  const override = process.env[`${provider.toUpperCase().replace(/-/g, '_')}_REDIRECT_URI`]
    || (provider === 'schwab' ? process.env.SCHWAB_CLIENT_CALL_BACK : undefined);
  if (override) return override;
  const def = PROVIDERS[provider];
  return `${appUrl()}${def ? def.redirectPath : `/api/connect/${provider}/callback`}`;
}
function secretKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // No dev-key fallback: a hardcoded constant in a public repo is a key everyone holds,
    // which silently voids the PKCE/state crypto AND every legacy token blob written under it
    // (docs/security/SECURITY-HARDENING.md 3.1/9). Fail loud at the call site instead.
    throw new Error('SESSION_SECRET is required for connector state/token crypto — the hardcoded dev-key fallback was removed');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/** Encrypt a token for at-rest storage (AES-256-GCM → iv:tag:cipher, base64). */
function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

/** PKCE pair: a high-entropy verifier + its S256 challenge (Twitter OAuth 2.0 mandates PKCE).
 *  The verifier is carried (encrypted) inside the signed `state` so the stateless flow can
 *  recover it at callback without a server-side store. */
function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Read + decrypt the PKCE verifier cookie set at /start (keeps it out of the `state` param). */
function readPkceVerifier(req: Request, provider: string): string | undefined {
  const name = `oshalpkce_${provider}`;
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (!raw) return undefined;
  try { return decrypt(decodeURIComponent(raw.slice(name.length + 1))); } catch { return undefined; }
}

/** Sign a CSRF state (HMAC, time-boxed) so no server-side state store is needed. */
function signState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyState(state: string): Record<string, any> | null {
  try {
    const [body, sig] = state.split('.');
    const expect = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
    if (sig !== expect) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof data.ts !== 'number' || Date.now() - data.ts > 10 * 60 * 1000) return null; // 10-min window
    return data;
  } catch {
    return null;
  }
}

/** Pull the signed-in user's identity (sub + email) from the OIDC session. */
function caller(req: Request): { sub: string; email: string } | null {
  const oidc = (req as any).oidc;
  if (!oidc || typeof oidc.isAuthenticated !== 'function' || !oidc.isAuthenticated()) return null;
  const u = oidc.user || {};
  const sub = u.sub || u.oid;
  if (!sub) return null;
  return { sub: String(sub), email: String(u.email || u.preferred_username || '') };
}

/** Create or validate the connector connection stores. */
export async function ensureConnectionsSchema(pool: AppContext['pool']): Promise<void> {
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'connector routes',
    statements: [
      `CREATE TABLE IF NOT EXISTS oshal_connections (
        connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub TEXT NOT NULL,
        user_email TEXT,
        provider VARCHAR(40) NOT NULL,
        account_email TEXT,
        account_id TEXT,
        scopes TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expiry TIMESTAMPTZ,
        status VARCHAR(20) NOT NULL DEFAULT 'connected',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_sub, provider)
      )`,
      'ALTER TABLE oshal_connections ADD COLUMN IF NOT EXISTS account_id TEXT',
    ],
    requirements: [
      {
        table: 'oshal_connections',
        columns: [
          'connection_id',
          'user_sub',
          'user_email',
          'provider',
          'account_email',
          'account_id',
          'scopes',
          'access_token',
          'refresh_token',
          'expiry',
          'status',
          'created_at',
          'updated_at',
        ],
      },
    ],
  });
  // Per-user DEK table (envelope encryption). Created regardless of the flag so flipping
  // OSHAL_ENVELOPE_CRYPTO on needs no migration step; unused while the flag is off.
  await ensureDekSchema(pool);
  // Startup posture (envelope crypto is ON by default since 2026-07-20): if SESSION_SECRET is
  // unset, the per-user DEK / master KEK cannot be derived and connector token encrypt/decrypt
  // will THROW at the crypto boundary (connector-token-crypto.kek() fail-loud). Surface it LOUD at
  // boot so the misconfig is caught before the first connect. Break-glass: OSHAL_ENVELOPE_CRYPTO=false.
  if (envelopeEnabled() && !process.env.SESSION_SECRET) {
    logger.error(
      'OSHAL_ENVELOPE_CRYPTO is ON but SESSION_SECRET is unset — connector token crypto will THROW on every encrypt/decrypt. Set SESSION_SECRET (production) or OSHAL_ENVELOPE_CRYPTO=false (legacy/dev).',
    );
  }
  // Tenancy (ADR-042): tenant tables + tenant_id/connected_by_sub on oshal_connections +
  // partial unique indexes. Backward-compatible (tenant_id defaults NULL = personal).
  await ensureTenancySchema(pool);
}

/**
 * @description Connectors hub sub-router (mounted at /api/connect, requiresAuth).
 * @param ctx - app context (db pool)
 * @returns an Express router
 */
export function createConnectorsRoutes(ctx: AppContext): Router {
  const router = Router();
  ensureConnectionsSchema(ctx.pool).catch((err) => logger.error({ err }, 'Failed to ensure oshal_connections schema'));

  // Plaid Link (auth:'link') — its own connect ceremony (POST /plaid/link-token + /plaid/exchange),
  // registered before the generic /:provider/* handlers. Tokens land in oshal_connections like any
  // other connector; see connector-plaid-link.ts (ADR-048 corrected: hub connector, not app-private).
  registerPlaidLinkRoutes(router, ctx, caller);

  /** GET /api/connect/list — the caller's connections (status only, never tokens). */
  router.get('/list', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    // Personal ∪ shared (ADR-042). A caller may have MANY accounts per provider (labeled);
    // return them all so the UI can list + select each one.
    const rows = await accessibleConnections(ctx.pool, me.sub);
    const byProvider = new Map<string, ConnectionRow[]>();
    for (const r of rows) { const a = byProvider.get(r.provider) || []; a.push(r); byProvider.set(r.provider, a); }
    const providers = Object.entries(PROVIDERS).map(([id, def]) => {
      const conns = byProvider.get(id) || [];
      const creds = providerCreds(id);
      const authModel = def.auth || 'oauth';
      return {
        id,
        label: def.label,
        category: CONNECTOR_CATEGORY[id] || 'other',
        auth: authModel,
        // Token-paste connectors need no OAuth client — they're "configured" out of
        // the box (the user supplies the token). Link connectors (Plaid) need the platform
        // app creds (PLAID_CLIENT_ID/SECRET). OAuth ones need a client id + secret.
        configured: authModel === 'token' ? true
          : authModel === 'link' ? isPlaidConfigured()
          : !!(creds.clientId && creds.clientSecret),
        tokenHelpUrl: def.tokenHelpUrl || null,
        // OAuth connector that also accepts a pasted token (shows a paste field until
        // its OAuth client is configured) — e.g. SmartThings.
        tokenFallback: !!def.allowTokenFallback,
        // A shared platform key (env) already serves everyone, so connecting a personal token is
        // OPTIONAL — the UI labels these "Optional — shared key active" rather than as setup.
        platformDefault: (PLATFORM_DEFAULT_ENV[id] || []).some((k) => !!(process.env[k] || '').trim()),
        connected: conns.length > 0,
        // Every account the caller has for this provider, each individually selectable.
        connections: conns.map((c) => ({
          connectionId: c.connection_id, label: c.label, account: c.account_email,
          tenantId: c.tenant_id || null, isDefault: c.is_default,
        })),
        status: conns.length ? 'connected' : 'not_connected',
      };
    });
    // The "any API, any LLM" connector — OSHAL's vendor-neutral selling point — lives on
    // the same Connections page (its rows reuse oshal_connections, so it appears here too).
    providers.push(buildAnyLlmListEntry(rows) as any);
    res.json({ providers });
  });

  /** GET /api/connect/:provider/start — kick off the consent flow. `?tenant=<id>`
   *  connects on behalf of a household the caller belongs to (shared); omitted/`personal`
   *  = a personal connection (ADR-042). */
  router.get('/:provider/start', async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const def = PROVIDERS[provider];
    const me = caller(req);
    if (!def) { res.status(404).json({ error: 'unknown provider' }); return; }
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    const creds = providerCreds(provider);
    if (!creds.clientId || !creds.clientSecret) {
      res.status(503).json({ error: `${provider} connector is not configured (missing OAuth client)` });
      return;
    }
    // Optional target household — the caller must be a member to connect a shared hub.
    const tenant = String(req.query.tenant || '').trim();
    if (tenant && tenant !== 'personal' && !(await isTenantMember(ctx.pool, tenant, me.sub))) {
      res.status(403).json({ error: 'not a member of that household' });
      return;
    }
    // Optional label (nickname) for this account — lets a user hold several accounts per
    // provider ("work email", "home email"). Blank → defaults to the account email.
    const label = String(req.query.label || '').trim().slice(0, 60);
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri(provider),
      response_type: 'code',
      // Only send `scope` when the connector defines one. Schwab has no user-selectable scopes
      // and 400s on an empty scope= param, so scopeless connectors omit it entirely.
      ...(def.scopes.length ? { scope: def.scopes.join(def.scopeSep) } : {}),
      ...def.authParams,
      // login_hint helps the OIDC providers; Twitter + Schwab authorize endpoints don't use it.
      ...(me.email && provider !== 'twitter' && provider !== 'schwab' ? { login_hint: me.email } : {}),
    });
    // PKCE (Twitter): send the S256 challenge; carry the verifier in a short-lived
    // cookie (NOT the state) so `state` stays small — X 400s on an over-long state.
    if (def.pkce) {
      const { verifier, challenge } = pkcePair();
      res.cookie(`oshalpkce_${provider}`, encrypt(verifier), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' });
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }
    params.set('state', signState({ provider, sub: me.sub, tenant: tenant && tenant !== 'personal' ? tenant : undefined, label: label || undefined }));
    // Facebook / Meta "Login for Business" apps define permissions in a Login Configuration
    // (a config_id), NOT a scope list — sending raw scopes (e.g. pages_read_engagement)
    // yields "Invalid Scopes". When a per-provider CONFIG_ID is set, drop scope + send it.
    // FACEBOOK_CONFIG_ID for the login app; META_BUSINESS_CONFIG_ID for the Pages app.
    const configId = process.env[`${provider.toUpperCase().replace(/-/g, '_')}_CONFIG_ID`]
      || (provider === 'facebook' ? process.env.FACEBOOK_CONFIG_ID : undefined);
    if ((provider === 'facebook' || provider === 'meta-business') && configId) {
      params.delete('scope');
      params.set('config_id', configId);
    }
    // Slack: a USER token (reads the user's own channels/DMs) is granted only when the
    // scopes ride in `user_scope`; plain `scope` would request a bot token instead. Move
    // them over. The matching unwrap of authed_user.access_token is in exchangeCode.
    if (provider === 'slack') {
      params.delete('scope');
      params.set('user_scope', def.scopes.join(def.scopeSep));
    }
    logger.info({ provider, sub: me.sub }, 'Connector consent started');
    res.redirect(302, `${def.authUrl}?${params.toString()}`);
  });

  /** GET /api/connect/:provider/callback — exchange the code, store the token. */
  router.get('/:provider/callback', async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const def = PROVIDERS[provider];
    const me = caller(req);
    try {
      if (!def || !me) { res.redirect(302, '/utilities?error=auth'); return; }
      const data = verifyState(String(req.query.state || ''));
      if (!data || data.provider !== provider || data.sub !== me.sub) {
        res.redirect(302, '/utilities?error=state');
        return;
      }
      const code = String(req.query.code || '');
      if (!code) { res.redirect(302, `/utilities?error=${encodeURIComponent(String(req.query.error || 'no_code'))}`); return; }

      const codeVerifier = readPkceVerifier(req, provider); // PKCE verifier (from the /start cookie)
      if (def.pkce) res.clearCookie(`oshalpkce_${provider}`, { path: '/' });
      const tok = await exchangeCode(provider, def, code, codeVerifier);
      const acct = await fetchAccount(provider, tok).catch(() => ({ email: me.email, id: null as string | null }));

      // Per-user envelope encryption (flag-gated; legacy KEK when off — same blob format).
      // For a shared connection the DEK is the grantor's (me.sub) — see ownerSub() in resolution.
      const encAccess = tok.access_token ? await encryptToken(ctx.pool, me.sub, tok.access_token) : null;
      const encRefresh = tok.refresh_token ? await encryptToken(ctx.pool, me.sub, tok.refresh_token) : null;
      const tenantId = typeof data.tenant === 'string' ? data.tenant : null; // shared household, or null = personal
      await upsertConnection(ctx.pool, {
        userSub: me.sub, userEmail: me.email, provider, accountEmail: acct.email, accountId: acct.id,
        scopes: def.scopes.join(' '), encAccess, encRefresh,
        expiry: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
        tenantId, connectedBySub: me.sub, label: typeof data.label === 'string' ? data.label : null,
      });
      logger.info({ provider, sub: me.sub, tenantId, account: acct.email, gotRefresh: !!tok.refresh_token }, 'Connector connected');
      res.redirect(302, `/utilities?connected=${provider}`);
    } catch (err: any) {
      logger.error({ err, provider }, 'Connector callback failed');
      res.redirect(302, `/utilities?error=${encodeURIComponent(err.message || 'exchange_failed')}`);
    }
  });

  /** POST /api/connect/:provider/token — store a pasted Personal Access Token for a
   *  token-auth connector (e.g. SmartThings). Validates the token against the provider
   *  before persisting (encrypted), so a bad paste fails fast instead of silently. */
  router.post('/:provider/token', async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const def = PROVIDERS[provider];
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!def || (def.auth !== 'token' && !def.allowTokenFallback)) { res.status(404).json({ error: 'not a token connector' }); return; }
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) { res.status(400).json({ error: 'token is required' }); return; }
    // Two-value secrets (HTTP Basic connectors like Jira): the card sends an `email`
    // alongside the token; store them as one "email:token" secret (split on the FIRST ':'
    // at use, so the token may itself contain ':'). Single-value connectors omit `email`.
    const accountEmail = String((req.body && req.body.email) || '').trim();
    const secret = accountEmail ? `${accountEmail}:${token}` : token;
    // Optional target household (shared) — caller must be a member.
    const tenant = String((req.body && req.body.tenant) || '').trim();
    if (tenant && tenant !== 'personal' && !(await isTenantMember(ctx.pool, tenant, me.sub))) {
      res.status(403).json({ error: 'not a member of that household' }); return;
    }
    const label = String((req.body && req.body.label) || '').trim().slice(0, 60);
    try {
      // Validate the token by reading the account (fails closed on a bad/expired token).
      const acct = await fetchAccount(provider, { access_token: secret });
      if (!acct.id && !acct.email) { res.status(400).json({ error: 'token rejected by provider' }); return; }
      const encAccess = await encryptToken(ctx.pool, me.sub, secret);
      await upsertConnection(ctx.pool, {
        userSub: me.sub, userEmail: me.email, provider, accountEmail: acct.email, accountId: acct.id,
        scopes: def.scopes.join(' '), encAccess, encRefresh: null, expiry: null,
        tenantId: tenant && tenant !== 'personal' ? tenant : null, connectedBySub: me.sub, label: label || null,
      });
      logger.info({ provider, sub: me.sub, account: acct.email || acct.id }, 'Token connector connected');
      res.json({ success: true, account: acct.email || acct.id });
    } catch (err: any) {
      logger.error({ err, provider }, 'Token connector save failed');
      res.status(400).json({ error: err.message || 'token validation failed' });
    }
  });

  /** GET /api/connect/:provider/access-token — a fresh access token for the
   *  caller's connection (refreshed if expired). Lets the user's own bots/tools
   *  act on the connected account. 404 if not connected. */
  router.get('/:provider/access-token', async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!PROVIDERS[provider]) { res.status(404).json({ error: 'unknown provider' }); return; }
    try {
      // Select a specific account via ?label= / ?email= / ?connection= / ?tenant=.
      // None → default/single/household-first.
      const sel: ConnectionSelector = {
        tenantId: String(req.query.tenant || '').trim() || undefined,
        label: String(req.query.label || '').trim() || undefined,
        email: String(req.query.email || '').trim() || undefined,
        connectionId: String(req.query.connection || '').trim() || undefined,
      };
      const token = await getValidAccessToken(ctx.pool, me.sub, provider, sel);
      if (!token) { res.status(404).json({ error: 'not connected' }); return; }
      res.json({ access_token: token });
    } catch (err: any) {
      logger.error({ err, provider }, 'access-token failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /api/connect/:provider — revoke + remove a connection. */
  router.delete('/:provider', async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const def = PROVIDERS[provider];
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      // Personal disconnect only (tenant_id IS NULL). Removing a shared/household hub is a
      // tenant-admin action (ADR-042 Phase 3), not a per-member disconnect.
      const row = (await ctx.pool.query('SELECT refresh_token FROM oshal_connections WHERE user_sub = $1 AND provider = $2 AND tenant_id IS NULL', [me.sub, provider])).rows[0];
      if (row?.refresh_token && def?.revokeUrl) {
        try {
          const refresh = await decryptToken(ctx.pool, me.sub, row.refresh_token);
          await fetch(`${def.revokeUrl}?token=${encodeURIComponent(refresh)}`, { method: 'POST' });
        } catch { /* best-effort */ }
      }
      await ctx.pool.query('DELETE FROM oshal_connections WHERE user_sub = $1 AND provider = $2 AND tenant_id IS NULL', [me.sub, provider]);
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err, provider }, 'Disconnect failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/connect/connection/:id/label — rename a connection and/or make it the
   *  provider default for the caller. { label?, makeDefault? }. */
  router.post('/connection/:id/label', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      const ok = await relabelConnection(ctx.pool, me.sub, String(req.params.id), {
        label: req.body?.label, makeDefault: !!req.body?.makeDefault,
      });
      if (!ok) { res.status(404).json({ error: 'connection not found' }); return; }
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, 'relabel failed');
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /api/connect/connection/:id — disconnect ONE specific personal connection the
   *  caller owns (multi-account). Shared/household hubs are removed by a tenant admin (P3). */
  router.delete('/connection/:id', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    try {
      const row = (await ctx.pool.query(
        'SELECT provider, refresh_token FROM oshal_connections WHERE connection_id = $1 AND user_sub = $2 AND tenant_id IS NULL',
        [String(req.params.id), me.sub],
      )).rows[0];
      if (!row) { res.status(404).json({ error: 'not found' }); return; }
      const def = PROVIDERS[row.provider];
      if (row.refresh_token && def?.revokeUrl) {
        try {
          const refresh = await decryptToken(ctx.pool, me.sub, row.refresh_token);
          await fetch(`${def.revokeUrl}?token=${encodeURIComponent(refresh)}`, { method: 'POST' });
        } catch { /* best-effort */ }
      }
      await ctx.pool.query('DELETE FROM oshal_connections WHERE connection_id = $1 AND user_sub = $2 AND tenant_id IS NULL', [String(req.params.id), me.sub]);
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, 'connection delete failed');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * @description Return a valid access token for a user's connection, refreshing it
 * via the stored refresh token when expired. Exported so in-process bots/tools
 * (e.g. the email summarizer) can act on a connected account without re-consent.
 * @param pool - db pool
 * @param userSub - the connection owner's OIDC sub
 * @param provider - provider id (e.g. 'google')
 * @returns a usable access token, or null if not connected / unrefreshable
 */
export async function getValidAccessToken(
  pool: any, userSub: string, provider: string, opts?: ConnectionSelector,
): Promise<string | null> {
  const def = PROVIDERS[provider];
  if (!def) return null;
  // Resolve personal ∪ shared (household-first, or a specific household via opts.tenantId).
  const row = await resolveConnectionRow(pool, userSub, provider, opts);
  if (!row) return null;
  const owner = ownerSub(row); // whose DEK encrypts this row's tokens (grantor for shared)
  // Still-valid access token (>60s headroom)?
  if (row.access_token && row.expiry && new Date(row.expiry).getTime() - Date.now() > 60_000) {
    return decryptToken(pool, owner, row.access_token);
  }
  if (!row.refresh_token) return row.access_token ? decryptToken(pool, owner, row.access_token) : null;
  const creds = providerCreds(provider);
  const refreshPlain = await decryptToken(pool, owner, row.refresh_token);
  if (def.flavor === 'square') {
    // Square refresh: JSON body + version header; returns a new access_token + expires_at
    // (the refresh_token itself does not rotate).
    const sr = await fetch(def.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'refresh_token', refresh_token: refreshPlain }),
    });
    if (!sr.ok) throw new Error(`square refresh ${sr.status}`);
    const sj = (await sr.json()) as { access_token?: string; expires_at?: string };
    if (!sj.access_token) return null;
    const exp = sj.expires_at ? new Date(sj.expires_at) : null;
    await pool.query('UPDATE oshal_connections SET access_token = $2, expiry = $3, updated_at = NOW() WHERE connection_id = $1',
      [row.connection_id, await encryptToken(pool, owner, sj.access_token), exp]);
    return sj.access_token;
  }
  const body = new URLSearchParams({ refresh_token: refreshPlain, grant_type: 'refresh_token' });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (def.tokenAuth === 'basic') {
    headers.Authorization = 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    body.set('client_id', creds.clientId);
  } else {
    body.set('client_id', creds.clientId);
    body.set('client_secret', creds.clientSecret);
  }
  const r = await fetch(def.tokenUrl, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const tok = (await r.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!tok.access_token) return null;
  // Twitter/SmartThings rotate refresh tokens — persist the new one when present. Key the
  // UPDATE by connection_id so it works for both personal and shared (tenant-owned) rows.
  const newAccess = await encryptToken(pool, owner, tok.access_token);
  const newRefresh = tok.refresh_token ? await encryptToken(pool, owner, tok.refresh_token) : null;
  await pool.query(
    'UPDATE oshal_connections SET access_token = $2, refresh_token = COALESCE($4, refresh_token), expiry = $3, updated_at = NOW() WHERE connection_id = $1',
    [row.connection_id, newAccess, tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null, newRefresh],
  );
  return tok.access_token;
}

/** Exchange an auth code for tokens (provider-aware). `codeVerifier` is the PKCE
 *  verifier (Twitter); undefined for the non-PKCE providers. */
async function exchangeCode(provider: string, def: ProviderDef, code: string, codeVerifier?: string): Promise<any> {
  const creds = providerCreds(provider);
  const redirect = redirectUri(provider);
  if (def.flavor === 'facebook') {
    // FB exchanges via GET and issues no refresh token; immediately swap the
    // short-lived token for a long-lived one (~60 days).
    const q = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: redirect, code });
    const r = await fetch(`${def.tokenUrl}?${q.toString()}`);
    if (!r.ok) throw new Error(`fb token exchange ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const short = (await r.json()) as { access_token?: string };
    if (!short.access_token) return short;
    const lq = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: creds.clientId, client_secret: creds.clientSecret, fb_exchange_token: short.access_token });
    const lr = await fetch(`${def.tokenUrl}?${lq.toString()}`);
    return lr.ok ? lr.json() : short;
  }
  if (def.flavor === 'square') {
    // Square's token endpoint takes a JSON body (client_id+secret in the body) + a version header.
    const r = await fetch(def.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
      body: JSON.stringify({ client_id: creds.clientId, client_secret: creds.clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirect }),
    });
    if (!r.ok) throw new Error(`square token exchange ${r.status}: ${(await r.text()).slice(0, 200)}`);
    // Square returns expires_at (ISO), not expires_in — normalize so the caller can persist expiry.
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_at?: string };
    const expires_in = j.expires_at ? Math.max(0, Math.floor((new Date(j.expires_at).getTime() - Date.now()) / 1000)) : undefined;
    return { ...j, expires_in };
  }
  if (def.flavor === 'slack') {
    // Slack oauth.v2.access: form-encoded POST, creds in the body, NO grant_type. The USER
    // token (reads the user's own messages) is nested under authed_user — lift it to the
    // top-level access_token the callback persists. No expires_in / refresh_token (rotation off).
    const sb = new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri: redirect });
    const sr = await fetch(def.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: sb });
    if (!sr.ok) throw new Error(`slack token exchange ${sr.status}: ${(await sr.text()).slice(0, 200)}`);
    const sj = (await sr.json()) as { ok?: boolean; error?: string; authed_user?: { access_token?: string; scope?: string }; team?: { id?: string; name?: string } };
    if (!sj.ok || !sj.authed_user?.access_token) throw new Error(`slack token exchange failed: ${sj.error || 'no user token (check user_scope)'}`);
    return { access_token: sj.authed_user.access_token, scope: sj.authed_user.scope, team: sj.team };
  }
  const body = new URLSearchParams({ code, redirect_uri: redirect, grant_type: 'authorization_code' });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // GitHub's token endpoint returns form-encoded by default; ask for JSON so r.json() works.
  if (def.flavor === 'github') headers.Accept = 'application/json';
  if (def.tokenAuth === 'basic') {
    // Twitter confidential client: HTTP Basic (client_id:client_secret); client_id also in body.
    headers.Authorization = 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    body.set('client_id', creds.clientId);
  } else {
    body.set('client_id', creds.clientId);
    body.set('client_secret', creds.clientSecret);
  }
  const r = await fetch(def.tokenUrl, { method: 'POST', headers, body });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}


/** Verify a Facebook signed_request (HMAC-SHA256 with the app secret) and return its payload. */
function parseSignedRequest(signed: string, appSecret: string): { user_id?: string } | null {
  try {
    const [encSig, payload] = String(signed).split('.');
    if (!encSig || !payload) return null;
    const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
    const sig = b64(encSig);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    return JSON.parse(b64(payload).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * @description Facebook Data Deletion Request callback (Meta requirement). FB POSTs a
 * signed_request when a user removes the app / requests deletion; we verify it, delete
 * that user's stored Facebook connection, and return {url, confirmation_code}.
 * Mounted UNGATED at /auth/facebook/data-deletion (FB calls it server-to-server).
 */
export function createFacebookDataDeletionRoute(ctx: AppContext) {
  const base = (process.env.FACEBOOK_REDIRECT_URI || `${appUrl()}/auth/facebook/callback`).replace(/\/auth\/facebook\/callback$/, '');
  return {
    /** POST — the actual deletion callback. */
    post: async (req: Request, res: Response): Promise<void> => {
      try {
        const secret = process.env.FACEBOOK_APP_SECRET || '';
        const data = req.body?.signed_request && secret ? parseSignedRequest(req.body.signed_request, secret) : null;
        if (!data || !data.user_id) { res.status(400).json({ error: 'invalid signed_request' }); return; }
        const code = crypto.randomBytes(8).toString('hex');
        await ctx.pool.query("DELETE FROM oshal_connections WHERE provider = 'facebook' AND account_id = $1", [String(data.user_id)]);
        logger.info({ fbUserId: data.user_id, code }, 'Facebook data deletion processed');
        res.json({ url: `${base}/auth/facebook/data-deletion?code=${code}`, confirmation_code: code });
      } catch (err: any) {
        logger.error({ err }, 'Facebook data deletion failed');
        res.status(500).json({ error: err.message });
      }
    },
    /** GET — human-readable status / instructions page. */
    page: (req: Request, res: Response): void => {
      const code = String(req.query.code || '');
      res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data Deletion</title><style>body{font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 18px;color:#1a2238;line-height:1.6}h1{font-size:20px}code{background:#eef;padding:2px 6px;border-radius:4px}</style></head><body><h1>OSHAL — Facebook data deletion</h1>${code ? `<p>Your request was received. Confirmation code: <code>${code.replace(/[^a-f0-9]/gi, '')}</code>. Any Facebook account data OSHAL stored for you has been deleted.</p>` : ''}<p>OSHAL only stores the OAuth token + your account email/id for a Facebook account you explicitly connect. To delete it: open <strong>Settings → Connections → Facebook → Disconnect</strong> in the app, or remove the app from <a href="https://www.facebook.com/settings?tab=applications">Facebook → Settings → Apps and Websites</a> (Facebook then calls this endpoint automatically). For help: <a href="mailto:maintainer@emeraldcoastsystemsgroup.com">maintainer@emeraldcoastsystemsgroup.com</a>.</p></body></html>`);
    },
  };
}
