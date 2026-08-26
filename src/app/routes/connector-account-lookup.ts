/**
 * Connector account lookup — resolve a connected account's display identity.
 *
 * Extracted from connectors-routes.ts (which hit the 1000-line cap): the per-provider
 * "who is this token for" dialect. Given a freshly-exchanged token, returns an
 * { email, id } label for the connection card. Each provider has its own identity
 * endpoint (OIDC userinfo, Graph /me, Square /v2/merchants, …); adding a connector
 * adds a branch here. Pure read — no storage, no secrets beyond the supplied token.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — fetchAccount + decodeJwt moved out of connectors-routes.ts (over the 1000-line cap) verbatim, including the square/paypal branches. Provider base URLs re-derived from the same env vars.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add 'uber' (Uber Eats) branch — deep-link handoff connector with no consumer order API, so the pasted token is an optional affiliate/marketing blob; accept any non-empty paste and derive a label (no live validation call).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add 'schwab' branch — validate the OAuth token against the Trader API GET /accounts/accountNumbers (confirms Accounts & Trading approval); label by the masked account number, id = the account number. Base URL env-overridable (SCHWAB_TRADER_BASE_URL) for the sandbox.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Add 'twilio' branch — the pasted secret is the combined "AccountSid:AuthToken" (Jira two-value shape); validate as HTTP Basic against GET /2010-04-01/Accounts/{sid}.json, reject non-active accounts, label by friendly name, id = Account SID.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Add 'kalshi' branch — the pasted secret is "keyId:privateKeyPem" (two-value shape); no bearer token exists, so validate by RSA-PSS-signing a real GET /portfolio/balance, label by balance, id = key id.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Recognize the Outlook connector's stable `outlook` id as the Microsoft OAuth dialect when deriving its account label from the OIDC id_token.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Add 'resend' (GENERIC_VERIFY against GET /domains, label by the first verified domain) and a bespoke 'bluesky' branch (kalshi shape) — the pasted secret is "identifier:app-password"; no bearer whoami exists, so validate via a real com.atproto.server.createSession POST; label = handle, id = DID.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Add 'ringcentral' branch — GET /restapi/v1.0/account/~/extension/~ labels the connection by contact email (else name + extension number); id = the extension id the screen-pop presence events are scoped to. Throws on a non-OK lookup so a bad token fails the connect loudly.
 *
 * @module connector-account-lookup
 */

import { probeKalshiAccount } from '@/features/prediction-markets';

const FB_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const GOOGLE_HOME_PROJECT_ID = process.env.GOOGLE_HOME_PROJECT_ID || '';
const SQUARE_SANDBOX = (process.env.SQUARE_ENV || 'sandbox') !== 'production';
const SQUARE_WEB = SQUARE_SANDBOX ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2024-12-18';
const PAYPAL_SANDBOX = (process.env.PAYPAL_ENV || 'sandbox') !== 'production';
const PAYPAL_API = PAYPAL_SANDBOX ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
// Jira Cloud site root (no trailing slash) for validating a pasted email+API-token.
// Accept either the site root or the declarative spec's REST root (/rest/api/3).
const JIRA_SITE = normalizeJiraSiteUrl(process.env.CONNECTOR_JIRA_BASE_URL || process.env.JIRA_BASE_URL || '');

export function normalizeJiraSiteUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/rest\/api\/3$/i, '');
}

/** Decode a JWT payload without verifying (we already trust the token endpoint). */
function decodeJwt(jwt?: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

/** Read a dotted path from an object, e.g. dot(j, 'resource.email'). */
function dot(o: any, p: string): unknown { return p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o); }

/**
 * Config-driven validation for ADR-065 token-paste connectors (flavor 'generic'): GET a "whoami"
 * endpoint with the pasted PAT; a non-2xx fails the connect closed. Adds a connector with a row here,
 * no bespoke branch. Default auth is `Authorization: Bearer <token>` (override header/prefix).
 */
const GENERIC_VERIFY: Record<string, { url: string; header?: string; prefix?: string; idPath?: string; emailPath?: string; label: string }> = {
  gitlab: { url: 'https://gitlab.com/api/v4/user', header: 'PRIVATE-TOKEN', prefix: '', idPath: 'username', emailPath: 'email', label: 'GitLab' },
  zoom: { url: 'https://api.zoom.us/v2/users/me', idPath: 'id', emailPath: 'email', label: 'Zoom' },
  calendly: { url: 'https://api.calendly.com/users/me', idPath: 'resource.uri', emailPath: 'resource.email', label: 'Calendly' },
  hubspot: { url: 'https://api.hubapi.com/account-info/v3/details', idPath: 'portalId', label: 'HubSpot' },
  asana: { url: 'https://app.asana.com/api/1.0/users/me', idPath: 'data.gid', emailPath: 'data.email', label: 'Asana' },
  airtable: { url: 'https://api.airtable.com/v0/meta/whoami', idPath: 'id', emailPath: 'email', label: 'Airtable' },
  stripe: { url: 'https://api.stripe.com/v1/account', idPath: 'id', emailPath: 'email', label: 'Stripe' },
  sendgrid: { url: 'https://api.sendgrid.com/v3/scopes', label: 'SendGrid' },
  openai: { url: 'https://api.openai.com/v1/models', label: 'OpenAI' },
  strava: { url: 'https://www.strava.com/api/v3/athlete', idPath: 'id', emailPath: 'username', label: 'Strava' },
  oura: { url: 'https://api.ouraring.com/v2/usercollection/personal_info', idPath: 'id', emailPath: 'email', label: 'Oura' },
  fitbit: { url: 'https://api.fitbit.com/1/user/-/profile.json', idPath: 'user.encodedId', emailPath: 'user.fullName', label: 'Fitbit' },
  whoop: { url: 'https://api.prod.whoop.com/developer/v1/user/profile/basic', idPath: 'user_id', emailPath: 'email', label: 'WHOOP' },
  vercel: { url: 'https://api.vercel.com/v2/user', idPath: 'user.uid', emailPath: 'user.email', label: 'Vercel' },
  netlify: { url: 'https://api.netlify.com/api/v1/user', idPath: 'id', emailPath: 'email', label: 'Netlify' },
  sentry: { url: 'https://sentry.io/api/0/organizations/', label: 'Sentry' },
  bitbucket: { url: 'https://api.bitbucket.org/2.0/user', idPath: 'uuid', emailPath: 'username', label: 'Bitbucket' },
  coinbase: { url: 'https://api.coinbase.com/v2/user', idPath: 'data.id', emailPath: 'data.email', label: 'Coinbase' },
  discord: { url: 'https://discord.com/api/v10/users/@me', idPath: 'id', emailPath: 'username', label: 'Discord' },
  intercom: { url: 'https://api.intercom.io/me', idPath: 'id', emailPath: 'email', label: 'Intercom' },
  clickup: { url: 'https://api.clickup.com/api/v2/user', header: 'Authorization', prefix: '', idPath: 'user.id', emailPath: 'user.email', label: 'ClickUp' },
  figma: { url: 'https://api.figma.com/v1/me', header: 'X-Figma-Token', prefix: '', idPath: 'id', emailPath: 'email', label: 'Figma' },
  todoist: { url: 'https://api.todoist.com/rest/v2/projects', label: 'Todoist' },
  wakatime: { url: 'https://api.wakatime.com/api/v1/users/current', idPath: 'data.id', emailPath: 'data.email', label: 'WakaTime' },
  pinterest: { url: 'https://api.pinterest.com/v5/user_account', idPath: 'username', emailPath: 'username', label: 'Pinterest' },
  gumroad: { url: 'https://api.gumroad.com/v2/user', idPath: 'user.user_id', emailPath: 'user.email', label: 'Gumroad' },
  pagerduty: { url: 'https://api.pagerduty.com/abilities', header: 'Authorization', prefix: 'Token token=', label: 'PagerDuty' },
  shippo: { url: 'https://api.goshippo.com/addresses/', header: 'Authorization', prefix: 'ShippoToken ', label: 'Shippo' },
  raindrop: { url: 'https://api.raindrop.io/rest/v1/user', idPath: 'user._id', emailPath: 'user.email', label: 'Raindrop.io' },
  monzo: { url: 'https://api.monzo.com/ping/whoami', idPath: 'user_id', label: 'Monzo' },
  buttondown: { url: 'https://api.buttondown.com/v1/newsletters', header: 'Authorization', prefix: 'Token ', label: 'Buttondown' },
  postmark: { url: 'https://api.postmarkapp.com/server', header: 'X-Postmark-Server-Token', prefix: '', idPath: 'ID', emailPath: 'Name', label: 'Postmark' },
  unsplash: { url: 'https://api.unsplash.com/me', idPath: 'id', emailPath: 'email', label: 'Unsplash' },
  // Resend has no /me — /domains is the cheapest key-scoped GET (401s on a bad key). Response is
  // { data: [ { id, name, … } ] }; label by the first verified domain when one exists.
  resend: { url: 'https://api.resend.com/domains', idPath: 'data.0.id', emailPath: 'data.0.name', label: 'Resend' },
};

/**
 * @description Fetch the connected account's identity from the token response.
 * @param provider - The connector id (google, square, paypal, …).
 * @param tok - The token bag from the OAuth exchange (access_token / id_token).
 * @returns An { email, id } label for the connection (best-effort; nulls when unavailable).
 */
export async function fetchAccount(provider: string, tok: { access_token?: string; id_token?: string }): Promise<{ email: string | null; id: string | null }> {
  const accessToken = tok?.access_token || '';
  if (provider === 'microsoft' || provider === 'outlook') {
    // An IMAP-scoped token can't call Graph /me — read identity from the OIDC id_token.
    const c = decodeJwt(tok?.id_token);
    return { email: (c.email as string) || (c.preferred_username as string) || null, id: (c.oid as string) || (c.sub as string) || null };
  }
  if (!accessToken) return { email: null, id: null };
  if (provider === 'ringcentral') {
    // Label by the authenticated extension (`~` = own account/extension): contact email
    // when present, else the extension name/number. id = the extension id — the identity
    // the screen-pop listener's presence events are scoped to.
    const base = (process.env.RINGCENTRAL_SERVER_URL || 'https://platform.ringcentral.com').replace(/\/$/, '');
    const r = await fetch(`${base}/restapi/v1.0/account/~/extension/~`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`ringcentral extension lookup ${r.status}`);
    const j = (await r.json()) as { id?: number | string; name?: string; extensionNumber?: string; contact?: { email?: string } };
    const label = j.contact?.email || [j.name, j.extensionNumber ? `ext ${j.extensionNumber}` : ''].filter(Boolean).join(' · ');
    return { email: label || null, id: j.id != null ? String(j.id) : null };
  }
  if (provider === 'google' || provider === 'gcp') {
    // Both carry openid+email, so OIDC userinfo labels the connection by the account
    // email (GCP adds the cloud-platform scope on top, which userinfo ignores).
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { email?: string; sub?: string };
    return { email: j.email ?? null, id: j.sub ?? null };
  }
  if (provider === 'facebook' || provider === 'meta-business') {
    const r = await fetch(`https://graph.facebook.com/${FB_VERSION}/me?fields=id,email,name&access_token=${encodeURIComponent(accessToken)}`);
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { id?: string; email?: string; name?: string };
    return { email: j.email || j.name || null, id: j.id ?? null };
  }
  if (provider === 'linkedin') {
    // OIDC userinfo (openid scope): sub is the LinkedIn person id used as the post author URN.
    const r = await fetch('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { sub?: string; email?: string; name?: string };
    return { email: j.email || j.name || null, id: j.sub ?? null };
  }
  if (provider === 'twitter') {
    // X gives no email; use @handle for display and the numeric id as account_id (author for posts).
    const r = await fetch('https://api.twitter.com/2/users/me?user.fields=username,name', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { data?: { id?: string; username?: string; name?: string } };
    const d = j.data || {};
    return { email: d.username ? `@${d.username}` : (d.name ?? null), id: d.id ?? null };
  }
  if (provider === 'github') {
    // GitHub requires a User-Agent; email may be private (null) — fall back to @login.
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'OSHAL-connectors' } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { login?: string; id?: number; email?: string };
    return { email: j.email || (j.login ? `@${j.login}` : null), id: j.id != null ? String(j.id) : (j.login ?? null) };
  }
  if (provider === 'dropbox') {
    // get_current_account is an arg-less RPC: POST with the bearer token, no body.
    const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { account_id?: string; email?: string; name?: { display_name?: string } };
    return { email: j.email || j.name?.display_name || null, id: j.account_id ?? null };
  }
  if (provider === 'smartthings') {
    // SmartThings has no /me; validate the OAuth access token against /v1/locations and use the
    // first location's name as the display label + its id as the account id.
    const r = await fetch('https://api.smartthings.com/v1/locations', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { items?: Array<{ locationId?: string; name?: string }> };
    const loc = (j.items || [])[0] || {};
    return { email: loc.name ? `SmartThings · ${loc.name}` : 'SmartThings', id: loc.locationId ?? null };
  }
  if (provider === 'jira') {
    // accessToken is the combined "email:token" secret. Validate it as HTTP Basic against
    // the site's /myself; label by display name + email, id = Atlassian accountId.
    if (!JIRA_SITE) return { email: null, id: null };
    const i = accessToken.indexOf(':');
    if (i < 1) return { email: null, id: null };
    const email = accessToken.slice(0, i), apiToken = accessToken.slice(i + 1);
    const auth = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
    const r = await fetch(`${JIRA_SITE}/rest/api/3/myself`, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { accountId?: string; displayName?: string; emailAddress?: string };
    const who = j.displayName || j.emailAddress || email;
    return { email: `Jira · ${who}`, id: j.accountId ?? null };
  }
  if (provider === 'twilio') {
    // accessToken is the combined "AccountSid:AuthToken" secret (Jira two-value shape).
    // Validate it as HTTP Basic against the account resource itself; label by the
    // account's friendly name, id = the Account SID.
    const i = accessToken.indexOf(':');
    if (i < 1) return { email: null, id: null };
    const sid = accessToken.slice(0, i), authToken = accessToken.slice(i + 1);
    const auth = 'Basic ' + Buffer.from(`${sid}:${authToken}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { headers: { Authorization: auth } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { sid?: string; friendly_name?: string; status?: string };
    if (j.status && j.status !== 'active') return { email: null, id: null };
    return { email: j.friendly_name ? `Twilio · ${j.friendly_name}` : 'Twilio', id: j.sid ?? sid };
  }
  if (provider === 'kalshi') {
    // accessToken is the combined "keyId:privateKeyPem" secret (two-value shape; the PEM has no
    // ':'). Kalshi has no bearer token — every request is RSA-PSS signed — so validate by
    // SIGNING a real /portfolio/balance call; a bad key id or key material fails closed.
    try {
      const acct = await probeKalshiAccount(accessToken);
      return { email: `Kalshi ${acct.env.toUpperCase()} · $${acct.balanceDollars.toFixed(2)} balance`, id: acct.keyId };
    } catch {
      return { email: null, id: null };
    }
  }
  if (provider === 'bluesky') {
    // accessToken is the combined "identifier:app-password" secret (two-value shape; identifier =
    // handle, DID, or email — Bluesky app passwords are xxxx-xxxx-xxxx-xxxx with no ':', so the
    // FIRST-colon split is safe). There is no bearer whoami — validate by performing the real
    // ATProto session handshake; a bad identifier or app password fails closed. Label = the
    // resolved handle, id = the stable DID (the repo key the posting operation writes under).
    const i = accessToken.indexOf(':');
    if (i < 1 || i >= accessToken.length - 1) return { email: null, id: null };
    const identifier = accessToken.slice(0, i).trim();
    const password = accessToken.slice(i + 1);
    if (!identifier || !password) return { email: null, id: null };
    const base = (process.env.MARKETING_BLUESKY_SERVICE || 'https://bsky.social').replace(/\/+$/, '');
    try {
      const r = await fetch(`${base}/xrpc/com.atproto.server.createSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ identifier, password }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { email: null, id: null };
      const j = (await r.json()) as { did?: string; handle?: string };
      if (!j.did) return { email: null, id: null };
      return { email: j.handle ? `Bluesky · @${j.handle}` : 'Bluesky', id: j.did };
    } catch {
      return { email: null, id: null };
    }
  }
  if (provider === 'finnhub') {
    // A plain API token passed as ?token= — no OAuth, no account endpoint. Validate by making a
    // real, cheap call (/quote?symbol=AAPL): 200 with a numeric current price ('c') means the key
    // works; 401/403/429 or a Finnhub error object fails closed. Labels the connection by a masked
    // key tail so the user can tell which key is stored without exposing it.
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(accessToken)}`);
      if (!r.ok) return { email: null, id: null };
      const j = (await r.json()) as { c?: number; error?: string };
      if (j.error || typeof j.c !== 'number' || j.c <= 0) return { email: null, id: null };
      const tail = accessToken.slice(-4);
      return { email: `Finnhub key …${tail}`, id: `finnhub:${tail}` };
    } catch {
      return { email: null, id: null };
    }
  }
  if (provider === 'square') {
    // Label the connection by the merchant's business name; id = merchant_id.
    const r = await fetch(`${SQUARE_WEB}/v2/merchants`, { headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': SQUARE_VERSION } });
    if (!r.ok) return { email: 'Square', id: null };
    const j = (await r.json()) as { merchant?: Array<{ id?: string; business_name?: string }> };
    const m = (j.merchant || [])[0] || {};
    return { email: m.business_name ? `Square · ${m.business_name}` : 'Square', id: m.id ?? null };
  }
  if (provider === 'paypal') {
    // PayPal Identity userinfo (openid scope): email + payer_id.
    const r = await fetch(`${PAYPAL_API}/v1/identity/oauth2/userinfo?schema=paypalv1.1`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: 'PayPal', id: null };
    const j = (await r.json()) as { email?: string; payer_id?: string; user_id?: string };
    return { email: j.email || 'PayPal', id: j.payer_id || j.user_id || null };
  }
  if (provider === 'google-home') {
    // The sdm.service token can't call userinfo (wrong scope). Validate against the
    // Device Access structures endpoint; label by the project id (the account scope).
    if (!GOOGLE_HOME_PROJECT_ID) return { email: 'Google Nest', id: null };
    const r = await fetch(`https://smartdevicemanagement.googleapis.com/v1/enterprises/${GOOGLE_HOME_PROJECT_ID}/structures`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return { email: r.ok ? 'Google Nest' : 'Google Nest (no structures)', id: GOOGLE_HOME_PROJECT_ID };
  }
  if (provider === 'walmart') {
    // The "token" is a JSON blob {consumerId, keyVersion, privateKeyPem, publisherId?, baseUrl?}.
    // Validate by signing a real catalog call (taxonomy) — a bad key/consumer id fails closed.
    let c: any;
    try { c = JSON.parse(accessToken); } catch { return { email: null, id: null }; }
    if (!c.consumerId || !c.privateKeyPem) return { email: null, id: null };
    const { createSign } = await import('crypto');
    const base = String(c.baseUrl || 'https://developer.api.walmart.com').replace(/\/$/, '');
    const keyVersion = String(c.keyVersion || '1');
    const ts = String(Date.now());
    let sig: string;
    try { sig = createSign('RSA-SHA256').update(`${c.consumerId}\n${ts}\n${keyVersion}\n`).sign(c.privateKeyPem, 'base64'); }
    catch { return { email: null, id: null }; }
    const r = await fetch(`${base}/api-proxy/service/affil/product/v2/taxonomy`, {
      headers: {
        'WM_CONSUMER.ID': c.consumerId, 'WM_CONSUMER.INTIMESTAMP': ts,
        'WM_SEC.KEY_VERSION': keyVersion, 'WM_SEC.AUTH_SIGNATURE': sig, Accept: 'application/json',
      },
    });
    if (!r.ok) return { email: null, id: null };
    return { email: `Walmart · ${String(c.consumerId).slice(0, 8)}…`, id: String(c.consumerId) };
  }
  if (provider === 'uber') {
    // Uber Eats is a DEEP-LINK HANDOFF connector — there is no consumer order API to
    // validate against. The "token" is an optional affiliate/marketing JSON blob
    // {affiliateId?, marketUrl?, baseUrl?} (or a bare affiliate-id string). Accept any
    // non-empty paste and derive a label; the deep link works with or without it.
    const raw = String(accessToken || '').trim();
    if (!raw) return { email: null, id: null };
    let affiliateId = '';
    try {
      const c = JSON.parse(raw);
      affiliateId = String(c.affiliateId || c.affiliate_id || c.publisherId || '').trim();
    } catch {
      // Not JSON — treat the whole paste as the affiliate id.
      affiliateId = raw.slice(0, 64);
    }
    return {
      email: affiliateId ? `Uber Eats · ${affiliateId.slice(0, 16)}` : 'Uber Eats',
      id: affiliateId || 'ubereats',
    };
  }
  if (provider === 'tmdb') {
    // The "token" is a TMDB API key — either a v3 key (query param) or a v4 read access
    // token (a JWT, sent as a Bearer). Validate by reading /configuration; a bad key 401s.
    const raw = String(accessToken || '').trim();
    if (!raw) return { email: null, id: null };
    const isV4 = raw.startsWith('eyJ'); // v4 tokens are JWTs
    const url = isV4 ? 'https://api.themoviedb.org/3/configuration' : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(raw)}`;
    const r = await fetch(url, isV4 ? { headers: { Authorization: `Bearer ${raw}` } } : undefined);
    if (!r.ok) return { email: null, id: null };
    return { email: `TMDB · ${isV4 ? 'v4 token' : 'API key'}`, id: 'tmdb' };
  }
  if (provider === 'duffel') {
    // The "token" is a Duffel access token (duffel_test_… sandbox / duffel_live_… real).
    // Validate by reading /air/airlines (a cheap auth'd GET); a bad token 401/403s.
    const raw = String(accessToken || '').trim();
    if (!raw) return { email: null, id: null };
    const r = await fetch('https://api.duffel.com/air/airlines?limit=1', {
      headers: { Authorization: `Bearer ${raw}`, 'Duffel-Version': 'v2', Accept: 'application/json' },
    });
    if (!r.ok) return { email: null, id: null };
    const live = raw.toLowerCase().startsWith('duffel_live_');
    return { email: `Duffel · ${live ? 'live' : 'test'}`, id: 'duffel' };
  }
  if (provider === 'spotify') {
    // GET /v1/me → the user's profile. display_name labels the connection; email needs the
    // user-read-email scope (falls back to display_name); id is the Spotify user id (the
    // owner used when creating playlists on their behalf).
    const r = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { id?: string; email?: string; display_name?: string };
    return { email: j.email || (j.display_name ? `Spotify · ${j.display_name}` : 'Spotify'), id: j.id ?? null };
  }
  if (provider === 'slack') {
    // No email for a user token; auth.test returns the workspace + handle. Label by
    // "Slack · <workspace> (@<user>)"; id = the Slack user id (the message author key).
    // Slack always HTTP-200s and signals failure via { ok:false } — check both.
    const r = await fetch('https://slack.com/api/auth.test', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json()) as { ok?: boolean; team?: string; user?: string; user_id?: string };
    if (!j.ok) return { email: null, id: null };
    return { email: j.team ? `Slack · ${j.team}${j.user ? ` (@${j.user})` : ''}` : 'Slack', id: j.user_id ?? null };
  }
  if (provider === 'schwab') {
    // Validate the freshly-exchanged token against the Trader API's account-numbers endpoint
    // (a cheap auth'd GET that also confirms the app is approved for Accounts & Trading). Label
    // the connection by the masked account number; id = the plain account number. A bad/insufficient
    // token 401/403s → fails the connect closed. Base is env-overridable for Schwab's sandbox.
    const base = (process.env.SCHWAB_TRADER_BASE_URL || 'https://api.schwabapi.com/trader/v1').replace(/\/$/, '');
    const r = await fetch(`${base}/accounts/accountNumbers`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!r.ok) return { email: null, id: null };
    const j = (await r.json().catch(() => [])) as Array<{ accountNumber?: string; hashValue?: string }>;
    const first = (Array.isArray(j) ? j : [])[0] || {};
    const num = String(first.accountNumber || '');
    if (!num) return { email: 'Charles Schwab', id: null };
    return { email: `Schwab · …${num.slice(-4)}`, id: num };
  }
  const gv = GENERIC_VERIFY[provider];
  if (gv) {
    // Validate the pasted PAT against the provider's whoami endpoint (fails closed on a bad token).
    const header = gv.header || 'Authorization';
    const value = (gv.prefix ?? 'Bearer ') + accessToken;
    const r = await fetch(gv.url, { headers: { [header]: value, Accept: 'application/json' } });
    if (!r.ok) return { email: null, id: null };
    const j = await r.json().catch(() => ({}));
    const id = (gv.idPath ? String(dot(j, gv.idPath) ?? '') : '') || provider;
    const email = (gv.emailPath ? (dot(j, gv.emailPath) as string) : '') || gv.label;
    return { email, id };
  }
  return { email: null, id: null };
}
