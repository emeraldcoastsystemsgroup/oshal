/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Unit tests for GoogleCalendarService CRUD operations: createEvent (timed, all-day, attendees, location), getEvent, updateEvent (PATCH), listUpcoming, deleteEvent, and error handling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleCalendarService,
  GoogleCalendarError,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
} from '@/features/google-calendar';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleCalendarService CRUD operations', () => {
  it('creates a timed meeting with attendees and location', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'evt-123', htmlLink: 'https://calendar.google.com/event?id=evt-123' }), { status: 200 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    const input: CreateCalendarEventInput = {
      summary: 'Product Architecture Review',
      description: 'Reviewing next quarter roadmap',
      date: '2026-10-15',
      time: '14:00',
      timeZone: 'America/New_York',
      location: 'Conference Room A / Google Meet',
      attendees: ['alice@example.com', { email: 'bob@example.com', displayName: 'Bob' }],
      reminderMinutes: 15,
    };

    const result = await service.createEvent(input);

    expect(result).toEqual({ id: 'evt-123', htmlLink: 'https://calendar.google.com/event?id=evt-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer mock-token');

    const sentBody = JSON.parse(String(calls[0].init.body));
    expect(sentBody.summary).toBe('Product Architecture Review');
    expect(sentBody.location).toBe('Conference Room A / Google Meet');
    expect(sentBody.start).toEqual({ dateTime: '2026-10-15T14:00:00', timeZone: 'America/New_York' });
    expect(sentBody.end).toEqual({ dateTime: '2026-10-15T15:00:00', timeZone: 'America/New_York' });
    expect(sentBody.attendees).toEqual([
      { email: 'alice@example.com' },
      { email: 'bob@example.com', displayName: 'Bob' },
    ]);
    expect(sentBody.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 15 }],
    });
  });

  it('creates an all-day event when no time is supplied', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'evt-allday', htmlLink: null }), { status: 200 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    const result = await service.createEvent({
      summary: 'Company Holiday',
      date: '2026-12-25',
    });

    expect(result.id).toBe('evt-allday');
    const sentBody = JSON.parse(String(calls[0].init.body));
    expect(sentBody.start).toEqual({ date: '2026-12-25' });
    expect(sentBody.end).toEqual({ date: '2026-12-26' });
  });

  it('gets an existing event and normalizes its fields', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-999');
      return new Response(JSON.stringify({
        id: 'evt-999',
        summary: 'Sync with Team',
        description: 'Weekly team sync',
        start: { dateTime: '2026-10-20T10:00:00Z' },
        end: { dateTime: '2026-10-20T11:00:00Z' },
        htmlLink: 'https://calendar.google.com/evt-999',
        location: 'Zoom',
        attendees: [{ email: 'dev@example.com', responseStatus: 'accepted' }],
      }), { status: 200 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    const event = await service.getEvent('evt-999');

    expect(event).toEqual({
      id: 'evt-999',
      summary: 'Sync with Team',
      description: 'Weekly team sync',
      start: '2026-10-20T10:00:00Z',
      end: '2026-10-20T11:00:00Z',
      allDay: false,
      htmlLink: 'https://calendar.google.com/evt-999',
      location: 'Zoom',
      attendees: [{ email: 'dev@example.com', displayName: undefined, responseStatus: 'accepted' }],
    });
  });

  it('updates an existing event with PATCH', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'evt-999', htmlLink: 'https://calendar.google.com/evt-999' }), { status: 200 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    const patchInput: UpdateCalendarEventInput = {
      summary: 'Updated Sync Title',
      time: '15:30',
      date: '2026-10-20',
      location: 'Room B',
      attendees: ['lead@example.com'],
    };

    const res = await service.updateEvent('evt-999', patchInput);

    expect(res).toEqual({ id: 'evt-999', htmlLink: 'https://calendar.google.com/evt-999' });
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-999');
    expect(calls[0].init.method).toBe('PATCH');

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.summary).toBe('Updated Sync Title');
    expect(body.location).toBe('Room B');
    expect(body.attendees).toEqual([{ email: 'lead@example.com' }]);
    expect(body.start.dateTime).toBe('2026-10-20T15:30:00');
  });

  it('lists upcoming events with query params', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toContain('/calendars/primary/events?');
      expect(url).toContain('maxResults=10');
      return new Response(JSON.stringify({
        items: [
          { id: '1', summary: 'Standup', start: { dateTime: '2026-10-01T09:00:00Z' }, end: { dateTime: '2026-10-01T09:15:00Z' } },
          { id: '2', summary: 'All Hands', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
        ],
      }), { status: 200 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    const events = await service.listUpcoming({ maxResults: 10 });

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe('1');
    expect(events[0].allDay).toBe(false);
    expect(events[1].id).toBe('2');
    expect(events[1].allDay).toBe(true);
  });

  it('deletes an event and handles 404/410 idempotently', async () => {
    let called = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      called++;
      if (called === 1) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ error: { message: 'Resource has been deleted' } }), { status: 410 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    await expect(service.deleteEvent('evt-1')).resolves.toBeUndefined();
    // 410 should also resolve without throwing
    await expect(service.deleteEvent('evt-1')).resolves.toBeUndefined();
  });

  it('throws GoogleCalendarError on API failure', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ error: { message: 'Insufficient Permission' } }), { status: 403 });
    });

    const service = new GoogleCalendarService(async () => 'mock-token');
    await expect(service.getEvent('evt-forbidden')).rejects.toThrow(GoogleCalendarError);
  });
});
