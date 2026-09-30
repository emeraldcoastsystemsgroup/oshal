/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Google Calendar v3 client — reuses the google-bot OAuth access token (injected, no cross-feature import) to push/pull events. Backs the Little Monsters calendar sync.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | freeBusy(): the Calendar API's free/busy query for one calendar. It returns busy windows only (Google sends no titles, and events marked "free" or declined are not busy), which is what an availability view needs; a per-calendar error in the answer is raised rather than read as "free". Additive: no existing method changed.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Support full calendar event CRUD: added getEvent, updateEvent (PATCH), location and attendees on createEvent/updateEvent.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'google-calendar-service' });

const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';

/**
 * @description A token provider yields a fresh Google OAuth access token with
 * the `calendar` scope. Injected so this feature never imports another feature
 * slice — the app layer wires in voice-providers' getGoogleAccessToken().
 */
export type GoogleAccessTokenProvider = () => Promise<string>;

/** @description Raised when the calendar API rejects a call or no token exists. */
export class GoogleCalendarError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
}

/** @description A normalized calendar event returned to callers. */
export interface NormalizedCalendarEvent {
  id: string;
  summary: string;
  description: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  htmlLink: string | null;
  location?: string | null;
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
}

/** @description One busy window from a free/busy query: ISO instants, end exclusive. No title or detail. */
export interface CalendarBusyWindow {
  start: string;
  end: string;
}

/** @description Input to createEvent — a local LM calendar event, normalized. */
export interface CreateCalendarEventInput {
  summary: string;
  description?: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM[:SS] — omit/null for an all-day event */
  time?: string | null;
  /** IANA timezone for timed events; defaults to America/Chicago (repo TZ). */
  timeZone?: string;
  /** Popup reminder minutes before start; omit for the calendar default. */
  reminderMinutes?: number | null;
  calendarId?: string;
  /** Optional location/link for the meeting */
  location?: string;
  /** Optional attendees: string emails or { email: string } objects */
  attendees?: Array<string | { email: string; displayName?: string }>;
}

/** @description Input to updateEvent — patchable fields for an existing event. */
export interface UpdateCalendarEventInput {
  summary?: string;
  description?: string;
  /** YYYY-MM-DD */
  date?: string;
  /** HH:MM[:SS] — omit/null for an all-day event */
  time?: string | null;
  /** IANA timezone for timed events; defaults to America/Chicago (repo TZ). */
  timeZone?: string;
  /** Popup reminder minutes before start; omit for the calendar default. */
  reminderMinutes?: number | null;
  calendarId?: string;
  /** Optional location/link for the meeting */
  location?: string;
  /** Optional attendees: string emails or { email: string } objects */
  attendees?: Array<string | { email: string; displayName?: string }>;
}

const DEFAULT_TZ = 'America/Chicago';

/**
 * @description Thin Google Calendar v3 client. Holds no credentials of its
 * own — every call resolves a fresh bearer token via the injected provider,
 * so token storage/refresh stays owned by the google-bot OAuth profile.
 */
export class GoogleCalendarService {
  constructor(private readonly getAccessToken: GoogleAccessTokenProvider) {}

  /**
   * @description Issue an authenticated Calendar API request and parse JSON.
   * @param pathAndQuery - path beneath the calendar base URL (with query string)
   * @param init - fetch init (method/body); Authorization is added here
   * @returns the parsed JSON body, or null for 204 responses
   */
  private async call(pathAndQuery: string, init: RequestInit = {}): Promise<any> {
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: any) {
      throw new GoogleCalendarError(`Google account not connected: ${err?.message || err}`);
    }
    const resp = await fetch(`${CALENDAR_BASE_URL}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (resp.status === 204) return null;
    const body: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = body?.error?.message || resp.statusText;
      logger.error({ status: resp.status, msg, pathAndQuery }, 'Google Calendar API call failed');
      throw new GoogleCalendarError(`Google Calendar API ${resp.status}: ${msg}`, resp.status);
    }
    return body;
  }

  /**
   * @description List events in a time window, expanded to single instances.
   * @param opts - calendarId (default 'primary'), ISO timeMin/timeMax, maxResults
   * @returns normalized events ordered by start time
   */
  async listUpcoming(opts: { calendarId?: string; timeMin?: string; timeMax?: string; maxResults?: number } = {}): Promise<NormalizedCalendarEvent[]> {
    const calendarId = opts.calendarId || 'primary';
    const now = new Date();
    const timeMin = opts.timeMin || now.toISOString();
    const timeMax = opts.timeMax || new Date(now.getTime() + 30 * 86400000).toISOString();
    const q = new URLSearchParams({
      timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime',
      maxResults: String(opts.maxResults || 50),
    });
    const data = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`);
    return (data.items || []).map((e: any): NormalizedCalendarEvent => ({
      id: e.id,
      summary: e.summary || '(untitled)',
      description: e.description || '',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      allDay: !!e.start?.date && !e.start?.dateTime,
      htmlLink: e.htmlLink || null,
      location: e.location || null,
      attendees: Array.isArray(e.attendees)
        ? e.attendees.map((a: any) => ({ email: a.email, displayName: a.displayName, responseStatus: a.responseStatus }))
        : undefined,
    }));
  }

  /**
   * @description Ask the free/busy endpoint for one calendar's busy windows. Availability views use
   * this instead of listing events: the answer carries no titles, and Google already leaves out
   * events marked "free" and invitations the person declined.
   * @param opts - calendarId (default 'primary') and the ISO timeMin/timeMax window
   * @returns the busy windows Google reported, in its order
   * @throws GoogleCalendarError when the call fails or the answer names an error for the calendar
   * (an unreadable calendar must never look free)
   */
  async freeBusy(opts: { calendarId?: string; timeMin: string; timeMax: string }): Promise<CalendarBusyWindow[]> {
    const calendarId = opts.calendarId || 'primary';
    const data = await this.call('/freeBusy', {
      method: 'POST',
      body: JSON.stringify({ timeMin: opts.timeMin, timeMax: opts.timeMax, items: [{ id: calendarId }] }),
    });
    const entry = data && data.calendars ? data.calendars[calendarId] : null;
    if (!entry) throw new GoogleCalendarError('Google Calendar free/busy answer did not include the calendar');
    if (Array.isArray(entry.errors) && entry.errors.length) {
      const reason = String(entry.errors[0]?.reason || 'unknown');
      throw new GoogleCalendarError(`Google Calendar free/busy error: ${reason}`, reason === 'notFound' ? 404 : undefined);
    }
    return (Array.isArray(entry.busy) ? entry.busy : [])
      .filter((b: any) => b && typeof b.start === 'string' && typeof b.end === 'string')
      .map((b: any): CalendarBusyWindow => ({ start: b.start, end: b.end }));
  }

  /**
   * @description Get a single event by id.
   * @param eventId - the Google event id
   * @param calendarId - default 'primary'
   * @returns normalized event
   */
  async getEvent(eventId: string, calendarId = 'primary'): Promise<NormalizedCalendarEvent> {
    const e = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    return {
      id: e.id,
      summary: e.summary || '(untitled)',
      description: e.description || '',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      allDay: !!e.start?.date && !e.start?.dateTime,
      htmlLink: e.htmlLink || null,
      location: e.location || null,
      attendees: Array.isArray(e.attendees)
        ? e.attendees.map((a: any) => ({ email: a.email, displayName: a.displayName, responseStatus: a.responseStatus }))
        : undefined,
    };
  }

  /**
   * @description Create an event. Timed events use dateTime+timeZone; events
   * without a time become all-day (start.date .. next-day end.date per the
   * Calendar API's exclusive-end convention).
   * @param input - normalized local event fields
   * @returns the new Google event id + htmlLink
   */
  async createEvent(input: CreateCalendarEventInput): Promise<{ id: string; htmlLink: string | null }> {
    const calendarId = input.calendarId || 'primary';
    const tz = input.timeZone || DEFAULT_TZ;
    const body: any = {
      summary: input.summary,
      description: input.description || '',
    };
    if (input.location) {
      body.location = input.location;
    }
    if (Array.isArray(input.attendees) && input.attendees.length > 0) {
      body.attendees = input.attendees.map((a) => (typeof a === 'string' ? { email: a } : a));
    }
    if (input.time) {
      const hms = input.time.length === 5 ? `${input.time}:00` : input.time;
      body.start = { dateTime: `${input.date}T${hms}`, timeZone: tz };
      body.end = { dateTime: `${input.date}T${addOneHour(hms)}`, timeZone: tz };
    } else {
      body.start = { date: input.date };
      body.end = { date: nextDay(input.date) };
    }
    if (typeof input.reminderMinutes === 'number') {
      body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: input.reminderMinutes }] };
    }
    const created = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { id: created.id, htmlLink: created.htmlLink || null };
  }

  /**
   * @description Update an existing event.
   * @param eventId - the Google event id
   * @param input - updated fields
   * @param calendarId - default 'primary'
   * @returns the updated Google event id + htmlLink
   */
  async updateEvent(eventId: string, input: UpdateCalendarEventInput, calendarId = 'primary'): Promise<{ id: string; htmlLink: string | null }> {
    const targetCalendarId = input.calendarId || calendarId;
    const tz = input.timeZone || DEFAULT_TZ;
    const body: any = {};
    if (input.summary !== undefined) body.summary = input.summary;
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (Array.isArray(input.attendees)) {
      body.attendees = input.attendees.map((a) => (typeof a === 'string' ? { email: a } : a));
    }
    if (input.date) {
      if (input.time) {
        const hms = input.time.length === 5 ? `${input.time}:00` : input.time;
        body.start = { dateTime: `${input.date}T${hms}`, timeZone: tz };
        body.end = { dateTime: `${input.date}T${addOneHour(hms)}`, timeZone: tz };
      } else {
        body.start = { date: input.date };
        body.end = { date: nextDay(input.date) };
      }
    }
    if (typeof input.reminderMinutes === 'number') {
      body.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: input.reminderMinutes }] };
    }
    const updated = await this.call(`/calendars/${encodeURIComponent(targetCalendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return { id: updated.id, htmlLink: updated.htmlLink || null };
  }

  /**
   * @description Delete an event by id. A 404/410 (already gone) is treated as
   * success so callers can clear a stale google_event_id idempotently.
   * @param eventId - the Google event id
   * @param calendarId - default 'primary'
   */
  async deleteEvent(eventId: string, calendarId = 'primary'): Promise<void> {
    try {
      await this.call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof GoogleCalendarError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  }
}

/** @description Add one hour to an HH:MM:SS string, clamping at 23:59:59. */
function addOneHour(hms: string): string {
  const [h, m, s] = hms.split(':').map((n) => parseInt(n, 10));
  const total = Math.min(h * 3600 + m * 60 + (s || 0) + 3600, 86399);
  const hh = Math.floor(total / 3600), mm = Math.floor((total % 3600) / 60), ss = total % 60;
  return [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
}

/** @description Return the YYYY-MM-DD date that follows the given date. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
