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
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Twilio connector (Intelligent Communication swarm — phone + text): per-user pasted Account SID + Auth Token in the Jira two-value shape ("SID:AuthToken" combined secret), validated against the Twilio Accounts API before persisting. BYO account only.
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Outlook default scopes += Mail.Send (ADR-037 email-swarm parity with Gmail's send leg): scripts/oshal-outlook.js now sends via POST /me/sendMail, which needs the delegated Mail.Send permission. Existing Outlook connections must RECONNECT at /utilities to pick up the new scope; the Azure app registration needs Mail.Send added under API permissions (docs/partner-app-registration.md, Communications bundle).
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Plaid becomes a first-class hub connector (new auth:'link' mode) instead of the app-private oshal_finance_items store ADR-048 gave Finance. Adds the 'plaid' PROVIDERS entry (finance category, stub OAuth fields — its ceremony is the Link widget), the 'link' auth-model + 'plaid' flavor union members, the /list `configured` link-branch (isPlaidConfigured), and registers the Plaid Link routes (connector-plaid-link.ts) before the generic /:provider/* handlers. Tokens land in oshal_connections (per-user AES-GCM) and read back via getValidAccessToken's no-refresh_token branch, so an app REFERENCES Plaid via the broker rather than forking its own store. NB: file at the decomposition threshold — all substantive Plaid logic lives in connector-plaid-link.ts, this is a small wiring seam only.
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY-HARDENING 3.1/9: removed the hardcoded dev-key fallback from the key derivation - SESSION_SECRET unset now throws at the call site instead of silently deriving a well-known AES key any reader of this public repo can compute. Guard: tests/unit/no-dev-secret-fallback.spec.ts.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Multi-account-per-provider closed out (ADR-113 section 4). (a) The CREATE TABLE no longer declares UNIQUE (user_sub, provider) — it was created and then dropped again by ensureTenancySchema on every fresh boot, and under OSHAL_SCHEMA_BOOTSTRAP=validate-only it survived, so a migration-driven deployment silently OVERWROTE the first account on the second connect. scripts/migrations/101-connections-multi-account.sql is the owner-role half; the per-account partial unique indexes are the only uniqueness now. (b) /start forces the provider's ACCOUNT CHOOSER once the caller already holds a connection for that provider (or asks with ?another=1) — Google's default prompt=consent silently re-authorises the SAME account, which made "two Gmails" unreachable from the UI no matter how the schema was shaped. (c) DELETE /:provider revoked ONE refresh token and then deleted EVERY row for the provider; it now revokes each account it removes and re-seeds the scope default. (d) /list publishes defaultConnectionId + multiAccount so a consumer can see which account a bare token request will resolve to. Guards: tests/unit/connector-multi-account.spec.ts.
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Envelope-crypto default-ON boot posture: after ensureDekSchema, log LOUD (error) when OSHAL_ENVELOPE_CRYPTO is on (now the default) but SESSION_SECRET is unset — connector token crypto will throw at the kek() boundary, so surface the misconfig at boot rather than on the first connect. Imported envelopeEnabled for the check.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | INSTALLER-GAPS G14: getValidAccessToken accepts opts.forceRefresh — when a refresh token exists, skip the still-valid-expiry shortcut and exercise a REAL provider refresh, so the connector-liveness probe learns whether the provider still honors the grant (revoked Testing-mode Google → `refresh 400`) instead of trusting the DB row. Default path (no flag) is byte-for-byte unchanged.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | MACHINE-WRITE IDENTITY (BACKLOG "Machine-write identity: audit every un-migrated identity-less WRITE"). The Facebook data-deletion callback DELETEd from oshal_connections with no database identity established. Meta calls it server-to-server with a signed_request and no OIDC session, so the global middleware stamps anonymous non-operator — and oshal_connections carries FORCE ROW LEVEL SECURITY (migration 060 Tier-2, user_sub/tenant_id). The DELETE therefore matched ZERO rows on every call while the handler happily returned {url, confirmation_code}: a silent no-op that is simultaneously this audit class and a false deletion attestation to Meta. The statement now runs under runWithSystemIdentity and reports its real rowCount. Deliberate deviation from the synthetic-machine-sub rail (alert:prometheus / a2a:<id> / webhook:<provider>) and the ONLY one in this pass: those work because the machine OWNS the rows it writes, whereas here the row belongs to a real user whose sub Facebook never tells us — the operation is cross-owner by definition. Bounded the way cli-token-routes bounds its own pre-identity lookup: a single statement, no scan, keyed on an HMAC-verified account id, returning nothing to the caller but a confirmation code.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: retain encrypted per-user Twilio enrollment for fixed controller operations while removing the former generic bot/CLI credential carrier.
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed the over-threshold connector hub into cohesive provider-registry/credentials, OAuth-ceremony, account-operation, and response-helper modules. This file remains the stable route/export facade; route order, auth, RLS identity, SQL, provider requests, environment credential mappings, and the concurrent SEC-05 Twilio boundary are unchanged.
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Register the RingCentral screen-pop SSE stream (ringcentral-screen-pop.ts) ahead of the generic handlers, Plaid-style; RingCentral consent itself rides the ordinary /start + /callback with the new registry entry.
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | Reconnect-in-place: /start?reconnect=<connectionId> re-runs consent for ONE existing accessible connection instead of adding another. login_hint is pinned to the STORED account_email (the provider re-auths that login, not whichever account the browser holds), the ADR-113 account-chooser override is skipped (the def's own authParams stand, so Google keeps prompt=consent and re-issues the refresh token a dead grant is missing), the stored label rides the signed state (the upsert's label refresh would otherwise rename the account to its email mid-repair), and an unknown/inaccessible id 404s. No callback change: the (scope, provider, account_key) conflict already updates the same row, so id/default/label survive. Pairs with the per-account "reconnect" action on /utilities; guard tests/unit/connector-reconnect.spec.ts.
 * -----------------------------------------------------------------------------
 *
 * @module connectors-routes
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '@/app/composition/app-context';
import { encryptToken } from './connector-token-crypto';
import {
  accessibleConnections, upsertConnection, isTenantMember, relabelConnection,
  disconnectConnections, type ConnectionSelector,
} from './connector-tenancy';
import { fetchAccount } from './connector-account-lookup';
import { registerPlaidLinkRoutes } from './connector-plaid-link';
import { registerRingcentralScreenPop } from './ringcentral-screen-pop';
import {
  PROVIDERS, additionalAccountAuthParams, providerCreds,
} from './connector-provider-registry';
import {
  appUrl, encrypt, exchangeCode, parseSignedRequest, pkcePair, readPkceVerifier,
  redirectUri, signState, verifyState,
} from './connector-oauth-ceremony';
import {
  ensureConnectionsSchema, getValidAccessToken, revokeRefreshToken,
} from './connector-account-operations';
import { buildConnectorListResponse, caller } from './connector-response-helpers';

const logger = createChildLogger({ module: 'connectors-routes' });

export { additionalAccountAuthParams, ensureConnectionsSchema, getValidAccessToken };

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

  // RingCentral screen-pop realtime stream (GET /ringcentral/events, SSE) — the server-owned
  // per-user presence listener behind the Intelligent Sales inbound-call pop. Registered ahead
  // of the generic handlers like Plaid; consent itself rides the ordinary /start + /callback.
  registerRingcentralScreenPop(router, ctx);

  /** GET /api/connect/list — the caller's connections (status only, never tokens). */
  router.get('/list', async (req: Request, res: Response) => {
    const me = caller(req);
    if (!me) { res.status(401).json({ error: 'not authenticated' }); return; }
    // Personal ∪ shared (ADR-042). A caller may have MANY accounts per provider (labeled);
    // return them all so the UI can list + select each one.
    const rows = await accessibleConnections(ctx.pool, me.sub);
    res.json({ providers: buildConnectorListResponse(rows) });
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
    // Reconnect-in-place (?reconnect=<connectionId>): re-run consent for ONE account the caller
    // already holds instead of adding another — the repair path for a dead grant (liveness
    // `needs_reconnect`, per-row `expired`). The row must be accessible to the caller; the
    // callback needs no new path because the upsert conflicts on (scope, provider, account_key),
    // so re-consenting the same account UPDATES the row — id, default flag and label survive.
    const providerConnections = await accessibleConnections(ctx.pool, me.sub, provider);
    const reconnectId = String(req.query.reconnect || '').trim();
    const reconnectRow = reconnectId
      ? providerConnections.find((r) => r.connection_id === reconnectId) ?? null
      : null;
    if (reconnectId && !reconnectRow) { res.status(404).json({ error: 'connection not found' }); return; }
    // Optional target household — the caller must be a member to connect a shared hub. A
    // reconnect targets the row's OWN scope (membership already proven by accessibility).
    const tenant = reconnectRow ? String(reconnectRow.tenant_id || '') : String(req.query.tenant || '').trim();
    if (!reconnectRow && tenant && tenant !== 'personal' && !(await isTenantMember(ctx.pool, tenant, me.sub))) {
      res.status(403).json({ error: 'not a member of that household' });
      return;
    }
    // Optional label (nickname) for this account — lets a user hold several accounts per
    // provider ("work email", "home email"). Blank → defaults to the account email. A reconnect
    // re-sends the STORED label so the upsert's label refresh cannot rename the account mid-repair.
    const label = reconnectRow
      ? String(reconnectRow.label || '').slice(0, 60)
      : String(req.query.label || '').trim().slice(0, 60);
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri(provider),
      response_type: 'code',
      // Only send `scope` when the connector defines one. Schwab has no user-selectable scopes
      // and 400s on an empty scope= param, so scopeless connectors omit it entirely.
      ...(def.scopes.length ? { scope: def.scopes.join(def.scopeSep) } : {}),
      ...def.authParams,
      // login_hint helps the OIDC providers; Twitter + Schwab authorize endpoints don't use it.
      // A reconnect pins the hint to the STORED account so the provider re-auths that login,
      // not whichever account the browser happens to be signed into.
      ...((reconnectRow?.account_email || me.email) && provider !== 'twitter' && provider !== 'schwab'
        ? { login_hint: reconnectRow?.account_email || me.email } : {}),
    });
    // PKCE (Twitter): send the S256 challenge; carry the verifier in a short-lived
    // cookie (NOT the state) so `state` stays small — X 400s on an over-long state.
    if (def.pkce) {
      const { verifier, challenge } = pkcePair();
      res.cookie(`oshalpkce_${provider}`, encrypt(verifier), { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' });
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }
    // Adding ANOTHER account of a provider the caller is already connected to (ADR-113 section 4):
    // force the provider's account chooser, otherwise the consent screen silently re-authorises the
    // account the browser is signed into and the "second Gmail" becomes an update of the first.
    // A reconnect deliberately SKIPS the chooser — the flow already knows which account
    // (login_hint above), and the def's own authParams stand, so Google keeps prompt=consent
    // and re-issues the refresh token a dead grant is missing.
    const chooser = reconnectRow
      ? {}
      : additionalAccountAuthParams(def.flavor, providerConnections.length, String(req.query.another || '').trim() === '1');
    if (Object.keys(chooser).length) {
      for (const [k, v] of Object.entries(chooser)) params.set(k, v);
      logger.info({ provider, sub: me.sub, existing: providerConnections.length }, 'Connector consent: forcing the provider account chooser (additional account)');
    }
    if (reconnectRow) {
      logger.info({ provider, sub: me.sub, connectionId: reconnectRow.connection_id }, 'Connector consent: reconnect-in-place for an existing account');
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
      // ADR-134 D5.3: "log in → accounts pull in" means the LOGIN, not a later screen visit — the
      // Schwab callback fires broker-account discovery directly (the token was just validated
      // against GET /accounts/accountNumbers, so the enumeration is literally in hand). Fire-and-
      // forget: a discovery failure must never fail the connect itself.
      if (provider === 'schwab') {
        void import('../trading-accounts-store.js')
          .then((m) => m.discoverBrokerAccounts(ctx.pool, me.sub))
          .then((r) => logger.info({ sub: me.sub, ...r }, 'schwab connect → broker accounts discovered'))
          .catch((err) => logger.error({ err, sub: me.sub }, 'schwab connect → account discovery failed (connect itself succeeded)'));
      }
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
      // Multi-account: this removes EVERY personal account of the provider, so every one of them
      // gets its refresh token revoked. The pre-multi-account code read a single row and revoked
      // that one while the DELETE removed them all — leaving live grants at the provider.
      const rows = (await ctx.pool.query(
        'SELECT connection_id, refresh_token FROM oshal_connections WHERE user_sub = $1 AND provider = $2 AND tenant_id IS NULL',
        [me.sub, provider],
      )).rows as Array<{ connection_id: string; refresh_token: string | null }>;
      await Promise.all(rows.map(async (r) => revokeRefreshToken(ctx.pool, me.sub, def, r.refresh_token)));
      const removed = await disconnectConnections(ctx.pool, me.sub, rows.map((r) => r.connection_id), provider);
      res.json({ success: true, removed });
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
      await revokeRefreshToken(ctx.pool, me.sub, PROVIDERS[row.provider], row.refresh_token);
      // disconnectConnections re-seeds the provider's scope default, so removing the DEFAULT of two
      // accounts promotes the remaining one instead of leaving the provider defaultless (which would
      // drop resolution onto the stable-order fallback).
      await disconnectConnections(ctx.pool, me.sub, [String(req.params.id)], String(row.provider));
      res.json({ success: true });
    } catch (err: any) {
      logger.error({ err }, 'connection delete failed');
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * @description Facebook Data Deletion Request callback (Meta requirement). FB POSTs a
 * signed_request when a user removes the app / requests deletion; we verify it, delete
 * that user's stored Facebook connection, and return {url, confirmation_code}.
 * Mounted UNGATED at /auth/facebook/data-deletion (FB calls it server-to-server).
 * @param ctx - application context containing the RLS-governed database pool
 * @returns POST and GET handlers for Meta's deletion contract
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
        // IDENTITY: oshal_connections is FORCE-RLS (migration 060 Tier-2). Meta calls this
        // server-to-server, so the ambient identity is anonymous non-operator and this DELETE
        // silently matched zero rows while still returning a confirmation code. The row belongs
        // to a real user whose sub the signed_request never carries, so the synthetic-machine-sub
        // rail cannot express it — this is a genuinely cross-owner statement and the trusted
        // SYSTEM sentinel is the sanctioned way to mark one. Kept as narrow as the cli-token
        // pre-identity lookup: ONE statement, no scan, keyed on the HMAC-verified account id.
        const deleted = await runWithSystemIdentity(() => ctx.pool.query(
          "DELETE FROM oshal_connections WHERE provider = 'facebook' AND account_id = $1 RETURNING user_sub",
          [String(data.user_id)],
        ));
        // rowCount is the attestation. A zero here used to be invisible; Meta is told the data is
        // gone either way, so a silent zero must be loud in our logs.
        logger.info(
          { fbUserId: data.user_id, code, deletedConnections: deleted.rowCount ?? 0 },
          'Facebook data deletion processed',
        );
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
