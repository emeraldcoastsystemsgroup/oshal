/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added ops intelligence API routes for cost, metrics, audit, watchdog, feedback, and mesh breakout
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fix /metrics to query DB (work_items) instead of in-memory — host server has no in-process executions so getRankedMetrics() always returned []
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { SwarmExtensionBindings } from '../index';

const logger = createChildLogger({ module: 'ops-intelligence-routes' });

/**
 * @description Creates Express router for operational intelligence API endpoints.
 * @param bindings - Swarm extension bindings containing ops intelligence services
 * @returns Express router mounted at /api/swarm/ops
 */
export function createOpsIntelligenceRoutes(bindings: SwarmExtensionBindings): Router {
  const router = Router();

  // ── Cost Tracking ───────────────────────────────────────────────
  router.get('/costs', (_req: Request, res: Response) => {
    logger.info('GET /api/swarm/ops/costs');
    const summary = bindings.costTrackingService?.getSummary();
    res.json({ ok: true, data: summary ?? null });
  });

  router.get('/costs/recent', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit) || '20', 10);
    logger.info({ limit }, 'GET /api/swarm/ops/costs/recent');
    const events = bindings.costTrackingService?.getRecentEvents(limit) ?? [];
    res.json({ ok: true, data: events });
  });

  // ── Agent Metrics ───────────────────────────────────────────────
  // Query work_items table for durable metrics — in-memory events on the host
  // server are always empty because actual task executions happen in bot containers.
  router.get('/metrics', async (_req: Request, res: Response) => {
    logger.info('GET /api/swarm/ops/metrics');
    try {
      const metrics = bindings.agentMetricsService
        ? await bindings.agentMetricsService.queryFromDB()
        : [];
      res.json({ ok: true, data: metrics });
    } catch (err) {
      logger.error({ err }, 'Failed to query agent metrics');
      res.status(500).json({ ok: false, error: 'Failed to query metrics' });
    }
  });

  router.get('/metrics/:agentId', async (req: Request, res: Response) => {
    const agentId = String(req.params.agentId);
    logger.info({ agentId }, 'GET /api/swarm/ops/metrics/:agentId');
    try {
      const metrics = bindings.agentMetricsService
        ? await bindings.agentMetricsService.queryFromDB(agentId)
        : [];
      res.json({ ok: true, data: metrics[0] ?? null });
    } catch (err) {
      logger.error({ err, agentId }, 'Failed to query agent metrics');
      res.status(500).json({ ok: false, error: 'Failed to query metrics' });
    }
  });

  // ── Competency Rankings ─────────────────────────────────────────
  router.get('/rankings', (_req: Request, res: Response) => {
    logger.info('GET /api/swarm/ops/rankings');
    const rankings = bindings.competencyRanker?.rankAll() ?? [];
    res.json({ ok: true, data: rankings });
  });

  // ── Routing Audit Log ───────────────────────────────────────────
  router.get('/audit', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit) || '50', 10);
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const strategy = typeof req.query.strategy === 'string' ? req.query.strategy : undefined;
    logger.info({ limit, agentId, strategy }, 'GET /api/swarm/ops/audit');
    const entries = bindings.routingAuditLog?.query({ agentId, strategy, limit }) ?? [];
    res.json({ ok: true, data: entries });
  });

  router.get('/audit/distribution', (_req: Request, res: Response) => {
    logger.info('GET /api/swarm/ops/audit/distribution');
    const dist = bindings.routingAuditLog?.getStrategyDistribution() ?? {};
    res.json({ ok: true, data: dist });
  });

  // ── Stuck Agent Watchdog ────────────────────────────────────────
  router.get('/watchdog/actions', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit) || '50', 10);
    logger.info({ limit }, 'GET /api/swarm/ops/watchdog/actions');
    const actions = bindings.stuckAgentWatchdog?.getActions(limit) ?? [];
    res.json({ ok: true, data: actions });
  });

  router.post('/watchdog/check', async (_req: Request, res: Response) => {
    logger.info('POST /api/swarm/ops/watchdog/check');
    try {
      const stuck = await bindings.stuckAgentWatchdog?.check() ?? [];
      res.json({ ok: true, data: stuck });
    } catch (err) {
      logger.error({ err }, 'Watchdog manual check failed');
      res.status(500).json({ ok: false, error: 'Watchdog check failed' });
    }
  });

  // ── Human Feedback ──────────────────────────────────────────────
  router.post('/feedback', async (req: Request, res: Response) => {
    logger.info({ body: req.body }, 'POST /api/swarm/ops/feedback');
    try {
      await bindings.feedbackLoopService?.submitFeedback(req.body);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Feedback submission failed');
      res.status(500).json({ ok: false, error: 'Feedback submission failed' });
    }
  });

  router.get('/feedback', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit) || '20', 10);
    logger.info({ limit }, 'GET /api/swarm/ops/feedback');
    const feedback = bindings.feedbackLoopService?.getRecentFeedback(limit) ?? [];
    res.json({ ok: true, data: feedback });
  });

  router.get('/feedback/stats', (_req: Request, res: Response) => {
    logger.info('GET /api/swarm/ops/feedback/stats');
    const stats = bindings.feedbackLoopService?.getAllStats() ?? [];
    res.json({ ok: true, data: stats });
  });

  // ── Breakout Channels ───────────────────────────────────────────
  router.get('/channels', (_req: Request, res: Response) => {
    logger.info('GET /api/swarm/ops/channels');
    const channels = bindings.privateMeshManager?.getActiveChannels() ?? [];
    res.json({ ok: true, data: channels });
  });

  return router;
}
