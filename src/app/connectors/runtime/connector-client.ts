/**
 * ConnectorClient — the shared HTTP middle layer every connector calls instead of raw `fetch`.
 *
 * This is the keystone of ADR-065. Before it, each of the ~20 connectors hand-rolled its own
 * fetch + error handling + (sometimes) refresh, with NO retries, NO rate-limit governor, and a
 * different error shape each. A connector now becomes a thin mapping over this client: declare
 * provider/baseUrl/auth/retry/rateLimit once, then call `request()` and map the JSON.
 *
 * One call flows through, in order:
 *   rate-limit governor (token bucket) -> auth injection -> fetch (with timeout)
 *     -> on 401: force a token refresh once and retry
 *     -> on 429/5xx/network: exponential backoff + jitter, honoring Retry-After
 *     -> normalize every failure to ConnectorError
 *     -> emit one telemetry record (onCall) for the catalog health dashboard
 *
 * Decoupled by design: it takes a TokenProvider thunk, never the pg pool or SESSION_SECRET, so it
 * composes with the ADR-056 broker on the controller path and with fixed tokens in tests.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065. Additive; no
 *            | existing connector is rewired in this change (Spotify port is opt-in, parallel).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Honor cursor `exclusive` in paginate():
 *            | follow-up pages send only the cursor param for Dynatrace-style APIs that reject
 *            | nextPageKey combined with the original query params. Default behavior unchanged.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/connector-client
 */

import { ConnectorError } from './connector-error';
import type {
  AuthSpec, ConnectorClientConfig, PaginationStrategy, RateLimitPolicy, RequestOptions, RetryPolicy, TokenProvider,
} from './types';

const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, baseDelayMs: 300, maxDelayMs: 10_000, honorRetryAfter: true };
const DEFAULT_RATE: RateLimitPolicy = { burst: 0, perSecond: 0 };
const DEFAULT_TIMEOUT_MS = 20_000;

/** Extract the rel="next" URL from an RFC-5988 Link header, e.g. `<https://api/x?page=2>; rel="next"`. */
export function parseNextLink(linkHeader: string | null | undefined): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Read a (possibly dotted) field from an object, e.g. dotGet(res, '@odata.nextLink') or 'paging.next'. */
function dotGet(obj: any, dotPath: string): any {
  if (obj && dotPath in obj) return obj[dotPath]; // exact key first (handles literal dots like @odata.nextLink)
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** A simple token-bucket: the one place provider rate-limits are governed, so depth doesn't DoS us. */
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly policy: RateLimitPolicy, private readonly now: () => number, private readonly sleep: (ms: number) => Promise<void>) {
    this.tokens = policy.burst;
    this.last = now();
  }
  private refill(): void {
    if (this.policy.perSecond <= 0) return;
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    this.tokens = Math.min(this.policy.burst, this.tokens + elapsed * this.policy.perSecond);
    this.last = t;
  }
  async acquire(): Promise<void> {
    if (this.policy.burst <= 0 || this.policy.perSecond <= 0) return; // disabled
    this.refill();
    while (this.tokens < 1) {
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.policy.perSecond) * 1000));
      await this.sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }
}

export class ConnectorClient {
  private readonly provider: string;
  private readonly baseUrl: string;
  private readonly auth: AuthSpec;
  private readonly retry: RetryPolicy;
  private readonly bucket: TokenBucket;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger?: ConnectorClientConfig['logger'];
  private readonly onCall?: ConnectorClientConfig['onCall'];

  constructor(cfg: ConnectorClientConfig) {
    this.provider = cfg.provider;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.auth = cfg.auth ?? { type: 'none' };
    this.retry = { ...DEFAULT_RETRY, ...(cfg.retry || {}) };
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
    this.now = cfg.now ?? (() => Date.now());
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = cfg.logger;
    this.onCall = cfg.onCall;
    this.bucket = new TokenBucket({ ...DEFAULT_RATE, ...(cfg.rateLimit || {}) }, this.now, this.sleep);
  }

  /** Make one request, returning parsed JSON (typed by the caller). Throws ConnectorError on failure. */
  async request<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    const retry = { ...this.retry, ...(opts.retry || {}) };
    const method = opts.method ?? 'GET';
    const url = this.buildUrl(path, opts.query);
    const started = this.now();
    let attempt = 0;
    let refreshedOn401 = false;
    let lastErr: ConnectorError | undefined;

    while (attempt <= retry.maxRetries) {
      attempt += 1;
      await this.bucket.acquire();
      let status: number | undefined;
      try {
        const { headers, urlWithKey } = await this.applyAuth(url, opts.headers, refreshedOn401);
        const res = await this.fetchOnce(urlWithKey, method, headers, opts.body);
        status = res.status;

        if ((opts.emptyOk || []).includes(res.status) || res.status === 204) {
          if (opts.captureLinkHeader) opts.captureLinkHeader(parseNextLink(res.headers?.get?.('link')));
          this.emit(method, path, status, started, attempt, true);
          return {} as T;
        }
        const text = await res.text();
        if (res.ok) {
          if (opts.captureLinkHeader) opts.captureLinkHeader(parseNextLink(res.headers?.get?.('link')));
          this.emit(method, path, status, started, attempt, true);
          return (text ? JSON.parse(text) : {}) as T;
        }

        const err = ConnectorError.fromStatus(this.provider, res.status, text, attempt);

        // 401 once: force a token refresh and retry immediately (not counted as a backoff round).
        if (err.code === 'auth' && res.status === 401 && this.auth.type === 'bearer' && !refreshedOn401) {
          refreshedOn401 = true;
          attempt -= 1; // this attempt doesn't count against the retry budget
          this.logger?.warn?.({ provider: this.provider, path }, 'connector: 401, forcing token refresh');
          continue;
        }
        lastErr = err;
        if (!err.retriable || attempt > retry.maxRetries) { this.emit(method, path, status, started, attempt, false); throw err; }
        await this.backoff(attempt, retry, this.retryAfterMs(res));
      } catch (e) {
        if (e instanceof ConnectorError) {
          if (!e.retriable || attempt > retry.maxRetries) { this.emit(method, path, status, started, attempt, false); throw e; }
          lastErr = e;
          await this.backoff(attempt, retry, undefined);
          continue;
        }
        // fetch threw (network/timeout) — retriable.
        const ne = ConnectorError.fromNetwork(this.provider, e, attempt);
        lastErr = ne;
        if (attempt > retry.maxRetries) { this.emit(method, path, undefined, started, attempt, false); throw ne; }
        await this.backoff(attempt, retry, undefined);
      }
    }
    // Exhausted retries.
    this.emit(method, path, lastErr?.status, started, attempt, false);
    throw lastErr ?? new ConnectorError({ provider: this.provider, code: 'unknown', retriable: false, message: 'request failed', attempts: attempt });
  }

  /**
   * Walk every page of a list endpoint and return the flattened items. The part everyone
   * reimplements differently — declared once here per strategy.
   */
  async paginate<T = any>(path: string, strategy: PaginationStrategy, opts: RequestOptions = {}, extract: (page: any) => T[] = (p) => (p?.items || []), maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let page = 0;
    let query: Record<string, any> = { ...(opts.query || {}) };
    let nextPath = path;
    while (page < maxPages) {
      page += 1;
      let linkNext: string | undefined;
      const res = await this.request<any>(nextPath, { ...opts, query, captureLinkHeader: (v) => { linkNext = v; } });
      out.push(...extract(res));
      if (strategy.type === 'cursor') {
        const cursor = strategy.nextFrom(res);
        if (!cursor) break;
        // exclusive: the cursor already encodes the original query (Dynatrace v2 rejects both together).
        query = strategy.exclusive ? { [strategy.param]: cursor } : { ...query, [strategy.param]: cursor };
      } else if (strategy.type === 'offset') {
        if (strategy.isLastPage(res)) break;
        const cur = Number(query[strategy.param] || 0);
        query = { ...query, [strategy.param]: cur + strategy.pageSize };
      } else if (strategy.type === 'link-header') {
        // Follow the RFC-5988 Link: rel="next" response header (GitHub-style).
        if (!linkNext) break;
        nextPath = linkNext.startsWith('http') ? linkNext.slice(this.baseUrl.length) : linkNext;
        query = {};
      } else {
        // link: the next URL came back as an absolute href in the response body. Honor a configured
        // dot-path field (e.g. `@odata.nextLink`), else fall back to `next` / `paging.next`.
        const next = (strategy.nextField ? dotGet(res, strategy.nextField) : (res?.next || res?.paging?.next)) as string | undefined;
        if (!next) break;
        nextPath = next.startsWith('http') ? next.slice(this.baseUrl.length) : next;
        query = {};
      }
    }
    return out;
  }

  // --- internals -------------------------------------------------------------

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    if (!query) return base;
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) usp.set(k, String(v));
    const qs = usp.toString();
    return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
  }

  /** Resolve auth into headers (and, for query-key auth, a URL with the key appended). */
  private async applyAuth(url: string, extra: Record<string, string> | undefined, force: boolean): Promise<{ headers: Record<string, string>; urlWithKey: string }> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(extra || {}) };
    let urlWithKey = url;
    switch (this.auth.type) {
      case 'bearer': {
        const token = await this.auth.token({ force });
        if (!token) throw new ConnectorError({ provider: this.provider, code: 'auth', retriable: false, message: 'not connected (no token)', status: 401 });
        headers.Authorization = `Bearer ${token}`;
        break;
      }
      case 'basic':
        headers.Authorization = 'Basic ' + Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64');
        break;
      case 'apiKeyHeader':
        headers[this.auth.header] = this.auth.value;
        break;
      case 'apiKeyQuery':
        urlWithKey = `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(this.auth.param)}=${encodeURIComponent(this.auth.value)}`;
        break;
      case 'none':
      default:
        break;
    }
    return { headers, urlWithKey };
  }

  private async fetchOnce(url: string, method: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined && method !== 'GET') {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        (init.headers as Record<string, string>)['Content-Type'] = (headers['Content-Type'] || 'application/json');
      }
      return await this.fetchImpl(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  private retryAfterMs(res: Response): number | undefined {
    if (!this.retry.honorRetryAfter) return undefined;
    const h = res.headers?.get?.('retry-after');
    if (!h) return undefined;
    const secs = Number(h);
    if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(h);
    return Number.isNaN(when) ? undefined : Math.max(0, when - this.now());
  }

  private async backoff(attempt: number, retry: RetryPolicy, retryAfterMs: number | undefined): Promise<void> {
    const expo = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    // Full jitter (AWS-style): a uniform draw in [0, expo]. Deterministic in tests where now() is fixed-step.
    const jitter = expo * ((this.now() % 1000) / 1000);
    const wait = Math.max(retryAfterMs ?? 0, jitter);
    await this.sleep(Math.ceil(wait));
  }

  private emit(method: string, path: string, status: number | undefined, started: number, attempts: number, ok: boolean): void {
    try { this.onCall?.({ provider: this.provider, method, path, status, ms: this.now() - started, attempts, ok }); } catch { /* telemetry must never break a request */ }
  }
}

/** Convenience: build a bearer TokenProvider from the broker's getValidAccessToken. */
export function brokeredBearer(getValidAccessToken: (pool: any, userSub: string, provider: string) => Promise<string | null>, pool: any, userSub: string, provider: string): TokenProvider {
  return async () => getValidAccessToken(pool, userSub, provider);
}
