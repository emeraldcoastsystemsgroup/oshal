/**
 * Personal graph ingest SERVICE (ADR-066): the Pull->Ingest->Reverberate orchestration.
 *
 * Proves the service is decoupled and testable WITHOUT live creds: it runs over an
 * InMemoryGraphStore with injected sample item arrays.
 *  - ingestItems produces the expected node/edge counts for gmail + google-calendar.
 *  - ingestFromConnector calls the injected fetcher and ingests its result.
 *  - runIngestAndReverberate merges a person seen in BOTH gmail and calendar into ONE node
 *    (end-to-end Pull -> Ingest -> Reverberate).
 *
 * @module tests/unit/personal-graph/graph-ingest-service
 */
import { describe, it, expect, vi } from 'vitest';
import { InMemoryGraphStore } from '@/features/personal-graph/graph-store';
import {
  PROVIDER_MAPPERS,
  ingestItems,
  ingestFromConnector,
  runIngestAndReverberate,
} from '@/features/personal-graph/graph-ingest-service';

// --- sample items (the normalized shape an ADR-065 connector would yield) -----

const gcalEvent = {
  id: 'evt1',
  summary: 'Roadmap sync',
  location: 'Room 4',
  start: { dateTime: '2026-06-21T10:00:00Z' },
  end: { dateTime: '2026-06-21T11:00:00Z' },
  organizer: { email: 'Boss@Acme.com', displayName: 'Boss' },
  attendees: [
    { email: 'alice@acme.com', displayName: 'Alice' },
    { email: 'bob@acme.com' },
  ],
};

const gmailMsg = {
  id: 'm1',
  threadId: 't1',
  snippet: 'see attached',
  payload: {
    headers: [
      { name: 'Subject', value: 'Budget' },
      { name: 'From', value: 'Alice <alice@acme.com>' },
      { name: 'To', value: 'Carol <carol@acme.com>' },
      { name: 'Date', value: '2026-06-21T09:00:00Z' },
    ],
  },
};

describe('PROVIDER_MAPPERS registry', () => {
  it('exposes a mapper for each supported provider', () => {
    expect(Object.keys(PROVIDER_MAPPERS).sort()).toEqual(
      ['github', 'gmail', 'google-calendar', 'strava'].sort(),
    );
  });
});

describe('ingestItems', () => {
  it('produces expected node/edge counts for google-calendar', async () => {
    const store = new InMemoryGraphStore();
    const counts = await ingestItems(store, 'google-calendar', [gcalEvent]);
    // Event + 3 people (boss, alice, bob) + place = 5 nodes; organized + 2 attended + located-at = 4 edges.
    expect(counts).toEqual({ items: 1, nodes: 5, edges: 4 });
    expect(store.nodesByType('Event')).toHaveLength(1);
    expect(store.nodesByType('Person')).toHaveLength(3);
    expect(store.nodesByType('Place')).toHaveLength(1);
    expect(store.allEdges()).toHaveLength(4);
  });

  it('produces expected node/edge counts for gmail', async () => {
    const store = new InMemoryGraphStore();
    const counts = await ingestItems(store, 'gmail', [gmailMsg]);
    // Message + alice (From) + carol (To) = 3 nodes; authored + mentions = 2 edges.
    expect(counts).toEqual({ items: 1, nodes: 3, edges: 2 });
    expect(store.nodesByType('Message')).toHaveLength(1);
    expect(store.nodesByType('Person')).toHaveLength(2);
  });

  it('is idempotent: re-ingesting the same items does not duplicate', async () => {
    const store = new InMemoryGraphStore();
    await ingestItems(store, 'gmail', [gmailMsg]);
    await ingestItems(store, 'gmail', [gmailMsg]);
    expect(store.nodesByType('Message')).toHaveLength(1);
    expect(store.nodesByType('Person')).toHaveLength(2);
  });

  it('throws a clear error for an unknown provider', async () => {
    const store = new InMemoryGraphStore();
    await expect(ingestItems(store, 'nope' as any, [])).rejects.toThrow(/no ingest mapper/);
  });
});

describe('ingestFromConnector', () => {
  it('calls the injected fetcher and ingests its result', async () => {
    const store = new InMemoryGraphStore();
    const fetchItems = vi.fn(async () => [gcalEvent]);
    const counts = await ingestFromConnector(store, 'google-calendar', fetchItems);
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(counts.items).toBe(1);
    expect(store.nodesByType('Event')).toHaveLength(1);
  });
});

describe('runIngestAndReverberate (end-to-end Pull -> Ingest -> Reverberate)', () => {
  it('merges a person appearing in BOTH gmail and calendar into one node', async () => {
    const store = new InMemoryGraphStore();
    const result = await runIngestAndReverberate(store, [
      { provider: 'gmail', fetchItems: async () => [gmailMsg] },
      { provider: 'google-calendar', fetchItems: async () => [gcalEvent] },
    ]);

    // alice@acme.com is the sender in gmail AND an attendee on the calendar event:
    // a single email-keyed Person node, carrying sources from BOTH providers.
    const alice = store.getNode('person:alice@acme.com');
    expect(alice).toBeDefined();
    const providers = alice!.sources.map((s) => s.provider).sort();
    expect(providers).toContain('gmail');
    expect(providers).toContain('google-calendar');

    // People present: boss, alice, bob (calendar) + carol (gmail) = 4 distinct.
    expect(store.nodesByType('Person')).toHaveLength(4);

    // Reverberation derived the acme.com Org from email domains and linked people to it.
    expect(store.getNode('org:acme.com')).toBeDefined();
    expect(result.reverberate.orgsCreated).toBeGreaterThanOrEqual(1);
    expect(result.reverberate.orgLinks).toBeGreaterThanOrEqual(1);

    // Per-job + total counts are reported.
    expect(result.jobs.map((j) => j.provider).sort()).toEqual(['gmail', 'google-calendar']);
    expect(result.totals.items).toBe(2);
  });
});
