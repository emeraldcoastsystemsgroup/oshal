/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial RCA analysis routes for rca-specialist bot
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | No-mock remediation: the route ran the engine's hardcoded placeholder analyzers. It now wires the REAL path — an RcaExecutor closure over executeBotOrInline dispatching to the rca-specialist bot (ADR-036 direct sync call: budget-gated, cost auto-tracked in chat_tasks, caller's sub threaded for accountability) — and maps the engine's honest failures: RcaEngineDisabledError → 501, RcaEngineUnavailableError → 503. createRcaRoutes now takes AppContext (server.ts registration updated in the same change).
 */

import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { RcaEngine, RcaEngineDisabledError, RcaEngineUnavailableError } from '@/features/rca-analysis';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import type { AppContext } from '@/app/composition/app-context';
import { executeBotOrInline } from '@/app/routes/inline-bot-execution';
import type { RcaAnalysisRequest, RcaMethod } from '@/shared/types';

const logger = createChildLogger({ module: 'rca-routes' });

/** The rca-specialist dedicated analysis node (swarm-bot-registry: a…0016). */
const RCA_SPECIALIST_AGENT_ID = process.env.RCA_SPECIALIST_AGENT_ID?.trim()
  || 'a0000000-0000-0000-0000-000000000016';

const botClient = new BotNodeClient(createRegistryEndpointResolver());

const VALID_METHODS: RcaMethod[] = ['five-whys', 'fishbone', 'fault-tree'];

/**
 * @description Creates routes for the RCA analysis engine.
 * POST /api/rca/analyze — Submit an incident for root cause analysis. The
 * analysis runs on the rca-specialist bot (never inline on the controller);
 * when the bot is unreachable the route returns an honest 503 — never
 * placeholder results.
 *
 * @param ctx - App context (pool for the budget gate + inline orchestrator fallback)
 * @returns Express Router with RCA endpoints
 */
export function createRcaRoutes(ctx: AppContext): Router {
  const router = Router();

  /**
   * @openapi
   * /api/rca/analyze:
   *   post:
   *     summary: Submit an incident for RCA analysis
   *     tags: [RCA]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [incidentId, description, method]
   *             properties:
   *               incidentId:
   *                 type: string
   *               description:
   *                 type: string
   *               method:
   *                 type: string
   *                 enum: [five-whys, fishbone, fault-tree]
   *               severity:
   *                 type: string
   *                 enum: [low, medium, high, critical]
   *     responses:
   *       200:
   *         description: RCA analysis result
   *       400:
   *         description: Invalid request
   *       501:
   *         description: Engine disabled (RCA_ENGINE_MODE=disabled)
   *       503:
   *         description: Analysis bot unreachable or returned no usable verdict
   */
  router.post('/analyze', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const body = req.body as Partial<RcaAnalysisRequest>;

      if (!body.incidentId || !body.description || !body.method) {
        logger.warn({ bodyKeys: Object.keys(req.body ?? {}) }, 'Invalid RCA request — missing required fields');
        res.status(400).json({
          error: 'Missing required fields: incidentId, description, method',
        });
        return;
      }

      if (!VALID_METHODS.includes(body.method)) {
        logger.warn({ method: body.method }, 'Invalid RCA method');
        res.status(400).json({
          error: `Invalid method. Must be one of: ${VALID_METHODS.join(', ')}`,
        });
        return;
      }

      const request: RcaAnalysisRequest = {
        incidentId: body.incidentId,
        description: body.description,
        method: body.method,
        payload: body.payload,
        severity: body.severity,
      };

      // The caller's sub scopes budget accountability + the bot's per-user data
      // access; absent (service callers) the dispatch runs as a system call.
      const userSub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub;
      const taskId = `rca-${request.incidentId}-${Date.now()}`;

      // ADR-036: the bot owns the reasoning. executeBotOrInline is the budget-gated
      // chokepoint — cost lands in chat_tasks against the rca-specialist node.
      const engine = new RcaEngine(async (prompt) => {
        const result = await executeBotOrInline(ctx, botClient, RCA_SPECIALIST_AGENT_ID, {
          text: prompt,
          taskId,
          workspaceFolderId: taskId,
          agentId: RCA_SPECIALIST_AGENT_ID,
          agenticMode: true,
          direct: true,
          userSub,
        });
        return result.response;
      });

      const result = await engine.analyze(request);
      const durationMs = Date.now() - startTime;

      logger.info({ incidentId: request.incidentId, durationMs }, 'RCA analysis request completed');
      res.json(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;
      if (error instanceof RcaEngineDisabledError) {
        logger.warn({ durationMs }, 'RCA analysis requested while engine disabled');
        res.status(501).json({ error: error.message });
        return;
      }
      if (error instanceof RcaEngineUnavailableError) {
        // A dispatch failure can be a governance decision, not an outage — the engine flattens the
        // executor's throw into RcaEngineUnavailableError, so recover the real cause here: a budget
        // breach is 429 (retry later), an entitlement denial is 403, only a genuine bot outage is 503.
        const detail = error.message.toLowerCase();
        if (detail.includes('budget governance')) {
          logger.warn({ err: error, durationMs }, 'RCA analysis blocked by budget governance');
          res.status(429).json({ error: 'RCA analysis blocked by spend governance — retry after the budget window resets' });
          return;
        }
        if (detail.includes('entitle') || detail.includes('not authorized') || detail.includes('forbidden')) {
          logger.warn({ err: error, durationMs }, 'RCA analysis denied by entitlement gate');
          res.status(403).json({ error: 'Not authorized to run RCA analysis on this bot' });
          return;
        }
        logger.error({ err: error, durationMs }, 'RCA analysis engine unavailable');
        res.status(503).json({ error: error.message });
        return;
      }
      logger.error({ err: error, durationMs }, 'RCA analysis request failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
