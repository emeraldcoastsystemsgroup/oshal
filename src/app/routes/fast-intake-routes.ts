/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                    | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Fast intake API route — POST /api/intake/fast
 *                     |                           | Accepts natural language, extracts ticket fields via direct LLM,
 *                     |                           | creates internal ticket, returns in 1-3 seconds
 */

import type { Express, Request, RequestHandler, Response } from 'express';
import { FastIntakeService } from '@/features/intake';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'fast-intake-routes' });

/**
 * @description Mounts the fast intake route at POST /api/intake/fast.
 * Accepts { message, previousQuestion? } and returns extracted ticket fields
 * or a created ticket ID in 1-3 seconds using the direct OpenAI API path.
 *
 * @param app - Express application instance
 * @param requiresAuth - OIDC auth middleware. Required because authRequired:
 *   false at the express-openid-connect layer means routes are open by
 *   default; this endpoint runs codex and creates approved tickets, so it
 *   MUST be authenticated.
 * @param ticketService - TicketService for creating internal tickets after extraction
 */
export function registerFastIntakeRoutes(
  app: Express,
  requiresAuth: RequestHandler,
  ticketService?: { createTicket: (input: Record<string, unknown>) => Promise<{ ticketId: string }> },
): void {
  const intakeService = new FastIntakeService();

  app.post('/api/intake/fast', requiresAuth, async (req: Request, res: Response) => {
    try {
      const { message, previousQuestion } = req.body as {
        message?: string;
        previousQuestion?: string;
      };

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({ success: false, error: 'message is required' });
        return;
      }

      const result = await intakeService.extractTicket(message.trim(), previousQuestion);

      if (result.needsClarification) {
        res.json({
          success: true,
          needsClarification: true,
          clarificationQuestion: result.clarificationQuestion,
        });
        return;
      }

      // If a ticket service is available, create the ticket immediately
      if (ticketService) {
        try {
          const ticket = await ticketService.createTicket({
            title: result.title,
            description: result.description,
            priority: result.priority,
            status: 'approved',
            stateGroup: 'approved',
            source: 'fast-intake',
          });
          result.ticketId = ticket.ticketId;
          result.status = 'created';
          logger.info({ ticketId: ticket.ticketId, title: result.title }, 'FastIntake: ticket created');
        } catch (ticketErr) {
          logger.error({ err: ticketErr }, 'FastIntake: ticket creation failed — returning extraction only');
          result.status = 'extracted_no_ticket';
        }
      }

      res.json({ success: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error({ err }, 'FastIntake: request failed');
      res.status(500).json({ success: false, error: message });
    }
  });

  logger.info('Fast intake route registered at POST /api/intake/fast');
}