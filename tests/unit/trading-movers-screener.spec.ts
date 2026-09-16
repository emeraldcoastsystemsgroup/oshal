/**
 * ADR-143 D5 — the Alpaca REST screener behind the whole-market movers board.
 *
 * THE BOUNDARY THIS GUARD CROSSES: the screener leg is an HTTP client, and every failure shape it
 * claims to survive is an HTTP one. So the module is driven against a REAL `node:http` server on
 * 127.0.0.1 — a real socket, real request line, real headers, real status codes and a real body
 * parse — with ALPACA_SCREENER_BASE_URL pointed at it. Nothing about the screener's own transport is
 * mocked; a fetch double would prove the branch logic and nothing about the boundary that fails.
 *
 * ONE SCOPED DOUBLE, and it is outside that boundary: `assetDirectory()` talks to paper-api.alpaca
 * .markets, which is a collaborator of the filter rather than the screener transport. Only requests
 * to THAT host are answered from the test; every screener request goes over the real socket. The
 * directory filter's own vendor call is therefore not proven here — it is proven by market-data's
 * existing callers — and the case that matters for this fix (an unavailable directory must not empty
 * the board) is exercised explicitly.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the ADR-143 D5 screener guard over a real local HTTP vendor: the gainers/losers/most-actives parse with the vendor's last_updated carried verbatim, the key headers actually on the wire, the documented `top` clamp in the request line, `by=` on most-actives, the minimum-price and asset-directory filters (including the unavailable-directory case that must NOT empty the board), most-actives rows left unpriced rather than back-filled, and the four fail-soft shapes — non-200, unusable body, a dead socket, and no key configured (which must not reach the vendor at all) — each answering null so the caller can fall back to its bounded board.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

type ScreenerModule = typeof import('../../src/features/trading/services/alpaca-screener');

/** What the stand-in vendor should answer next, and what it actually received. */
interface VendorState {
  status: number;
  body: string;
  contentType: string;
  requests: Array<{ url: string; keyId: string | undefined; secret: string | undefined }>;
}

const vendor: VendorState = { status: 200, body: '{}', contentType: 'application/json', requests: [] };
let server: Server;
let base = '';

/** The asset directory the paper-api double answers with — null means "the directory is down". */
let directory: Array<{ symbol: string; name: string; exchange: string; tradable: boolean }> | null = null;

const realFetch = globalThis.fetch;

const ENV_KEYS = [
  'ALPACA_SCREENER_BASE_URL', 'ALPACA_PAPER_KEY_ID', 'ALPACA_PAPER_SECRET_KEY', 'ALPACA_KEY_ID',
  'ALPACA_KEY', 'ALPAKA_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_SECRET', 'ALPAKA_SECRET',
  'TRADING_MOVERS_MIN_PRICE',
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const k of ENV_KEYS) { savedEnv.set(k, process.env[k]); delete process.env[k]; }
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    vendor.requests.push({
      url: req.url ?? '',
      keyId: req.headers['apca-api-key-id'] as string | undefined,
      secret: req.headers['apca-api-secret-key'] as string | undefined,
    });
    res.writeHead(vendor.status, { 'content-type': vendor.contentType });
    res.end(vendor.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta1/screener`;
  // Only the asset-directory host is answered from here; screener traffic goes over the real socket.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes('paper-api.alpaca.markets')) {
      return Promise.resolve(directory === null
        ? new Response('down', { status: 503 })
        : new Response(JSON.stringify(directory), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

afterEach(() => {
  vendor.requests.length = 0;
  for (const k of ENV_KEYS) delete process.env[k];
});

/** A configured screener module with a fresh asset-directory cache (the cache lives module-level). */
async function screener(opts: { keys?: boolean; minPrice?: string } = {}): Promise<ScreenerModule> {
  process.env.ALPACA_SCREENER_BASE_URL = base;
  if (opts.keys !== false) {
    process.env.ALPACA_PAPER_KEY_ID = 'test-key-id';
    process.env.ALPACA_PAPER_SECRET_KEY = 'test-secret-key';
  }
  if (opts.minPrice !== undefined) process.env.TRADING_MOVERS_MIN_PRICE = opts.minPrice;
  vi.resetModules();
  return import('../../src/features/trading/services/alpaca-screener');
}

/** Point the stand-in vendor at a JSON payload. */
function answers(body: unknown, status = 200, contentType = 'application/json'): void {
  vendor.status = status;
  vendor.contentType = contentType;
  vendor.body = typeof body === 'string' ? body : JSON.stringify(body);
}

const MOVERS_BODY = {
  gainers: [
    { symbol: 'NVDA', price: 182.5, change: 12.1, percent_change: 7.1 },
    { symbol: 'WRNTW', price: 0.42, change: 0.2, percent_change: 90.9 },
    { symbol: 'AMD', price: 141.2, change: 6.4, percent_change: 4.7 },
  ],
  losers: [{ symbol: 'INTC', price: 21.4, change: -2.2, percent_change: -9.3 }],
  market_type: 'stocks',
  last_updated: '2026-09-16T17:41:02.113Z',
};

const ACTIVES_BODY = {
  most_actives: [
    { symbol: 'TSLA', volume: 91_204_331, trade_count: 812_004 },
    { symbol: 'ZZZQ', volume: 44_000_000, trade_count: 12_000 },
  ],
  last_updated: '2026-09-16T17:41:04.900Z',
};

const FULL_DIRECTORY = [
  { symbol: 'NVDA', name: 'NVIDIA Corp', exchange: 'NASDAQ', tradable: true },
  { symbol: 'AMD', name: 'Advanced Micro Devices', exchange: 'NASDAQ', tradable: true },
  { symbol: 'INTC', name: 'Intel Corp', exchange: 'NASDAQ', tradable: true },
  { symbol: 'WRNTW', name: 'Some Warrant', exchange: 'OTC', tradable: true },
  { symbol: 'TSLA', name: 'Tesla Inc', exchange: 'NASDAQ', tradable: true },
];

describe('ADR-143 D5 — the screener reads the whole board over a real HTTP boundary', () => {
  it('parses the gainers board, carries the vendor last_updated verbatim, and sends the key headers', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY);
    const { screenerMovers, SCREENER_LABEL } = await screener();
    const board = await screenerMovers('gainers', 15);

    expect(board).not.toBeNull();
    expect(board!.lastUpdated).toBe('2026-09-16T17:41:02.113Z');
    expect(board!.rows.map((r) => r.symbol)).toEqual(['NVDA', 'AMD']);
    expect(board!.rows[0]).toMatchObject({ symbol: 'NVDA', price: 182.5, changePct: 7.1 });
    expect(SCREENER_LABEL).toBe('Alpaca screener');

    // the request actually reached the vendor, authenticated, on the documented path
    expect(vendor.requests).toHaveLength(1);
    expect(vendor.requests[0].url).toContain('/v1beta1/screener/stocks/movers');
    expect(vendor.requests[0].keyId).toBe('test-key-id');
    expect(vendor.requests[0].secret).toBe('test-secret-key');
  });

  it('reads the losers array off the same call', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY);
    const { screenerMovers } = await screener();
    const board = await screenerMovers('losers', 15);
    expect(board!.rows.map((r) => r.symbol)).toEqual(['INTC']);
    expect(board!.rows[0].changePct).toBe(-9.3);
  });

  it('clamps `top` to the documented ceiling in the request line the vendor receives', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY);
    const { screenerMovers } = await screener();
    await screenerMovers('gainers', 5000);
    expect(vendor.requests[0].url).toContain('top=50');
  });

  it('most-actives ranks by the asked-for measure and leaves the unpriced rows unpriced', async () => {
    directory = FULL_DIRECTORY;
    answers(ACTIVES_BODY);
    const { screenerMostActives } = await screener();
    const board = await screenerMostActives('volume', 15);

    expect(vendor.requests[0].url).toContain('/v1beta1/screener/stocks/most-actives');
    expect(vendor.requests[0].url).toContain('by=volume');
    expect(board!.lastUpdated).toBe('2026-09-16T17:41:04.900Z');
    // ZZZQ is not in the directory, so the directory filter drops it; TSLA survives unpriced.
    expect(board!.rows.map((r) => r.symbol)).toEqual(['TSLA']);
    expect(board!.rows[0]).toMatchObject({ price: null, changePct: null, dayVolume: 91_204_331, tradeCount: 812_004 });
  });
});

describe('ADR-143 D5 — the two stated filters, and neither may empty the board on its own', () => {
  it('the minimum price drops the sub-floor rows the vendor priced, and reports the floor it used', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY);
    const { screenerMovers, DEFAULT_MOVERS_MIN_PRICE } = await screener();
    const board = await screenerMovers('gainers', 15);
    expect(board!.filter.minPrice).toBe(DEFAULT_MOVERS_MIN_PRICE);
    expect(board!.rows.map((r) => r.symbol)).not.toContain('WRNTW');   // $0.42 warrant
  });

  it('TRADING_MOVERS_MIN_PRICE moves the floor — nothing here is a hardcoded five', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY);
    const { screenerMovers } = await screener({ minPrice: '150' });
    const board = await screenerMovers('gainers', 15);
    expect(board!.filter.minPrice).toBe(150);
    expect(board!.rows.map((r) => r.symbol)).toEqual(['NVDA']);
  });

  it('the asset-directory filter drops what the directory does not list, and says it ran', async () => {
    directory = FULL_DIRECTORY.filter((a) => a.symbol !== 'AMD');
    answers(MOVERS_BODY);
    const { screenerMovers } = await screener();
    const board = await screenerMovers('gainers', 15);
    expect(board!.filter.assetDirectory).toBe(true);
    expect(board!.rows.map((r) => r.symbol)).toEqual(['NVDA']);
  });

  it('an UNAVAILABLE directory is skipped, not treated as an empty one — the board survives', async () => {
    directory = null;                                   // paper-api answers 503
    answers(MOVERS_BODY);
    const { screenerMovers } = await screener();
    const board = await screenerMovers('gainers', 15);
    expect(board!.filter.assetDirectory).toBe(false);
    expect(board!.rows.map((r) => r.symbol)).toEqual(['NVDA', 'AMD']);
  });
});

describe('ADR-143 D5 — fail-soft: every failure answers null so the caller falls back, never blanks', () => {
  it('a non-200 answers null EVEN WHEN the body would have parsed — the status alone decides', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY, 403);          // a perfectly good board behind a refusal
    const { screenerMovers } = await screener();
    await expect(screenerMovers('gainers', 15)).resolves.toBeNull();
    expect(vendor.requests).toHaveLength(1);

    answers(MOVERS_BODY, 429);          // and a rate-limit, likewise
    await expect(screenerMovers('gainers', 15)).resolves.toBeNull();
  });

  it('a 200 that is not the documented shape answers null rather than an empty board', async () => {
    directory = FULL_DIRECTORY;
    answers('<html>maintenance</html>', 200, 'text/html');
    const { screenerMovers } = await screener();
    await expect(screenerMovers('gainers', 15)).resolves.toBeNull();

    answers({ gainers: 'soon' });
    const again = await screenerMovers('gainers', 15);
    expect(again).toBeNull();
  });

  it('a dead socket answers null instead of throwing at the caller', async () => {
    directory = FULL_DIRECTORY;
    const { screenerMovers } = await screener();
    process.env.ALPACA_SCREENER_BASE_URL = 'http://127.0.0.1:1/v1beta1/screener';
    await expect(screenerMovers('gainers', 15)).resolves.toBeNull();
  });

  it('with NO key configured it answers null without ever reaching the vendor', async () => {
    directory = FULL_DIRECTORY;
    answers(MOVERS_BODY);
    const { screenerMovers, screenerMostActives } = await screener({ keys: false });
    await expect(screenerMovers('gainers', 15)).resolves.toBeNull();
    await expect(screenerMostActives('volume', 15)).resolves.toBeNull();
    expect(vendor.requests).toHaveLength(0);
  });
});
