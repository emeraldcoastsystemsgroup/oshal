/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Unit tests for /api/calendar routes over real HTTP: auth requirements, connection checks, GET/POST/PATCH/DELETE event endpoints, input validation, and server-auxiliary-routes registration guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/shared/logger', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createCalendarRoutes, type CalendarRoutesDeps } from '@/app/routes/calendar-routes';
import { GoogleCalendarError, type GoogleCalendarService } from '@/features/google-calendar';

let openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.map((s) => s.close()));
  openServers = [];
  vi.unstubAllGlobals();
});

async function serve(deps: Partial<CalendarRoutesDeps>, sub: string | null = 'test-sub') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (sub) {
      (req as any).oidc = { user: { sub }, isAuthenticated: () => true };
    }
    next();
  });
  app.use('/api/calendar', createCalendarRoutes({ pool: {} as any, ...deps }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const request = async (method: string, path: string, body?: any) => {
    const res = await fetch(`${origin}/api/calendar${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const instance = {
    get: (path: string) => request('GET', path),
    post: (path: string, body: any) => request('POST', path, body),
    patch: (path: string, body: any) => request('PATCH', path, body),
    delete: (path: string) => request('DELETE', path),
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
  openServers.push(instance);
  return instance;
}

describe('/api/calendar routes', () => {
  it('returns 401 when signed out', async () => {
    const s = await serve({}, null);
    const res = await s.get('/events');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('not_authenticated');
  });

  it('returns 409 when Google connector is not connected', async () => {
    const tokenFor = vi.fn(async () => null);
    const s = await serve({ tokenFor });
    const res = await s.get('/events');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_connected');
  });

  it('lists upcoming events with GET /events', async () => {
    const mockService = {
      listUpcoming: vi.fn(async () => [{ id: 'evt-1', summary: 'Standup', start: '2026-10-01T09:00:00Z', end: '2026-10-01T09:15:00Z', allDay: false, htmlLink: null }]),
    } as unknown as GoogleCalendarService;

    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => mockService,
    });

    const res = await s.get('/events?maxResults=5');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].id).toBe('evt-1');
  });

  it('retrieves a single event with GET /events/:id', async () => {
    const mockService = {
      getEvent: vi.fn(async (id: string) => ({ id, summary: 'Client Demo', description: 'Demo meeting', start: '2026-10-01T14:00:00Z', end: '2026-10-01T15:00:00Z', allDay: false, htmlLink: 'https://meet.google.com/xyz' })),
    } as unknown as GoogleCalendarService;

    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => mockService,
    });

    const res = await s.get('/events/evt-demo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.event.summary).toBe('Client Demo');
    expect(mockService.getEvent).toHaveBeenCalledWith('evt-demo', 'primary');
  });

  it('validates required fields on POST /events', async () => {
    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => ({} as GoogleCalendarService),
    });

    const res1 = await s.post('/events', { date: '2026-10-01' });
    expect(res1.status).toBe(400);
    expect(res1.body.error).toContain('summary is required');

    const res2 = await s.post('/events', { summary: 'Meeting' });
    expect(res2.status).toBe(400);
    expect(res2.body.error).toContain('date');
  });

  it('creates an event with POST /events', async () => {
    const mockService = {
      createEvent: vi.fn(async (input: any) => ({ id: 'new-evt', htmlLink: 'https://calendar.google.com/new-evt' })),
    } as unknown as GoogleCalendarService;

    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => mockService,
    });

    const res = await s.post('/events', {
      summary: 'Q4 Budget Review',
      date: '2026-10-15',
      time: '10:00',
      location: 'HQ Room 4',
      attendees: ['cfo@example.com'],
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.eventId).toBe('new-evt');
    expect(res.body.htmlLink).toBe('https://calendar.google.com/new-evt');
  });

  it('updates an event with PATCH /events/:id', async () => {
    const mockService = {
      updateEvent: vi.fn(async (id: string, input: any) => ({ id, htmlLink: 'https://calendar.google.com/updated' })),
    } as unknown as GoogleCalendarService;

    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => mockService,
    });

    const res = await s.patch('/events/evt-123', {
      summary: 'Rescheduled Review',
      date: '2026-10-16',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.eventId).toBe('evt-123');
  });

  it('deletes an event with DELETE /events/:id', async () => {
    const mockService = {
      deleteEvent: vi.fn(async () => undefined),
    } as unknown as GoogleCalendarService;

    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => mockService,
    });

    const res = await s.delete('/events/evt-delete');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(true);
  });

  it('handles GoogleCalendarError with upstream status', async () => {
    const mockService = {
      getEvent: vi.fn(async () => {
        throw new GoogleCalendarError('Event not found', 404);
      }),
    } as unknown as GoogleCalendarService;

    const s = await serve({
      tokenFor: async () => 'mock-token',
      calendarServiceFor: () => mockService,
    });

    const res = await s.get('/events/missing-id');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Event not found');
  });

  it('is registered behind requiresAuth in server-auxiliary-routes.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/server-auxiliary-routes.ts'), 'utf8');
    expect(source).toContain("app.use('/api/calendar', requiresAuth, createCalendarRoutes({ pool: ctx.pool }));");
  });
});
