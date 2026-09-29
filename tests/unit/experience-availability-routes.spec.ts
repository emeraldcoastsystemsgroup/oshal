/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The default token lookup (no injected tokenFor) asks the connector store for the caller's personal Google connection ({ tenantId: 'personal' }), never a household's shared one.
 * 1 | maintainer@emeraldcoastsystemsgroup.com | GET /api/experience/availability over real HTTP: signed out is refused, the window is validated (unparseable, reversed, wider than 42 days, outside the horizon), the token is looked up for the session's sub only (a sub in the query is ignored), no connection / an unrenewable grant / a refused read / a provider failure are distinct refusals and never an empty "free" answer, and a ready answer carries clamped, ordered busy windows and nothing else. The mount in server-auxiliary-routes.ts carries requiresAuth. GoogleCalendarService.freeBusy is proven against a stubbed Calendar endpoint: the exact POST it sends, busy windows only back, and a per-calendar error raised instead of read as free.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/shared/logger', () => ({ createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('@/app/routes/connectors-routes', () => ({ getValidAccessToken: vi.fn(async () => null) }));
import { getValidAccessToken } from '@/app/routes/connectors-routes';

import { createExperienceAvailabilityRoutes, normalizeBusy, parseAvailabilityWindow, AVAILABILITY_MAX_DAYS } from '@/app/routes/experience-availability-routes';
import { GoogleCalendarError, GoogleCalendarService } from '@/features/google-calendar';

const NOW = new Date('2026-10-15T12:00:00Z');
const WINDOW = { timeMin: '2026-11-01T05:00:00.000Z', timeMax: '2026-12-04T06:00:00.000Z' };
type Deps = Parameters<typeof createExperienceAvailabilityRoutes>[0];

/** @description Serve the router on a loopback port with a session seat that sets req.oidc for a signed-in sub. */
async function serve(deps: Partial<Deps>, sub: string | null = 'synthetic-person') {
  const app = express();
  app.use((req, _res, next) => { if (sub) (req as unknown as { oidc: unknown }).oidc = { user: { sub }, isAuthenticated: () => true }; next(); });
  app.use('/api/experience/availability', createExperienceAvailabilityRoutes({ pool: {} as never, now: () => NOW, ...deps }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (query: string) => { const r = await fetch(`${origin}/api/experience/availability${query}`); return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') }; };
  return { get, close: () => new Promise<void>(done => server.close(() => done())) };
}
const q = (w: { timeMin: string; timeMax: string }, extra = '') => `?timeMin=${encodeURIComponent(w.timeMin)}&timeMax=${encodeURIComponent(w.timeMax)}${extra}`;

let open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => { await Promise.all(open.map(s => s.close())); open = []; vi.unstubAllGlobals(); });
async function started(deps: Partial<Deps>, sub?: string | null) { const s = await serve(deps, sub); open.push(s); return s; }

describe('GET /api/experience/availability', () => {
  it('refuses a request with no signed-in person and never asks for a token', async () => {
    const tokenFor = vi.fn(async () => 'token');
    const s = await started({ tokenFor }, null);
    expect(await s.get(q(WINDOW))).toMatchObject({ status: 401, body: { state: 'signed-out' } });
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it('validates the window before any lookup', async () => {
    const tokenFor = vi.fn(async () => 'token');
    const s = await started({ tokenFor });
    expect((await s.get('?timeMin=soon&timeMax=later')).status).toBe(400);
    expect((await s.get(q({ timeMin: WINDOW.timeMax, timeMax: WINDOW.timeMin }))).body).toMatchObject({ state: 'invalid', error: 'timeMax must be after timeMin' });
    expect((await s.get(q({ timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-12-31T00:00:00Z' }))).body.error).toContain(`${AVAILABILITY_MAX_DAYS} days`);
    expect((await s.get(q({ timeMin: '2025-01-01T00:00:00Z', timeMax: '2025-01-20T00:00:00Z' }))).status).toBe(400);
    expect((await s.get(q({ timeMin: '2028-01-01T00:00:00Z', timeMax: '2028-01-20T00:00:00Z' }))).status).toBe(400);
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it('reads the token for the session sub only, even when the query names another person', async () => {
    const tokenFor = vi.fn(async () => 'synthetic-token');
    const busyFor = vi.fn(async () => []);
    const s = await started({ tokenFor, busyFor }, 'synthetic-person');
    const r = await s.get(q(WINDOW, '&sub=someone-else&user=someone-else'));
    expect(r.status).toBe(200);
    expect(tokenFor.mock.calls).toEqual([['synthetic-person']]);
    expect(busyFor).toHaveBeenCalledWith('synthetic-token', WINDOW);
    expect(r.cache).toBe('no-store');
  });

  it('answers busy windows only: clamped to the window, malformed ones dropped, ordered, with the read time', async () => {
    const busyFor = vi.fn(async () => [
      { start: '2026-11-20T15:00:00Z', end: '2026-11-20T16:00:00Z', summary: 'Synthetic private title' },
      { start: '2026-10-31T20:00:00Z', end: '2026-11-01T09:00:00Z' },
      { start: 'nonsense', end: '2026-11-02T00:00:00Z' },
      { start: '2026-11-05T10:00:00Z', end: '2026-11-05T09:00:00Z' },
    ] as never);
    const s = await started({ tokenFor: async () => 'token', busyFor });
    const r = await s.get(q(WINDOW));
    expect(r.body).toMatchObject({ state: 'ready', source: 'google-calendar', calendar: 'primary', ...WINDOW });
    expect(r.body.busy).toEqual([{ start: WINDOW.timeMin, end: '2026-11-01T09:00:00.000Z' }, { start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T16:00:00.000Z' }]);
    expect(Number.isFinite(Date.parse(r.body.checkedAt))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('Synthetic private title');
  });

  it('keeps no connection, an unrenewable grant, a refused read and a provider failure apart, and never answers them as free', async () => {
    const none = await started({ tokenFor: async () => null });
    expect(await none.get(q(WINDOW))).toMatchObject({ status: 409, body: { state: 'not-connected', error: expect.stringContaining('unknown, not free') } });
    const stale = await started({ tokenFor: async () => { throw new Error('refresh 400'); } });
    expect(await stale.get(q(WINDOW))).toMatchObject({ status: 409, body: { state: 'no-access' } });
    const refused = await started({ tokenFor: async () => 'token', busyFor: async () => { throw new GoogleCalendarError('Google Calendar API 403: insufficient scope', 403); } });
    expect(await refused.get(q(WINDOW))).toMatchObject({ status: 409, body: { state: 'no-access', error: expect.stringContaining('Reconnect Google') } });
    const down = await started({ tokenFor: async () => 'token', busyFor: async () => { throw new GoogleCalendarError('Google Calendar API 500: backend', 500); } });
    const failed = await down.get(q(WINDOW));
    expect(failed).toMatchObject({ status: 502, body: { state: 'failed' } });
    expect(failed.body.busy).toBeUndefined();
    expect(JSON.stringify(failed.body)).not.toContain('backend');
  });

  it('asks the connector store for the caller\'s personal Google connection when no token lookup is injected', async () => {
    const s = await started({});
    expect((await s.get(q(WINDOW))).body).toMatchObject({ state: 'not-connected' });
    expect(vi.mocked(getValidAccessToken).mock.calls.at(-1)).toEqual([{}, 'synthetic-person', 'google', { tenantId: 'personal' }]);
  });

  it('is mounted behind requiresAuth', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
    expect(source).toContain("app.use('/api/experience/availability', requiresAuth, createExperienceAvailabilityRoutes({ pool: ctx.pool }));");
  });
});

describe('availability pure helpers', () => {
  it('parses a window into ISO instants and clamps busy windows to it', () => {
    expect(parseAvailabilityWindow(WINDOW, NOW)).toEqual(WINDOW);
    expect(normalizeBusy([{ start: '2026-12-03T00:00:00Z', end: '2026-12-09T00:00:00Z' }], WINDOW)).toEqual([{ start: '2026-12-03T00:00:00.000Z', end: WINDOW.timeMax }]);
    expect(normalizeBusy([{ start: '2026-12-05T00:00:00Z', end: '2026-12-06T00:00:00Z' }], WINDOW)).toEqual([]);
  });
});

describe('GoogleCalendarService.freeBusy against a stubbed Calendar endpoint', () => {
  it('posts the window for one calendar and returns only its busy windows', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ kind: 'calendar#freeBusy', calendars: { primary: { busy: [{ start: '2026-11-06T15:00:00Z', end: '2026-11-06T16:00:00Z' }, { start: 7 }] } } }), { status: 200 });
    });
    const busy = await new GoogleCalendarService(async () => 'synthetic-token').freeBusy({ timeMin: WINDOW.timeMin, timeMax: WINDOW.timeMax });
    expect(busy).toEqual([{ start: '2026-11-06T15:00:00Z', end: '2026-11-06T16:00:00Z' }]);
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-token');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ timeMin: WINDOW.timeMin, timeMax: WINDOW.timeMax, items: [{ id: 'primary' }] });
  });

  it('raises a per-calendar error instead of reading it as free, and a refused call keeps its status', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ calendars: { primary: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } }), { status: 200 }));
    await expect(new GoogleCalendarService(async () => 't').freeBusy(WINDOW)).rejects.toMatchObject({ name: 'GoogleCalendarError', status: 404 });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }), { status: 403 }));
    await expect(new GoogleCalendarService(async () => 't').freeBusy(WINDOW)).rejects.toMatchObject({ status: 403 });
  });
});
