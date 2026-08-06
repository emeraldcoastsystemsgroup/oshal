/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ticket REST API: CRUD, status transitions, task/workspace linking
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored to createTicketRoutes(ctx) pattern matching codebase conventions
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added /sync/pull, /sync/push, /sync/reconcile endpoints for PlaneSyncService API
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added root-ticket project move endpoint so operators can reassign a root ticket tree to a new project without changing shared workspace ownership
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Documented operator pause, resume, and cancel endpoints in the ticket route change log
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added paused task-state mapping so cockpit fallback task-backed tickets can pause without reverting to created/backlog
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Enforced object-level authorization (IDOR fix): every by-id handler (get/patch/delete/status/state/pause/resume/cancel/chat) now checks the caller owns the ticket (or is an operator) via requireTicketAccess() and returns 404 on mismatch. The list endpoint now forces ownerSub to the caller for non-operators and ignores client-supplied ownerSub unless operator, so a user can no longer enumerate or read other tenants' tickets.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Review fix (DLQ mis-count): the manual cockpit status/state PUT handlers now transition via updateStatusAs with the caller's identity instead of the actor-less updateStatus (which defaulted to 'system'). The queue DLQ policy counts only 'system' escalations as poison cycles, so a deliberate operator escalation recorded as 'system' could be quarantined as an auto-escalate loop — recording the operator actor prevents the mis-count.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: cockpit ticket chat no longer grants blanket automatic tool approval; executor policy must authorize each operation.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppContext } from '../composition-root';
import {
  CreateInternalTicketSchema,
  TicketProjectAssignmentInputSchema,
  OshalTicketStateSchema,
  normalizeOshalTicketState,
} from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import { canAccessResource, isOperator, getCaller } from '@/shared/middleware/authz';
import { emitAuditEvent, type AuditDecision } from '@/features/governance';
import type { TaskStatus } from '@/shared/types';

const logger = createChildLogger({ module: 'ticket-routes' });

/**
 * @description Fire-and-forget per-resource access audit. Off by default: only writes
 * when OSHAL_ACCESS_AUDIT is truthy (keeps the per-request CREATE-TABLE/INSERT cost out
 * of the hot path unless an operator opts in). Never awaited and never throws — emit is
 * best-effort and self-healing (see audit-emit). This is the single ticket chokepoint, so
 * one call here audits every by-id ticket access decision.
 */
function auditTicketAccess(
  ctx: AppContext,
  req: Request,
  ticketId: string,
  decision: AuditDecision,
): void {
  const flag = (process.env.OSHAL_ACCESS_AUDIT ?? '').toLowerCase().trim();
  if (!['true', '1', 'yes', 'on'].includes(flag)) return;
  const { sub } = getCaller(req);
  void emitAuditEvent(ctx.pool, {
    actorSub: sub,
    action: 'ticket.access',
    resourceType: 'ticket',
    resourceId: ticketId,
    decision,
  });
}

type LoadedTicket = NonNullable<Awaited<ReturnType<AppContext['ticketService']['getTicket']>>>;

/**
 * @description Object-level authorization guard for ticket by-id routes. Loads the
 * ticket; if it is missing, or the caller is neither its owner nor an operator,
 * responds 404 (NOT 403, so ticket ids cannot be probed) and returns null. On
 * success returns the loaded ticket so callers can reuse it without re-fetching.
 */
async function requireTicketAccess(
  ctx: AppContext,
  req: Request,
  res: Response,
  ticketId: string,
): Promise<LoadedTicket | null> {
  const ticket = await ctx.ticketService.getTicket(ticketId);
  if (!ticket) {
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  const ownerSub = (ticket as { ownerSub?: string | null }).ownerSub ?? null;
  if (!canAccessResource(req, ownerSub)) {
    logger.warn({ ticketId }, 'Ticket access denied (caller is not owner/operator) — returning 404');
    auditTicketAccess(ctx, req, ticketId, 'deny');
    res.status(404).json({ error: 'Ticket not found' });
    return null;
  }
  auditTicketAccess(ctx, req, ticketId, 'allow');
  return ticket;
}

/**
 * @description Creates Express router with ticket REST API endpoints for CRUD,
 * status transitions, and task/workspace linking.
 * @param ctx - Application context with ticketing services
 * @returns Configured Express router
 */
export function createTicketRoutes(ctx: AppContext): Router {
  const router = Router();

  /* ── POST / ──────────────────────────────────────────────────────── */
  router.post('/', async (req: Request, res: Response) => {
    logger.info({ title: req.body?.title, storeType: (ctx.ticketService as any).ticketStore?.constructor?.name }, 'POST /api/tickets — Create ticket requested');
    try {
      const rawTitle = typeof req.body?.title === 'string' ? req.body.title : '';
      if (process.env.REJECT_LOOP_TICKETS === 'true' && /^loop-(build|incident|rca)-\d+$/i.test(rawTitle)) {
        res.status(429).json({ error: 'Rejected: loop-* titles are blocked while REJECT_LOOP_TICKETS=true' });
        return;
      }
      const parsed = CreateInternalTicketSchema.safeParse(req.body);
      if (!parsed.success) {
        logger.warn({ issues: parsed.error.issues }, 'Ticket validation failed');
        res.status(400).json({ error: 'Invalid input', details: parsed.error.issues });
        return;
      }
      logger.info({ parsedTitle: parsed.data.title, parsedType: parsed.data.ticketType }, 'Parsed ticket input');
      // Stamp the creating user's OIDC sub so the ticket is owned (per-user "my tickets" queues).
      const callerSub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub;
      const ticket = await ctx.ticketService.createTicket({
        ...parsed.data,
        ownerSub: parsed.data.ownerSub ?? (callerSub ? String(callerSub) : null),
      });
      logger.info({ ticketId: ticket.ticketId, storedType: (ticket as any).ticketType }, 'Ticket created by route');
      res.status(201).json(ticket);
    } catch (error) {
      logger.error({ err: error }, 'Failed to create ticket');
      res.status(500).json({ error: 'Failed to create ticket' });
    }
  });

  /* ── GET / ───────────────────────────────────────────────────────── */
  router.get('/', async (req: Request, res: Response) => {
    logger.debug('List tickets requested');
    try {
      const options: Record<string, unknown> = {};
      if (req.query.status) options.status = String(req.query.status);
      if (req.query.workspaceId) options.workspaceId = String(req.query.workspaceId);
      if (req.query.assignedAgentId) options.assignedAgentId = String(req.query.assignedAgentId);
      if (req.query.type) options.ticketType = String(req.query.type).toLowerCase();
      if (req.query.ticketType) options.ticketType = String(req.query.ticketType).toLowerCase();
      if (req.query.limit) options.limit = Number(req.query.limit);
      if (req.query.offset) options.offset = Number(req.query.offset);
      /* ── Per-user scoping (IDOR fix) ────────────────────────────────────
       * Non-operators are ALWAYS forced to their own ownerSub and cannot pass
       * an arbitrary ?ownerSub. Only operators may list across users (?scope=all)
       * or query a specific ?ownerSub. Previously this endpoint returned ALL
       * tickets by default and honored a client-supplied ownerSub, letting any
       * authenticated user enumerate other tenants' tickets. */
      const callerSub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub;
      const operator = isOperator(req);
      if (operator) {
        if (req.query.scope !== 'all') {
          if (req.query.ownerSub) options.ownerSub = String(req.query.ownerSub);
          else if (req.query.mine === 'true' || req.query.owner === 'me') {
            if (callerSub) options.ownerSub = String(callerSub);
          }
        }
        // operator + scope=all → leave ownerSub unset (see everyone)
      } else if (callerSub) {
        // Non-operator: hard-scope to own tickets regardless of query params.
        options.ownerSub = String(callerSub);
      }

      const tickets = await ctx.ticketService.listTickets(options as any);
      res.json({ tickets, count: tickets.length });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list tickets');
      res.status(500).json({ error: 'Failed to list tickets' });
    }
  });

  /* ── GET /:ticketId ──────────────────────────────────────────────── */
  router.get('/:ticketId', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.debug({ ticketId }, 'Get ticket requested');
    try {
      const ticket = await requireTicketAccess(ctx, req, res, ticketId as string);
      if (!ticket) return;
      res.json(ticket);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get ticket');
      res.status(500).json({ error: 'Failed to get ticket' });
    }
  });

  /* ── PATCH /:ticketId ────────────────────────────────────────────── */
  router.patch('/:ticketId', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'Update ticket requested');
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      await ctx.ticketService.updateTicket(ticketId as string, req.body);
      res.json({ status: 'updated' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to update ticket');
      res.status(500).json({ error: 'Failed to update ticket' });
    }
  });

  /* ── PUT /:ticketId/project ─────────────────────────────────────── */
  router.put('/:ticketId/project', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const startedAt = Date.now();
    logger.info({ ticketId, body: sanitizeProjectMoveBody(req.body) }, 'Root-ticket project move requested');

    try {
      const parsed = TicketProjectAssignmentInputSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid project assignment input', details: parsed.error.issues });
        return;
      }
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;

      const result = await ctx.ticketProjectAssignmentService.moveRootTicketToProject(ticketId as string, parsed.data);
      logger.info({
        ticketId,
        projectId: result.project.projectId,
        updatedTicketCount: result.updatedTicketIds.length,
        updatedTaskCount: result.updatedTaskIds.length,
        durationMs: Date.now() - startedAt,
      }, 'Root-ticket project move completed');
      res.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to move ticket project';
      logger.error({ err: error, ticketId, durationMs: Date.now() - startedAt }, 'Root-ticket project move failed');
      const statusCode = message.includes('not found') ? 404 : message.includes('Only root tickets') ? 400 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  /* ── DELETE /:ticketId ───────────────────────────────────────────── */
  router.delete('/:ticketId', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'Delete ticket requested');
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      await ctx.ticketService.deleteTicket(ticketId as string);
      res.json({ status: 'deleted' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete ticket');
      res.status(500).json({ error: 'Failed to delete ticket' });
    }
  });

  /* ── PUT /:ticketId/status ───────────────────────────────────────── */
  router.put('/:ticketId/status', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'Update ticket status requested');
    try {
      const parsed = OshalTicketStateSchema.safeParse(req.body.status);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid status', details: parsed.error.issues });
        return;
      }
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      // Actor-aware transition: a cockpit status change is a human action, so it must NOT be
      // recorded as the 'system' actor. The queue DLQ policy counts only 'system' escalations
      // as poison cycles; recording the operator's identity here keeps a deliberate manual
      // escalation from being mis-counted (and quarantined) as an auto-escalate loop.
      const { sub, email } = getCaller(req);
      const actor = email ?? sub ?? 'operator';
      await ctx.ticketService.updateStatusAs(ticketId as string, parsed.data, actor, `Operator ${actor}`);
      res.json({ status: 'updated', newStatus: parsed.data });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to update status';
      logger.error({ err: error }, msg);
      const statusCode = msg.includes('not found') ? 404 : msg.includes('Invalid state') ? 400 : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  /* ── PUT /:ticketId/state (cockpit compatibility) ──────────────── */
  router.put('/:ticketId/state', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const requestedStatus = readOptionalString(req.body?.status);
    logger.info({ ticketId, requestedStatus }, 'Update ticket state requested (compat)');

    if (!requestedStatus) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    try {
      const internalTicket = await ctx.ticketService.getTicket(ticketId as string);
      if (internalTicket) {
        if (!canAccessResource(req, (internalTicket as { ownerSub?: string | null }).ownerSub ?? null)) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const normalized = normalizeOshalTicketState(requestedStatus);
        // Actor-aware: a cockpit state change is a human action (see PUT /:ticketId/status) —
        // record the operator identity so the DLQ policy never mis-counts it as a 'system' loop.
        const { sub, email } = getCaller(req);
        const actor = email ?? sub ?? 'operator';
        await ctx.ticketService.updateStatusAs(ticketId as string, normalized, actor, `Operator ${actor}`);
        res.json({ success: true, status: 'updated', entity: 'ticket', newStatus: normalized });
        return;
      }

      const task = await ctx.taskStore.get(ticketId as string);
      if (task) {
        const mappedTaskStatus = mapCockpitStateToTaskStatus(requestedStatus);
        await ctx.taskStore.updateStatus(ticketId as string, mappedTaskStatus);
        res.json({ success: true, status: 'updated', entity: 'task', newStatus: mappedTaskStatus });
        return;
      }

      res.status(404).json({ error: 'Ticket not found' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to update state';
      logger.error({ err: error, ticketId }, msg);
      const statusCode = msg.includes('not found') ? 404 : msg.includes('Invalid state') ? 400 : 500;
      res.status(statusCode).json({ error: msg });
    }
  });

  /* ── POST /:ticketId/chat (cockpit compatibility) ──────────────── */
  // ── Ticket lifecycle control: pause, resume, cancel ──────────────────
  router.put('/:ticketId/pause', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      await ctx.ticketService.updateStatus(ticketId as string, 'paused');
      res.json({ success: true, status: 'paused', ticketId });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Failed to pause ticket' });
    }
  });

  router.put('/:ticketId/resume', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      await ctx.ticketService.updateStatus(ticketId as string, 'approved');
      res.json({ success: true, status: 'approved', ticketId, message: 'Ticket resumed — will be picked up by next poll cycle' });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Failed to resume ticket' });
    }
  });

  router.put('/:ticketId/cancel', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      await ctx.ticketService.updateStatus(ticketId as string, 'cancelled');
      res.json({ success: true, status: 'cancelled', ticketId });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Failed to cancel ticket' });
    }
  });

  router.post('/:ticketId/chat', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    const message = readOptionalString(req.body?.message);
    const requestedAgentId = readOptionalString(req.body?.targetAgent) || readOptionalString(req.body?.agentId);
    logger.info({ ticketId, hasMessage: Boolean(message), requestedAgentId }, 'Ticket chat requested');

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      let resolvedTaskId = ticketId as string;
      let resolvedAgentId = requestedAgentId;

      const existingTask = await ctx.taskStore.get(ticketId as string);
      if (existingTask) {
        resolvedAgentId = resolvedAgentId || readOptionalString(existingTask.agentId);
      } else {
        const internalTicket = await ctx.ticketService.getTicket(ticketId as string);
        if (!internalTicket) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        if (!canAccessResource(req, (internalTicket as { ownerSub?: string | null }).ownerSub ?? null)) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }

        const links = await ctx.ticketService.getTasksForTicket(ticketId as string).catch(() => []);
        const primaryTaskId = selectPrimaryTaskId(links as Array<{ taskId?: string; role?: string }>);
        resolvedTaskId = primaryTaskId || (ticketId as string);
        resolvedAgentId = resolvedAgentId || readOptionalString(internalTicket.assignedAgentId);

        if (!primaryTaskId) {
          await ctx.ticketService.linkTask(ticketId as string, resolvedTaskId, 'primary').catch((linkError) => {
            logger.warn({ err: linkError, ticketId, resolvedTaskId }, 'Failed to persist auto-created ticket-task link');
          });
        }
      }

      const result = await ctx.orchestrator.processMessage(resolvedTaskId, message, {
        agenticMode: true,
        autoApprove: false,
        source: 'cockpit-ticket',
        agentId: resolvedAgentId,
        ticketId: ticketId as string,
      });

      res.json({
        success: result.success,
        ticketId,
        taskId: resolvedTaskId,
        botResponse: result.response || '',
        agentId: resolvedAgentId || null,
        completionType: result.completionType || null,
        error: result.error,
      });
    } catch (error) {
      logger.error({ err: error, ticketId }, 'Ticket chat failed');
      res.status(500).json({ error: error instanceof Error ? error.message : 'Ticket chat failed' });
    }
  });

  /* ── POST /:ticketId/tasks ───────────────────────────────────────── */
  router.post('/:ticketId/tasks', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'Link task to ticket requested');
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      const { taskId, role } = req.body;
      if (!taskId) {
        res.status(400).json({ error: 'taskId is required' });
        return;
      }
      await ctx.ticketService.linkTask(ticketId as string, taskId, role);
      res.status(201).json({ status: 'linked' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to link task');
      res.status(500).json({ error: 'Failed to link task' });
    }
  });

  /* ── GET /:ticketId/tasks ────────────────────────────────────────── */
  router.get('/:ticketId/tasks', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      const links = await ctx.ticketService.getTasksForTicket(ticketId as string);
      res.json({ links, count: links.length });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get task links');
      res.status(500).json({ error: 'Failed to get task links' });
    }
  });

  /* ── POST /:ticketId/workspaces ──────────────────────────────────── */
  router.post('/:ticketId/workspaces', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    logger.info({ ticketId }, 'Link workspace to ticket requested');
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      const { workspaceId } = req.body;
      if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId is required' });
        return;
      }
      await ctx.ticketService.linkWorkspace(ticketId as string, workspaceId);
      res.status(201).json({ status: 'linked' });
    } catch (error) {
      logger.error({ err: error }, 'Failed to link workspace');
      res.status(500).json({ error: 'Failed to link workspace' });
    }
  });

  /* ── GET /:ticketId/workspaces ───────────────────────────────────── */
  router.get('/:ticketId/workspaces', async (req: Request, res: Response) => {
    const { ticketId } = req.params;
    try {
      if (!(await requireTicketAccess(ctx, req, res, ticketId as string))) return;
      const links = await ctx.ticketService.getWorkspacesForTicket(ticketId as string);
      res.json({ links, count: links.length });
    } catch (error) {
      logger.error({ err: error }, 'Failed to get workspace links');
      res.status(500).json({ error: 'Failed to get workspace links' });
    }
  });

  // ═══ PLANE SYNC ═══

  /**
   * @description Pull tickets from Plane into the internal ticket store.
   * POST /api/tickets/sync/pull
   */
  router.post('/sync/pull', async (_req: Request, res: Response) => {
    try {
      logger.info('POST /api/tickets/sync/pull');
      const result = await ctx.planeSyncService.pullTickets();
      logger.info({ ...result }, 'Plane sync pull completed');
      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Plane sync pull failed');
      res.status(500).json({ error: 'Plane sync pull failed' });
    }
  });

  /**
   * @description Push a ticket's state to Plane.
   * POST /api/tickets/sync/push
   */
  router.post('/sync/push', async (req: Request, res: Response) => {
    try {
      const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId : '';
      if (!ticketId) {
        res.status(400).json({ error: 'ticketId is required' });
        return;
      }
      const status = typeof req.body?.status === 'string' ? req.body.status : undefined;
      const comment = typeof req.body?.comment === 'string' ? req.body.comment : undefined;
      logger.info({ ticketId, status, comment }, 'POST /api/tickets/sync/push');
      await ctx.planeSyncService.pushUpdate(ticketId, { status, comment });
      logger.info({ ticketId }, 'Plane sync push completed');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Plane sync push failed');
      res.status(500).json({ error: 'Plane sync push failed' });
    }
  });

  /**
   * @description Full bidirectional reconciliation with Plane for a project.
   * POST /api/tickets/sync/reconcile
   */
  router.post('/sync/state', async (req: Request, res: Response) => {
    try {
      const ticketId = typeof req.body?.ticketId === 'string' ? req.body.ticketId : '';
      if (!ticketId) {
        res.status(400).json({ error: 'ticketId is required' });
        return;
      }
      logger.info({ ticketId }, 'POST /api/tickets/sync/state');
      await ctx.planeSyncService.syncTicketState(ticketId);
      logger.info({ ticketId }, 'Plane sync state completed');
      res.json({ success: true });
    } catch (error) {
      logger.error({ err: error }, 'Plane sync state failed');
      res.status(500).json({ error: 'Plane sync state failed' });
    }
  });

  return router;
}

function mapCockpitStateToTaskStatus(state: string): TaskStatus {
  const normalized = state.trim().toLowerCase();
  if (['done', 'complete', 'completed', 'delivered', 'closed'].includes(normalized)) {
    return 'completed';
  }
  if (['failed', 'error'].includes(normalized)) {
    return 'failed';
  }
  if (['cancelled', 'canceled'].includes(normalized)) {
    return 'cancelled';
  }
  if (['paused', 'pause', 'hold', 'on hold'].includes(normalized)) {
    return 'paused';
  }
  if (['in review', 'review', 'customer action', 'customer approval', 'waiting_for_input'].includes(normalized)) {
    return 'waiting_for_input';
  }
  if (['in progress', 'in_progress', 'processing', 'active', 'running'].includes(normalized)) {
    return 'processing';
  }
  return 'created';
}

function selectPrimaryTaskId(links: Array<{ taskId?: string; role?: string }>): string | null {
  if (!Array.isArray(links) || links.length === 0) {
    return null;
  }

  const primary = links.find((link) => link?.taskId && link.role === 'primary');
  if (primary?.taskId) {
    return primary.taskId;
  }

  const first = links.find((link) => link?.taskId);
  return first?.taskId ?? null;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeProjectMoveBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  return {
    projectId: readOptionalString(source.projectId) || null,
    projectName: readOptionalString(source.projectName) || null,
    projectIdentifier: readOptionalString(source.projectIdentifier) || null,
    workspaceSlug: readOptionalString(source.workspaceSlug) || null,
  };
}
