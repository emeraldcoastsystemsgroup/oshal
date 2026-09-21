/**
 * Alpaca market-data rate limiting — the vendor's documented 429 contract, honoured.
 *
 * WHY: every bars fetch in `market-data.ts` went through one `adata()` that threw on any non-OK
 * response with no retry and no pacing. On 2026-09-15 the 00:01Z `trading-assess` run burst its
 * batches (`multiTimeframeScan` fires one `barsBatch` per timeframe in parallel, each up to 8
 * pages, and `recordPerAlgoPredictions` adds two more) and the vendor answered `too many
 * requests.` — losing the whole per-algo record for that session.
 *
 * WHAT THE VENDOR DOCUMENTS (Alpaca Market Data API, `GET /v2/stocks/bars`, read 2026-09-21):
 *   - HTTP **429**: "Too many requests. You hit the rate limit. Use the X-RateLimit-... response
 *     headers to make sure you're under the rate limit."
 *   - `X-RateLimit-Limit` — request limit per minute.
 *   - `X-RateLimit-Remaining` — request limit per minute remaining.
 *   - `X-RateLimit-Reset` — the UNIX epoch when the remaining quota changes.
 *   - Plan ceilings: 200 requests/min on Basic (the free plan this deployment uses), 10,000/min on
 *     Algo Trader Plus.
 * The ceiling is therefore NEVER guessed here: the pacing window comes from the headers the vendor
 * itself returns, so a plan change needs no code change. `Retry-After` is honoured when present as
 * the RFC-9110 fallback, but Alpaca does not document sending it on this endpoint.
 *
 * SHAPE: two cooperating parts, both bounded.
 *   1. A **bounded retry** on 429 only — the vendor-indicated wait (reset epoch / Retry-After),
 *      else exponential backoff with jitter, capped. Any other status still raises on the first
 *      response, so a 400/401 never turns into a retry storm.
 *   2. A **shared quota window** — the last `X-RateLimit-Remaining` / `X-RateLimit-Reset` any
 *      caller in this process observed. Every trading schedule (`trading-fast`, `trading-events`,
 *      `trading-autopilot`, `trading-assess`) runs in the controller process and shares it, so a
 *      run that is about to spend the last of the minute's quota waits for the vendor's own reset
 *      instead of racing the other schedules into a 429.
 * Both waits are capped by `ALPACA_DATA_RATE_LIMIT_MAX_WAIT_MS` — past the cap the request fires
 * anyway and the retry absorbs the 429. A late price is recoverable; a market-data call that
 * stalls a protective exit for a full quota minute is not.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — AlpacaRateLimitError, the shared quota window read from the vendor's X-RateLimit-* headers, and withAlpacaRateLimit(): bounded retry on 429 with the vendor-indicated wait, so a paginated barsBatch completes instead of raising and losing the assessment's per-algo record.
 *
 * @module market-data-rate-limit
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'market-data-rate-limit' });

/** The status Alpaca documents for "you hit the rate limit" on the market-data endpoints. */
export const RATE_LIMIT_STATUS = 429;

/** Default attempts for one request (1 initial + 3 retries) before the 429 is raised. */
const DEFAULT_ATTEMPTS = 4;
/** Default ceiling on ANY single wait — pre-flight pacing or retry backoff. */
const DEFAULT_MAX_WAIT_MS = 15_000;
/** Default remaining-quota floor at which the next request waits for the vendor's reset. */
const DEFAULT_MIN_REMAINING = 2;
/** First retry's backoff when the vendor gave no reset/Retry-After to aim at. */
const BASE_BACKOFF_MS = 500;

/**
 * The header accessor both a real `fetch` `Response.headers` and a spec's fake transport satisfy —
 * this module never needs more of `Headers` than a case-insensitive `get`.
 */
export interface RateLimitHeaderBag {
  /**
   * @description Read one header value.
   * @param name - Header name (case-insensitive, as `Headers.get` is).
   * @returns The value, or null when absent.
   */
  get(name: string): string | null;
}

/** The quota window the vendor last reported, shared by every market-data caller in the process. */
interface QuotaWindow {
  /** Requests left in the current minute, per `X-RateLimit-Remaining`. */
  remaining: number;
  /** Epoch ms at which the quota changes, per `X-RateLimit-Reset` (documented in epoch SECONDS). */
  resetAtMs: number;
}

let quota: QuotaWindow | null = null;

/**
 * @description Read a positive integer env override, falling back to the documented default.
 * @param name - Environment variable name.
 * @param fallback - Value to use when unset or not a positive finite number.
 * @returns The effective value.
 */
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * @description Total attempts allowed for one rate-limited request (ALPACA_DATA_RATE_LIMIT_ATTEMPTS).
 * @returns Attempt count, at least 1.
 */
export function rateLimitAttempts(): number { return envInt('ALPACA_DATA_RATE_LIMIT_ATTEMPTS', DEFAULT_ATTEMPTS); }

/**
 * @description Ceiling on any single wait this module performs (ALPACA_DATA_RATE_LIMIT_MAX_WAIT_MS).
 * Past it the request fires and the bounded retry absorbs the 429, rather than stalling a trading leg.
 * @returns Max wait in milliseconds.
 */
export function rateLimitMaxWaitMs(): number { return envInt('ALPACA_DATA_RATE_LIMIT_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS); }

/**
 * @description Remaining-quota floor below which the next request waits for the vendor's reset
 * (ALPACA_DATA_RATE_LIMIT_MIN_REMAINING).
 * @returns The floor, in requests.
 */
export function rateLimitMinRemaining(): number { return envInt('ALPACA_DATA_RATE_LIMIT_MIN_REMAINING', DEFAULT_MIN_REMAINING); }

/** The vendor's documented rate-limit refusal, carrying the wait its headers asked for. */
export class AlpacaRateLimitError extends Error {
  /** Always `RATE_LIMIT_STATUS` — lets a caller classify without instanceof across module copies. */
  readonly status = RATE_LIMIT_STATUS;
  /** Milliseconds the vendor's headers asked us to wait, or null when they said nothing. */
  readonly vendorWaitMs: number | null;

  /**
   * @description Build the typed 429 from the vendor's own message and headers.
   * @param message - The vendor's `message` field (e.g. `too many requests.`).
   * @param headers - The response headers, for the reset/Retry-After hint.
   */
  constructor(message: string, headers?: RateLimitHeaderBag) {
    super(message);
    this.name = 'AlpacaRateLimitError';
    this.vendorWaitMs = headers ? vendorWaitFrom(headers) : null;
  }
}

/**
 * @description The wait the vendor's headers ask for: `X-RateLimit-Reset` (documented epoch
 * SECONDS) first, else the RFC-9110 `Retry-After` in seconds. Never negative.
 * @param headers - Response headers.
 * @param nowMs - Current epoch ms (injectable so a spec need not move the clock).
 * @returns Milliseconds to wait, or null when neither header is usable.
 */
export function vendorWaitFrom(headers: RateLimitHeaderBag, nowMs: number = Date.now()): number | null {
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  if (reset !== null && reset > 0) return Math.max(0, reset * 1000 - nowMs);
  const retryAfter = headerNumber(headers, 'retry-after');
  if (retryAfter !== null && retryAfter >= 0) return retryAfter * 1000;
  return null;
}

/**
 * @description Read one header as a finite number. An ABSENT header must read as absent, not as
 * zero — `Number(null)` is 0, and a zero `Retry-After` would mean "retry immediately", turning a
 * vendor that sent no hint at all into a hot retry loop.
 * @param headers - Response headers.
 * @param name - Header name (lower-case; `Headers.get` is case-insensitive).
 * @returns The number, or null when the header is absent, empty or unparseable.
 */
function headerNumber(headers: RateLimitHeaderBag, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @description Record the quota window from a market-data response so every OTHER trading schedule
 * in this process paces against the same vendor numbers. Called on every response, 429 or not.
 * @param headers - Response headers (a bag missing the X-RateLimit-* trio is ignored).
 */
export function noteRateLimitHeaders(headers: RateLimitHeaderBag): void {
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  if (remaining === null || reset === null || reset <= 0) return;
  quota = { remaining, resetAtMs: reset * 1000 };
}

/**
 * @description The quota window the vendor last reported, for pacing decisions and for specs.
 * @returns The window, or null when no response has carried the headers yet.
 */
export function observedQuota(): { remaining: number; resetAtMs: number } | null {
  return quota ? { ...quota } : null;
}

/**
 * @description Forget the observed quota window. A process that has been idle past the reset is
 * pacing on stale numbers; specs use it to start from a clean window.
 */
export function resetRateLimitWindow(): void { quota = null; }

/** Sleep helper — the only timer this module owns. */
function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * @description How long to wait before firing, given the shared quota window: nothing unless the
 * vendor says this minute's quota is nearly spent and its reset is still ahead.
 * @param nowMs - Current epoch ms.
 * @returns Milliseconds to pause, capped by `rateLimitMaxWaitMs()`.
 */
export function pacingWaitMs(nowMs: number = Date.now()): number {
  if (!quota) return 0;
  if (quota.remaining > rateLimitMinRemaining()) return 0;
  if (quota.resetAtMs <= nowMs) return 0;
  return Math.min(quota.resetAtMs - nowMs, rateLimitMaxWaitMs());
}

/**
 * @description Backoff for one 429: the vendor-indicated wait when its headers gave one, else
 * exponential with full jitter. Always capped by `rateLimitMaxWaitMs()`.
 * @param err - The rate-limit error just caught.
 * @param attempt - Zero-based attempt index that just failed.
 * @returns Milliseconds to wait before the next attempt.
 */
export function retryWaitMs(err: AlpacaRateLimitError, attempt: number): number {
  const cap = rateLimitMaxWaitMs();
  if (err.vendorWaitMs !== null) return Math.min(err.vendorWaitMs, cap);
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, cap);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/**
 * @description Run one market-data request under the vendor's rate-limit contract: pace against the
 * shared quota window first, then retry a documented 429 (and ONLY a 429) up to
 * `rateLimitAttempts()` times with the vendor-indicated wait. Any other failure propagates on the
 * first response, unchanged.
 * @param label - Short request label for the log lines (e.g. the data-API pathname).
 * @param run - The request to perform; it must throw `AlpacaRateLimitError` on the vendor's 429.
 * @returns Whatever `run` resolves to.
 */
export async function withAlpacaRateLimit<T>(label: string, run: () => Promise<T>): Promise<T> {
  const attempts = rateLimitAttempts();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pause = pacingWaitMs();
    if (pause > 0) {
      logger.info({ label, pauseMs: pause, remaining: quota?.remaining }, 'market-data paced — vendor quota nearly spent');
      await sleep(pause);
    }
    try {
      return await run();
    } catch (e) {
      const last = attempt === attempts - 1;
      if (!(e instanceof AlpacaRateLimitError) || last) throw e;
      const wait = retryWaitMs(e, attempt);
      logger.warn({ label, attempt: attempt + 1, attempts, waitMs: wait, err: e.message }, 'market-data rate limited — retrying');
      await sleep(wait);
    }
  }
  /* Unreachable: the loop either returns or throws on its last attempt. */
  throw new AlpacaRateLimitError(`rate-limit retry exhausted for ${label}`);
}
