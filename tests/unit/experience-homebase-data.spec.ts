/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The homebase data seam headlessly (the shipped src/experience/homebase-data.js): the location view keeps places by name and never a coordinate, marks this browser's device and reports refusals with the route's code and message; the level span reproduces Little Monsters' own level rule and shows nothing when the rule disagrees; groups are picked by kind only; member rows put the caller first and name nobody the directory did not; cron wording covers the common shapes and names anything else as custom; day grouping, local matching and the search, briefing and schedule rows; and the data client's requests: the directory is asked only when a group has someone else, the briefing write carries its own header, and every route is the caller-scoped one.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The seam is a classic browser script with a CommonJS export; load the shipped file itself.
const HD = require('../../src/experience/homebase-data.js') as Record<string, any>;

type Reply = { status: number; body?: unknown };
/** @description A live-adapter double: getJson/sendJson answered by method + path prefix, every call recorded. */
function fakeLive(routes: Record<string, Reply>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const answer = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    const key = Object.keys(routes).find(k => `${method} ${path}`.startsWith(k));
    const r = key ? routes[key] : { status: 404, body: { error: 'missing' } };
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body ?? null });
  };
  return { calls, live: { getJson: (p: string) => answer('GET', p), sendJson: (p: string, m: string, b?: unknown) => answer(m, p, b) } };
}
const OVERVIEW = {
  settings: { defaultPrecisionClass: 'block' },
  devices: [{ deviceId: 'd1', kind: 'browser', reportingEnabled: true, precisionClass: 'block', lastSeenAt: '2026-09-28T10:00:00Z', createdAt: '2026-09-01T00:00:00Z' }, { deviceId: 'd2', kind: 'node', reportingEnabled: false, precisionClass: 'city', lastSeenAt: null, createdAt: '2026-09-02T00:00:00Z' }],
  current: { deviceId: 'd1', source: 'browser', precisionClass: 'block', accuracyM: 40, receivedAt: '2026-09-28T10:00:00Z', ageSeconds: 300, place: { placeId: 'p1', name: 'Synthetic place', label: 'home' }, lat: 1, lon: 2 },
  history: { observationCount: 7 },
  visibility: { memberShares: [{ shareId: 's1', groupName: 'Synthetic household', placeCount: 2, active: true }, { shareId: 's2', groupName: 'Old group', placeCount: 1, active: false }], guardianShares: [{ shareId: 'g1', groupName: 'Synthetic household', grantees: [{ sub: 'a' }, { sub: 'b' }], active: true }], restrictions: [{ groupName: 'Synthetic household' }] },
};

describe('homebase data seam: pure helpers', () => {
  it('reads the location overview as places, marks this browser and keeps only active shares', () => {
    const v = HD.locationView({ ok: true, status: 200, body: OVERVIEW }, 'd1');
    expect(v.ok).toBe(true);
    expect(v.current).toEqual({ place: { name: 'Synthetic place', label: 'home' }, ageSeconds: 300, precisionClass: 'block' });
    expect(JSON.stringify(v)).not.toMatch(/"lat"|"lon"/);
    expect(v.thisDevice).toMatchObject({ id: 'd1', reporting: true, thisBrowser: true });
    expect(v.devices.map((d: any) => d.thisBrowser)).toEqual([true, false]);
    expect(v.reporting).toBe(true);
    expect(v.memberShares).toEqual([{ id: 's1', group: 'Synthetic household', places: 2 }]);
    expect(v.guardianShares).toEqual([{ id: 'g1', group: 'Synthetic household', grantees: 2 }]);
    expect(v.restrictions).toEqual(['Synthetic household']);
    expect(v.history).toBe(7);
    // A stored id that names a node, not a browser, is not "this browser".
    expect(HD.locationView({ ok: true, status: 200, body: OVERVIEW }, 'd2').thisDevice).toBeNull();
  });

  it('reports a location refusal with its status, code and message, and a failed read as status 0', () => {
    expect(HD.locationView({ ok: false, status: 403, body: { error: 'browser_session_required', message: 'Signed-in browser only.' } }, null)).toEqual({ ok: false, status: 403, code: 'browser_session_required', message: 'Signed-in browser only.' });
    expect(HD.locationView({ ok: false, status: 0, body: null }, null)).toEqual({ ok: false, status: 0, code: '', message: '' });
  });

  it('reproduces Little Monsters’ level rule and shows no span when the rule disagrees with the package', () => {
    expect(HD.levelSpan(1, 0)).toEqual({ into: 0, need: 100, next: 2 });
    expect(HD.levelSpan(1, 99)).toEqual({ into: 99, need: 100, next: 2 });
    expect(HD.levelSpan(2, 100)).toEqual({ into: 0, need: 150, next: 3 });
    expect(HD.levelSpan(2, 160)).toEqual({ into: 60, need: 150, next: 3 });
    expect(HD.levelSpan(3, 250)).toEqual({ into: 0, need: 225, next: 4 });
    expect(HD.levelSpan(3, 160)).toBeNull();
    expect(HD.levelSpan(1, -5)).toBeNull();
    expect(HD.levelSpan(1, 'x')).toBeNull();
  });

  it('picks a group by kind only and lists the caller first, admins next, naming only what the directory shared', () => {
    const tenants = [{ tenant_id: 'o1', kind: 'org', name: 'Synthetic org', role: 'member' }, { tenant_id: 'h1', kind: 'space', name: 'Synthetic household', role: 'admin' }];
    expect(HD.groupPick(tenants, 'space').tenant_id).toBe('h1');
    expect(HD.groupPick(tenants, 'org').tenant_id).toBe('o1');
    expect(HD.groupPick([tenants[0]], 'space')).toBeNull();
    const rows = HD.memberRows([{ user_sub: 'm2', role: 'member' }, { user_sub: 'a1', role: 'admin' }, { user_sub: 'me', role: 'member' }], { sub: 'me', name: 'Synthetic Me' }, [{ sub: 'a1', label: 'Synthetic Admin (google; active)' }]);
    expect(rows).toEqual([{ sub: 'me', role: 'member', self: true, name: 'Synthetic Me' }, { sub: 'a1', role: 'admin', self: false, name: 'Synthetic Admin' }, { sub: 'm2', role: 'member', self: false, name: '' }]);
  });

  it('words common crons and names any other shape as a custom schedule', () => {
    expect(HD.cronText('0 8 * * *')).toBe('Every day at 8:00 AM');
    expect(HD.cronText('30 17 * * 1-5')).toBe('Weekdays at 5:30 PM');
    expect(HD.cronText('0 9 * * 0,6')).toBe('Weekends at 9:00 AM');
    expect(HD.cronText('30 8 * * 6')).toBe('Every Saturday at 8:30 AM');
    expect(HD.cronText('0 12 * * 1,3')).toBe('Every Monday, Wednesday at 12:00 PM');
    expect(HD.cronText('0 0 * * *')).toBe('Every day at 12:00 AM');
    expect(HD.cronText('*/5 * * * *')).toBe('Custom schedule (*/5 * * * *)');
    expect(HD.cronText('')).toBe('Custom schedule (no cron)');
    expect(HD.cronText('15 10 25 12 *')).toMatch(/at 10:15 AM$/);
  });

  it('groups events by day in time order and matches a query against local rows by title and detail', () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h);
    const groups = HD.dayGroups([{ title: 'b', when: at(29, 15) }, { title: 'a', when: at(28, 9) }, { title: 'c', when: at(29, 8) }, { title: 'bad', when: new Date('x') }]);
    expect(groups.map((g: any) => [g.key, g.events.map((e: any) => e.title)])).toEqual([['2026-09-28', ['a']], ['2026-09-29', ['c', 'b']]]);
    const m = HD.localMatches('SEED', { events: [{ id: 'e1', title: 'Seed circle', detail: 'Class' }], items: [{ id: 'i1', title: 'Milk' }], work: [{ id: 'w1', title: 'Review', detail: 'Seed ledger' }] });
    expect(m).toEqual([{ kind: 'events', title: 'Seed circle', detail: 'Class', id: 'e1' }, { kind: 'work', title: 'Review', detail: 'Seed ledger', id: 'w1' }]);
    expect(HD.localMatches('   ', { items: [{ id: 'i1', title: 'x' }] })).toEqual([]);
  });

  it('normalizes search hits, briefing sources and schedules, and passes a refusal through as data', () => {
    expect(HD.searchRows({ ok: true, status: 200, body: { hits: [{ title: 'T', snippet: 's', kind: 'ticket', url: '/cockpit/?ticket=1', source: 'tickets' }, { title: 'Doc', kind: 'doc', url: null }] } }).hits)
      .toEqual([{ title: 'T', snippet: 's', kind: 'ticket', url: '/cockpit/?ticket=1', source: 'tickets' }, { title: 'Doc', snippet: '', kind: 'doc', url: null, source: '' }]);
    expect(HD.searchRows({ ok: false, status: 500, body: { error: 'search failed' } })).toEqual({ ok: false, status: 500, code: 'search failed', message: '' });
    expect(HD.briefingRows({ ok: true, status: 200, body: { sources: [{ id: 'b1', title: 'Brief', preference: { enabled: true, frequency: 'daily', channel: 'screen' } }] } }).sources[0])
      .toEqual({ id: 'b1', title: 'Brief', description: '', enabled: true, frequency: 'daily', channel: 'screen', delivery: '' });
    const s = HD.scheduleRows({ ok: true, status: 200, body: { schedules: [{ id: 'x', taskType: 'jarvis-reminder', cron: '0 8 * * 1-5', taskData: { prompt: 'check the markets' }, status: 'paused', nextRunAt: null, once: true }] } });
    expect(s.rows[0]).toEqual({ id: 'x', title: 'check the markets', when: 'Weekdays at 8:00 AM', cron: '0 8 * * 1-5', paused: true, nextRunAt: '', once: true });
  });
});

describe('homebase data seam: the client', () => {
  it('reads the caller’s household and asks the directory only when someone else is in it', async () => {
    const { live, calls } = fakeLive({ 'GET /api/tenants/h1/members': { status: 200, body: { members: [{ user_sub: 'me', role: 'admin' }] } }, 'GET /api/tenants': { status: 200, body: { tenants: [{ tenant_id: 'h1', kind: 'space', name: 'Synthetic household', role: 'admin' }] } } });
    const client = HD.createHomebaseData(live, { getItem: () => null });
    let asked = 0;
    const alone = await client.household('space', { sub: 'me', name: 'Me' }, async () => { asked += 1; return []; });
    expect(alone).toMatchObject({ ok: true, group: { id: 'h1', name: 'Synthetic household', role: 'admin' } });
    expect(asked).toBe(0);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/tenants', 'GET /api/tenants/h1/members']);
    const two = fakeLive({ 'GET /api/tenants/h1/members': { status: 200, body: { members: [{ user_sub: 'me', role: 'admin' }, { user_sub: 'x', role: 'member' }] } }, 'GET /api/tenants': { status: 200, body: { tenants: [{ tenant_id: 'h1', kind: 'space', name: 'H', role: 'admin' }] } } });
    const both = await HD.createHomebaseData(two.live, { getItem: () => null }).household('space', { sub: 'me', name: 'Me' }, async () => { asked += 1; return [{ sub: 'x', label: 'Synthetic X' }]; });
    expect(asked).toBe(1);
    expect(both.members.map((m: any) => m.name)).toEqual(['Me', 'Synthetic X']);
  });

  it('keeps a members refusal and a missing group apart', async () => {
    const refusedMembers = fakeLive({ 'GET /api/tenants/h1/members': { status: 403, body: { error: 'not a member' } }, 'GET /api/tenants': { status: 200, body: { tenants: [{ tenant_id: 'h1', kind: 'space', name: 'H', role: 'member' }] } } });
    expect(await HD.createHomebaseData(refusedMembers.live, null).household('space', { sub: 'me', name: 'Me' }, async () => [])).toMatchObject({ ok: false, status: 403, code: 'not a member', members: [] });
    const none = fakeLive({ 'GET /api/tenants': { status: 200, body: { tenants: [] } } });
    expect(await HD.createHomebaseData(none.live, null).household('space', { sub: 'me', name: 'Me' }, async () => [])).toEqual({ ok: true, status: 200, group: null, members: [] });
  });

  it('names this browser from the Settings page’s stored id and writes only through the caller-scoped routes', async () => {
    const { live, calls } = fakeLive({ 'GET /api/location/state': { status: 200, body: OVERVIEW }, 'POST /api/location/devices/d1/opt-out': { status: 200, body: { device: {}, currentCleared: 1 } } });
    const client = HD.createHomebaseData(live, { getItem: (k: string) => (k === HD.DEVICE_KEY ? 'd1' : null) });
    expect(HD.DEVICE_KEY).toBe('oshal.location.browserDeviceId');
    expect((await client.location()).thisDevice.id).toBe('d1');
    await client.optOut('d1');
    await client.setSchedule('s/1', true); await client.setSchedule('s1', false);
    await client.markRead('n1');
    await client.createHousehold('Our home');
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/location/state', 'POST /api/location/devices/d1/opt-out', 'POST /api/v1/agent/schedules/s%2F1/pause', 'POST /api/v1/agent/schedules/s1/resume', 'PATCH /api/education/notifications/n1/read', 'POST /api/tenants']);
    expect(calls[calls.length - 1].body).toEqual({ name: 'Our home', kind: 'space' });
  });

  it('sends the briefing preference with the route’s own header, keeping frequency and channel', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ enabled: true }) } as Response; };
    const client = HD.createHomebaseData(fakeLive({}).live, null, fetchImpl);
    const r = await client.setBriefing({ id: 'b 1', frequency: 'weekly', channel: 'screen' }, true);
    expect(r).toEqual({ ok: true, status: 200, body: { enabled: true } });
    expect(seen[0].url).toBe('/api/jarvis/briefings/b%201');
    expect(seen[0].init.method).toBe('PUT');
    expect((seen[0].init.headers as Record<string, string>)['x-oshal-briefing-request']).toBe('1');
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ enabled: true, frequency: 'weekly', channel: 'screen' });
  });

  it('reads a learner’s progress with the level span and passes a refused dashboard through', async () => {
    const ok = fakeLive({ 'GET /api/education/student/stu-1/dashboard': { status: 200, body: { student: { xp: 160, level: 2, streak_days: 3 }, stats: { quizAverage: 84, quizCount: 2, flashcardsReviewed: 12 } } } });
    expect(await HD.createHomebaseData(ok.live, null).progress('stu-1')).toEqual({ ok: true, status: 200, level: 2, xp: 160, streak: 3, quizAverage: 84, quizCount: 2, cards: 12, span: { into: 60, need: 150, next: 3 } });
    const no = fakeLive({ 'GET /api/education/student/stu-1/dashboard': { status: 403, body: { error: 'You cannot view this student' } } });
    expect(await HD.createHomebaseData(no.live, null).progress('stu-1')).toEqual({ ok: false, status: 403, code: 'You cannot view this student', message: '' });
  });
});
