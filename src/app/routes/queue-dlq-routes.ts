/**
 * Queue dead-letter routes — the operator surface over the DLQ (migration 081).
 *
 *   GET  /api/queue/dlq                     — quarantined poison tickets (+?all=true for
 *                                             tickets still accumulating attempts)
 *   GET  /api/queue/dlq/export              — downloadable JSON of the dead-lettered envelopes
 *                                             (ops-rails export; +?all=true includes accumulating)
 *   POST /api/queue/dlq/:ticketId/requeue   — release one back to 'approved' (attempts reset,
 *                                             acting operator recorded in requeued_by/requeued_at
 *                                             AND the actor-aware status history row)
 *
 * Every route is requiresAuth + requiresOperator (fail-closed allowlist): the DLQ exposes
 * other users' ticket titles/failures and requeue re-triggers swarm work, so it is never a
 * basic-user surface. Also exports buildQueueDlqOperatorNotifier — the quarantine alert
 * sender the swarm extension injects into the DeadLetterService: it fans the topic
 * 'queue-dlq' out to every OSHAL_OPERATOR_SUBS account through the notification-center
 * NotificationRouter (each operator's own channel prefs + quiet hours apply) and always
 * also fires the env-configured operator transport harness as the deployment-level fallback.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — operator DLQ list + requeue routes over DeadLetterService (requiresAuth param + requiresOperator, the sanctioned factory pattern) and the queue-dlq operator notifier over the notification-center router.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Ops-rails export: GET /api/queue/dlq/export — a requiresOperator-gated, downloadable JSON export of the dead-lettered envelopes over the SAME DeadLetterService (no second surface). Read-only; sets an attachment Content-Disposition and wraps the entries with export metadata (exportedAt/exportedBy/count).
 *
 * @module queue-dlq-routes
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import { DeadLetterService, type DeadLetterNotifier } from '@/features/swarm-orchestration';
import { notifyOperator } from '@/features/notifications';
import type { TicketService } from '@/features/ticketing';
import type { AppContext } from '@/app/composition/app-context';
import { buildNotificationRouter } from './notify-routes';

const logger = createChildLogger({ module: 'queue-dlq-routes' });

/** Ticket ids are UUIDs; reject junk before it reaches SQL params or logs. */
const TICKET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description Builds the quarantine alert sender for the DeadLetterService: fans the
 * 'queue-dlq' topic out to every OSHAL_OPERATOR_SUBS account through the per-user
 * NotificationRouter (their saved channel/quiet-hours prefs apply; an unconnected operator
 * is a clean logged skip) and ALWAYS also fires the env-configured operator transport
 * harness (notifyOperator — a no-op when no transport is configured) so a deployment with
 * no per-user prefs still gets the alert somewhere.
 * @param pool - Postgres pool (the only AppContext member the router construction reads).
 * @returns A DeadLetterNotifier for DeadLetterServiceDeps.notify.
 */
export function buildQueueDlqOperatorNotifier(pool: Pool): DeadLetterNotifier {
  // buildNotificationRouter only reads ctx.pool (documented on the builder); the cast keeps
  // this callable from the swarm extension, which has a pool but no full AppContext.
  const router = buildNotificationRouter({ pool } as AppContext);
  return async (topic, message) => {
    const operatorSubs = (process.env.OSHAL_OPERATOR_SUBS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sub of operatorSubs) {
      try {
        const outcome = await router.notify(sub, topic, message);
        logger.info({ topic, delivered: outcome.delivered, channel: outcome.channel, reason: outcome.reason }, 'DLQ operator notification routed');
      } catch (err) {
        // router.notify never throws by contract; this is a last-resort guard.
        logger.error({ err, stack: (err as Error).stack, topic }, 'DLQ operator notification failed unexpectedly');
      }
    }
    if (operatorSubs.length === 0) {
      logger.warn({ topic }, 'OSHAL_OPERATOR_SUBS is empty — DLQ alert goes to the operator transport harness only');
    }
    // Deployment-level fallback channel (Telegram/Twilio env transports; no-op unconfigured).
    return notifyOperator({ text: `${message.subject}\n\n${message.body}` }).catch((err) => {
      logger.error({ err, stack: (err as Error).stack, topic }, 'DLQ operator-transport fallback send failed (non-fatal)');
      return null;
    });
  };
}

/** @description Dependencies for the route factory — mirrors createBudgetRoutes. */
export interface QueueDlqRoutesDeps {
  /** Postgres pool for the oshal_queue_dlq table. */
  pool: Pool;
  /** The app's TicketService so requeue goes through validated transitions. */
  ticketService: TicketService;
}

/**
 * @description Builds the /api/queue/dlq router (mount:
 * `app.use('/api/queue/dlq', createQueueDlqRoutes(requiresAuth, { pool: ctx.pool, ticketService: ctx.ticketService }))`).
 * Constructs its own DeadLetterService over the shared DB state (the quarantining instance
 * lives in the swarm extension; both read/write the same oshal_queue_dlq rows, and this one
 * never attaches the escalation listener). Every route is requiresAuth + requiresOperator.
 * @param requiresAuth - OIDC auth middleware from server.ts (sanctioned factory pattern).
 * @param deps - Pool + TicketService.
 * @returns Router to mount at /api/queue/dlq.
 */
export function createQueueDlqRoutes(requiresAuth: RequestHandler, deps: QueueDlqRoutesDeps): Router {
  const router = Router();
  const service = new DeadLetterService({
    pool: deps.pool,
    ticketService: deps.ticketService,
    // The route-side instance never quarantines (list/requeue only) — no notifier needed.
  });

  router.get('/', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const includeAll = String(req.query.all || '') === 'true';
    try {
      const entries = await service.listEntries(includeAll);
      logger.info({ count: entries.length, includeAll, durationMs: Date.now() - startedAt }, 'DLQ listed');
      res.json({ entries, includeAll });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'DLQ list failed');
      res.status(500).json({ error: 'dlq list failed' });
    }
  });

  // Operator-only downloadable export of the dead-lettered envelopes (ops-rails). Read-only over
  // the SAME DeadLetterService.listEntries — not a second DLQ surface. Quarantined-only by default;
  // ?all=true also exports tickets still accumulating attempts. Wrapped with export metadata and an
  // attachment Content-Disposition so a browser saves it as a file.
  router.get('/export', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const includeAll = String(req.query.all || '') === 'true';
    try {
      const entries = await service.listEntries(includeAll);
      const { sub, email } = getCaller(req);
      const exportedBy = email ?? sub ?? 'operator';
      const exportedAt = new Date().toISOString();
      const payload = {
        kind: 'oshal-queue-dlq-export',
        version: 1,
        exportedAt,
        exportedBy,
        includeAll,
        count: entries.length,
        entries,
      };
      const filename = `oshal-dlq-export-${exportedAt.replace(/[:.]/g, '-')}.json`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      logger.info({ count: entries.length, includeAll, exportedBy, durationMs: Date.now() - startedAt }, 'DLQ exported');
      res.status(200).send(JSON.stringify(payload, null, 2));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'DLQ export failed');
      res.status(500).json({ error: 'dlq export failed' });
    }
  });

  router.post('/:ticketId/requeue', requiresAuth, requiresOperator, async (req: Request, res: Response) => {
    const startedAt = Date.now();
    const ticketId = String(req.params.ticketId || '');
    if (!TICKET_ID_RE.test(ticketId)) {
      res.status(400).json({ error: 'ticketId must be a UUID' });
      return;
    }
    // Identity from the validated OIDC session ONLY — never from the body.
    const { sub, email } = getCaller(req);
    const requeuedBy = email ?? sub ?? 'operator';
    try {
      const result = await service.requeue(ticketId, requeuedBy);
      logger.info({ ticketId, requeuedBy, ok: result.ok, durationMs: Date.now() - startedAt }, 'DLQ requeue handled');
      if (result.ok) {
        res.json({ ok: true, entry: result.entry });
        return;
      }
      const status = result.error === 'not-found' ? 404 : result.error === 'invalid-state' ? 409 : 503;
      res.status(status).json({ ok: false, error: result.error });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack, ticketId, requeuedBy }, 'DLQ requeue failed');
      res.status(500).json({ error: 'dlq requeue failed' });
    }
  });

  return router;
}
