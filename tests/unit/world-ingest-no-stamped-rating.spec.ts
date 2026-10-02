/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the ingest half of oshal's own outlet ratings (operator decision 2026-09-22: the seed table is deleted). A real publisher feed served by a local HTTP server runs through the real speed-read and deep-dive engines with a capturing world service. Proves nothing stamps a rating at ingest: every archive row carries lean and reliability NULL, the outlet node written to the shared graph carries every retired rating prop as null (so a re-ingest clears the seeded numbers) and no number, and the publisher still resolves to the canonical id its history is stored under.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the classifier_model stamp, which changed with no test when the classify backend became the platform's: the stamp names what scored that item. A fake backend registered through the production configureWorldClassify scores one item of a chunk. The per-subject ingest (a registry news source, its request answered by the local feed) archives that item under the backend's name with usedLlm true and the item the backend left unscored as lexicon with usedLlm false; with no backend registered every row is lexicon; the deep dive hands markDeepened and its per-entity archive row the backend's name for the model-scored item, and markDeepened lexicon for the other. The recording world service keeps the markDeepened payloads for this. Red when the engine stamps one fixed model name on every row.
 */

/**
 * @description The double is the world service (it records the archive rows, the deep-dive upgrades
 * and the contributions the engine builds instead of writing a database); the feed is a real
 * node:http server and the parser the production one. The rating cases register no classify backend,
 * so the deep dive scores with the lexicon. The classifier-stamp cases register a fake backend
 * through the production configureWorldClassify; their per-subject ingest pulls a registry source,
 * whose request (a public host) is answered by the same local feed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  configureWorldClassify, deepDiveFirehose, ingestFeeds, speedReadFirehose,
  type ClassifyProvider, type FeedIngestResult,
} from '../../src/features/world-data/news-fetcher';
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

/** What the deep dive hands markDeepened for one queued item. */
type DeepenedRecord = Parameters<WorldIntelligenceService['markDeepened']>[1];

/** A world service that records what the engine would write. */
function recordingService(queue: Array<{ itemHash: string; title: string; description: string; outlet: string; link: string; pubDate: string | null }> = []) {
  const archived: ArchiveRecord[] = [];
  const ingested: WorldContribution[] = [];
  const deepened = new Map<string, DeepenedRecord>();
  const svc = {
    existingHashes: async () => new Set<string>(),
    touchItems: async () => undefined,
    archiveItem: async (r: ArchiveRecord) => { archived.push(r); return { inserted: true }; },
    logPull: async () => undefined,
    pullNoveltyByFeed: async () => new Map(),
    recentUndeepened: async () => queue,
    markDeepened: async (itemHash: string, r: DeepenedRecord) => { deepened.set(itemHash, r); },
    ingest: async (c: WorldContribution) => { ingested.push(c); return { nodes: c.entities.length, edges: c.edges.length, facts: c.facts.length }; },
  } as unknown as WorldIntelligenceService;
  return { svc, archived, ingested, deepened };
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

/** A classify backend that scores item 0 of a chunk and leaves the rest unscored; it counts its calls. */
function scoringBackend(): { backend: ClassifyProvider; calls: () => number } {
  let calls = 0;
  const text = '[{"i":0,"s":0.5,"e":[{"n":"Nvidia","t":"org"}],"ev":{"t":"earnings","i":0.8}}]';
  return { calls: () => calls, backend: { name: 'swarm:test-bot', complete: async () => { calls += 1; return { text }; } } };
}

/** One light per-subject pull of a registry news source. The registry names public hosts, so the
 *  engine's request is answered by the local feed for the length of the call. */
async function ingestTopic(svc: WorldIntelligenceService): Promise<FeedIngestResult> {
  const realFetch = globalThis.fetch;
  const redirect = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => realFetch(url, init));
  try {
    return await ingestFeeds(svc, 'technology industry', 'world:topic:technology', 'Technology', ['google-news'], { light: true });
  } finally {
    redirect.mockRestore();
  }
}

describe('classifier_model names what scored the item', () => {
  // An operator label (WORLD_SENTIMENT_MODEL), when set, replaces the backend name: cleared for these cases.
  beforeEach(() => { vi.stubEnv('WORLD_SENTIMENT_MODEL', ''); });
  afterEach(() => { configureWorldClassify([]); vi.unstubAllEnvs(); });

  it('ingest: the model-scored row carries the backend name, the row the backend left unscored carries lexicon', async () => {
    const fake = scoringBackend();
    configureWorldClassify([fake.backend]);
    const rec = recordingService();
    const result = await ingestTopic(rec.svc);
    expect(fake.calls()).toBe(1); // one chunk, one token from the module's global classify budget
    expect(rec.archived).toMatchObject([
      { title: 'Markets climb as yields ease', classifierModel: 'swarm:test-bot', usedLlm: true },
      { title: 'Oil slips on supply news', classifierModel: 'lexicon', usedLlm: false },
    ]);
    expect(result.usedLlm).toBe(true);
  });

  it('ingest: with no backend registered every row is stamped lexicon', async () => {
    configureWorldClassify([]);
    const rec = recordingService();
    const result = await ingestTopic(rec.svc);
    expect(rec.archived).toHaveLength(2);
    for (const row of rec.archived) expect(row).toMatchObject({ classifierModel: 'lexicon', usedLlm: false });
    expect(result.usedLlm).toBe(false);
  });

  it('deep dive: markDeepened and the deep row carry the backend name for the model-scored item only', async () => {
    const fake = scoringBackend();
    configureWorldClassify([fake.backend]);
    const rec = recordingService([
      { itemHash: 'h1', title: 'Nvidia tops estimates', description: 'Revenue rose.', outlet: 'Fox News', link: 'https://news.example.com/1', pubDate: null },
      { itemHash: 'h2', title: 'Oil slips on supply news', description: 'Crude fell 2%.', outlet: 'Fox News', link: 'https://news.example.com/2', pubDate: null },
    ]);
    const result = await deepDiveFirehose(rec.svc, [{ id: 'fox-test', name: 'Fox News', url }], { budget: 5, metered: false });
    expect(result.deepened).toBe(2);
    expect(fake.calls()).toBe(1);
    expect(rec.deepened.get('h1')?.classifierModel).toBe('swarm:test-bot');
    expect(rec.deepened.get('h2')?.classifierModel).toBe('lexicon');
    // Only the model-scored item names an entity, so it alone gets a per-entity deep row.
    expect(rec.archived).toMatchObject([{ queryVariant: 'firehose-deep', classifierModel: 'swarm:test-bot', usedLlm: true }]);
  });
});
