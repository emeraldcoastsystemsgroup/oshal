/**
 * Connector OAuth ceremony primitives.
 *
 * Owns redirect construction, signed state, encrypted PKCE cookies, provider-aware
 * authorization-code exchange, and Facebook signed-request verification. User token
 * persistence and account selection remain in connector-account-operations.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted OAuth state/PKCE, redirect, code-exchange, and signed-request helpers from connectors-routes.ts without changing provider requests or credential sources.
 * -----------------------------------------------------------------------------
 *
 * @module connector-oauth-ceremony
 */

import * as crypto from 'crypto';
import type { Request } from 'express';
import {
  PROVIDERS, SQUARE_VERSION, providerCreds, type ProviderDef,
} from './connector-provider-registry';

/**
 * @description Resolve the public application base URL used by connector callbacks.
 * @returns the base URL without a trailing slash
 */
export function appUrl(): string {
  return (process.env.APP_URL || 'http://localhost:35457').replace(/\/$/, '');
}
/**
 * @description Resolve the registered callback URI, honoring the existing provider override.
 * @param provider - stable connector provider id
 * @returns the exact callback URI sent to the provider
 */
export function redirectUri(provider: string): string {
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

/**
 * @description Seal a short-lived PKCE verifier for its HttpOnly callback cookie.
 * @param plain - verifier plaintext
 * @returns AES-256-GCM iv:tag:cipher payload
 */
export function encrypt(plain: string): string {
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

/**
 * @description Create a high-entropy verifier and S256 challenge for PKCE providers.
 * The encrypted verifier travels in a short-lived HttpOnly cookie, outside OAuth state.
 * @returns the verifier and matching base64url challenge
 */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * @description Read and decrypt the PKCE verifier cookie set by the start route.
 * @param req - callback request
 * @param provider - stable connector provider id
 * @returns the verifier, or undefined when the cookie is absent or invalid
 */
export function readPkceVerifier(req: Request, provider: string): string | undefined {
  const name = `oshalpkce_${provider}`;
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (!raw) return undefined;
  try { return decrypt(decodeURIComponent(raw.slice(name.length + 1))); } catch { return undefined; }
}

/**
 * @description Sign a time-boxed CSRF state payload without a server-side state store.
 * @param payload - connector flow identity and optional tenant/label fields
 * @returns the base64url payload and HMAC signature
 */
export function signState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
/**
 * @description Verify and decode a connector CSRF state within its ten-minute window.
 * @param state - signed state value returned by the provider
 * @returns the decoded payload, or null when invalid or expired
 */
export function verifyState(state: string): Record<string, any> | null {
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

/**
 * @description Exchange an authorization code using the provider's existing OAuth dialect.
 * @param provider - stable connector provider id
 * @param def - provider authorization contract
 * @param code - authorization code returned by the provider
 * @param codeVerifier - PKCE verifier for providers that require one
 * @returns the normalized provider token response
 */
export async function exchangeCode(provider: string, def: ProviderDef, code: string, codeVerifier?: string): Promise<any> {
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


/**
 * @description Verify a Facebook signed_request with HMAC-SHA256.
 * @param signed - encoded signature and payload supplied by Meta
 * @param appSecret - Facebook application secret
 * @returns the verified payload, or null when malformed or unauthentic
 */
export function parseSignedRequest(signed: string, appSecret: string): { user_id?: string } | null {
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


