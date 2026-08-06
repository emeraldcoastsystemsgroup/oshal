/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added OSHAL-native task explorer API routes for hierarchy, metrics, activity, and workspace browsing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized wildcard route parameter handling after Session 68 task-explorer service decomposition
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | CM-3: Added /explorer/tickets/:ticketId/status-history endpoint for Process tab
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Passed exact authenticated identity and explicit operator authority into workspace browse, tree, and preview handlers before filesystem resolution.
 */

import { Router, type Request, type Response } from 'express';
import { TaskExplorerService } from '@/features/task-explorer';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator } from '@/shared/middleware/authz';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'task-explorer-routes' });

/**
 * @description Creates Express routes for the OSHAL-native task explorer surface.
 *
 * @param ctx - Application context with task, message, and workspace services
 * @returns Express router with task explorer endpoints
 */
export function createTaskExplorerRoutes(ctx: AppContext): Router {
  const router = Router();
  const service = new TaskExplorerService(ctx.taskStore, ctx.messageStore, ctx.workspaceService);

  router.get('/projects', createProjectsHandler(service));
  router.get('/tickets/hierarchy', createHierarchyHandler(service));
  router.get('/tickets/:ticketId/activity', createActivityHandler(service));
  router.get('/metrics/summary', createMetricsHandler(service));
  router.get('/workspace/browse', createBrowseHandler(service));
  router.get('/workspace/:ticketId/files/*filePath', createWorkspaceFileHandler(service));
  router.get('/workspace/:ticketId/files', createWorkspaceTreeHandler(service));

  // Status history for Process tab — namespaced under /explorer/ to avoid cockpit route shadowing
  router.get('/explorer/tickets/:ticketId/status-history', createStatusHistoryHandler(ctx));

  logger.info('Task explorer routes registered');
  return router;
}

function createProjectsHandler(service: TaskExplorerService) {
  return async (_req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    logger.info('GET /api/v1/projects');

    try {
      const data = await service.listProjects();
      logger.info({ count: data.length, durationMs: Date.now() - startedAt }, 'GET /api/v1/projects complete');
      res.json({ success: true, data });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'GET /api/v1/projects failed');
      res.status(500).json({ success: false, error: 'Failed to load projects' });
    }
  };
}

function createHierarchyHandler(service: TaskExplorerService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    logger.info({ projectId: projectId ?? null }, 'GET /api/v1/tickets/hierarchy');

    try {
      const result = await service.getHierarchy(projectId);
      logger.info({ projectId: projectId ?? null, total: result.total, durationMs: Date.now() - startedAt }, 'GET /api/v1/tickets/hierarchy complete');
      res.json({
        success: true,
        data: result.tickets,
        total: result.total,
        projectIdentifier: result.project.identifier,
        projectId: result.project.projectId,
        workspaceSlug: result.project.workspaceSlug,
      });
    } catch (error) {
      logger.error({ err: error, projectId: projectId ?? null, durationMs: Date.now() - startedAt }, 'GET /api/v1/tickets/hierarchy failed');
      res.status(500).json({ success: false, error: 'Failed to load ticket hierarchy' });
    }
  };
}

function createActivityHandler(service: TaskExplorerService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'GET /api/v1/tickets/:ticketId/activity');

    try {
      const data = await service.getTicketActivity(ticketId as string);
      if (!data) {
        res.status(404).json({ success: false, error: 'Ticket not found' });
        return;
      }

      logger.info({ ticketId, durationMs: Date.now() - startedAt }, 'GET /api/v1/tickets/:ticketId/activity complete');
      res.json({ success: true, data });
    } catch (error) {
      logger.error({ err: error, ticketId, durationMs: Date.now() - startedAt }, 'GET /api/v1/tickets/:ticketId/activity failed');
      res.status(500).json({ success: false, error: 'Failed to load ticket activity' });
    }
  };
}

function createMetricsHandler(service: TaskExplorerService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    logger.info({ projectId: projectId ?? null }, 'GET /api/v1/metrics/summary');

    try {
      const data = await service.getMetricsSummary(projectId);
      logger.info({ projectId: projectId ?? null, durationMs: Date.now() - startedAt }, 'GET /api/v1/metrics/summary complete');
      res.json({ success: true, data });
    } catch (error) {
      logger.error({ err: error, projectId: projectId ?? null, durationMs: Date.now() - startedAt }, 'GET /api/v1/metrics/summary failed');
      res.status(500).json({ success: false, error: 'Failed to load metrics summary' });
    }
  };
}

function createBrowseHandler(service: TaskExplorerService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    logger.info('GET /api/v1/workspace/browse');
    const principal = requireExplorerPrincipal(req, res);
    if (!principal) return;

    try {
      const data = await service.browseWorkspaces(principal.sub, principal.operator);
      logger.info({ total: data.total, durationMs: Date.now() - startedAt }, 'GET /api/v1/workspace/browse complete');
      res.json({ success: true, data });
    } catch (error) {
      logger.error({ err: error, durationMs: Date.now() - startedAt }, 'GET /api/v1/workspace/browse failed');
      res.status(500).json({ success: false, error: 'Failed to browse workspaces' });
    }
  };
}

function createWorkspaceTreeHandler(service: TaskExplorerService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'GET /api/v1/workspace/:ticketId/files');
    const principal = requireExplorerPrincipal(req, res);
    if (!principal) return;

    try {
      const data = await service.getWorkspaceFiles(ticketId as string, principal.sub, principal.operator);
      logger.info({ ticketId, exists: data.exists, durationMs: Date.now() - startedAt }, 'GET /api/v1/workspace/:ticketId/files complete');
      res.json({ success: true, data });
    } catch (error) {
      logger.error({ err: error, ticketId, durationMs: Date.now() - startedAt }, 'GET /api/v1/workspace/:ticketId/files failed');
      const status = error instanceof Error && error.message === 'Workspace not found' ? 404 : 400;
      res.status(status).json({
        success: false,
        error: status === 404 ? 'Workspace not found' : 'Failed to load workspace files',
      });
    }
  };
}

function createWorkspaceFileHandler(service: TaskExplorerService) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const ticketId = readRouteParam(req.params.ticketId);
    const filePath = readWildcardParam(req.params.filePath);
    logger.info({ ticketId, filePath }, 'GET /api/v1/workspace/:ticketId/files/:filePath');
    const principal = requireExplorerPrincipal(req, res);
    if (!principal) return;

    try {
      const data = await service.getWorkspaceFileContent(ticketId, filePath, principal.sub, principal.operator);
      logger.info({ ticketId, filePath, durationMs: Date.now() - startedAt }, 'GET /api/v1/workspace/:ticketId/files/:filePath complete');
      res.json({ success: true, data });
    } catch (error) {
      logger.error({ err: error, ticketId, filePath, durationMs: Date.now() - startedAt }, 'GET /api/v1/workspace/:ticketId/files/:filePath failed');
      const status = error instanceof Error && error.message === 'Workspace not found' ? 404 : 400;
      res.status(status).json({ success: false, error: status === 404 ? 'Workspace not found' : 'Failed to load file preview' });
    }
  };
}

function readRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function readWildcardParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join('/');
  }
  return value ?? '';
}

function requireExplorerPrincipal(
  req: Request,
  res: Response,
): { sub: string; operator: boolean } | null {
  const { sub } = getCaller(req);
  if (!sub || sub.trim().length === 0 || sub.includes('\0')) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return null;
  }
  return { sub, operator: isOperator(req) };
}

/**
 * @description Creates a handler for GET /explorer/tickets/:ticketId/status-history.
 * Reads status history from the ticket store for the Process tab.
 */
function createStatusHistoryHandler(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const ticketId = readRouteParam(req.params.ticketId);
    logger.info({ ticketId }, 'GET /api/v1/explorer/tickets/:ticketId/status-history');

    if (!ctx.ticketService) {
      logger.info({ ticketId }, 'Ticket service not available for status history');
      res.json({ success: true, data: [] });
      return;
    }

    try {
      const history = await ctx.ticketService.getStatusHistory(ticketId, 50);
      logger.info(
        { ticketId, count: history.length, durationMs: Date.now() - startedAt },
        'GET /api/v1/explorer/tickets/:ticketId/status-history complete',
      );
      res.json({ success: true, data: history });
    } catch (error) {
      logger.error(
        { err: error, ticketId, durationMs: Date.now() - startedAt },
        'GET /api/v1/explorer/tickets/:ticketId/status-history failed',
      );
      res.json({ success: true, data: [] });
    }
  };
}
