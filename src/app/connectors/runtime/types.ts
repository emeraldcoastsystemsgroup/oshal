/**
 * Connector runtime types — the contract a connector declares so the shared client gives it
 * auth, retries, rate-limiting, pagination, and structured errors for free.
 *
 * The runtime is intentionally decoupled from the token broker and the pg pool: it takes a
 * `TokenProvider` thunk, so the same client works for the controller path (wrap
 * getValidAccessToken) and tests (return a fixed token). Connectors map provider responses to
 * their own shapes; the runtime owns the transport.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-065.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Cursor pagination gains `exclusive` —
 *            | APIs like Dynatrace Environment v2 REJECT the cursor combined with the original
 *            | query params (the cursor encodes them), so follow-up pages must send only the cursor.
 * -----------------------------------------------------------------------------
 * @module connectors/runtime/types
 */

/**
 * Supplies a valid bearer token on demand. Called with { force: true } after a 401 so the
 * caller can force a refresh (e.g. re-run getValidAccessToken which re-checks expiry / refreshes).
 * Returns null when the account isn't connected — the runtime then throws a clean auth error.
 */
export type TokenProvider = (opts?: { force?: boolean }) => Promise<string | null>;

/** How the runtime injects credentials onto each request. One switch, not 20 bespoke headers. */
export type AuthSpec =
  | { type: 'none' }
  | { type: 'bearer'; token: TokenProvider }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apiKeyHeader'; header: string; value: string }
  | { type: 'apiKeyQuery'; param: string; value: string };

export interface RetryPolicy {
  /** Max RETRY attempts after the first try (so total attempts = maxRetries + 1). Default 3. */
  maxRetries: number;
  /** Base backoff in ms; grows exponentially (base * 2^n) with jitter. Default 300. */
  baseDelayMs: number;
  /** Ceiling for a single backoff wait. Default 10_000. */
  maxDelayMs: number;
  /** Honor a provider Retry-After header (seconds or HTTP date) when present. Default true. */
  honorRetryAfter: boolean;
}

export interface RateLimitPolicy {
  /** Token-bucket capacity (max burst). Default 0 = disabled. */
  burst: number;
  /** Sustained requests per second the bucket refills at. Default 0 = disabled. */
  perSecond: number;
}

/** Strategy for walking multi-page list endpoints (the part everyone reimplements differently). */
export type PaginationStrategy =
  | { type: 'cursor'; nextFrom: (page: any) => string | null; param: string;
      /** Follow-up pages send ONLY the cursor param. Dynatrace-style APIs reject the cursor
       *  combined with the original query params (the cursor already encodes them). */
      exclusive?: boolean }
  | { type: 'offset'; param: string; pageSize: number; isLastPage: (page: any) => boolean }
  | { type: 'link'; nextField?: string /* follow a next URL in the BODY (default `next`, e.g. `@odata.nextLink`) */ }
  | { type: 'link-header' /* follow the RFC-5988 `Link: <url>; rel="next"` response HEADER */ };

export interface ConnectorClientConfig {
  /** Provider slug (matches the PROVIDERS registry + broker CRED_ENV_KEYS), e.g. 'spotify'. */
  provider: string;
  /** API root, e.g. 'https://api.spotify.com/v1'. Paths are appended verbatim. */
  baseUrl: string;
  auth?: AuthSpec;
  retry?: Partial<RetryPolicy>;
  rateLimit?: Partial<RateLimitPolicy>;
  /** Per-request timeout in ms (AbortController). Default 20_000. */
  timeoutMs?: number;
  /** Injected for testability — default the platform globals. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional structured logger (best-effort; runtime never throws on a log failure). */
  logger?: { warn: (obj: unknown, msg?: string) => void; debug?: (obj: unknown, msg?: string) => void };
  /** Optional telemetry sink — one call per request for the catalog health dashboard. */
  onCall?: (m: { provider: string; method: string; path: string; status?: number; ms: number; attempts: number; ok: boolean }) => void;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Query params appended to the path (values are URL-encoded; null/undefined skipped). */
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body (serialized) — mutually exclusive with rawBody. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Override retry for this call (e.g. a non-idempotent POST you don't want auto-retried). */
  retry?: Partial<RetryPolicy>;
  /** Treat these statuses as success returning {} (e.g. Spotify 204 = nothing playing). */
  emptyOk?: number[];
  /** Internal (used by paginate): receives the parsed `rel="next"` URL from the Link header, if any. */
  captureLinkHeader?: (next: string | undefined) => void;
}
