import type { Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../composition-root';
import { createChildLogger } from '@/shared/logger';
import { getCaller, isOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'cockpit-ticket-detail-route' });

export function handleGetCockpitTicketDetail(ctx: AppContext): RequestHandler {
  return async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const ownerSub = resolveOwnerSub(req);
    try {
      logger.info({ ticketId, scoped: Boolean(ownerSub) }, 'GET /api/v1/tickets/:ticketId');
      const ticket = await ctx.ticketService.getTicket(ticketId as string);
      if (!ticket || !canReadTicket(ticket as unknown as Record<string, unknown>, ownerSub)) {
        res.status(404).json({ success: false, error: 'Ticket not found' });
        return;
      }
      res.json({ success: true, ticket });
    } catch (error) {
      logger.error({ err: error, ticketId }, 'Failed to get ticket');
      res.status(500).json({ success: false, error: 'Failed to get ticket' });
    }
  };
}

function resolveOwnerSub(req: Request): string | undefined {
  if (req.query.scope === 'all' && isOperator(req)) return undefined;
  return getCaller(req).sub ?? '__missing-caller__';
}

function canReadTicket(ticket: Record<string, unknown>, ownerSub?: string): boolean {
  if (ownerSub === undefined) return true;
  return typeof ticket.ownerSub === 'string' && ticket.ownerSub === ownerSub;
}

