/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial /api/trace surface for the run-trace read-model: GET /api/trace/:ticketId (JSON waterfall) + GET /api/trace/:ticketId.html (a self-contained rendered waterfall) + GET /api/trace/app (the cockpit tool shell). Auth-gated via the requiresAuth param (the sanctioned factory pattern, mirroring budget-routes.ts). Every read is caller-scoped in TraceService by owner_sub — a non-operator can only trace a ticket they own, and a ticket they can't see returns the SAME not-found as a missing one (no existence leak).
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import { TraceService, renderTraceHtml } from '@/features/run-trace';

const logger = createChildLogger({ module: 'trace-routes' });

/** @description Dependencies for the trace routes. `service` is injectable for tests. */
export interface TraceRoutesDeps {
  pool: Pool | null;
  service?: TraceService;
}

/**
 * @description Builds the /api/trace router (mount: `app.use('/api/trace', createTraceRoutes(requiresAuth, { pool: ctx.pool }))`).
 * Every endpoint sits behind `requiresAuth`; per-ticket ownership is enforced inside TraceService
 * (operator sees any; a user sees only a ticket they own), so the authorization rule holds for
 * every transport (JSON, rendered HTML) without duplication.
 * @param requiresAuth - The app-level OIDC auth middleware (sanctioned param pattern).
 * @param deps - Postgres pool (null tolerated: getTrace resolves null → 404, never 500s a cockpit).
 * @returns The configured Express router.
 */
export function createTraceRoutes(requiresAuth: RequestHandler, deps: TraceRoutesDeps): Router {
  const router = Router();
  const service = deps.service ?? new TraceService(deps.pool);
  router.use(requiresAuth);

  // Cockpit tool shell (a static page that fetches the JSON for an entered ticket id). Declared
  // BEFORE the /:ticketId param routes so the literal 'app' is not swallowed as a ticket id.
  router.get('/app', (_req: Request, res: Response) => {
    const filePath = path.resolve(process.cwd(), 'src/pages/run-trace/index.html');
    res.sendFile(filePath, (err: unknown) => {
      if (err) {
        logger.error({ err }, 'GET /api/trace/app: failed to send surface');
        if (!res.headersSent) res.status(500).send('Run-trace surface unavailable');
      }
    });
  });

  // Rendered waterfall for quick viewing (the demo path). :ticketId captures up to the .html suffix.
  router.get('/:ticketId.html', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const trace = await loadTraceFor(service, req);
      if (!trace) {
        res.status(404).type('html').send(notFoundHtml());
        return;
      }
      logger.info({ ticketId: trace.ticket.id, spans: trace.spans.length, durationMs: Date.now() - startedAt }, 'GET /api/trace/:ticketId.html');
      res.type('html').send(renderTraceHtml(trace));
    } catch (err) {
      logger.error({ err }, 'GET /api/trace/:ticketId.html failed');
      res.status(500).type('html').send('<p>Failed to render trace</p>');
    }
  });

  // JSON waterfall.
  router.get('/:ticketId', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const trace = await loadTraceFor(service, req);
      if (!trace) {
        res.status(404).json({ success: false, error: 'Trace not found' });
        return;
      }
      logger.info({ ticketId: trace.ticket.id, spans: trace.spans.length, durationMs: Date.now() - startedAt }, 'GET /api/trace/:ticketId');
      res.json({ success: true, trace });
    } catch (err) {
      logger.error({ err }, 'GET /api/trace/:ticketId failed');
      res.status(500).json({ success: false, error: 'Failed to assemble trace' });
    }
  });

  return router;
}

/**
 * @description Resolves the caller from the validated OIDC session and assembles the trace for the
 * requested ticket. Identity is read ONLY from req.oidc (getCaller/isOperator) — never from the
 * path/query — so a caller cannot trace another user's ticket by supplying a foreign sub.
 * @param service - The TraceService instance.
 * @param req - The authenticated Express request (`:ticketId` from the path).
 * @returns The trace, or null when the ticket is missing / not the caller's / the id is malformed.
 */
async function loadTraceFor(service: TraceService, req: Request): Promise<Awaited<ReturnType<TraceService['getTrace']>>> {
  const { sub } = getCaller(req);
  const ticketId = String(req.params.ticketId ?? '').trim();
  return service.getTrace(ticketId, sub, isOperator(req));
}

/** @description Minimal not-found HTML (same body whether the ticket is missing or not the caller's). */
function notFoundHtml(): string {
  return '<!doctype html><meta charset="utf-8"><title>Trace not found</title><body style="font:14px sans-serif;padding:24px"><h1>Trace not found</h1><p>No trace is available for that ticket.</p></body>';
}
