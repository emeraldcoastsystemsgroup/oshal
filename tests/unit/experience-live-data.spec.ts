/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Prove the experience adapter's joins and Jarvis ask flow headlessly: catalog authority order, suite grouping, work merging, summary caps, identity derivation, session roll on a refused thread, poll-to-terminal states and honest source reporting when a read fails.
 */
import { describe, expect, it } from 'vitest';
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

  it('lets the authorized plan lead the catalog, keeps unadmitted apps visible as unavailable, and derives relationships', () => {
    const apps = LIVE.mergeApps({
      plan: [{ name: 'a', displayName: 'A', suite: 'ai-home', firstSurfaceUrl: '/api/a/', summary: [{ app: 'a', path: '/api/a/home-summary' }], todos: [], integrationSources: [{ app: 'b' }, { app: 'a' }] }],
      apps: [{ name: 'a', displayName: 'Listing A', description: 'from listing', version: '1.2.3', suite: 'ai-home', botCount: 2, ticketType: 'A-Type' }, { name: 'b', displayName: 'B', suite: null }],
      workspaces: [{ name: 'a', href: '/cockpit/?app=a', theme: 'ocean' }],
    });
    expect(apps.map((x: any) => x.id)).toEqual(['a', 'b']);
    expect(apps[0]).toMatchObject({ name: 'A', description: 'from listing', version: '1.2.3', navigable: true, inPlan: true, theme: 'ocean', ticketType: 'a-type', botCount: 2, related: ['b'] });
    expect(apps[1]).toMatchObject({ suite: 'platform', navigable: false, inPlan: false, href: '/cockpit/?app=b' });
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
    expect(await LIVE.createClient({ fetch: slow.fetch, storage: memoryStorage() }).ask('x', { sleep: async () => {}, maxPolls: 2 })).toMatchObject({ status: 'error', error: expect.stringContaining('unusually long') });
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
