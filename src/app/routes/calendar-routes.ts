/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Express router for /api/calendar: full CRUD for Google Calendar meetings and events (list, get, create, update, delete) using the caller's personal Google OAuth connection.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  GoogleCalendarService,
  GoogleCalendarError,
  type CreateCalendarEventInput,
  type UpdateCalendarEventInput,
} from '@/features/google-calendar';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'calendar-routes' });

export interface CalendarRoutesDeps {
  pool: Pool;
  tokenFor?: (sub: string) => Promise<string | null>;
  calendarServiceFor?: (token: string) => GoogleCalendarService;
}

function callerSub(req: Request): string | null {
  const user = (req as { oidc?: { user?: { sub?: unknown } } }).oidc?.user;
  return user && typeof user.sub === 'string' && user.sub ? user.sub : null;
}

/**
 * @description Creates the router for /api/calendar. Mounted behind requiresAuth.
 * Supports reading, creating, updating, and deleting Google Calendar meetings.
 */
export function createCalendarRoutes(deps: CalendarRoutesDeps): Router {
  const router = Router();
  const tokenFor = deps.tokenFor ?? ((sub: string) => getValidAccessToken(deps.pool, sub, 'google', { tenantId: 'personal' }));
  const calendarServiceFor = deps.calendarServiceFor ?? ((token: string) => new GoogleCalendarService(async () => token));

  async function resolveService(req: Request, res: Response): Promise<GoogleCalendarService | null> {
    const sub = callerSub(req);
    if (!sub) {
      res.status(401).json({ ok: false, error: 'not_authenticated' });
      return null;
    }
    let token: string | null = null;
    try {
      token = await tokenFor(sub);
    } catch (err: any) {
      logger.error({ err, sub }, 'Failed to resolve Google access token for calendar');
      res.status(409).json({ ok: false, error: 'token_renewal_failed', details: err?.message || String(err) });
      return null;
    }
    if (!token) {
      res.status(409).json({ ok: false, error: 'not_connected', message: 'Connect Google in Utilities to access Google Calendar' });
      return null;
    }
    return calendarServiceFor(token);
  }

  function handleCalendarError(res: Response, err: unknown, op: string) {
    if (err instanceof GoogleCalendarError) {
      logger.error({ err: err.message, status: err.status, op }, 'Google Calendar API error');
      res.status(err.status || 502).json({ ok: false, error: err.message, status: err.status });
      return;
    }
    logger.error({ err, op }, 'Unexpected error in calendar operation');
    res.status(500).json({ ok: false, error: 'internal_calendar_error', details: String(err) });
  }

  // GET /api/calendar/events - list upcoming events
  router.get('/events', async (req: Request, res: Response) => {
    const service = await resolveService(req, res);
    if (!service) return;

    try {
      const { calendarId, timeMin, timeMax, maxResults } = req.query;
      const events = await service.listUpcoming({
        calendarId: calendarId ? String(calendarId) : undefined,
        timeMin: timeMin ? String(timeMin) : undefined,
        timeMax: timeMax ? String(timeMax) : undefined,
        maxResults: maxResults ? parseInt(String(maxResults), 10) : undefined,
      });
      res.json({ ok: true, events });
    } catch (err) {
      handleCalendarError(res, err, 'listUpcoming');
    }
  });

  // GET /api/calendar/events/:id - get single event
  router.get('/events/:id', async (req: Request, res: Response) => {
    const service = await resolveService(req, res);
    if (!service) return;

    try {
      const eventId = String(req.params.id);
      const calendarId = req.query.calendarId ? String(req.query.calendarId) : 'primary';
      const event = await service.getEvent(eventId, calendarId);
      res.json({ ok: true, event });
    } catch (err) {
      handleCalendarError(res, err, 'getEvent');
    }
  });

  // POST /api/calendar/events - create new meeting / event
  router.post('/events', async (req: Request, res: Response) => {
    const service = await resolveService(req, res);
    if (!service) return;

    const body = req.body as Partial<CreateCalendarEventInput>;
    if (!body || typeof body.summary !== 'string' || !body.summary.trim()) {
      res.status(400).json({ ok: false, error: 'summary is required' });
      return;
    }
    if (!body.date || typeof body.date !== 'string') {
      res.status(400).json({ ok: false, error: 'date (YYYY-MM-DD) is required' });
      return;
    }

    try {
      const result = await service.createEvent(body as CreateCalendarEventInput);
      res.status(201).json({ ok: true, eventId: result.id, htmlLink: result.htmlLink });
    } catch (err) {
      handleCalendarError(res, err, 'createEvent');
    }
  });

  // PATCH /api/calendar/events/:id - update existing meeting / event
  router.patch('/events/:id', async (req: Request, res: Response) => {
    const service = await resolveService(req, res);
    if (!service) return;

    const eventId = String(req.params.id);
    const body = req.body as UpdateCalendarEventInput;
    const calendarId = req.query.calendarId ? String(req.query.calendarId) : 'primary';

    try {
      const result = await service.updateEvent(eventId, body, calendarId);
      res.json({ ok: true, eventId: result.id, htmlLink: result.htmlLink });
    } catch (err) {
      handleCalendarError(res, err, 'updateEvent');
    }
  });

  // DELETE /api/calendar/events/:id - delete meeting / event
  router.delete('/events/:id', async (req: Request, res: Response) => {
    const service = await resolveService(req, res);
    if (!service) return;

    const eventId = String(req.params.id);
    const calendarId = req.query.calendarId ? String(req.query.calendarId) : 'primary';

    try {
      await service.deleteEvent(eventId, calendarId);
      res.json({ ok: true, deleted: true, eventId });
    } catch (err) {
      handleCalendarError(res, err, 'deleteEvent');
    }
  });

  return router;
}
