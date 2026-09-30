/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial - the congressional-disclosure live-acceptance case's own logic over a doubled HTTP transport and an in-memory watchlist: dated rows + a passing card + an Add that lists and deletes the synthetic ticker = pass; a row without observed_at = fail (and the symbol is still removed); a synthetic symbol already on the watchlist is never touched; a delete that leaves the symbol is a red cleanup; an unmounted report is unavailable with no watchlist write; only ZZT-XXXXX symbols are ever written. The real companion is `node scripts/operations/live-acceptance.js congress` on the box.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fakeApi, type FakeHandler } from '../fixtures/live-acceptance-fake-api';

const requireCjs = createRequire(import.meta.url);
const congress = requireCjs('../../scripts/lib/live-acceptance-congress.js');

const SYMBOL = 'ZZT-QKXWB';
const ROWS = [
  { symbol: 'NVDA', disclosureDate: '2026-09-25', observedAt: '2026-09-28T12:00:04.000Z', source: 'quiver-congress', net: 2 },
  { symbol: 'MSFT', disclosureDate: '2026-09-22', observedAt: '2026-09-28T06:00:03.000Z', source: 'quiver-congress', net: -1 },
];

function world(options: { rows?: unknown[]; preexisting?: string[]; deleteWorks?: boolean; over?: Record<string, FakeHandler> } = {}) {
  const watchlist = new Set(options.preexisting ?? []);
  const rows = (options.rows ?? ROWS) as Array<{ symbol: string; disclosureDate: string; observedAt: string; source: string }>;
  return fakeApi({
    'POST /api/test-lab/run': () => ({ status: 200, json: { results: [{ id: 'congress-disclosures', steps: [{ state: 'pass', detail: 'Live: 2 name(s)' }] }] } }),
    'GET /api/trading/reports/congress': () => ({ status: 200, json: { status: 'ok', source: 'quiver-congress', windowDays: 90, rows } }),
    'GET /api/trading/watchlist': () => ({ status: 200, json: { items: [...watchlist].map((symbol) => {
      const feed = rows.find((r) => r && r.symbol === symbol && r.source === 'quiver-congress' && r.observedAt);
      return { symbol, congress: feed ? { disclosureDate: feed.disclosureDate, observedAt: feed.observedAt, source: feed.source } : null };
    }) } }),
    'POST /api/trading/watchlist': ({ body }) => { const symbol = (body as { symbol: string }).symbol; watchlist.add(symbol); return { status: 201, json: { item: { symbol } } }; },
    'DELETE /api/trading/watchlist/:symbol': ({ params }) => {
      const had = watchlist.has(params.symbol);
      if (options.deleteWorks !== false) watchlist.delete(params.symbol);
      return { status: 200, json: { deleted: had, symbol: params.symbol } };
    },
    ...(options.over || {}),
  });
}

describe('congressional disclosures live acceptance', () => {
  it('passes on dated rows, a passing card and an Add that is listed then deleted', async () => {
    const api = world();
    const result = await congress.run({ api: api.api }, { symbol: SYMBOL });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('2 dated disclosure row(s); newest disclosure 2026-09-25, last observed 2026-09-28T12:00:04.000Z');
    expect(result.detail).toContain('Feed symbol NVDA added; watchlist row carries disclosure day 2026-09-25; deleted cleanly');
    const adds = api.calls.filter((c) => c.method === 'POST' && c.path === '/api/trading/watchlist');
    expect(adds.map((c) => c.body)).toEqual([{ symbol: SYMBOL }, { symbol: 'NVDA' }]);
    expect(result.cleanup.removed).toEqual([`watchlist-symbol ${SYMBOL}`, 'watchlist-symbol NVDA']);
    expect(result.cleanup.outstanding).toEqual([]);
  });

  it('fails a row without observed_at and still removes the synthetic symbol', async () => {
    const api = world({ rows: [{ ...ROWS[0], observedAt: null }] });
    const result = await congress.run({ api: api.api }, { symbol: SYMBOL });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('1 of 1 disclosure row(s) lack a ReportDate day, an observedAt');
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(result.cleanup.removed).toEqual([`watchlist-symbol ${SYMBOL}`]);
  });

  it('never touches a synthetic symbol that is already on the watchlist', async () => {
    const api = world({ preexisting: [SYMBOL] });
    const result = await congress.run({ api: api.api }, { symbol: SYMBOL });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('already on the watchlist');
    expect(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/trading/watchlist')).toEqual([]);
    expect(api.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('turns a delete that leaves the symbol into a red cleanup', async () => {
    const result = await congress.run({ api: world({ deleteWorks: false }).api }, { symbol: SYMBOL });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain(`CLEANUP INCOMPLETE: ${SYMBOL} is still on the watchlist after the delete`);
    expect(result.cleanup.outstanding).toEqual([`watchlist-symbol ${SYMBOL}`]);
  });

  it('is unavailable with no watchlist write when the report route is not mounted', async () => {
    const api = world({ over: { 'GET /api/trading/reports/congress': () => ({ status: 404 }) } });
    const result = await congress.run({ api: api.api }, { symbol: SYMBOL });
    expect(result.state).toBe('unavailable');
    expect(api.calls.some((c) => c.path.startsWith('/api/trading/watchlist'))).toBe(false);
  });

  it('only ever writes a ZZT-XXXXX synthetic ticker in watchlistStep', async () => {
    for (let i = 0; i < 50; i += 1) expect(congress.syntheticSymbol()).toMatch(/^ZZT-[A-Z]{5}$/);
    const api = world();
    await expect(congress.watchlistStep({ api: api.api }, 'NVDA', { created() {}, removed() {}, error() {} })).rejects.toThrow('non-synthetic');
    expect(api.calls).toEqual([]);
  });

  it('skips adding a feed symbol if all disclosure candidates are already on the watchlist', async () => {
    const api = world({ preexisting: ['NVDA', 'MSFT'] });
    const result = await congress.run({ api: api.api }, { symbol: SYMBOL });
    expect(result.state).toBe('pass');
    expect(result.detail).toContain('every feed disclosure symbol is already on the watchlist; existing entries kept untouched');
    const adds = api.calls.filter((c) => c.method === 'POST' && c.path === '/api/trading/watchlist');
    expect(adds.map((c) => c.body)).toEqual([{ symbol: SYMBOL }]);
    expect(result.cleanup.removed).toEqual([`watchlist-symbol ${SYMBOL}`]);
  });

  it('fails if feed symbol on watchlist does not carry matching disclosure day', async () => {
    const watchlist = new Set<string>();
    const api = world({
      over: {
        'GET /api/trading/watchlist': () => ({
          status: 200,
          json: {
            items: [...watchlist].map((symbol) => ({
              symbol,
              congress: symbol === 'NVDA' ? { disclosureDate: '2026-01-01', observedAt: '2026-09-28T12:00:04.000Z', source: 'quiver-congress' } : null,
            })),
          },
        }),
        'POST /api/trading/watchlist': ({ body }) => {
          const symbol = (body as { symbol: string }).symbol;
          watchlist.add(symbol);
          return { status: 201, json: { item: { symbol } } };
        },
        'DELETE /api/trading/watchlist/:symbol': ({ params }) => {
          watchlist.delete(params.symbol);
          return { status: 200, json: { deleted: true, symbol: params.symbol } };
        },
      },
    });
    const result = await congress.run({ api: api.api }, { symbol: SYMBOL });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('observed congress disclosure day: 2026-01-01');
  });
});
