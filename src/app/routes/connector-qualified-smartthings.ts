/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bound fresh SmartThings OAuth and read-only location verification without inventing a person identity or exposing provider failures.
 */
import { createChildLogger } from '@/shared/logger';
import { PROVIDERS, providerCreds } from './connector-provider-registry';
import { redirectUri } from './connector-oauth-ceremony';

const logger = createChildLogger({ module: 'connector-qualified-smartthings' });
const TOKEN_URL = 'https://api.smartthings.com/oauth/token';
const LOCATIONS_URL = 'https://api.smartthings.com/v1/locations';
const ACCOUNT_PREFIX = 'smartthings-location:';
const MAX_BYTES = 65_536, MAX_CHUNKS = 1024, DEADLINE_MS = 10_000;
const MAX_LOCATIONS = 128, MAX_EXPIRY_SECONDS = 31_536_000;
type Failure = 'invalid_input' | 'unconfigured' | 'invalid_response' | 'provider_unavailable'
  | 'account_mismatch' | 'aborted' | 'timeout';
class SafeFailure extends Error {
  constructor(readonly reason: Failure) { super(`qualified_smartthings_${reason}`); this.name = 'QualifiedSmartThingsError'; }
}
interface Lifetime { signal: AbortSignal; check(): void }
function refuse(reason: Failure): never { throw new SafeFailure(reason); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function tokenString(value: unknown): value is string {
  return boundedString(value, 16_384) && !/\s/.test(value);
}

// One deadline includes headers, every body chunk and parsing; caller abort reasons never escape.
async function bounded<T>(operation: string, signal: AbortSignal | undefined,
  work: (lifetime: Lifetime) => Promise<T>): Promise<T> {
  const started = Date.now(), controller = new AbortController();
  let failure: 'aborted' | 'timeout' | undefined, rejectAbort!: (error: SafeFailure) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const cancel = (reason: 'aborted' | 'timeout') => {
    if (failure) return;
    failure = reason; controller.abort(); rejectAbort(new SafeFailure(reason));
  };
  const onAbort = () => cancel('aborted');
  const timer = setTimeout(() => cancel('timeout'), DEADLINE_MS);
  const check = () => {
    if (signal?.aborted) refuse('aborted');
    if (failure) refuse(failure);
    if (Date.now() - started >= DEADLINE_MS) refuse('timeout');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  logger.debug({ operation }, 'Qualified SmartThings operation started');
  try {
    // Attach race handlers before invoking work, including the already-aborted path.
    const pending = Promise.resolve().then(() => { check(); return work({ signal: controller.signal, check }); });
    const result = await Promise.race([pending, aborted]);
    check(); logger.info({ operation, durationMs: Date.now() - started }, 'Qualified SmartThings operation completed');
    return result;
  } catch (error) {
    const safe = new SafeFailure(signal?.aborted ? 'aborted' : failure
      ?? (error instanceof SafeFailure ? error.reason : 'provider_unavailable'));
    // Do not retain the original error/cause/stack: fetch and parser errors can contain secrets.
    logger.error({ err: safe, operation, durationMs: Date.now() - started }, 'Qualified SmartThings operation refused');
    throw safe;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
  }
}

async function readJson(response: Response, lifetime: Lifetime): Promise<unknown> {
  lifetime.check();
  if (!response.ok || response.redirected) refuse('provider_unavailable');
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) refuse('invalid_response');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) refuse('invalid_response');
  if (!response.body) refuse('invalid_response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let count = 0; ; count++) {
      if (count >= MAX_CHUNKS) refuse('invalid_response');
      const chunk = await reader.read(); lifetime.check();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) refuse('invalid_response');
      chunks.push(chunk.value);
    }
    lifetime.check();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    lifetime.check(); return parsed;
  } finally { reader.releaseLock(); }
}

async function requestJson(url: string, init: RequestInit, lifetime: Lifetime): Promise<unknown> {
  lifetime.check();
  const response = await fetch(url, { ...init, redirect: 'error', signal: lifetime.signal });
  lifetime.check();
  const data = await readJson(response, lifetime); lifetime.check(); return data;
}

function oauthConfig(redirect: unknown): { clientId: string; clientSecret: string; redirect: string } {
  const def = PROVIDERS.smartthings, credentials = providerCreds('smartthings');
  if (!def || def.tokenUrl !== TOKEN_URL || def.tokenAuth !== 'basic'
    || !boundedString(credentials.clientId, 1024) || credentials.clientId.includes(':')
    || !boundedString(credentials.clientSecret, 4096)) refuse('unconfigured');
  if (!boundedString(redirect, 2048) || redirect !== redirectUri('smartthings')) refuse('invalid_input');
  const uri = new URL(redirect);
  if (uri.username || uri.password || uri.hash || !['http:', 'https:'].includes(uri.protocol)) refuse('invalid_input');
  return { ...credentials, redirect };
}

function tokens(payload: unknown, issuedAt: number): { accessToken: string; refreshToken: string | null; expiresAt: string | null } {
  if (!record(payload) || !tokenString(payload.access_token)) refuse('invalid_response');
  if (payload.token_type !== undefined && (typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer')) refuse('invalid_response');
  if (payload.refresh_token !== undefined && payload.refresh_token !== null && !tokenString(payload.refresh_token)) refuse('invalid_response');
  let expiresAt: string | null = null;
  if (payload.expires_in !== undefined) {
    const seconds = payload.expires_in;
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > MAX_EXPIRY_SECONDS) refuse('invalid_response');
    expiresAt = new Date(issuedAt + seconds * 1000).toISOString();
  }
  return { accessToken: payload.access_token, refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null, expiresAt };
}

/**
 * @description Exchange only a fresh SmartThings code using registered credentials and exact callback URI; no legacy grant fallback.
 * @param code Opaque fresh authorization code, bounded and never logged.
 * @param options Server-held registered redirect and optional cancellation covering the entire request/body lifetime.
 * @returns Validated access material; omitted refresh/expiry are null. Supplied expiry must be whole seconds in [1,31536000].
 */
export function exchangeQualifiedSmartThings(code: string, options: { redirect: string; signal?: AbortSignal }):
Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null }> {
  const { redirect, signal } = options;
  return bounded('exchange', signal, async lifetime => {
    if (!boundedString(code, 4096) || /\s/.test(code)) refuse('invalid_input');
    const config = oauthConfig(redirect), issuedAt = Date.now();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code,
      client_id: config.clientId, redirect_uri: config.redirect });
    const payload = await requestJson(TOKEN_URL, { method: 'POST', body,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64') } }, lifetime);
    lifetime.check(); return tokens(payload, issuedAt);
  });
}

/**
 * @description Verify a LOCATION grant with a fixed read-only SmartThings request; this key is not a person or email identity.
 * @param accessToken Fresh access material consumed only by the fixed GET /v1/locations operation.
 * @param options Reconnect requires the exact server-held location in the returned set; optional cancellation includes body reads.
 * @returns SmartThings plus smartthings-location:<ID>; creates select the lexically smallest returned ID deterministically. No paging URLs are followed.
 */
export function verifyQualifiedSmartThings(accessToken: string, options: { expectedAccountKey?: string; signal?: AbortSignal } = {}):
Promise<{ provider: 'smartthings'; accountKey: string }> {
  const { expectedAccountKey: expected, signal } = options;
  return bounded('verify', signal, async lifetime => {
    if (!tokenString(accessToken) || (expected !== undefined && (typeof expected !== 'string'
      || !expected.startsWith(ACCOUNT_PREFIX) || !boundedString(expected.slice(ACCOUNT_PREFIX.length), 256)))) refuse('invalid_input');
    const expectedId = expected?.slice(ACCOUNT_PREFIX.length);
    const payload = await requestJson(LOCATIONS_URL, { method: 'GET', headers: {
      Accept: 'application/json', Authorization: `Bearer ${accessToken}` } }, lifetime);
    lifetime.check();
    if (!record(payload) || !Array.isArray(payload.items) || !payload.items.length || payload.items.length > MAX_LOCATIONS) refuse('invalid_response');
    const ids = payload.items.map((item: unknown) => {
      if (!record(item) || !boundedString(item.locationId, 256)) refuse('invalid_response');
      return item.locationId;
    });
    if (expectedId !== undefined && !ids.includes(expectedId)) refuse('account_mismatch');
    lifetime.check(); return { provider: 'smartthings', accountKey: ACCOUNT_PREFIX + (expectedId ?? ids.sort()[0]) };
  });
}
