/**
 * Personal graph reverberation (ADR-066): a person seen in BOTH calendar and gmail resolves to one
 * node carrying edges from both; handle-keyed people fold into an email-keyed canonical person;
 * email domains seed Org links. The pass is idempotent.
 * @module tests/unit/personal-graph/reverberate
 */
import { describe, it, expect } from 'vitest';
import { InMemoryGraphStore, applyFragment } from '@/features/personal-graph/graph-store';
import { ingestGoogleCalendarEvent } from '@/features/personal-graph/ingest/google-calendar-ingest';
import { ingestGmailMessage } from '@/features/personal-graph/ingest/gmail-ingest';
import { ingestGitHubRepo } from '@/features/personal-graph/ingest/github-ingest';
import { reverberate } from '@/features/personal-graph/reverberate';

describe('reverberate', () => {
  it('merges a person seen in calendar + gmail into ONE node with edges from both sources', () => {
    const store = new InMemoryGraphStore();
    // Alice is an attendee on a calendar event...
    applyFragment(
      store,
      ingestGoogleCalendarEvent({
        id: 'e1',
        summary: 'Sync',
        attendees: [{ email: 'alice@acme.com', displayName: 'Alice' }],
      }),
    );
    // ...and the sender of a gmail message.
    applyFragment(
      store,
      ingestGmailMessage({
        id: 'm1',
        payload: { headers: [{ name: 'From', value: 'Alice <alice@acme.com>' }] },
      }),
    );

    // Before reverberation the email-keyed upsert already unifies Alice (same id person:alice@acme.com).
    const alice = store.getNode('person:alice@acme.com');
    expect(alice).toBeDefined();
    expect(alice!.sources.map((s) => s.provider).sort()).toEqual(['gmail', 'google-calendar']);

    // Alice has an `attended` (calendar) edge and an `authored` (gmail) edge.
    const edges = store.neighbors('person:alice@acme.com');
    expect(edges.some((e) => e.type === 'attended')).toBe(true);
    expect(edges.some((e) => e.type === 'authored')).toBe(true);
  });

  it('folds a github handle-keyed person into an email-keyed canonical person', () => {
    const store = new InMemoryGraphStore();
    // GitHub repo owner has no email -> person:github:octocat.
    applyFragment(store, ingestGitHubRepo({ id: 1, name: 'r', full_name: 'octocat/r', owner: { login: 'octocat' } }));
    // Later we learn octocat's email via another github repo payload that includes it.
    applyFragment(
      store,
      ingestGitHubRepo({ id: 2, name: 's', full_name: 'octocat/s', owner: { login: 'octocat', email: 'rm@acme.com' } }),
    );

    const res = reverberate(store);
    expect(res.peopleMerged).toBeGreaterThanOrEqual(1);

    // The canonical person owns BOTH repos after the merge re-pointed edges.
    const owns = store.neighbors('person:rm@acme.com', { direction: 'out' }).filter((e) => e.type === 'owns');
    expect(owns.map((e) => e.to).sort()).toEqual(['repo:github:octocat/r', 'repo:github:octocat/s']);
  });

  it('derives Person->Org links from non-consumer email domains, skipping gmail.com', () => {
    const store = new InMemoryGraphStore();
    applyFragment(
      store,
      ingestGmailMessage({
        id: 'm1',
        payload: {
          headers: [
            { name: 'From', value: 'work@acme.com' },
            { name: 'To', value: 'personal@gmail.com' },
          ],
        },
      }),
    );
    reverberate(store);
    expect(store.getNode('org:acme.com')).toBeDefined();
    expect(store.getNode('org:gmail.com')).toBeUndefined();
    const orgEdges = store
      .neighbors('person:work@acme.com', { direction: 'out' })
      .filter((e) => e.type === 'related-to' && e.to === 'org:acme.com');
    expect(orgEdges).toHaveLength(1);
  });

  it('is idempotent: running twice yields the same node/edge counts', () => {
    const store = new InMemoryGraphStore();
    applyFragment(
      store,
      ingestGmailMessage({ id: 'm1', payload: { headers: [{ name: 'From', value: 'a@acme.com' }] } }),
    );
    reverberate(store);
    const nodes1 = store.allNodes().length;
    const edges1 = store.allEdges().length;
    reverberate(store);
    expect(store.allNodes().length).toBe(nodes1);
    expect(store.allEdges().length).toBe(edges1);
  });
});
