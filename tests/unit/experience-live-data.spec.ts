/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the experience adapter's joins and Jarvis ask flow headlessly: catalog authority order, suite grouping, work merging, summary caps, identity derivation, session roll on a refused thread, poll-to-terminal states and honest source reporting when a read fails.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | `related` is a group's installed required members from the plan, no longer the plan's integrationSources (a plain app relates to nothing through them)
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Integration review: localHref keeps a same-origin path and refuses every link the browser would resolve off the page origin (tab-split, backslash, protocol-relative, absolute, non-string); the poll-limit ask result carries code 'poll_limit'.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | speak(): a readback stopped before the swarm's synthesize answer arrives never creates an Audio element or a browser utterance; the browser engine reports progress from its boundary index, and swarm audio from its time over its duration.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Fix round 1: dot-segment links that normalise to a '//' pathname ('/..//outside.example/x', '/.//…', '/%2e%2e//…', '/api/..//…') are refused, a same-origin dot segment is kept normalised and every kept path re-resolves to the page origin; an admitted workspace href that would leave the origin (dot-segment, absolute, non-string) falls back to the cockpit link.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Prove malformed successful overview cannot supply derived facts and its unavailable provenance agrees with visible source refusal.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Prove admitted personal overview fields survive intentional roster omission while malformed and failed reads retain unknown readiness and valid companion work.
 * 8 | maintainer@emeraldcoastsystemsgroup.com | Preserve the auth-state issuer independently of display claims, including explicit unknown provenance and guest namespaces.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The adapter is a classic browser script with a CommonJS export seam; load the shipped file itself.
const LIVE = require('../../src/experience/live-data.js') as typeof import('../../src/experience/live-data.js') & Record<string, any>;

type Reply = { status: number; body?: unknown };
/** @description A fetch double keyed by method + path prefix, recording every call. */
function fakeFetch(routes: Record<string, Reply | ((call: { method: string; url: string; body: any }) => Reply)>) {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = String(init.method || 'GET');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, url, body }; calls.push(call);
    const key = Object.keys(routes).find(k => `${method} ${url}`.startsWith(k));
    const reply = key ? (typeof routes[key] === 'function' ? (routes[key] as any)(call) : routes[key]) : { status: 404, body: { error: 'missing' } };
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => { if (reply.body === undefined) throw new Error('no body'); return reply.body; } } as Response;
  };
  return { fetch, calls };
}
function memoryStorage(seed: Record<string, string> = {}) { const map = new Map(Object.entries(seed)); return { getItem: (k: string) => map.has(k) ? map.get(k)! : null, setItem: (k: string, v: string) => { map.set(k, v); }, map }; }

describe('experience adapter: pure joins', () => {
  it('folds raw statuses into the shell vocabulary and keeps unknown ones readable', () => {
    expect(LIVE.statusOf('in_process')).toMatchObject({ label: 'Working', tone: 'neutral', open: true });
    expect(LIVE.statusOf('complete')).toMatchObject({ label: 'Ready', tone: 'good', open: false });
    expect(LIVE.statusOf('pending_approval')).toMatchObject({ label: 'Review', tone: 'warn', open: true });
    expect(LIVE.statusOf('error').open).toBe(false);
    expect(LIVE.statusOf('needs_owner_review').label).toBe('Needs owner review');
  });

  it('derives the display name from the account handle, never the whole address, and reports guests', () => {
    expect(LIVE.deriveIdentity({ authenticated: true, mode: 'oidc', user: { sub: 's', email: 'pat.lee@example.test', preferred_username: 'pat.lee@example.test' } })).toMatchObject({ name: 'pat.lee', initials: 'PL', email: 'pat.lee@example.test' });
    expect(LIVE.deriveIdentity({ authenticated: true, user: { sub: 's', name: 'Pat Lee', email: 'x@y.z' } }).name).toBe('Pat Lee');
    expect(LIVE.deriveIdentity({ authenticated: false, mode: 'oidc', user: null })).toMatchObject({ authenticated: false, name: 'Guest' });
    expect(LIVE.deriveIdentity(null).authenticated).toBe(false);
  });

  it('uses the authoritative auth-state issuer before conflicting display claims and keeps issuer twins distinct', () => {
    const payload = { authenticated: true, mode: 'oidc', user: { sub: 'same-subject', name: 'Fixture display', iss: 'https://display.fixture.test', issuer: 'https://alternate.fixture.test' } };
    const first = LIVE.deriveIdentity({ ...payload, principalIssuer: 'https://first.fixture.test' });
    const second = LIVE.deriveIdentity({ ...payload, principalIssuer: 'https://second.fixture.test' });
    expect(first).toMatchObject({ authenticated: true, sub: 'same-subject', name: 'Fixture display', issuer: 'https://first.fixture.test' });
    expect(second).toMatchObject({ authenticated: true, sub: 'same-subject', issuer: 'https://second.fixture.test' });
    expect(first.issuer).not.toBe(second.issuer);
    expect(LIVE.deriveIdentity({ authenticated: true, principalIssuer: 'https://first.fixture.test', user: { sub: 'same-subject' } }).issuer).toBe('https://first.fixture.test');
  });

  it('keeps an explicitly unknown server issuer empty while retaining older responses without that field', () => {
    const payload = { authenticated: true, user: { sub: 'same-subject', iss: 'https://display.fixture.test' } };
    expect(LIVE.deriveIdentity({ ...payload, principalIssuer: null }).issuer).toBe('');
    expect(LIVE.deriveIdentity({ ...payload, principalIssuer: '' }).issuer).toBe('');
    expect(LIVE.deriveIdentity(payload).issuer).toBe('https://display.fixture.test');
    expect(LIVE.deriveIdentity({ authenticated: true, user: { sub: 'same-subject', issuer: 'https://older.fixture.test' } }).issuer).toBe('https://older.fixture.test');
  });

  it('retains the exact guest namespace and does not derive an identity from an unauthenticated guest receipt', () => {
    const guest = { authenticated: true, mode: 'guest', guestMode: true, principalIssuer: 'urn:oshal:guest', user: { sub: 'guest:fixture-one', name: 'Guest' } };
    expect(LIVE.deriveIdentity(guest)).toMatchObject({ authenticated: true, sub: 'guest:fixture-one', issuer: 'urn:oshal:guest', guest: true });
    expect(LIVE.deriveIdentity({ ...guest, authenticated: false })).toMatchObject({ authenticated: false, sub: '', issuer: '', guest: true });
  });

  it('lets the authorized plan lead the catalog, keeps unadmitted apps visible as unavailable, and derives relationships', () => {
    const apps = LIVE.mergeApps({
      plan: [{ name: 'a', displayName: 'A', suite: 'ai-home', firstSurfaceUrl: '/api/a/', summary: [{ app: 'a', path: '/api/a/home-summary' }], todos: [], integrationSources: [{ app: 'b' }, { app: 'a' }] },
        { name: 'g', displayName: 'G', kind: 'group', suite: 'ai-home', members: ['b', 'c', 'b'], summary: [], todos: [], integrationSources: [{ app: 'b' }, { app: 'c' }] }],
      apps: [{ name: 'a', displayName: 'Listing A', description: 'from listing', version: '1.2.3', suite: 'ai-home', botCount: 2, ticketType: 'A-Type' }, { name: 'b', displayName: 'B', suite: null }],
      workspaces: [{ name: 'a', href: '/cockpit/?app=a', theme: 'ocean' }],
    });
    expect(apps.map((x: any) => x.id)).toEqual(['a', 'b', 'g']);
    // integrationSources list surfaces and outbound offers, not a dependency: a plain app relates to nothing, a group to its installed required members.
    expect(apps[0]).toMatchObject({ name: 'A', description: 'from listing', version: '1.2.3', navigable: true, inPlan: true, theme: 'ocean', ticketType: 'a-type', botCount: 2, related: [] });
    expect(apps[1]).toMatchObject({ suite: 'platform', navigable: false, inPlan: false, href: '/cockpit/?app=b', related: [] });
    expect(apps[2]).toMatchObject({ kind: 'group', related: ['b', 'c'] });
  });

  it('keeps an admitted navigation href only when it stays on this origin, otherwise opens the cockpit link', () => {
    const apps = LIVE.mergeApps({
      plan: [{ name: 'a', displayName: 'A', suite: 'ai-home', summary: [], todos: [] }, { name: 'b', displayName: 'B', suite: 'ai-home', summary: [], todos: [] },
        { name: 'c', displayName: 'C', suite: 'ai-home', summary: [], todos: [] }, { name: 'd', displayName: 'D', suite: 'ai-home', summary: [], todos: [] }],
      apps: [],
      workspaces: [{ name: 'a', href: '/cockpit/?app=a&tab=x' }, { name: 'b', href: '/..//outside.example/x' }, { name: 'c', href: 'https://outside.example/y' }, { name: 'd', href: 42 }],
    });
    expect(apps.map((x: any) => [x.id, x.href, x.navigable])).toEqual([
      ['a', '/cockpit/?app=a&tab=x', true], ['b', '/cockpit/?app=b', true], ['c', '/cockpit/?app=c', true], ['d', '/cockpit/?app=d', true]]);
  });

  it('always lists the six canonical suites and adds Platform only when populated', () => {
    const none = LIVE.buildSuites([]);
    expect(none.map((s: any) => s.id)).toEqual(['ai-finance', 'ai-engineering', 'ai-creative', 'ai-productivity', 'ai-home', 'ai-knowledge']);
    const withPlatform = LIVE.buildSuites([{ id: 'p', name: 'P', suite: 'platform', probes: [], navigable: false }, { id: 'f2', name: 'F2', suite: 'ai-finance', probes: [], navigable: true }, { id: 'f1', name: 'F1', suite: 'ai-finance', probes: [{}], navigable: true }]);
    expect(withPlatform.map((s: any) => s.id)).toContain('platform');
    expect(withPlatform.find((s: any) => s.id === 'ai-finance')).toMatchObject({ count: 2, spotlight: { id: 'f1' } });
  });

  it('merges tickets and tasks newest first and attributes them to applications', () => {
    const apps = [{ id: 'ledger', name: 'Ledger', ticketType: 'ledger-review', probes: [] }];
    const work = LIVE.mergeWork({
      tickets: [{ ticketId: 't1', title: 'Old', status: 'complete', ticketType: 'ledger-review', updatedAt: '2026-01-01T00:00:00Z' }],
      tasks: [{ id: 'k1', title: 'Ledger: weekly picture', status: 'done', kind: 'simple', createdAt: '2026-02-01T00:00:00Z', result: 'text', files: [{ name: 'a', downloadUrl: '/api/x' }] }, { id: 'k2', title: 'Unrelated', status: 'error', createdAt: '2026-03-01T00:00:00Z', error: 'boom' }],
    }, apps);
    expect(work.map((w: any) => w.id)).toEqual(['task:k2', 'task:k1', 'ticket:t1']);
    expect(work[1]).toMatchObject({ app: 'ledger', appName: 'Ledger', href: '/api/jarvis/', files: [{ name: 'a' }] });
    expect(work[2]).toMatchObject({ app: 'ledger', href: '/cockpit/?ticket=t1', status: { label: 'Ready' } });
    expect(work[0]).toMatchObject({ appName: 'Jarvis', status: { label: 'Failed' } });
  });

  it('applies the Home view caps to a package summary and distinguishes missing pointers', () => {
    const body = { tiles: [{ label: 'A label that is far too long for a tile', value: 'V'.repeat(30), tone: 'good' }, { label: 'x' }], items: Array.from({ length: 7 }, (_, i) => ({ text: `item ${i}`, detail: 'd', tone: 'warn', fix: 'surface' })), partial: true };
    const s = LIVE.normalizeSummary(body, { tilesPointer: '/tiles', itemsPointer: '/items' });
    expect(s.tiles).toEqual([{ label: 'A label that is far too long for a tile'.slice(0, 24), value: 'V'.repeat(16), tone: 'good' }]);
    expect(s.items).toHaveLength(5); expect(s.items[0]).toMatchObject({ tone: 'warn', fix: 'surface', highlight: false }); expect(s.partial).toBe(true);
    expect(LIVE.atPointer({ a: { b: null } }, '/a/b')).toEqual({ found: true, value: null });
    expect(LIVE.atPointer({ a: {} }, '/a/b').found).toBe(false);
    expect(LIVE.atPointer({}, 'tiles').found).toBe(false);
  });

  it('keeps only links that stay on the page origin, resolved the way the browser resolves an href', () => {
    const origin = 'https://oshal.test';
    expect(LIVE.localHref('/cockpit/?app=ledger#x', origin)).toBe('/cockpit/?app=ledger#x');
    expect(LIVE.localHref('/api/jarvis/files/synthetic', origin)).toBe('/api/jarvis/files/synthetic');
    // The browser strips tab/CR/LF and reads a backslash as a slash before resolving, so each of these lands on another host.
    const hostile: unknown[] = ['/\t/host/x', '/\\host', '//host/x', 'https://x', '/\n/host/y', '/\r//host/z', ' /cockpit/', 'cockpit/', '', null, undefined, 42, { href: '/x' }];
    for (const u of hostile) expect(LIVE.localHref(u, origin), JSON.stringify(u)).toBe('');
    // Dot segments normalise each of these to a pathname that starts with '//': returned as-is it would be a protocol-relative link to outside.example.
    const dotted = ['/..//outside.example/x', '/.//outside.example/x', '/%2e%2e//outside.example/x', '/%2E//outside.example/x', '/api/..//outside.example/x', '/.\\/outside.example/x', '/\t..//outside.example/x'];
    for (const u of dotted) expect(LIVE.localHref(u, origin), JSON.stringify(u)).toBe('');
    // A dot segment that stays on the origin is kept, normalised, and what comes back resolves to the page origin itself.
    expect(LIVE.localHref('/api/../cockpit/?app=a', origin)).toBe('/cockpit/?app=a');
    for (const u of ['/cockpit/?app=ledger#x', '/api/../cockpit/?app=a', '/a/./b']) expect(new URL(LIVE.localHref(u, origin), origin).origin).toBe(origin);
    // Without a page (node), the check still runs against a fixed placeholder origin.
    expect(LIVE.localHref('/cockpit/?app=a')).toBe('/cockpit/?app=a');
    expect(LIVE.localHref('/\\host')).toBe('');
  });

  it('formats relative time from the caller clock', () => {
    const now = new Date('2026-09-26T12:00:00Z');
    expect(LIVE.relativeTime(new Date('2026-09-26T11:59:40Z'), now)).toBe('just now');
    expect(LIVE.relativeTime(new Date('2026-09-26T11:20:00Z'), now)).toBe('40 min ago');
    expect(LIVE.relativeTime(new Date('2026-09-26T03:00:00Z'), now)).toBe('9 h ago');
    expect(LIVE.relativeTime(new Date('2026-09-23T12:00:00Z'), now)).toBe('3 d ago');
    expect(LIVE.relativeTime(null, now)).toBe('');
  });
});

describe('experience adapter: client over an injected fetch', () => {
  const okJson = (body: unknown) => ({ status: 200, body });
  const baseRoutes = {
    'GET /api/auth/user': okJson({ authenticated: true, mode: 'mock', user: { sub: 'u1', email: 'u1@fixture.test' } }),
    'GET /api/swarm/apps/home-plan': okJson({ apps: [{ name: 'a', displayName: 'A', suite: 'ai-home', firstSurfaceUrl: '/api/a/', summary: [{ app: 'a', path: '/api/a/home-summary', tilesPointer: '/tiles', itemsPointer: '/items' }], todos: [] }] }),
    'GET /api/swarm/apps?status=active': okJson({ apps: [{ name: 'a', displayName: 'A', suite: 'ai-home' }] }),
    'GET /api/ui/workspaces': okJson({ workspaces: [{ name: 'a', href: '/cockpit/?app=a' }] }),
    'GET /api/jarvis/tasks': okJson({ tasks: [] }),
    'GET /api/tickets': okJson({ tickets: [] }),
    'GET /api/jarvis/overview': { status: 503, body: { error: 'down' } },
    'GET /api/a/home-summary': okJson({ tiles: [{ label: 'T', value: '1' }], items: [{ text: 'hello' }] }),
  };

  it('loads the snapshot in one pass and names the sources that did not answer', async () => {
    const { fetch, calls } = fakeFetch(baseRoutes);
    const client = LIVE.createClient({ fetch, storage: memoryStorage() });
    const snap = await client.load();
    expect(snap.me).toMatchObject({ authenticated: true, name: 'u1' });
    expect(snap.apps).toHaveLength(1); expect(snap.suites).toHaveLength(6);
    expect(snap.unavailable).toEqual(['overview']); expect(snap.bots).toEqual([]); expect(snap.botsOnline).toBe(0);
    expect(calls.map(c => c.url)).toContain('/api/tickets?limit=100');
    const summary = await client.probeSummary(snap.apps[0]);
    expect(summary).toMatchObject({ ok: true, tiles: [{ label: 'T', value: '1' }], items: [{ text: 'hello' }] });
    const before = calls.length; await client.probeSummary(snap.apps[0]); expect(calls.length).toBe(before);
    expect(await client.probeSummary({ id: 'none', probes: [] })).toMatchObject({ none: true, ok: false });
  });

  it('withholds every derived fact from a malformed overview and names the unavailable source despite HTTP200', async () => {
    const { fetch } = fakeFetch({ ...baseRoutes,
      'GET /api/jarvis/tasks': okJson({ tasks: [{ id: 'kept', title: 'Admitted companion task', status: 'running' }] }),
      'GET /api/jarvis/overview': okJson({ bots: [{ id: 'wrong-family', online: true }], activity: { openCount: 99 }, comms: { digest: 'Unqualified digest' }, calendar: { events: [{ title: 'Unqualified calendar event' }] } }),
    });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.work.map((row: { ref: string }) => row.ref)).toEqual(['kept']);
    expect(snap.sources.overview).toBe(200);
    expect(snap.sourceValidity.overview).toBe(false);
    expect(snap.unavailable).toEqual(['overview']);
    expect(LIVE.sourceState(snap, ['overview'])).toMatchObject({ complete: false, kind: 'unavailable', message: 'Assistant status could not be loaded.', detail: 'Assistant status returned an unreadable response.' });
    expect(snap.bots).toEqual([]); expect(snap.botsOnline).toBe(0);
    expect(snap.calendarEvents).toEqual([]); expect(snap.comms).toBeNull();
    expect(snap.openTickets).toBe(0);
  });

  const personalFields = () => ({
    comms: { digest: { summary: 'Caller digest', updatedAt: '2026-10-04T09:00:00.000Z' }, signals: [{ from: 'Personal contact', subject: 'Caller subject', snippet: null, at: '2026-10-04T09:00:00.000Z' }] },
    activity: { tickets: [{ id: 'caller-ticket', title: 'Caller activity', status: 'pending_approval' }], openCount: 1 },
    calendar: { events: [{ title: '<b>Caller calendar</b>', when: '2026-10-05T10:00:00.000Z' }] },
  });

  it('retains caller-bound fields when the successful overview intentionally omits the global roster', async () => {
    const body = personalFields(), { fetch, calls } = fakeFetch({ ...baseRoutes, 'GET /api/jarvis/overview': okJson(body) });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.comms).toEqual(body.comms); expect(snap.calendarEvents).toEqual(body.calendar.events); expect(snap.openTickets).toBe(1);
    expect(snap.bots).toEqual([]); expect(snap.sourceValidity).toMatchObject({ overview: false, overviewCalendar: true, overviewComms: true });
    expect(snap.overviewRosterOmitted).toBe(true); expect(snap.unavailable).toEqual(['overview']);
    expect(LIVE.sourceState(snap, ['overview'])).toMatchObject({ complete: false, kind: 'unavailable', message: 'Assistant status is not provided to this session.', detail: 'Global assistant status is not provided to this session.' });
    expect(LIVE.sourceState(snap, ['overviewCalendar'])).toMatchObject({ complete: true, kind: 'ready' });
    expect(LIVE.sourceState(snap, ['overviewComms'])).toMatchObject({ complete: true, kind: 'ready' });
    expect(calls.filter(c => c.url === '/api/jarvis/overview')).toHaveLength(1);
  });

  it('keeps genuine empty personal fields readable without converting an omitted roster into a successful zero', async () => {
    const { fetch } = fakeFetch({ ...baseRoutes, 'GET /api/jarvis/overview': okJson({ comms: { digest: null, signals: [] }, activity: { tickets: [], openCount: 0 }, calendar: { events: [] } }) });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.comms).toEqual({ digest: null, signals: [] }); expect(snap.calendarEvents).toEqual([]);
    expect(LIVE.sourceState(snap, ['overviewCalendar']).complete).toBe(true);
    expect(LIVE.sourceState(snap, ['overviewComms']).complete).toBe(true);
    expect(LIVE.sourceState(snap, ['overview']).complete).toBe(false);
  });

  it.each([{ bots: [] }, { bots: [{ agentId: 'operator-bot', online: true }] }])('preserves a readable operator roster and personal fields: %j', async ({ bots }) => {
    const body = { ...personalFields(), bots }, { fetch } = fakeFetch({ ...baseRoutes, 'GET /api/jarvis/overview': okJson(body) });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.bots).toEqual(bots); expect(snap.botsOnline).toBe(bots.length); expect(snap.overviewRosterOmitted).toBe(false);
    expect(snap.calendarEvents).toEqual(body.calendar.events); expect(snap.comms).toEqual(body.comms);
    expect(LIVE.sourceState(snap, ['overview']).complete).toBe(true);
  });

  it('retains readable calendar rows but qualifies a malformed sibling and an independently malformed communications field', async () => {
    const body = personalFields();
    const { fetch } = fakeFetch({ ...baseRoutes, 'GET /api/jarvis/overview': okJson({ ...body, comms: { digest: 'wrong family', signals: [] }, calendar: { events: [...body.calendar.events, { title: 'Undated phantom', when: 'not-a-date' }] } }) });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.calendarEvents).toEqual(body.calendar.events); expect(snap.comms).toBeNull(); expect(snap.openTickets).toBe(1);
    expect(LIVE.sourceState(snap, ['overviewCalendar'])).toMatchObject({ complete: false, kind: 'partial', message: 'Only readable calendar events are shown.' });
    expect(LIVE.sourceState(snap, ['overviewComms'])).toMatchObject({ complete: false, kind: 'unavailable', detail: 'Communications returned an unreadable response.' });
  });

  it('does not claim an empty calendar or invalid activity count when only companion fields are readable', async () => {
    const { fetch } = fakeFetch({ ...baseRoutes, 'GET /api/tickets': okJson({ tickets: [{ ticketId: 'kept-ticket', title: 'Admitted ticket', status: 'pending_approval' }] }),
      'GET /api/jarvis/overview': okJson({ ...personalFields(), activity: { tickets: [], openCount: -1 }, calendar: { events: [{ title: 'Missing date' }] } }),
    });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.work.map((row: { ref: string }) => row.ref)).toEqual(['kept-ticket']); expect(snap.openTickets).toBe(1);
    expect(snap.calendarEvents).toEqual([]); expect(snap.comms).not.toBeNull();
    expect(LIVE.sourceState(snap, ['overviewCalendar'])).toMatchObject({ complete: false, kind: 'unavailable', message: 'Calendar could not be loaded.' });
  });

  it.each([{ bots: null }, { bots: [{ agentId: 'invalid-online', online: 'yes' }] }])('refuses all derived facts for an explicitly malformed roster: %j', async ({ bots }) => {
    const { fetch } = fakeFetch({ ...baseRoutes, 'GET /api/jarvis/tasks': okJson({ tasks: [{ id: 'kept', title: 'Admitted companion task', status: 'running' }] }), 'GET /api/jarvis/overview': okJson({ ...personalFields(), bots }) });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.work.map((row: { ref: string }) => row.ref)).toEqual(['kept']);
    expect(snap.bots).toEqual([]); expect(snap.comms).toBeNull(); expect(snap.calendarEvents).toEqual([]); expect(snap.openTickets).toBe(0);
    expect(snap.overviewRosterOmitted).toBe(false); expect(snap.sourceValidity).toMatchObject({ overview: false, overviewCalendar: false, overviewComms: false });
  });

  it.each([{ status: 503, body: personalFields() }, { status: 403, body: personalFields() }, { status: 200, body: null }, { status: 200, body: [] }, { status: 200 }])('withholds personal fields from a failed or unreadable HTTP receipt: %j', async reply => {
    const { fetch } = fakeFetch({ ...baseRoutes, 'GET /api/jarvis/overview': reply });
    const snap = await LIVE.createClient({ fetch, storage: memoryStorage() }).load();
    expect(snap.comms).toBeNull(); expect(snap.calendarEvents).toEqual([]); expect(snap.openTickets).toBe(0);
    expect(snap.overviewRosterOmitted).toBe(false); expect(snap.sourceValidity.overviewCalendar).toBe(false);
    expect(LIVE.sourceState(snap, ['overviewCalendar']).complete).toBe(false);
    expect(LIVE.sourceState(snap, ['overviewComms']).complete).toBe(false);
  });

  it('paints in two phases: identity and catalog first, then work merged into the same snapshot arrays', async () => {
    const { fetch, calls } = fakeFetch({ ...baseRoutes, 'GET /api/tickets': okJson({ tickets: [{ ticketId: 't1', title: 'Open ticket', status: 'in_process', ticketType: 'x', updatedAt: new Date().toISOString() }] }), 'GET /api/ui/profile?name=little-monsters': okJson({ profile: { ribbon: { items: [{ id: 'tool-lm-dashboard' }] } } }) });
    const client = LIVE.createClient({ fetch, storage: memoryStorage() });
    const core = await client.loadCore();
    expect(core.apps).toHaveLength(1); expect(core.work).toEqual([]); expect(core.workLoaded).toBe(false); expect(core.unavailable).toEqual([]);
    expect(calls.map(c => c.url)).not.toContain('/api/tickets?limit=100');
    const workRef = core.work;
    const full = await client.loadWork(core);
    expect(full).toBe(core); expect(core.work).toBe(workRef); expect(core.work).toHaveLength(1); expect(core.workLoaded).toBe(true); expect(core.unavailable).toEqual(['overview']);
    expect(calls.map(c => c.url)).toContain('/api/tickets?limit=100');
    const profile = await client.packages.profile('little-monsters');
    expect(profile.ok).toBe(true); expect(profile.body.profile.ribbon.items[0].id).toBe('tool-lm-dashboard');
  });

  it('asks Jarvis on the stored thread, polls to done, and reports the answer shape the page renders', async () => {
    let polls = 0;
    const { fetch, calls } = fakeFetch({
      'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j1' } },
      'GET /api/jarvis/ask/result?jobId=j1': () => (++polls < 3 ? okJson({ status: 'pending' }) : okJson({ status: 'done', answer: 'Hi', handoffs: [{ name: 'A', deepLink: '/cockpit/?app=a' }], taskId: 't' })),
    });
    const storage = memoryStorage({ jarvisSessionId: 'jarvis-existing' });
    const client = LIVE.createClient({ fetch, storage });
    const phases: string[] = [];
    const result = await client.ask('  hello ', { sleep: async () => {}, onPhase: (p: any) => phases.push(p.phase) });
    expect(result).toMatchObject({ status: 'done', answer: 'Hi', handoffs: [{ deepLink: '/cockpit/?app=a' }], jobId: 'j1', taskId: 't', sessionId: 'jarvis-existing' });
    expect(calls[0].body).toEqual({ message: 'hello', sessionId: 'jarvis-existing' });
    expect(phases.slice(0, 2)).toEqual(['sending', 'accepted']); expect(phases).toContain('waiting');
  });

  it('rolls to a fresh thread once when the persisted one is refused, and keeps an explicit room thread as is', async () => {
    const asks: string[] = [];
    const { fetch } = fakeFetch({
      'POST /api/jarvis/ask': (call) => { asks.push(call.body.sessionId); return ['jarvis-stale', 'jarvis-room-r'].includes(call.body.sessionId) ? { status: 404, body: { error: 'session_not_found' } } : { status: 202, body: { jobId: 'j2' } }; },
      'GET /api/jarvis/ask/result?jobId=j2': okJson({ status: 'done', answer: 'ok' }),
    });
    const storage = memoryStorage({ jarvisSessionId: 'jarvis-stale' });
    const client = LIVE.createClient({ fetch, storage });
    const result = await client.ask('x', { sleep: async () => {} });
    expect(result.status).toBe('done'); expect(asks).toHaveLength(2); expect(asks[0]).toBe('jarvis-stale'); expect(asks[1]).not.toBe('jarvis-stale');
    expect(storage.map.get('jarvisSessionId')).toBe(asks[1]);
    const explicit = await client.ask('x', { sessionId: 'jarvis-room-r', sleep: async () => {} });
    expect(explicit).toMatchObject({ status: 'error', httpStatus: 404, sessionId: 'jarvis-room-r' }); expect(asks).toHaveLength(3); expect(asks[2]).toBe('jarvis-room-r');
  });

  it('surfaces refusals, expiry and job errors as error results instead of pretending', async () => {
    const { fetch } = fakeFetch({ 'POST /api/jarvis/ask': { status: 503, body: { message: 'No hosted brain is configured' } } });
    expect(await LIVE.createClient({ fetch, storage: memoryStorage() }).ask('x')).toMatchObject({ status: 'error', error: 'No hosted brain is configured', httpStatus: 503 });
    const expired = fakeFetch({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j' } }, 'GET /api/jarvis/ask/result?jobId=j': okJson({ status: 'expired' }) });
    expect(await LIVE.createClient({ fetch: expired.fetch, storage: memoryStorage() }).ask('x', { sleep: async () => {} })).toMatchObject({ status: 'error', error: expect.stringContaining('expired') });
    const failed = fakeFetch({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j' } }, 'GET /api/jarvis/ask/result?jobId=j': okJson({ status: 'error', error: 'tool blew up', code: 'X' }) });
    expect(await LIVE.createClient({ fetch: failed.fetch, storage: memoryStorage() }).ask('x', { sleep: async () => {} })).toMatchObject({ status: 'error', error: 'tool blew up', code: 'X' });
    const slow = fakeFetch({ 'POST /api/jarvis/ask': { status: 202, body: { jobId: 'j' } }, 'GET /api/jarvis/ask/result?jobId=j': okJson({ status: 'pending' }) });
    expect(await LIVE.createClient({ fetch: slow.fetch, storage: memoryStorage() }).ask('x', { sleep: async () => {}, maxPolls: 2 })).toMatchObject({ status: 'error', code: 'poll_limit', error: expect.stringContaining('unusually long') });
    expect(await LIVE.createClient({ fetch: slow.fetch, storage: memoryStorage() }).ask('   ')).toMatchObject({ status: 'error' });
  });

  it('keeps device preferences namespaced and tolerant of a broken storage', () => {
    const storage = memoryStorage();
    const client = LIVE.createClient({ fetch: fakeFetch({}).fetch, storage });
    expect(client.prefs.get('pins:studio', ['x'])).toEqual(['x']);
    expect(client.prefs.set('pins:studio', ['a'])).toBe(true); expect(client.prefs.get('pins:studio', [])).toEqual(['a']);
    expect(storage.map.has('oshal-experience:pins:studio')).toBe(true);
    const broken = LIVE.createClient({ fetch: fakeFetch({}).fetch, storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
    expect(broken.prefs.get('k', 'fallback')).toBe('fallback'); expect(broken.prefs.set('k', 1)).toBe(false);
    expect(broken.sessionId()).toMatch(/^jarvis-/);
  });
});

describe('experience adapter: speak', () => {
  const stubGlobals = (utterances: any[], audios: any[], speak: (u: any) => void = () => {}) => {
    const g = globalThis as Record<string, any>;
    const previous = { SpeechSynthesisUtterance: g.SpeechSynthesisUtterance, speechSynthesis: g.speechSynthesis, Audio: g.Audio };
    g.SpeechSynthesisUtterance = function SyntheticUtterance(this: any, text: string) { this.text = text; utterances.push(this); };
    g.speechSynthesis = { speak, cancel: () => {} };
    g.Audio = function SyntheticAudio(this: any, src: string) { this.src = src; this.duration = 4; this.currentTime = 0; this.play = async () => {}; this.pause = () => {}; audios.push(this); };
    return () => { Object.assign(g, previous); };
  };
  const tick = () => new Promise(done => setTimeout(done, 20));

  it('never starts a readback that was stopped while the swarm was still answering', async () => {
    const utterances: any[] = [], audios: any[] = [], hooks = { onStart: vi.fn(), onEnd: vi.fn(), onLevel: vi.fn(), onProgress: vi.fn() };
    let answer!: (r: Response) => void;
    const fetch = () => new Promise<Response>(resolve => { answer = resolve; });
    const restore = stubGlobals(utterances, audios);
    try {
      const controller = LIVE.createClient({ fetch: fetch as unknown as typeof globalThis.fetch, storage: memoryStorage() }).speak('hello there', hooks);
      controller.stop();
      answer({ ok: true, status: 200, json: async () => ({ success: true, data: { audioData: 'AAAA', format: 'wav' } }) } as Response);
      await tick(); await tick();
      expect(audios).toEqual([]); expect(utterances).toEqual([]);
      expect(hooks.onStart).not.toHaveBeenCalled(); expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it('reports progress from the browser engine\'s boundaries and from swarm audio\'s time over its duration', async () => {
    const utterances: any[] = [], audios: any[] = [];
    const progress: number[] = [], hooks = { onStart: vi.fn(), onEnd: vi.fn(), onProgress: (f: number) => progress.push(f) };
    const restore = stubGlobals(utterances, audios, u => { u.onboundary({ charIndex: 5 }); u.onboundary({ charIndex: 20 }); u.onend(); });
    try {
      const refused = fakeFetch({ 'POST /api/voice/synthesize': { status: 404, body: { error: 'none' } } });
      LIVE.createClient({ fetch: refused.fetch, storage: memoryStorage() }).speak('0123456789', hooks);
      await tick(); await tick();
      expect(hooks.onStart).toHaveBeenCalledWith('lifecycle'); expect(progress).toEqual([0.5, 1]); expect(hooks.onEnd).toHaveBeenCalledTimes(1);
      const spoken = fakeFetch({ 'POST /api/voice/synthesize': { status: 200, body: { success: true, data: { audioData: 'AAAA', format: 'wav' } } } });
      const audioHooks = { onStart: vi.fn(), onEnd: vi.fn(), onProgress: vi.fn() };
      const controller = LIVE.createClient({ fetch: spoken.fetch, storage: memoryStorage() }).speak('hello', audioHooks);
      await tick(); await tick();
      expect(audios).toHaveLength(1); expect(audios[0].src).toBe('data:audio/wav;base64,AAAA');
      expect(audioHooks.onStart).toHaveBeenCalledWith('lifecycle');
      audios[0].currentTime = 1; audios[0].ontimeupdate();
      expect(audioHooks.onProgress).toHaveBeenLastCalledWith(0.25);
      controller.stop();
      audios[0].currentTime = 2; audios[0].ontimeupdate();
      expect(audioHooks.onProgress).toHaveBeenCalledTimes(1); expect(audioHooks.onEnd).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });
});
