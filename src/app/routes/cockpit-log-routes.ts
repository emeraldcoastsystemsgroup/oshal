/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — GET /api/cockpit/logs with ticket-trace resolution and structured filtering
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { LogReaderService } from '@/features/logging';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'cockpit-log-routes' });

/**
 * @description Creates Express router for cockpit log query endpoints.
 * Supports ticket-trace resolution: given a root ticket ID, automatically
 * includes log entries from all child tickets.
 *
 * @param ctx - Application context with ticket service for child lookups
 * @returns Configured Express router
 */
export function createCockpitLogRoutes(ctx: AppContext): Router {
  const router = Router();
  const logReader = new LogReaderService();

  /**
   * @description Query structured logs with filters.
   * GET /api/v1/logs/query (mounted under /api/v1 prefix)
   *
   * Query params:
   *   ticketId  — root ticket ID (auto-expands to include children)
   *   level     — comma-separated levels (info,warn,error)
   *   module    — exact module name
   *   search    — free text substring match
   *   since     — ISO timestamp lower bound
   *   until     — ISO timestamp upper bound
   *   limit     — max entries (default 200, max 1000)
   *   offset    — pagination offset
   */
  router.get('/logs/query', async (req: Request, res: Response) => {
    try {
      const { ticketId, level, module, search, since, until, limit, offset } = req.query;

      // Build ticket ID set: root + children for trace support
      let ticketIds: string[] | undefined;
      if (typeof ticketId === 'string' && ticketId.trim()) {
        const rootId = ticketId.trim();
        ticketIds = [rootId];

        try {
          const children = await ctx.ticketService.listTickets({ parentTicketId: rootId });
          for (const child of children) {
            ticketIds.push(child.ticketId);
          }
          logger.debug(
            { rootTicketId: rootId, childCount: children.length },
            'Resolved ticket trace set for log query',
          );
        } catch (err) {
          logger.warn({ ticketId: rootId, err }, 'Failed to resolve child tickets for trace — querying root only');
        }
      }

      const result = await logReader.query({
        ticketIds,
        levels: typeof level === 'string' ? level.split(',').map(l => l.trim()).filter(Boolean) : undefined,
        module: typeof module === 'string' ? module.trim() || undefined : undefined,
        search: typeof search === 'string' ? search.trim() || undefined : undefined,
        since: typeof since === 'string' ? since : undefined,
        until: typeof until === 'string' ? until : undefined,
        limit: typeof limit === 'string' ? parseInt(limit, 10) || 200 : 200,
        offset: typeof offset === 'string' ? parseInt(offset, 10) || 0 : 0,
      });

      logger.info(
        { ticketId: ticketId || null, total: result.total, returned: result.entries.length },
        'Cockpit log query served',
      );

      res.json({ data: result.entries, meta: { total: result.total, hasMore: result.hasMore } });
    } catch (err) {
      logger.error({ err }, 'Cockpit log query failed');
      res.status(500).json({ error: 'Failed to query logs' });
    }
  });

  /**
   * @description Get distinct module names from recent logs.
   * GET /api/cockpit/logs/modules
   */
  router.get('/logs/modules', async (_req: Request, res: Response) => {
    try {
      const modules = await logReader.getModules();
      res.json({ modules });
    } catch (err) {
      logger.error({ err }, 'Failed to get log modules');
      res.status(500).json({ error: 'Failed to get modules' });
    }
  });

  return router;
}
