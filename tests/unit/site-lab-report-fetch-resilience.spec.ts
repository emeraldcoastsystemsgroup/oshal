/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the nightly lab-report generator's
 *   fetch layer. Twice (2026-07-27, 2026-07-30) the job emailed "site-lab-report FAILED: fetch
 *   failed" while the api was up and healthy: the box was saturated by the overlapping 17:00
 *   recap leg, one connect attempt lost, and 59 strategies' worth of work was discarded with a
 *   message that named no cause. This pins the three properties that fix it — a transient
 *   failure is retried, a 4xx is NOT (retrying a 401 only delays the same alert), and the
 *   thrown message carries undici's `cause` chain instead of the bare string "fetch failed" —
 *   plus the base URL staying off `localhost`, whose ::1 detour is what times out here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.LAB_REPORT_BACKOFF_MS = '0'; // no real sleeping in a unit test
process.env.OSHAL_CLI_TOKEN = 'test-token';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../../scripts/site-lab-report.js') as {
  describeError: (err: unknown) => string;
  isTransient: (err: Error & { status?: number }) => boolean;
  get: (p: string) => Promise<unknown>;
  BASE: string;
};

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const httpErr = (status: number) => ({ ok: false, status, json: async () => ({}) });

describe('lab-report generator: base URL', () => {
  it('defaults off `localhost` — the ::1 detour is the failure mode being fixed', () => {
    expect(mod.BASE).not.toContain('localhost');
    expect(mod.BASE).toContain('127.0.0.1');
  });
});

describe('lab-report generator: error reporting', () => {
  it('unwraps undici\'s cause chain instead of reporting the bare "fetch failed"', () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    const described = mod.describeError(err);

    expect(described).toContain('fetch failed');
    expect(described).toContain('Connect Timeout Error');
    expect(described).toContain('UND_ERR_CONNECT_TIMEOUT');
    // The regression: the old code logged err.message alone, which is exactly this and nothing else.
    expect(described).not.toBe('fetch failed');
  });

  it('does not loop forever on a self-referential cause chain', () => {
    const err: Error & { cause?: unknown } = new Error('a');
    err.cause = err;
    expect(mod.describeError(err)).toBeTruthy();
  });
});

describe('lab-report generator: what counts as transient', () => {
  it('treats a transport failure (no verdict from the server) as transient', () => {
    expect(mod.isTransient(new TypeError('fetch failed'))).toBe(true);
  });

  it('treats 5xx and 429 as transient', () => {
    expect(mod.isTransient(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(mod.isTransient(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
  });

  it('treats auth/not-found as FATAL — retrying a 401 only delays the same alert', () => {
    expect(mod.isTransient(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(mod.isTransient(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
  });
});

describe('lab-report generator: get() retry behaviour', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('recovers when a connect failure is followed by success', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') }))
      .mockResolvedValueOnce(jsonOk({ strategies: [{ id: 's1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mod.get('/api/trading/lab/strategies')).resolves.toEqual({ strategies: [{ id: 's1' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(httpErr(503))
      .mockResolvedValueOnce(jsonOk({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mod.get('/api/trading/lab/strategies')).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 401 — it fails on the first attempt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpErr(401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mod.get('/api/trading/lab/strategies')).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget, and names the cause in the final error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mod.get('/api/trading/lab/strategies')).rejects.toThrow(/UND_ERR_CONNECT_TIMEOUT/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // the default budget
  });
});
