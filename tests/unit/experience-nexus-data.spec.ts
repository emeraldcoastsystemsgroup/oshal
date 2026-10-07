/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Phase-8 corrections: every weekend's state for a month, the state of a typed range, the comparison merge under composite ids with refusals by weekend, the weekend filter, and the city names a slice carries.
 * 1 | maintainer@emeraldcoastsystemsgroup.com | The central assistant's data kit (src/experience/nexus-data.js) in node: the month grid keeps past and unread days out of "free" and finds only complete free Friday-to-Sunday weekends (a busy Saturday removes its weekend, a refusal yields none); Travel offers become card views (malformed ones dropped, local airport times read as written) and the nonstop / after-3pm / USD budget filters and both sorts behave; short refinements are recognised and longer questions are left for Jarvis; the Google status, the device shortlist and the spoken briefing read only what they are given; the client sends each read and write to its route with the exact query or body.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Require readable sources for spoken assistant counts and empty-work claims.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../../src/experience/nexus-data.js') as Record<string, any>;

/** @description Local ISO instant for a local wall-clock time (the browser reads busy windows the same way). */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).toISOString();
const Y = 2030, M = 2; // March 2030: Fridays 1, 8, 15, 22, 29.
const ready = (busy: Array<{ start: string; end: string }>) => ({ state: 'ready', ...D.monthWindow(Y, M), busy, checkedAt: at(Y, M - 1, 20) });
const EARLIER = new Date(Y, M - 1, 20, 12);

describe('month grid and free weekends', () => {
  it('finds only complete free Friday-to-Sunday weekends; a busy Saturday removes its weekend', () => {
    const grid = D.monthGrid(Y, M, ready([{ start: at(Y, M, 9, 10), end: at(Y, M, 9, 12) }]), EARLIER);
    expect(grid.title).toBe('March 2030');
    expect(grid.lead).toBe(new Date(Y, M, 1).getDay());
    expect(grid.weekends.map((w: { label: string }) => w.label)).toEqual(['March 1–3', 'March 15–17', 'March 22–24', 'March 29–31']);
    expect(grid.weekends[0]).toMatchObject({ departDate: '2030-03-01', returnDate: '2030-03-03' });
    const day = (n: number) => grid.days.find((d: { n: number }) => d.n === n);
    expect(day(9)).toMatchObject({ state: 'busy', weekend: false });
    expect(day(15)).toMatchObject({ state: 'free', weekend: true });
    expect(day(12)).toMatchObject({ state: 'free', weekend: false });
  });

  it('crosses into the next month when the last Friday does, and keeps an unread Sunday out', () => {
    const y = 2030, m = 4; // May 2030: last Friday is the 31st, its Sunday is June 2.
    const cross = D.freeWeekends(y, m, { state: 'ready', ...D.monthWindow(y, m), busy: [] }, new Date(y, m - 1, 1));
    expect(cross[cross.length - 1]).toMatchObject({ label: 'May 31 – Jun 2', returnDate: '2030-06-02' });
    const shortRead = { state: 'ready', timeMin: new Date(y, m, 1).toISOString(), timeMax: new Date(y, m + 1, 1).toISOString(), busy: [] };
    expect(D.freeWeekends(y, m, shortRead, new Date(y, m - 1, 1)).map((w: { label: string }) => w.label)).not.toContain('May 31 – Jun 2');
  });

  it('never calls a day free without a ready read, and marks days before today as past', () => {
    const refused = D.monthGrid(Y, M, { state: 'not-connected', error: 'Connect Google' }, EARLIER);
    expect(refused.weekends).toEqual([]);
    expect(refused.counts).toMatchObject({ free: 0, busy: 0, unknown: 31 });
    const midMonth = D.monthGrid(Y, M, ready([]), new Date(Y, M, 10, 9));
    expect(midMonth.days.filter((d: { state: string }) => d.state === 'past')).toHaveLength(9);
    expect(midMonth.weekends.map((w: { label: string }) => w.label)).toEqual(['March 15–17', 'March 22–24', 'March 29–31']);
  });

  it('reads the window for a month from its 1st through the 4th of the next, as ISO instants', () => {
    expect(D.monthWindow(Y, M)).toEqual({ timeMin: new Date(Y, M, 1).toISOString(), timeMax: new Date(Y, M + 1, 4).toISOString() });
  });
});

const offer = (id: string, price: number, stops: number, departAt: string, duration: string, currency = 'USD') => ({
  id, price, currency, airline: `Synthetic ${id}`, cabin: 'economy', expiresAt: null,
  slices: [{ origin: 'PNS', destination: 'LAS', departAt, arriveAt: '2030-03-15T21:30:00', duration, stops, carriers: [`Synthetic ${id}`] },
    { origin: 'LAS', destination: 'PNS', departAt: '2030-03-17T09:05:00', arriveAt: '2030-03-17T15:00:00', duration: '4h 30m', stops: 0, carriers: [] }],
});

describe('Travel offers', () => {
  it('builds card views, reads local airport times as written, and drops malformed offers', () => {
    const v = D.offerView(offer('a', 238, 1, '2030-03-15T16:20:00', '5h 24m'));
    expect(v).toMatchObject({ id: 'a', price: 238, currency: 'USD', stops: 1, nonstop: false, hour: 16, minutes: 324 });
    expect(v.outbound).toMatchObject({ date: '2030-03-15', time: '4:20 PM', arrive: '9:30 PM' });
    expect(v.inbound).toMatchObject({ date: '2030-03-17', time: '9:05 AM' });
    expect([null, {}, { id: 'x', price: 'NaN', slices: [] }, { id: 'y', price: 5, slices: [] }].map(D.offerView)).toEqual([null, null, null, null]);
    expect(D.durationMinutes('1d 2h 5m')).toBe(1565);
    expect(D.durationMinutes('soon')).toBe(Infinity);
  });

  it('filters nonstop, after 3pm and a USD budget, and sorts by price or outbound duration', () => {
    const views = [offer('a', 238, 1, '2030-03-15T16:20:00', '5h 24m'), offer('b', 318, 0, '2030-03-15T13:15:00', '4h 06m'), offer('c', 218, 1, '2030-03-15T14:10:00', '6h 12m'),
      offer('d', 286, 1, '2030-03-15T17:05:00', '5h 06m'), offer('e', 150, 0, '2030-03-15T18:00:00', '4h 00m', 'EUR')].map(D.offerView);
    const ids = (f: object) => D.filterOffers(views, f).map((v: { id: string }) => v.id);
    expect(ids({})).toEqual(['e', 'c', 'a', 'd', 'b']);
    expect(ids({ sort: 'duration' })).toEqual(['e', 'b', 'd', 'a', 'c']);
    expect(ids({ nonstop: true })).toEqual(['e', 'b']);
    expect(ids({ late: true })).toEqual(['e', 'a', 'd']);
    expect(ids({ budget: 250 })).toEqual(['e', 'c', 'a']);
    expect(ids({ nonstop: true, late: true, budget: 200 })).toEqual(['e']);
  });
});

describe('refinements, status, shortlist and briefing', () => {
  it('recognises short refinements and leaves real questions for Jarvis', () => {
    expect(['after 3pm', 'After 3', 'leave after lunch', 'evening', 'late'].map(D.refinement)).toEqual(['late', 'late', 'late', 'late', 'late']);
    expect(['nonstop', 'non-stop only', 'direct flights'].map(D.refinement)).toEqual(['nonstop', 'nonstop', 'nonstop']);
    expect(['calendar', 'show my calendar'].map(D.refinement)).toEqual(['calendar', 'calendar']);
    expect(D.refinement('Can you find nonstop flights to Vegas for my family next month?')).toBeNull();
    expect(D.refinement('What is due today?')).toBeNull();
  });

  it('reads the Google row of the connection list, status only', () => {
    const list = (google: object | null) => ({ ok: true, status: 200, body: { providers: google ? [{ id: 'slack', connected: true }, google] : [] } });
    expect(D.googleStatus(list({ id: 'google', connected: true, connections: [{ expired: false }] })).state).toBe('connected');
    expect(D.googleStatus(list({ id: 'google', connected: true, connections: [{ expired: true }] })).state).toBe('expired');
    expect(D.googleStatus(list(null)).state).toBe('not-connected');
    expect(D.googleStatus({ ok: false, status: 503, body: null })).toEqual({ state: 'unknown', status: 503 });
  });

  it('keeps one shortlist entry per offer, newest first, at most twelve', () => {
    const view = D.offerView(offer('a', 238, 1, '2030-03-15T16:20:00', '5h 24m'));
    const entry = D.shortlistEntry(view, { origin: 'PNS', destination: 'LAS', departDate: '2030-03-15', returnDate: '2030-03-17' }, 'duffel', '2030-03-01T00:00:00Z');
    expect(entry).toMatchObject({ id: 'a', origin: 'PNS', destination: 'LAS', price: 238, time: '4:20 PM', source: 'duffel' });
    let list = Array.from({ length: 12 }, (_, i) => ({ ...entry, id: `old-${i}` }));
    list = D.addToShortlist(D.addToShortlist(list, entry), { ...entry, price: 200 });
    expect(list).toHaveLength(12);
    expect(list[0]).toMatchObject({ id: 'a', price: 200 });
    expect(list.filter((e: { id: string }) => e.id === 'a')).toHaveLength(1);
  });

  it('speaks unknown status instead of inventing online assistants or an empty workload', () => {
    const snap = { apps: [], bots: [], botsOnline: 0, workLoaded: true,
      sources: { overview: 200, tickets: 200, tasks: 503 }, sourceValidity: { overview: false, tickets: true, tasks: false } };
    const text = D.briefingText(snap, { greeting: 'Hello', firstName: 'Fixture', open: [] });
    expect(text).toContain('Assistant status is unavailable.');
    expect(text).toContain('Work status is incomplete.');
    expect(text).not.toContain('0 of 0'); expect(text).not.toContain('Nothing is waiting');
  });

  it('speaks a briefing built only from the snapshot it is given', () => {
    const snap = { apps: [1, 2, 3], bots: [{}, {}], botsOnline: 1, workLoaded: true, sources: { overview: 200, tickets: 200, tasks: 200 }, sourceValidity: { overview: true, tickets: true, tasks: true } };
    const open = [{ title: 'Synthetic review', status: { label: 'Working' } }, { title: 'Other', status: { label: 'Queued' } }];
    expect(D.briefingText(snap, { greeting: 'Good evening', firstName: 'Synthetic', open })).toBe('Good evening, Synthetic. 3 applications are ready and 1 of 2 assistants are online. You have 2 open items; the most recent is Synthetic review, working. Tell me what you want to do.');
    expect(D.briefingText(snap, { greeting: 'Good morning', firstName: 'S', open: [] })).toContain('Nothing is waiting on you right now.');
  });
});

describe('client over the existing routes', () => {
  it('sends each read and write to its route with the exact query or body', async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown; extra?: unknown }> = [];
    const live = { getJson: async (path: string, extra?: unknown) => { calls.push({ path, extra }); return { ok: true, status: 200, body: {} }; },
      sendJson: async (path: string, method: string, body: unknown) => { calls.push({ path, method, body }); return { ok: true, status: 200, body: {} }; } };
    const api = D.createNexusData(live);
    await api.availability(Y, M);
    const w = D.monthWindow(Y, M);
    expect(calls[0].path).toBe(`/api/experience/availability?timeMin=${encodeURIComponent(w.timeMin)}&timeMax=${encodeURIComponent(w.timeMax)}`);
    await api.connections(); await api.travel.config(); await api.travel.profile(); await api.travel.watches();
    expect(calls.slice(1).map(c => c.path)).toEqual(['/api/connect/list', '/api/travel/config', '/api/travel/profile', '/api/travel/watches']);
    const q = { origin: 'PNS', destination: 'LAS', departDate: '2030-03-15', returnDate: '2030-03-17', pax: 1, cabin: 'economy' };
    await api.travel.flights(q);
    expect(calls[5].path).toBe('/api/travel/flights?origin=PNS&destination=LAS&departDate=2030-03-15&returnDate=2030-03-17&pax=1&cabin=economy');
    await api.travel.flights({ ...q, returnDate: '' });
    expect(calls[6].path).not.toContain('returnDate');
    await api.travel.saveHomeAirport('ATL');
    await api.travel.watch(q, { price: 238 });
    expect(calls.slice(7)).toEqual([{ path: '/api/travel/profile', method: 'POST', body: { homeAirport: 'ATL' } },
      { path: '/api/travel/watches', method: 'POST', body: { kind: 'flight', origin: 'PNS', destination: 'LAS', departDate: '2030-03-15', returnDate: '2030-03-17', pax: 1, cabin: 'economy', lastPrice: 238 } }]);
  });
});

describe('Phase-8 corrections: weekend states, typed ranges, comparisons and cities', () => {
  const busySaturday = ready([{ start: at(Y, M, 9, 10), end: at(Y, M, 9, 12) }]);

  it('states every weekend of the month: free, busy on any busy day, past once begun, unknown without a read', () => {
    expect(D.weekendStates(Y, M, busySaturday, EARLIER).map((w: any) => [w.key, w.label, w.state])).toEqual([
      ['2030-03-01', 'March 1–3', 'free'], ['2030-03-08', 'March 8–10', 'busy'], ['2030-03-15', 'March 15–17', 'free'], ['2030-03-22', 'March 22–24', 'free'], ['2030-03-29', 'March 29–31', 'free']]);
    expect(D.weekendStates(Y, M, null, EARLIER).map((w: any) => w.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(D.weekendStates(Y, M, busySaturday, new Date(Y, M, 9, 9)).map((w: any) => w.state)).toEqual(['past', 'busy', 'free', 'free', 'free']);
    expect(D.weekendStates(Y, M, busySaturday, new Date(Y, M, 10, 9)).map((w: any) => w.state)).toEqual(['past', 'past', 'free', 'free', 'free']);
    expect(D.freeWeekends(Y, M, busySaturday, EARLIER).map((w: any) => w.key)).toEqual(['2030-03-01', '2030-03-15', '2030-03-22', '2030-03-29']);
  });

  it('classifies a typed range: busy on any overlap, unknown when unread, past or malformed, free otherwise', () => {
    expect(D.rangeState(busySaturday, '2030-03-08', '2030-03-10', EARLIER)).toBe('busy');
    expect(D.rangeState(busySaturday, '2030-03-09', '', EARLIER)).toBe('busy');
    expect(D.rangeState(busySaturday, '2030-03-15', '2030-03-17', EARLIER)).toBe('free');
    expect(D.rangeState(busySaturday, '2030-04-10', '2030-04-12', EARLIER)).toBe('unknown');
    expect(D.rangeState(null, '2030-03-15', '', EARLIER)).toBe('unknown');
    expect(D.rangeState(busySaturday, '2030-03-15', '2030-03-14', EARLIER)).toBe('unknown');
    expect(D.rangeState(busySaturday, '2030-02-10', '2030-02-11', EARLIER)).toBe('unknown');
    expect(D.rangeState(busySaturday, 'soon', 'later', EARLIER)).toBe('unknown');
  });

  it('merges one answer per weekend under composite ids, keeps refusals by weekend, filters by weekend, and carries the city names', () => {
    const offer = (id: string, price: number) => ({ id, price, currency: 'USD', airline: 'A', slices: [{ origin: 'PNS', destination: 'LAS', originCity: 'Pensacola', destinationCity: 'Las Vegas', departAt: '2030-03-01T14:10:00', arriveAt: '2030-03-01T18:00:00', duration: '5h 50m', stops: 1, carriers: ['A'] }] });
    const weekends = [{ key: '2030-03-01', label: 'March 1–3', departDate: '2030-03-01', returnDate: '2030-03-03' }, { key: '2030-03-15', label: 'March 15–17', departDate: '2030-03-15', returnDate: '2030-03-17' }, { key: '2030-03-22', label: 'March 22–24', departDate: '2030-03-22', returnDate: '2030-03-24' }];
    const m = D.mergeComparison(weekends, [
      { ok: true, status: 200, body: { source: 'duffel', items: [offer('x', 300)], price: { verdict: 'typical' } } },
      { ok: false, status: 502, body: { error: 'down' } },
      { ok: true, status: 200, body: { source: 'demo', items: [offer('x', 200), { id: 'bad' }] } }]);
    expect(m.result).toMatchObject({ source: 'duffel', price: { verdict: 'typical' } });
    expect(m.refused).toEqual([{ label: 'March 15–17', status: 502 }]);
    expect(m.views.map((v: any) => [v.id, v.offerId, v.weekend, v.weekendLabel, v.departDate, v.returnDate])).toEqual([
      ['2030-03-01/x', 'x', '2030-03-01', 'March 1–3', '2030-03-01', '2030-03-03'], ['2030-03-22/x', 'x', '2030-03-22', 'March 22–24', '2030-03-22', '2030-03-24']]);
    expect(m.views[0].outbound).toMatchObject({ originCity: 'Pensacola', destinationCity: 'Las Vegas' });
    expect(D.filterOffers(m.views, { weekend: '2030-03-22' }).map((v: any) => v.price)).toEqual([200]);
    expect(D.filterOffers(m.views, {}).map((v: any) => v.price)).toEqual([200, 300]);
    expect(D.mergeComparison(weekends.slice(0, 1), [{ ok: false, status: 0, body: null }])).toEqual({ result: null, views: [], refused: [{ label: 'March 1–3', status: 0 }] });
    expect(D.offerView(offer('y', 1)).outbound.destinationCity).toBe('Las Vegas');
    expect(D.offerView({ id: 'z', price: 1, slices: [{ origin: 'PNS', destination: 'LAS', departAt: '2030-03-01T14:10:00' }] }).outbound.destinationCity).toBe('');
  });
});
