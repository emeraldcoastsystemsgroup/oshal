/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Each depth collector reports its own feed outcome (core #1026 review): the Nasdaq calendar, openinsider, FINRA and USAspending collectors used to swallow a failed request and return zero counts, so a dead feed read as a clean run on the World sources screen. With the public feeds doubled by a fetch stub (outside the boundary) and a recording world service, every request failing reads `failed`, some failing reads `partial`, and readable-but-empty answers read `ok`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectMarketEvents } from '../../src/features/world-data/market-events';
import { collectInsiderTrades } from '../../src/features/world-data/insider-trades';
import { collectShortInterest } from '../../src/features/world-data/short-interest';
import { collectGovContracts } from '../../src/features/world-data/gov-contracts';
import { collectorFeedOutcome } from '../../src/features/world-data/world-source-control';

/** The world service methods the collectors write through, recorded. */
function recordingService() {
  const writes: string[] = [];
  return {
    writes,
    svc: {
      writeMetric: async (entity: string, metric: string) => { writes.push(`${entity}:${metric}`); },
      upsertEvent: async (e: { entityId: string; eventType: string }) => { writes.push(`${e.entityId}:${e.eventType}`); },
    } as never,
  };
}

/** A fetch double: `answer(url, n)` returns a Response or throws, n = the call index. */
function stubFetch(answer: (url: string, n: number) => Response) {
  let n = 0;
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => { urls.push(String(url)); return answer(String(url), n++); });
  return urls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refused = () => new Response('refused', { status: 503 });

afterEach(() => { vi.unstubAllGlobals(); });

describe('collectorFeedOutcome', () => {
  it('is ok when every request answered, failed when none did, partial in between', () => {
    expect(collectorFeedOutcome(3, 3)).toBe('ok');
    expect(collectorFeedOutcome(0, 3)).toBe('failed');
    expect(collectorFeedOutcome(1, 3)).toBe('partial');
  });
});

describe('each collector reports its own feed outcome', () => {
  it('Nasdaq calendar: every day refused is failed; empty days are ok; some refused is partial', async () => {
    stubFetch(() => refused());
    expect((await collectMarketEvents(recordingService().svc)).feed).toBe('failed');
    stubFetch(() => json({ data: { rows: [] } }));
    expect((await collectMarketEvents(recordingService().svc)).feed).toBe('ok');
    stubFetch((_url, n) => (n % 2 ? refused() : json({ data: { rows: null } })));
    expect((await collectMarketEvents(recordingService().svc)).feed).toBe('partial');
  });

  it('openinsider: both pages failing is failed; one page failing is partial', async () => {
    stubFetch(() => { throw new Error('connect ECONNREFUSED'); });
    expect((await collectInsiderTrades(recordingService().svc)).feed).toBe('failed');
    stubFetch((_url, n) => (n === 0 ? new Response('<table></table>', { status: 200 }) : refused()));
    expect((await collectInsiderTrades(recordingService().svc)).feed).toBe('partial');
  });

  it('FINRA: no day answering is failed; a readable file is ok', async () => {
    stubFetch(() => refused());
    expect(await collectShortInterest(recordingService().svc)).toMatchObject({ day: null, feed: 'failed' });
    stubFetch(() => new Response('Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n', { status: 200 }));
    expect((await collectShortInterest(recordingService().svc)).feed).toBe('ok');
  });

  it('USAspending: every request refused is failed and writes nothing; empty answers are ok', async () => {
    const rec = recordingService();
    const urls = stubFetch(() => refused());
    expect(await collectGovContracts(rec.svc)).toMatchObject({ tickers: 0, feed: 'failed' });
    expect(urls.length).toBeGreaterThan(1);
    expect(rec.writes).toEqual([]);
    stubFetch(() => json({ results: [] }));
    expect((await collectGovContracts(recordingService().svc)).feed).toBe('ok');
  });
});
