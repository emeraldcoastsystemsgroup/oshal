/**
 * Personal graph ingest mappers (ADR-066): each (rawItem) => fragment yields expected nodes/edges
 * and is idempotent under re-ingest into a store.
 * @module tests/unit/personal-graph/ingest
 */
import { describe, it, expect } from 'vitest';
import { InMemoryGraphStore, applyFragment } from '@/features/personal-graph/graph-store';
import { ingestGoogleCalendarEvent } from '@/features/personal-graph/ingest/google-calendar-ingest';
import { ingestGmailMessage } from '@/features/personal-graph/ingest/gmail-ingest';
import { ingestGitHubRepo } from '@/features/personal-graph/ingest/github-ingest';
import { ingestStravaActivity } from '@/features/personal-graph/ingest/strava-ingest';

describe('google-calendar ingest', () => {
  const event = {
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

  it('produces Event + Person + Place nodes and attended/organized/located-at edges', () => {
    const frag = ingestGoogleCalendarEvent(event);
    const types = frag.nodes.map((n) => n.type).sort();
    expect(types).toEqual(['Event', 'Person', 'Person', 'Person', 'Place'].sort());
    const edgeTypes = frag.edges.map((e) => e.type).sort();
    expect(edgeTypes).toEqual(['attended', 'attended', 'located-at', 'organized'].sort());
    // organizer email normalized in the person id
    expect(frag.nodes.some((n) => n.id === 'person:boss@acme.com')).toBe(true);
    expect(frag.nodes.some((n) => n.id === 'event:google-calendar:evt1')).toBe(true);
  });

  it('is idempotent when re-ingested into a store', () => {
    const store = new InMemoryGraphStore();
    applyFragment(store, ingestGoogleCalendarEvent(event));
    applyFragment(store, ingestGoogleCalendarEvent(event));
    expect(store.nodesByType('Event')).toHaveLength(1);
    expect(store.nodesByType('Person')).toHaveLength(3);
    expect(store.allEdges()).toHaveLength(4);
  });
});

describe('gmail ingest', () => {
  const msg = {
    id: 'm1',
    threadId: 't1',
    snippet: 'see attached',
    payload: {
      headers: [
        { name: 'Subject', value: 'Budget' },
        { name: 'From', value: 'Alice <alice@acme.com>' },
        { name: 'To', value: 'Bob <bob@acme.com>, carol@acme.com' },
        { name: 'Date', value: '2026-06-21T09:00:00Z' },
      ],
    },
  };

  it('produces a Message node, authored from sender, mentions for recipients', () => {
    const frag = ingestGmailMessage(msg);
    expect(frag.nodes.some((n) => n.type === 'Message' && n.id === 'message:gmail:m1')).toBe(true);
    const authored = frag.edges.filter((e) => e.type === 'authored');
    const mentions = frag.edges.filter((e) => e.type === 'mentions');
    expect(authored).toHaveLength(1);
    expect(authored[0].from).toBe('person:alice@acme.com');
    expect(mentions).toHaveLength(2);
  });

  it('is idempotent when re-ingested', () => {
    const store = new InMemoryGraphStore();
    applyFragment(store, ingestGmailMessage(msg));
    applyFragment(store, ingestGmailMessage(msg));
    expect(store.nodesByType('Message')).toHaveLength(1);
    expect(store.nodesByType('Person')).toHaveLength(3); // alice, bob, carol
  });
});

describe('github ingest', () => {
  const repo = {
    id: 7,
    name: 'oshal',
    full_name: 'octocat/oshal',
    private: true,
    html_url: 'https://github.com/octocat/oshal',
    language: 'TypeScript',
    owner: { login: 'octocat' },
  };

  it('produces a Repo node owned by a (handle-keyed) Person', () => {
    const frag = ingestGitHubRepo(repo);
    expect(frag.nodes.some((n) => n.type === 'Repo' && n.id === 'repo:github:octocat/oshal')).toBe(true);
    expect(frag.nodes.some((n) => n.id === 'person:github:octocat')).toBe(true);
    expect(frag.edges.some((e) => e.type === 'owns')).toBe(true);
    expect(frag.edges.some((e) => e.type === 'authored')).toBe(true);
  });

  it('keys the owner by email when present', () => {
    const frag = ingestGitHubRepo({ ...repo, owner: { login: 'octocat', email: 'rm@acme.com' } });
    expect(frag.nodes.some((n) => n.id === 'person:rm@acme.com')).toBe(true);
  });
});

describe('strava ingest', () => {
  const activity = {
    id: 99,
    name: 'Morning Run',
    type: 'Run',
    start_date: '2026-06-21T06:00:00Z',
    distance: 5000,
    moving_time: 1800,
    start_latlng: [30.4, -86.6] as [number, number],
    athlete: { id: 123 },
  };

  it('produces an Activity node located-at a Place with participated-in by athlete', () => {
    const frag = ingestStravaActivity(activity, undefined, { email: 'me@acme.com', name: 'Me' });
    expect(frag.nodes.some((n) => n.type === 'Activity' && n.id === 'activity:strava:99')).toBe(true);
    expect(frag.nodes.some((n) => n.type === 'Place')).toBe(true);
    expect(frag.edges.some((e) => e.type === 'located-at')).toBe(true);
    const part = frag.edges.find((e) => e.type === 'participated-in');
    expect(part?.from).toBe('person:me@acme.com');
  });

  it('falls back to a strava-handle person when no owner email is given', () => {
    const frag = ingestStravaActivity(activity);
    expect(frag.nodes.some((n) => n.id === 'person:strava:123')).toBe(true);
  });
});
