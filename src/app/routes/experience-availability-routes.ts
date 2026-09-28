/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | GET /api/experience/availability: the signed-in person's busy windows on their primary Google calendar for one bounded window (at most 42 days), read with their own Google connection through the Calendar free/busy query. It answers busy windows only (no titles, attendees or locations), so the central assistant's Calendar view can mark free and busy days without receiving event content. No connection, a refused grant and a provider failure are distinct refusals, never an empty "free" answer. requiresAuth at the mount; the token is resolved from the caller's session sub only.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { GoogleCalendarService, GoogleCalendarError, type CalendarBusyWindow } from '@/features/google-calendar';
import { getValidAccessToken } from './connectors-routes';

const logger = createChildLogger({ module: 'experience-availability-routes' });
const DAY_MS = 86_400_000;
/** Longest window one read may cover: a six-week month grid. */
export const AVAILABILITY_MAX_DAYS = 42;
/** How far back and ahead a window may reach from now. */
const PAST_LIMIT_DAYS = 31;
const FUTURE_LIMIT_DAYS = 400;

/** A validated read window (ISO instants, end exclusive). */
export interface AvailabilityWindow { timeMin: string; timeMax: string; }

/** Collaborators the route needs; the defaults are the caller's connector store and Google's free/busy query. */
export interface AvailabilityDeps {
  pool: Pool;
  /** The caller's Google access token, or null when not connected; throws when the stored grant cannot be renewed. */
  tokenFor?: (sub: string) => Promise<string | null>;
  /** Busy windows on the caller's primary calendar for the window. */
  busyFor?: (token: string, window: AvailabilityWindow) => Promise<CalendarBusyWindow[]>;
  /** Clock for the window bounds (tests pin it). */
  now?: () => Date;
}

const CONNECT_TEXT = 'Connect Google in Utilities with calendar access to see your availability. Until then these days are unknown, not free.';
const RENEW_TEXT = 'Google did not allow a calendar read. Reconnect Google with calendar access in Utilities, then try again. Until then these days are unknown, not free.';
const FAILED_TEXT = 'Google Calendar did not answer, so nothing is known about these days. Try again in a moment.';

/**
 * @description The signed-in person's sub from the session; nothing a client sends can name another person.
 * @param req - Express request (after requiresAuth)
 * @returns The sub, or null when the session carries none
 */
function callerSub(req: Request): string | null {
  const user = (req as { oidc?: { user?: { sub?: unknown } } }).oidc?.user;
  return user && typeof user.sub === 'string' && user.sub ? user.sub : null;
}

/**
 * @description Validate the requested window: both ends parse, the end is after the start, it spans at most
 * AVAILABILITY_MAX_DAYS, and it stays within the planning horizon around now.
 * @param query - The request query (timeMin, timeMax as ISO instants)
 * @param now - The current time
 * @returns The normalised window, or an error sentence for a 400
 */
export function parseAvailabilityWindow(query: Record<string, unknown>, now: Date): AvailabilityWindow | { error: string } {
  const min = new Date(String(query.timeMin ?? '')), max = new Date(String(query.timeMax ?? ''));
  if (!Number.isFinite(min.getTime()) || !Number.isFinite(max.getTime())) return { error: 'timeMin and timeMax must be ISO date-times' };
  if (max.getTime() <= min.getTime()) return { error: 'timeMax must be after timeMin' };
  if (max.getTime() - min.getTime() > AVAILABILITY_MAX_DAYS * DAY_MS) return { error: `A window may cover at most ${AVAILABILITY_MAX_DAYS} days` };
  if (min.getTime() < now.getTime() - PAST_LIMIT_DAYS * DAY_MS || max.getTime() > now.getTime() + FUTURE_LIMIT_DAYS * DAY_MS) {
    return { error: `A window must fall between ${PAST_LIMIT_DAYS} days ago and ${FUTURE_LIMIT_DAYS} days ahead` };
  }
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

/**
 * @description Keep only well-formed windows, clamped to the requested window and ordered by start, so the page
 * never receives anything outside what it asked for.
 * @param busy - Windows as the provider returned them
 * @param window - The validated read window
 * @returns Clamped, ordered busy windows (ISO instants)
 */
export function normalizeBusy(busy: CalendarBusyWindow[], window: AvailabilityWindow): CalendarBusyWindow[] {
  const lo = Date.parse(window.timeMin), hi = Date.parse(window.timeMax);
  return (Array.isArray(busy) ? busy : [])
    .map((b) => ({ s: Date.parse(String(b && b.start)), e: Date.parse(String(b && b.end)) }))
    .filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s && b.e > lo && b.s < hi)
    .map((b) => ({ s: Math.max(b.s, lo), e: Math.min(b.e, hi) }))
    .sort((a, b) => a.s - b.s)
    .map((b) => ({ start: new Date(b.s).toISOString(), end: new Date(b.e).toISOString() }));
}

/**
 * @description Send a refusal the page can show as it is: its state names why the days are unknown.
 * @param res - Express response
 * @param status - HTTP status
 * @param state - Machine state (signed-out, invalid, not-connected, no-access, failed)
 * @param error - The sentence the page shows
 * @returns Nothing; the response is sent
 */
function refuse(res: Response, status: number, state: string, error: string): void {
  res.status(status).json({ state, error });
}

/**
 * @description Map a provider failure to its refusal: a refused or missing grant asks for a reconnect, anything
 * else is a failed read. Never an empty (all free) answer.
 * @param res - Express response
 * @param err - What the free/busy read threw
 * @returns Nothing; the response is sent
 */
function refuseProvider(res: Response, err: unknown): void {
  const status = err instanceof GoogleCalendarError ? err.status : undefined;
  if (status === 401 || status === 403 || status === 404) { refuse(res, 409, 'no-access', RENEW_TEXT); return; }
  refuse(res, 502, 'failed', FAILED_TEXT);
}

/**
 * @description Router for GET /api/experience/availability (mounted behind requiresAuth). Reads the caller's busy
 * windows with the caller's own Google connection; the response carries windows only.
 * @param deps - Pool plus optional collaborators (token lookup, free/busy read, clock)
 * @returns The Express router
 */
export function createExperienceAvailabilityRoutes(deps: AvailabilityDeps): Router {
  const router = Router();
  const tokenFor = deps.tokenFor ?? ((sub: string) => getValidAccessToken(deps.pool, sub, 'google'));
  const busyFor = deps.busyFor ?? ((token: string, window: AvailabilityWindow) => new GoogleCalendarService(async () => token).freeBusy({ calendarId: 'primary', ...window }));
  const now = deps.now ?? (() => new Date());

  router.get('/', async (req: Request, res: Response) => {
    const started = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    const sub = callerSub(req);
    if (!sub) { refuse(res, 401, 'signed-out', 'not_authenticated'); return; }
    const window = parseAvailabilityWindow(req.query as Record<string, unknown>, now());
    if ('error' in window) { refuse(res, 400, 'invalid', window.error); return; }
    logger.info({ op: 'availability', days: Math.round((Date.parse(window.timeMax) - Date.parse(window.timeMin)) / DAY_MS) }, 'availability read started');
    let token: string | null;
    try { token = await tokenFor(sub); } catch (err) {
      logger.error({ err, op: 'availability', outcome: 'token-unrenewable' }, 'availability: Google grant could not be renewed');
      refuse(res, 409, 'no-access', RENEW_TEXT); return;
    }
    if (!token) { logger.info({ op: 'availability', outcome: 'not-connected', ms: Date.now() - started }, 'availability read finished'); refuse(res, 409, 'not-connected', CONNECT_TEXT); return; }
    try {
      const busy = normalizeBusy(await busyFor(token, window), window);
      logger.info({ op: 'availability', outcome: 'ready', windows: busy.length, ms: Date.now() - started }, 'availability read finished');
      res.json({ state: 'ready', source: 'google-calendar', calendar: 'primary', ...window, checkedAt: new Date().toISOString(), busy });
    } catch (err) {
      logger.error({ err, op: 'availability', outcome: 'provider-failed', ms: Date.now() - started }, 'availability: free/busy read failed');
      refuseProvider(res, err);
    }
  });
  return router;
}
