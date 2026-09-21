/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The market-data rate-limit guard. Drives the REAL barsBatch over a FAKE TRANSPORT installed at globalThis.fetch — the exact seam the vendor's 429 arrives on — with Alpaca's documented rate-limit response (429 + X-RateLimit-Limit/Remaining/Reset) and proves the paginated batch COMPLETES instead of raising, which is what lost the 2026-09-15 assessment its per-algo record. Also pins the three ways this can go wrong in the other direction: a non-429 must still raise on the first response (no retry storm on a 400), the retry must be bounded, and the retry/pacing wait must come from the vendor's own headers rather than a guessed constant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { barsBatch } from '../../src/features/trading/services/market-data';
import {
  resetRateLimitWindow, observedQuota, pacingWaitMs, vendorWaitFrom, retryWaitMs, noteRateLimitHeaders,
  AlpacaRateLimitError, RATE_LIMIT_STATUS,
} from '../../src/features/trading/services/market-data-rate-limit';

/** One scripted response from the fake vendor. */
interface FakeResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A call the module made, with the moment it was made (for the pacing assertions). */
interface FakeCall { url: string; atMs: number }

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

/**
 * Pin an env var for the duration of a case, remembering the operator shell's value.
 */
function pin(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

/** A 200 page of bars for one symbol, optionally paginated. */
function okPage(closes: number[], nextToken: string | null, headers: Record<string, string>): FakeResponse {
  return {
    status: 200,
    body: { bars: { AAPL: closes.map((c) => ({ c })) }, next_page_token: nextToken },
    headers,
  };
}

/** Alpaca's documented rate-limit refusal for the bars endpoint. */
function rateLimited(resetEpochSec: number): FakeResponse {
  return {
    status: RATE_LIMIT_STATUS,
    // The exact body the 2026-09-15 run logged.
    body: { message: 'too many requests.' },
    headers: {
      'x-ratelimit-limit': '200',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(resetEpochSec),
    },
  };
}

/** Headers that say the quota is healthy, so pacing stays out of the way. */
function healthy(): Record<string, string> {
  return {
    'x-ratelimit-limit': '200',
    'x-ratelimit-remaining': '199',
    'x-ratelimit-reset': String(Math.floor((Date.now() + 60_000) / 1000)),
  };
}

/**
 * Install a fake transport at globalThis.fetch that plays the scripted responses in order and
 * repeats the last one forever. This is the module's real HTTP boundary — nothing inside
 * market-data.ts is stubbed.
 */
function installTransport(script: FakeResponse[]): FakeCall[] {
  const calls: FakeCall[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push({ url, atMs: Date.now() });
    const r = script[Math.min(calls.length - 1, script.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.headers),
      json: async () => r.body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return calls;
}

describe('market data honours Alpaca\'s documented rate limit', () => {
  beforeEach(() => {
    resetRateLimitWindow();
    // Keep every wait short enough that the guard runs in milliseconds; the code path is identical.
    pin('ALPACA_DATA_RATE_LIMIT_MAX_WAIT_MS', '300');
    pin('ALPACA_DATA_RATE_LIMIT_ATTEMPTS', undefined);
    pin('ALPACA_DATA_RATE_LIMIT_MIN_REMAINING', undefined);
    pin('ALPACA_PAPER_KEY_ID', 'spec-key');
    pin('ALPACA_PAPER_SECRET_KEY', 'spec-secret');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetRateLimitWindow();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
  });

  it('completes a paginated batch when the vendor rate-limits a page mid-pagination', async () => {
    // Page 1 succeeds and hands back a page token; the fetch for page 2 is refused with the
    // documented 429; the retry of page 2 succeeds. Before the fix the 429 threw out of adata(),
    // barsBatch raised, and every caller above it lost its whole run.
    const resetSoon = Math.floor((Date.now() + 100) / 1000);
    const calls = installTransport([
      okPage([10, 11], 'page-2', healthy()),
      rateLimited(resetSoon),
      okPage([12, 13], null, healthy()),
    ]);

    const out = await barsBatch(['AAPL'], '1Day', 60);

    expect(out.get('AAPL')).toEqual([10, 11, 12, 13]);
    expect(calls).toHaveLength(3); // page 1, the refused page 2, the retried page 2
  });

  it('raises the vendor message once the bounded retries are spent', async () => {
    pin('ALPACA_DATA_RATE_LIMIT_ATTEMPTS', '2');
    const calls = installTransport([rateLimited(Math.floor((Date.now() + 50) / 1000))]);

    await expect(barsBatch(['AAPL'], '1Day', 60)).rejects.toThrow('too many requests.');
    expect(calls).toHaveLength(2); // the retry is bounded — it does not hammer the vendor
  });

  it('does not retry a failure that is not the documented rate limit', async () => {
    const calls = installTransport([{ status: 400, body: { message: 'invalid symbol' }, headers: {} }]);

    await expect(barsBatch(['AAPL'], '1Day', 60)).rejects.toThrow('invalid symbol');
    expect(calls).toHaveLength(1);
  });

  it('waits the interval the vendor\'s X-RateLimit-Reset asks for, not a guessed constant', async () => {
    pin('ALPACA_DATA_RATE_LIMIT_MAX_WAIT_MS', '3000');
    // X-RateLimit-Reset is an epoch in SECONDS. Round UP so the instant it names is genuinely in
    // the future — flooring it would put the target in the PAST and make this assertion vacuous.
    const resetSec = Math.ceil((Date.now() + 150) / 1000);
    const resetAtMs = resetSec * 1000;
    const calls = installTransport([rateLimited(resetSec), okPage([21, 22], null, healthy())]);

    await barsBatch(['AAPL'], '1Day', 60);

    expect(calls).toHaveLength(2);
    // The retry fired at (or after) the vendor's reset instant, and demonstrably WAITED to do it —
    // a fixed backoff, or no backoff at all, fires before the instant the vendor named.
    expect(calls[1].atMs).toBeGreaterThanOrEqual(resetAtMs - 20);
    expect(calls[1].atMs - calls[0].atMs).toBeGreaterThanOrEqual(120);
  });

  it('paces the NEXT caller off the quota window the vendor reported to the previous one', async () => {
    // This is the budget shared across the trading schedules: trading-fast, trading-events,
    // trading-autopilot and trading-assess all run in this process and read one window.
    pin('ALPACA_DATA_RATE_LIMIT_MAX_WAIT_MS', '3000');
    const resetSec = Math.ceil((Date.now() + 150) / 1000);
    const resetAtMs = resetSec * 1000;
    const spent = { 'x-ratelimit-limit': '200', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) };
    const calls = installTransport([okPage([1, 2], null, spent), okPage([3, 4], null, healthy())]);

    await barsBatch(['AAPL'], '1Day', 60);           // schedule A — burns the last of the minute
    expect(observedQuota()?.remaining).toBe(0);
    await barsBatch(['AAPL'], '1Day', 60);           // schedule B — must wait for the vendor's reset

    expect(calls).toHaveLength(2);
    expect(calls[1].atMs).toBeGreaterThanOrEqual(resetAtMs - 20);
    expect(calls[1].atMs - calls[0].atMs).toBeGreaterThanOrEqual(120);
  });

  it('reads the wait from the documented headers and stops pacing once the window resets', () => {
    const now = 1_700_000_000_000;
    const bag = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

    // X-RateLimit-Reset is the documented epoch in SECONDS.
    expect(vendorWaitFrom(bag({ 'x-ratelimit-reset': String(now / 1000 + 30) }), now)).toBe(30_000);
    // Retry-After (RFC 9110, seconds) is the fallback when the vendor sends one.
    expect(vendorWaitFrom(bag({ 'retry-after': '7' }), now)).toBe(7_000);
    // Neither header — the caller falls back to bounded exponential backoff.
    expect(vendorWaitFrom(bag({}), now)).toBeNull();

    // A past reset never pins the wait negative, and a spent window in the past stops pacing.
    expect(vendorWaitFrom(bag({ 'x-ratelimit-reset': String(now / 1000 - 30) }), now)).toBe(0);
    expect(pacingWaitMs()).toBe(0); // no window observed at all

    // A response carrying NO rate-limit headers must leave the window unset. `Number(null)` is 0,
    // so a careless read would record "0 requests remaining" and pace every later call forever.
    noteRateLimitHeaders(bag({}));
    expect(observedQuota()).toBeNull();

    // Backoff without vendor headers stays inside the configured cap.
    const blind = new AlpacaRateLimitError('too many requests.');
    expect(retryWaitMs(blind, 5)).toBeLessThanOrEqual(300);
  });
});
