/**
 * Kalshi authenticated requests — API-key-ID + RSA-PSS request signing.
 *
 * Kalshi's authed endpoints (portfolio, orders) require three headers per request:
 * KALSHI-ACCESS-KEY (key id), KALSHI-ACCESS-TIMESTAMP (epoch ms), and KALSHI-ACCESS-SIGNATURE =
 * base64(RSA-PSS-SHA256(timestamp + METHOD + path-without-query)) with salt length = digest
 * length. The private key arrives as a pasted PEM through the connector card; browsers mangle
 * multiline pastes, so normalizePem() rebuilds a valid PEM from whatever whitespace survived.
 * Stored connector secret shape: `keyId:PEM` (PEM contains no `:`; splitSecret-compatible).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — PEM normalization for single-line pastes, RSA-PSS signing per docs.kalshi.com, header builder, authed GET + balance probe (the connector-card validation call).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Auth env auto-detection per key (live registry first, demo on 401, cached per keyId): compose never forwards .env into containers, so the KALSHI_API_BASE=demo approach silently validated everything against prod (live key saved, demo key rejected — operator diagnosed it). A key's exchange is a property of the KEY, not process config; a global switch would also have pointed the market-data scan at the thin demo book. Probe now returns the detected env for the card label.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Phase 2 groundwork: kalshiAuthedRequest (any method + JSON body, same per-key env detection; fallback fires only on 401/403 wrong-registry, never business 400s) and Kalshi error bodies surfaced in thrown messages (insufficient_balance etc. must reach the UI, not a bare status).
 *
 * @module prediction-markets/kalshi-auth
 */

import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { kalshiApiBase } from './kalshi-public-client';

const log = createChildLogger({ module: 'kalshi-auth' });

/**
 * @description Rebuild a valid PEM from a paste that may have lost its newlines (single-line
 * input fields collapse them) or been line-commented (each line prefixed with `#`, e.g. a copy
 * out of a shell/env file where the key was temporarily disabled). Base64 never contains `#`,
 * so stripping a leading `#` per line is always safe. Accepts PKCS#1 ('RSA PRIVATE KEY') and
 * PKCS#8 ('PRIVATE KEY').
 * @param raw - The pasted key material.
 * @returns A well-formed PEM string.
 */
export function normalizePem(raw: string): string {
  const compact = raw.replace(/\\n/g, '\n').replace(/^[ \t]*#/gm, '').trim();
  const m = compact.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) throw new Error('not a PEM private key (missing BEGIN/END markers)');
  const label = m[1];
  const body = m[2].replace(/[\s\r\n#]+/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * @description Sign one request per Kalshi's scheme: RSA-PSS-SHA256 over
 * `${timestampMs}${METHOD}${path}` (path WITHOUT query params), salt = digest length, base64.
 * @param privateKeyPem - Normalized PEM private key.
 * @param timestampMs - Epoch ms as a string (must match the header value exactly).
 * @param method - Uppercase HTTP method.
 * @param path - Request path from the host root, query stripped, e.g. `/trade-api/v2/portfolio/balance`.
 * @returns Base64 signature.
 */
export function signKalshiRequest(privateKeyPem: string, timestampMs: string, method: string, path: string): string {
  const message = `${timestampMs}${method}${path.split('?')[0]}`;
  return crypto.sign('sha256', Buffer.from(message, 'utf8'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}

/**
 * @description Auth headers for one request.
 * @param keyId - Kalshi API key id.
 * @param privateKeyPem - Normalized PEM.
 * @param method - HTTP method.
 * @param fullPath - Path from host root including the /trade-api/v2 prefix.
 * @returns Header map ready to merge into fetch init.
 */
export function kalshiAuthHeaders(keyId: string, privateKeyPem: string, method: string, fullPath: string): Record<string, string> {
  const ts = String(Date.now());
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': signKalshiRequest(privateKeyPem, ts, method.toUpperCase(), fullPath),
  };
}

/** A parsed `keyId:PEM` connector secret. */
export interface KalshiCreds { keyId: string; privateKeyPem: string; }

/**
 * @description Split the stored connector secret (`keyId:PEM`) and normalize the key material.
 * @param secret - The decrypted connector secret.
 * @returns Parsed credentials.
 */
export function parseKalshiSecret(secret: string): KalshiCreds {
  const i = secret.indexOf(':');
  if (i <= 0) throw new Error('Kalshi secret must be "keyId:privateKeyPem"');
  return { keyId: secret.slice(0, i).trim(), privateKeyPem: normalizePem(secret.slice(i + 1)) };
}

/** The demo (paper-trading) exchange base — a key belongs to exactly one exchange registry. */
export const KALSHI_DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';

/** Which exchange each key id authenticated against, learned on first successful call.
 *  Auth env is a property OF THE KEY, not process config: a global env switch would also have
 *  repointed public MARKET DATA at the thin demo book, poisoning the edge scan. */
const keyEnvCache = new Map<string, string>();

async function authedRequestAgainst<T>(
  base: string, creds: KalshiCreds, method: string, pathAndQuery: string, body?: unknown,
): Promise<T> {
  const prefix = new URL(base).pathname;
  const headers: Record<string, string> = kalshiAuthHeaders(creds.keyId, creds.privateKeyPem, method, `${prefix}${pathAndQuery.split('?')[0]}`);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${pathAndQuery}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Kalshi error bodies carry the actionable reason (insufficient_balance, order size...)
    // — surface it instead of a bare status so the UI can show a real message.
    const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => '');
    throw new Error(`Kalshi authed ${method} ${pathAndQuery} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

/**
 * @description Authenticated GET that AUTO-DETECTS which exchange the key belongs to: the
 * production registry is tried first, then the demo exchange on a 401/403 (wrong-registry keys
 * are rejected with 401). The winning base is cached per key id, so detection costs one extra
 * round-trip once per process per key. Non-auth failures (5xx, network) do NOT trigger the
 * fallback — a prod outage must not silently reroute a live key at the demo book.
 * @param creds - Key id + PEM.
 * @param pathAndQuery - Path under the API base, e.g. `/portfolio/balance`.
 * @returns Parsed JSON body.
 */
export async function kalshiAuthedGet<T>(creds: KalshiCreds, pathAndQuery: string): Promise<T> {
  return kalshiAuthedRequest<T>(creds, 'GET', pathAndQuery);
}

/**
 * @description Authenticated request (any method) with the same per-key env auto-detection as
 * kalshiAuthedGet. Mutating calls (orders) resolve the key's exchange EXACTLY like reads do —
 * the fallback only fires on 401/403 wrong-registry rejections, never on business errors like
 * insufficient_balance (those arrive as 400 and propagate).
 * @param creds - Key id + PEM.
 * @param method - HTTP method, e.g. 'POST'.
 * @param pathAndQuery - Path under the API base, e.g. `/portfolio/orders`.
 * @param body - JSON body for POST/PUT.
 * @returns Parsed JSON body.
 */
export async function kalshiAuthedRequest<T>(creds: KalshiCreds, method: string, pathAndQuery: string, body?: unknown): Promise<T> {
  const cached = keyEnvCache.get(creds.keyId);
  const bases = cached ? [cached] : [...new Set([kalshiApiBase(), KALSHI_DEMO_BASE])];
  let lastErr: Error | null = null;
  for (const base of bases) {
    try {
      const out = await authedRequestAgainst<T>(base, creds, method.toUpperCase(), pathAndQuery, body);
      keyEnvCache.set(creds.keyId, base);
      return out;
    } catch (err) {
      lastErr = err as Error;
      if (!/HTTP 40[13]\b/.test(lastErr.message)) throw lastErr;
    }
  }
  throw lastErr || new Error('Kalshi authed request failed');
}

/**
 * @description Which exchange a key id last authenticated against — 'demo' | 'live', or null
 * before its first successful call.
 * @param keyId - Kalshi API key id.
 * @returns The detected environment label.
 */
export function kalshiKeyEnv(keyId: string): 'demo' | 'live' | null {
  const base = keyEnvCache.get(keyId);
  if (!base) return null;
  return base === KALSHI_DEMO_BASE ? 'demo' : 'live';
}

/**
 * @description Validation probe for the connector card: fetch the account balance. Succeeds only
 * when the key id + private key are a real, active pair on ONE of the exchanges (live registry
 * tried first, demo on 401 — see kalshiAuthedGet). The detected env is returned so the card can
 * label the connection honestly.
 * @param secret - The pasted `keyId:PEM` secret.
 * @returns Key id, balance in dollars, and which exchange ('live' | 'demo') accepted the key.
 */
export async function probeKalshiAccount(secret: string): Promise<{ keyId: string; balanceDollars: number; env: 'demo' | 'live' }> {
  const creds = parseKalshiSecret(secret);
  const body = await kalshiAuthedGet<{ balance?: number; balance_dollars?: string }>(creds, '/portfolio/balance');
  const dollars = body.balance_dollars !== undefined ? parseFloat(body.balance_dollars) : (Number(body.balance) || 0) / 100;
  const env = kalshiKeyEnv(creds.keyId) || 'live';
  log.info({ keyId: creds.keyId, env }, 'kalshi credential probe succeeded');
  return { keyId: creds.keyId, balanceDollars: Number.isFinite(dollars) ? dollars : 0, env };
}
