/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | WS1: Created debug routes — runtime trace analyzer endpoint for operator observability of phase/round execution history
 */

import type { Request, RequestHandler, Response, Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { RuntimeTraceAnalyzerService } from '@/features/swarm-orchestration';

const logger = createChildLogger({ module: 'debug-routes' });

/**
 * @description Registers debug/observability routes for runtime trace inspection.
 *
 * Endpoints:
 * - GET /api/debug/tickets/:ticketId/trace?workspaceTaskId=<uuid>
 *   Returns a structured trace report for one ticket across all cline runtime task folders.
 *   Flags persona misbinding, missing review completions, and regression handoffs.
 *
 * @param router - Express router to register routes on.
 * @param requiresAuth - OIDC auth middleware. Required because the trace endpoint
 *   exposes workspace paths, file content, and persona/handoff details — same
 *   sensitivity as other observability/admin APIs.
 */
export function registerDebugRoutes(router: Router, requiresAuth: RequestHandler): void {
  const analyzer = new RuntimeTraceAnalyzerService();

  /**
   * @route GET /api/debug/tickets/:ticketId/trace
   * @description Returns the runtime trace report for a ticket.
   * @param ticketId - Ticket external ID (e.g. "PROJ-123")
   * @param workspaceTaskId - Workspace task folder UUID (query param, required)
   */
  router.get('/api/debug/tickets/:ticketId/trace', requiresAuth, (req: Request, res: Response) => {
    const ticketId = typeof req.params['ticketId'] === 'string' ? req.params['ticketId'] : '';
    const rawWsId = req.query['workspaceTaskId'];
    const workspaceTaskId = typeof rawWsId === 'string' ? rawWsId : '';
    logger.info({ ticketId, workspaceTaskId }, 'Debug trace route invoked');

    if (!workspaceTaskId) {
      res.status(400).json({ error: 'workspaceTaskId query param is required' });
      return;
    }

    try {
      const report = analyzer.buildTicketTraceReport(ticketId, workspaceTaskId);
      res.json({
        ok: true,
        ticketId,
        workspaceTaskId,
        traceCount: report.traceCount,
        anomalyCount: report.anomalies.length,
        regressionCount: report.regressionHandoffs.length,
        report,
      });
    } catch (err) {
      logger.error({ err, ticketId, workspaceTaskId }, 'Runtime trace analysis failed');
      res.status(500).json({ error: 'Trace analysis failed', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}
