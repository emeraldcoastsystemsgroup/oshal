/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Session 22: Intake assistant API routes — start session, send message, submit ticket
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { IntakeAssistantService } from '@/features/intake';
import type { TicketService } from '@/features/ticketing';

const logger = createChildLogger({ module: 'intake-assistant-routes' });

/**
 * @description Creates intake assistant routes.
 * @param ticketService - For creating the final ticket
 * @returns Express Router
 */
export function createIntakeAssistantRoutes(ticketService: TicketService): Router {
  const router = Router();
  const intakeService = new IntakeAssistantService();

  /**
   * POST /api/v1/intake/start — Start a new intake session
   */
  router.post('/start', (_req: Request, res: Response) => {
    try {
      const { sessionId, message } = intakeService.startSession();
      res.json({ success: true, sessionId, message });
    } catch (error) {
      logger.error({ err: error }, 'Failed to start intake session');
      res.status(500).json({ success: false, error: 'Failed to start intake session' });
    }
  });

  /**
   * POST /api/v1/intake/:sessionId/message — Send a message to the intake assistant
   */
  router.post('/:sessionId/message', (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params.sessionId);
      const { message } = req.body as { message: string };
      if (!message) {
        res.status(400).json({ success: false, error: 'Message is required' });
        return;
      }
      const result = intakeService.processMessage(sessionId, message);
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error({ err: error }, 'Failed to process intake message');
      res.status(400).json({ success: false, error: (error as Error).message });
    }
  });

  /**
   * GET /api/v1/intake/:sessionId — Get session state
   */
  router.get('/:sessionId', (req: Request, res: Response) => {
    const session = intakeService.getSession(String(req.params.sessionId));
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    res.json({ success: true, session });
  });

  /**
   * POST /api/v1/intake/:sessionId/submit — Submit the ticket from gathered data
   */
  router.post('/:sessionId/submit', async (req: Request, res: Response) => {
    try {
      const payload = intakeService.buildTicketPayload(String(String(req.params.sessionId))) as Record<string, any>;
      const ticket = await ticketService.createTicket({
        title: String(payload.title),
        description: String(payload.description),
        status: 'approved',
        priority: String(payload.priority || 'medium'),
        labels: (payload.labels as string[]) || [],
        metadata: payload.metadata as Record<string, unknown>,
        externalId: null,
        externalProvider: null,
        externalUrl: null,
        workspaceId: null,
        assignedAgentId: null,
        parentTicketId: null,
      } as any);
      logger.info({ sessionId: String(req.params.sessionId), ticketId: ticket.ticketId }, 'Intake ticket created');
      res.json({ success: true, ticket });
    } catch (error) {
      logger.error({ err: error }, 'Failed to submit intake ticket');
      res.status(500).json({ success: false, error: (error as Error).message });
    }
  });

  return router;
}
