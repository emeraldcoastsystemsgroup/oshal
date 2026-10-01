/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ingest half of oshal's own outlet ratings (operator decision 2026-09-22: the seed table is deleted). A real publisher feed served by a local HTTP server runs through the real speed-read and deep-dive engines with a capturing world service. Proves nothing stamps a rating at ingest: every archive row carries lean and reliability NULL, the outlet node written to the shared graph carries every retired rating prop as null (so a re-ingest clears the seeded numbers) and no number, and the publisher still resolves to the canonical id its history is stored under.
 */

/**
 * @description The double is the world service (it records the archive rows and contributions the
 * engine builds instead of writing a database); the feed is a real node:http server and the parser
 * the production one. The classify provider is the production one too, and it fails closed (the
 * unattended CLI guard) before any process starts, so the deep dive scores with the lexicon.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deepDiveFirehose, speedReadFirehose } from '../../src/features/world-data/news-fetcher';
import { RETIRED_RATING_PROPS } from '../../src/features/world-data/outlet-ratings';
import type { ArchiveRecord, WorldIntelligenceService } from '../../src/features/world-data/world-intelligence-service';
import type { WorldContribution } from '../../src/features/world-data/world-types';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fox</title>
<item><title>Markets climb as yields ease</title><description>Stocks rose broadly.</description><link>https://news.example.com/1</link></item>
<item><title>Oil slips on supply news</title><description>Crude fell 2%.</description><link>https://news.example.com/2</link></item>
</channel></rss>`;

let server: Server;
let url = '';

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(RSS); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A world service that records what the engine would write. */
function recordingService(queue: Array<{ itemHash: string; title: string; description: string; outlet: string; link: string; pubDate: string | null }> = []) {
  const archived: ArchiveRecord[] = [];
  const ingested: WorldContribution[] = [];
  const svc = {
    existingHashes: async () => new Set<string>(),
    touchItems: async () => undefined,
    archiveItem: async (r: ArchiveRecord) => { archived.push(r); return { inserted: true }; },
    logPull: async () => undefined,
    pullNoveltyByFeed: async () => new Map(),
    recentUndeepened: async () => queue,
    markDeepened: async () => undefined,
    ingest: async (c: WorldContribution) => { ingested.push(c); return { nodes: c.entities.length, edges: c.edges.length, facts: c.facts.length }; },
  } as unknown as WorldIntelligenceService;
  return { svc, archived, ingested };
}

const isNumber = (v: unknown): boolean => typeof v === 'number';

describe('ingest stamps no rating', () => {
  it('speed read: every archive row has NULL lean and reliability and the canonical outlet id', async () => {
    const rec = recordingService();
    const result = await speedReadFirehose(rec.svc, [{ id: 'fox-test', name: 'Fox News', url }]);
    expect(result.perFeed[0]).toMatchObject({ fetched: 2, fresh: 2 });
    expect(rec.archived.length).toBeGreaterThanOrEqual(2);
    for (const row of rec.archived) {
      expect(row.lean).toBeNull();
      expect(row.reliability).toBeNull();
      expect(row.outletId).toBe('world:outlet:foxnews');
    }
  });

  it('deep dive: the outlet node carries every retired rating prop as null and no number', async () => {
    const rec = recordingService([
      { itemHash: 'h1', title: 'Markets climb as yields ease', description: 'Stocks rose broadly.', outlet: 'Fox News', link: 'https://news.example.com/1', pubDate: null },
    ]);
    const result = await deepDiveFirehose(rec.svc, [{ id: 'fox-test', name: 'Fox News', url }], { budget: 5, metered: false });
    expect(result.deepened).toBe(1);
    expect(rec.ingested).toHaveLength(1);
    const outlet = rec.ingested[0].entities.find((e) => e.type === 'outlet');
    expect(outlet?.id).toBe('world:outlet:foxnews');
    for (const key of Object.keys(RETIRED_RATING_PROPS)) expect(outlet?.props?.[key]).toBeNull();
    expect(Object.values(outlet?.props ?? {}).some(isNumber)).toBe(false);
    expect(rec.ingested[0].source).toBe('world:outlet:foxnews'); // the sentiment facts land under the same id as before
  });

  it('an unknown publisher keeps its slug id and is not rated at ingest either', async () => {
    const rec = recordingService([
      { itemHash: 'h2', title: 'Local mill reopens', description: 'Jobs return.', outlet: 'Riverside Gazette', link: '', pubDate: null },
    ]);
    await deepDiveFirehose(rec.svc, [{ id: 'gazette-test', name: 'Riverside Gazette', url }], { budget: 5, metered: false });
    const outlet = rec.ingested[0].entities.find((e) => e.type === 'outlet');
    expect(outlet?.id).toBe('world:outlet:riverside-gazette');
    expect(outlet?.props).toMatchObject({ unrated: null, lean: null, reliability: null, category: 'finance', name: 'Riverside Gazette' });
  });
});
