/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the 2026-07-16 blackout regression. A `catch { return 'closed' }` turned a DNS outage into "market closed", so the live desk ran no entries AND no protective exits for 28 min while the watchdog read it as healthy. These lock: every clock FAILURE marks blind (never a silent 'closed'), and the three stand-down causes (halt / closed / ext-disabled) stay DISTINCT so the watchdog can tell a kill-switch from a real closed market.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tradableSessionDetailed } from '../../src/features/trading';

const OK = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  process.env.ALPACA_PAPER_KEY_ID = 'test-key';
  process.env.ALPACA_PAPER_SECRET_KEY = 'test-secret';
  delete process.env.TRADING_HALT;
  delete process.env.TRADING_EXTENDED_HOURS;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('tradableSessionDetailed — a clock FAILURE is never a silent "closed"', () => {
  it('marks blind when the clock fetch throws (THE 2026-07-16 REGRESSION: DNS/EAI_AGAIN)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo EAI_AGAIN api.alpaca.markets'); }));
    const r = await tradableSessionDetailed();
    expect(r.session).toBeNull();     // still stands down — that direction is correct
    expect(r.blind).toBe(true);       // but it is now KNOWABLE, not silent
    expect(r.reason).toBe('closed');
  });

  it('marks blind on a non-2xx clock (a 500/429 is not a closed market)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
    expect((await tradableSessionDetailed()).blind).toBe(true);
  });

  it('marks blind on an unusable clock body (the old .json().catch(() => ({})) hole)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({})));            // no is_open / timestamp
    expect((await tradableSessionDetailed()).blind).toBe(true);
  });

  it('is NOT blind on a healthy open market', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => OK({ is_open: true, timestamp: '2026-07-16T12:00:00-04:00' })));
    const r = await tradableSessionDetailed();
    expect(r.session).toBe('regular');
    expect(r.reason).toBe('ok');
    expect(r.blind).toBe(false);
  });
});

describe('tradableSessionDetailed — the three stand-down causes stay DISTINCT', () => {
  it('TRADING_HALT reports reason "halt", never "closed" (it also kills protective exits)', async () => {
    process.env.TRADING_HALT = 'true';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not be called'); }));
    const r = await tradableSessionDetailed();
    expect(r.session).toBeNull();
    expect(r.reason).toBe('halt');    // collapsing this into "market closed" is what hid it from the watchdog
    expect(r.blind).toBe(false);
  });

  it('halt short-circuits before any network call', async () => {
    process.env.TRADING_HALT = 'true';
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await tradableSessionDetailed();
    expect(f).not.toHaveBeenCalled();
  });

  it('a genuinely closed market reports reason "closed" and is NOT blind', async () => {
    // is_open:false + a calendar with no rows = authoritative "not a trading day".
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/calendar')
      ? OK([])
      : OK({ is_open: false, timestamp: '2026-07-04T12:00:00-04:00' }))));
    const r = await tradableSessionDetailed();
    expect(r.session).toBeNull();
    expect(r.reason).toBe('closed');
    expect(r.blind).toBe(false);      // a FACT, not a guess — the distinction the fix exists for
  });
});
