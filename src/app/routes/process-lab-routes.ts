/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Process Lab routes for non-invasive lifecycle scenario runs and trace inspection
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '@/app/composition-root';
import { ProcessLabService } from '@/features/process-lab';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'process-lab-routes' });

const StartRunSchema = z.object({
  scenarioId: z.string().min(1),
  overrides: z.object({
    autoApproveBuild: z.boolean().optional(),
    completionWaitMs: z.number().int().min(30_000).max(30 * 60_000).optional(),
    description: z.string().min(1).max(20_000).optional(),
    planningWaitMs: z.number().int().min(30_000).max(20 * 60_000).optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
    title: z.string().min(1).max(300).optional(),
  }).optional(),
});

const RunListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const RunParamSchema = z.object({
  runId: z.string().uuid(),
});

/**
 * @description Builds the Express router exposing read-only Process Lab endpoints so operators can list lifecycle scenarios, enumerate prior runs, trigger a non-invasive scenario run, and inspect a single run's trace without affecting live ticket processing. Wires a fresh ProcessLabService from the shared application context.
 * @param ctx Application context supplying provider access, swarm services, ticket/workspace services, and the work item repository the service depends on.
 * @returns A configured Express Router with GET /scenarios, GET /runs, POST /runs, and GET /runs/:runId handlers.
 */
export function createProcessLabRoutes(ctx: AppContext): Router {
  const router = Router();
  const service = new ProcessLabService({
    getProvider: ctx.getProvider,
    swarmTicketProcessingService: ctx.swarm.swarmTicketProcessingService,
    ticketService: ctx.ticketService,
    workItemRepository: ctx.swarm.workItemRepository,
    workspaceService: ctx.workspaceService,
  });

  router.get('/scenarios', (_req: Request, res: Response) => {
    const scenarios = service.listScenarios();
    res.json({
      count: scenarios.length,
      scenarios,
      success: true,
    });
  });

  router.get('/runs', (req: Request, res: Response) => {
    const { limit } = RunListQuerySchema.parse(req.query);
    const runs = service.listRuns(limit);
    res.json({
      count: runs.length,
      runs,
      success: true,
    });
  });

  router.post('/runs', (req: Request, res: Response) => {
    try {
      const input = StartRunSchema.parse(req.body ?? {});
      const run = service.startRun(input);
      logger.info({ runId: run.runId, scenarioId: run.scenario.id }, 'Process Lab run started');
      res.status(202).json({
        run,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start Process Lab run';
      logger.warn({ err: error }, 'Process Lab run start rejected');
      res.status(400).json({
        error: message,
        success: false,
      });
    }
  });

  router.get('/runs/:runId', (req: Request, res: Response) => {
    const { runId } = RunParamSchema.parse(req.params);
    const run = service.getRun(runId);
    if (!run) {
      res.status(404).json({
        error: `Process Lab run not found: ${runId}`,
        success: false,
      });
      return;
    }

    res.json({
      run,
      success: true,
    });
  });

  return router;
}
