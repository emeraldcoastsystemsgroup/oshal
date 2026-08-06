/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — message send + history routes
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Defaulted chat sends to the shared standalone chat agent for Layer-1 prompt/tool-switch context
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log header to governance-compliant timestamp and author format
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Routed direct project-manager ticket intake through the canonical internal ticket system before orchestration so PM chat creates real tickets instead of markdown-only artifacts
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Read ticketId from request body and pass to processMessage options — activates linkTicketIfRequested so incident pipeline tasks get ticket_task_links rows for cost rollup
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Object-level authorization (IDOR fix): GET /:taskId/messages and the send handlers now check the caller may access the task before reading its history or posting to it. A task's owner is its ticket's owner (resolveTaskOwner); the check fails SAFE — unresolved/unowned tasks (incl. brand-new conversations) are allowed, only a clearly-different owner is denied (404). Previously any authenticated user could read another user's chat history or inject into their thread by supplying its taskId.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Split message read/write guards so history reads fail closed when RLS hides another user's task.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Initially added Twilio to the chat-path token broker; that legacy carrier is superseded by sequence 13.
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | EXECUTE-TIME ENTITLEMENT ON THE OTHER BOT ENDPOINT (BACKLOG "Bot-endpoint privilege model - authorize the ACTUAL endpoint call", which names /api/send-message explicitly). This route honoured a caller-supplied body.agentId VERBATIM and called ctx.orchestrator.processMessage directly, never through executeBotOrInline - so the gate K6 flipped to enforce covered /api/swarm-execute and the executeBotOrInline chokepoint but NOT here. A signed-in non-operator could reach exactly the ADR-087 operator+swarm machinery K7 scoped (oshal-developer, devops-bot, vault-bot, security-analyst, code-developer, ...) by naming its agentId on a task they legitimately own; the IDOR guard above checks the THREAD, not the bot. The resolved agentId now runs through assertExecuteEntitlement with `direct` set ONLY for genuine interactive identity callers - a valid service-secret call is swarm dispatch and stays trusted, so the manifest/incident-worker localhost fallback and the headless CLI are byte-identical - and CallerNotEntitledError maps to 403 caller_not_entitled_to_agent. Guard: tests/unit/send-message-entitlement.spec.ts.
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Guest turns are forced chatOnly, not overridable from the body. Guests reached this route for the first time when the capability matrix granted /api/tasks/:id/messages; without this an anonymous visitor could post chatOnly: false and create a ticket that dispatches real work into the swarm build pipeline.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Narrow service-secret message calls to the trusted user sub before chat-task/ticket writes, fail closed when that binding is absent, and remove the legacy body.userSub fallback so request content can never select the database or connector owner.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Security hardening: remove generic connector-token resolution and credential forwarding from the conversational model path; connector secrets stay inside audited server-side operations.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 closure: keep Twilio credentials out of conversational threads; authenticated fixed controller operations own any per-user SMS send.
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05: return the canonical 503 ai_disabled response on chat writes when the operator declares OSHAL_NO_AI=true.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | CORE-05 identity closure: narrow authenticated PAT message writes to their exact owner so bounded live verification cannot persist chat_tasks under the operator-bypass database stamp.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { DEFAULT_CHAT_AGENT_ID, resolveProjectManagerTicketExecutionContext } from '@/features/chat-orchestration';
import { canAccessResource, getCaller, hasValidServiceSecret, getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { assertExecuteEntitlement, CallerNotEntitledError } from '@/app/bot-node-execute-entitlement';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { requireTrustedServiceUserIdentity } from '@/shared/middleware/trusted-service-user-identity';
import { requireAiEnabled } from '@/shared/middleware/ai-availability';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import type { AppContext } from '../composition-root';

const logger = createChildLogger({ module: 'message-routes' });

/**
 * @description Object-level authorization for posting to a task thread. Existing
 * tasks must be visible to and owned by the caller. Missing/unresolved task ids
 * are allowed so the orchestrator can create a brand-new chat thread.
 */
async function callerMayAccessTask(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  const task = await ctx.taskStore.get(taskId).catch((err) => {
    logger.debug({ err, taskId }, 'message ownership lookup could not read chat task');
    return null;
  });
  if (task) {
    const owner = task.ownerSub ?? await ctx.workspaceService.resolveTaskOwner(taskId).catch((err) => {
      logger.debug({ err, taskId }, 'message ownership lookup could not resolve ticket owner');
      return null;
    });
    return callerOwnsResource(req, owner);
  }
  const owner = await ctx.workspaceService.resolveTaskOwner(taskId).catch((err) => {
    logger.debug({ err, taskId }, 'message ownership lookup could not resolve missing-task owner');
    return null;
  });
  return owner ? callerOwnsResource(req, owner) : true;
}

/**
 * @description Object-level authorization for reading message history. Unlike
 * write/new-thread checks, history reads fail closed when the task row is not
 * visible under RLS and no ticket owner can be resolved.
 */
async function callerMayReadMessages(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  const task = await ctx.taskStore.get(taskId).catch((err) => {
    logger.debug({ err, taskId }, 'message history lookup could not read chat task');
    return null;
  });
  if (task) {
    const owner = task.ownerSub ?? await ctx.workspaceService.resolveTaskOwner(taskId).catch((err) => {
      logger.debug({ err, taskId }, 'message history lookup could not resolve ticket owner');
      return null;
    });
    return callerOwnsResource(req, owner);
  }
  const owner = await ctx.workspaceService.resolveTaskOwner(taskId).catch((err) => {
    logger.debug({ err, taskId }, 'message history lookup could not resolve missing-task owner');
    return null;
  });
  return owner ? callerOwnsResource(req, owner) : false;
}

/** Compare ownership against the validated session or the secret-gated service assertion. */
function callerOwnsResource(req: Request, ownerSub: string | null | undefined): boolean {
  const trustedServiceSub = getTrustedServiceUserSub(req);
  return trustedServiceSub ? trustedServiceSub === ownerSub : canAccessResource(req, ownerSub);
}

/** Resolve the owner only from authenticated transport identity, never request content. */
function messageCallerSub(req: Request): string | undefined {
  return getCaller(req).sub
    ?? getTrustedServiceUserSub(req)
    ?? undefined;
}

/**
 * @description Execute-time entitlement for THIS endpoint (BACKLOG "Bot-endpoint privilege
 * model"). The service secret proves a trusted machine is calling and the IDOR guard proves the
 * caller owns the THREAD; neither says the caller is entitled to the BOT they just named. Reuses
 * the same decision the bot-node HTTP gate and executeBotOrInline run, so there is no policy
 * copy to drift.
 *
 * `direct` is what separates the two caller classes the model already distinguishes:
 *   - a valid service-secret call is swarm/queue dispatch threading a ticket owner's sub for the
   *     owner attribution (dispatch-manifest-worker / dispatch-incident-worker fall back to this
   *     route over localhost) -> NOT direct, trusted, unchanged;
 *   - an OIDC session or PAT caller is interactive per-user delegation -> direct, entitlement-checked.
 *
 * @param req - The inbound request (identity + service-secret facts).
 * @param resolvedAgentId - The bot the request will actually execute on.
 * @param taskId - Task id for the denial audit line.
 * @throws CallerNotEntitledError in enforce mode (the default) on an explicit mismatch.
 */
function assertSendMessageEntitlement(req: Request, resolvedAgentId: string, taskId: string): void {
  const isMachineCall = hasValidServiceSecret(req);
  const sessionSub = (req as { oidc?: { user?: { sub?: string } } }).oidc?.user?.sub ?? null;
  assertExecuteEntitlement({
    userSub: isMachineCall ? getTrustedServiceUserSub(req) ?? sessionSub : sessionSub,
    direct: !isMachineCall && Boolean(sessionSub),
    targetAgentId: resolvedAgentId,
    taskId,
    surface: 'POST /api/send-message',
  });
}

/**
 * @description Establish least-privilege database identity for every machine-reachable chat write.
 * The shared guard narrows fleet-secret calls to their asserted owner. A PAT is already a verified
 * user principal, but an operator-owned PAT inherits the global operator stamp; narrow that
 * credential to its exact owner before chat_tasks persistence. Interactive browser sessions retain
 * their ordinary platform posture.
 */
function requireMessageWriteIdentity(req: Request, res: Response, next: NextFunction): void {
  requireTrustedServiceUserIdentity(req, res, () => {
    const oidc = (req as { oidc?: { idToken?: unknown; isAuthenticated?: () => boolean } }).oidc;
    if (oidc?.idToken !== 'cli-token' || oidc.isAuthenticated?.() !== true) {
      next();
      return;
    }
    const sub = getCaller(req).sub;
    if (!sub) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    runWithRequestIdentity({
      sub,
      principalIssuer: getAuthenticatedPrincipalIssuer(req),
      isOperator: false,
    }, () => next());
  });
}

/**
 * @description Creates Express router for message endpoints.
 *
 * @param ctx - Application context with wired dependencies
 * @returns Express Router with message routes mounted
 */
export function createMessageRoutes(ctx: AppContext): Router {
  const router = Router();
  // The explicit no-AI state is evaluated before user-row attribution so every authenticated chat
  // write has the same 503 contract. History remains available on model-less deployments.
  router.post('/send-message', requireAiEnabled, requireMessageWriteIdentity, handleSendMessage(ctx));
  router.post('/tasks/:taskId/messages', requireAiEnabled, requireMessageWriteIdentity, handleSendMessage(ctx));
  router.get('/:taskId/messages', requireTrustedServiceUserIdentity, handleGetMessages(ctx));

  logger.info('Message routes registered');
  return router;
}

/**
 * @description Handler: Send a message to be processed by the orchestrator.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleSendMessage(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const startTime = Date.now();
    const {
      text,
      agenticMode,
      source,
      agentId,
      chatOnly,
      ticketId: bodyTicketId,
    } = req.body;
    // Accept taskId from URL param (POST /api/tasks/:taskId/messages) or body (POST /api/send-message)
    const taskId = req.params.taskId || req.body.taskId;

    logger.info({ taskId, textLength: text?.length, agenticMode, source }, 'POST /api/send-message');

    if (!taskId || !text) {
      res.status(400).json({ error: 'taskId and text are required' });
      return;
    }
    const callerSub = messageCallerSub(req);

    // IDOR guard: don't let a caller post into another user's existing task thread.
    if (!(await callerMayAccessTask(ctx, req, taskId))) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    let executionContext = {
      taskId,
      taskIdUsed: taskId,
      ticketCreated: false,
      ticketId: null as string | null,
      ticketStatus: null as string | null,
      ticketTitle: null as string | null,
    };

    try {
      const requestedAgentId = typeof agentId === 'string' && agentId.trim().length > 0
        ? agentId.trim()
        : '';
      const resolvedAgentId = await resolveMessageAgentId(ctx, taskId, requestedAgentId);
      // Runs BEFORE ticket creation and before any LLM work: an unentitled caller must not
      // create a ticket, consume budget, or reach a broker on the way to being refused.
      assertSendMessageEntitlement(req, resolvedAgentId, taskId);
      const resolvedContext = await resolveProjectManagerTicketExecutionContext(
        {
          taskStore: ctx.taskStore,
          ticketService: ctx.ticketService,
        },
        {
          requestedTaskId: taskId,
          resolvedAgentId,
          source: source ?? 'api',
          text,
          ownerSub: callerSub,
          // Guests are UNAUTHENTICATED, so their turn answers and stops: forcing chatOnly
          // keeps an anonymous visitor from creating a ticket and dispatching real work into
          // the swarm build pipeline. Not overridable from the body — a guest asking for
          // chatOnly: false would otherwise re-open exactly that path.
          chatOnly: chatOnly === true || isGuestRequest(req),
        },
      );
      executionContext = {
        taskId,
        taskIdUsed: resolvedContext.taskId,
        ticketCreated: resolvedContext.ticketCreated,
        ticketId: resolvedContext.ticketId ?? null,
        ticketStatus: resolvedContext.ticketStatus ?? null,
        ticketTitle: resolvedContext.ticketTitle ?? null,
      };

      const result = await ctx.orchestrator.processMessage(resolvedContext.taskId, text, {
        agenticMode: agenticMode ?? true,
        autoApprove: false,
        source: resolvedContext.source,
        agentId: resolvedAgentId,
        ticketContext: resolvedContext.ticketContext,
        // The generic message endpoint IS the conversational chat path (cockpit chat panel), so
        // default to 'chat' — this opens a workflow-less chat-ticket for each new thread (ADR: direct
        // bot chat → Chat queue). Callers doing task-mode work pass interactionMode:'task' to opt out.
        interactionMode: req.body.interactionMode ?? 'chat',
        ticketId: resolvedContext.ticketId ?? (typeof bodyTicketId === 'string' ? bodyTicketId : undefined),
        // Scope owner-bound server operations to the authenticated caller. Connector
        // credentials are never forwarded into this model-visible path.
        userSub: callerSub,
      } as any);

      const durationMs = Date.now() - startTime;
      logger.info(
        {
          taskId: executionContext.taskId,
          requestedTaskId: taskId,
          durationMs,
          success: result.success,
          agentId: resolvedAgentId,
          ticketCreated: executionContext.ticketCreated,
          ticketId: executionContext.ticketId,
        },
        'Message processed',
      );
      res.json({
        ...result,
        taskId: executionContext.taskIdUsed,
        taskIdUsed: executionContext.taskIdUsed,
        requestedTaskId: taskId,
        agentId: resolvedAgentId,
        ticketCreated: executionContext.ticketCreated,
        ticketId: executionContext.ticketId ?? null,
        ticketStatus: executionContext.ticketStatus ?? null,
        ticketTitle: executionContext.ticketTitle ?? null,
      });
    } catch (error) {
      // A denial is an authorization outcome, not a server fault: 403 with the same machine
      // code the bot-node gate returns, logged at WARN (the gate already logged the audit line).
      if (error instanceof CallerNotEntitledError) {
        logger.warn(
          { taskId, targetAgentId: error.targetAgentId, durationMs: Date.now() - startTime },
          'send-message refused: caller is not entitled to the named agent',
        );
        res.status(403).json({ success: false, error: error.code });
        return;
      }
      logger.error({ err: error, taskId, durationMs: Date.now() - startTime }, 'Failed to process message');
      if (executionContext.ticketCreated && executionContext.ticketId) {
        res.status(202).json({
          success: false,
          partialSuccess: true,
          error: 'Ticket created, but the assistant reply failed.',
          taskId: executionContext.taskIdUsed,
          taskIdUsed: executionContext.taskIdUsed,
          requestedTaskId: taskId,
          ticketCreated: true,
          ticketId: executionContext.ticketId,
          ticketStatus: executionContext.ticketStatus,
          ticketTitle: executionContext.ticketTitle,
        });
        return;
      }
      res.status(500).json({ error: 'Failed to process message' });
    }
  };
}

/**
 * @description Resolve the effective agent id for message processing.
 * Priority order:
 * 1. Explicit request agent id
 * 2. Existing task agent id
 * 3. Default shared chat agent id
 *
 * @param ctx - Application context
 * @param taskId - Task identifier
 * @param requestedAgentId - Agent id from request payload
 * @returns Effective agent id for orchestrator processing
 */
async function resolveMessageAgentId(ctx: AppContext, taskId: string, requestedAgentId: string): Promise<string> {
  if (requestedAgentId) {
    return requestedAgentId;
  }

  try {
    const task = await ctx.taskStore.get(taskId);
    const taskAgentId = typeof task?.agentId === 'string' ? task.agentId.trim() : '';
    if (taskAgentId) {
      return taskAgentId;
    }
  } catch (error) {
    logger.warn({ err: error, taskId }, 'Failed to resolve task agent id; using default chat agent');
  }

  return DEFAULT_CHAT_AGENT_ID;
}

/**
 * @description Handler: Get message history for a task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleGetMessages(ctx: AppContext) {
  return async (req: Request, res: Response): Promise<void> => {
    const taskId = req.params.taskId as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    logger.info({ taskId, limit }, 'GET /api/:taskId/messages');

    // IDOR guard: a caller may only read the history of a task they own (or an operator).
    if (!(await callerMayReadMessages(ctx, req, taskId))) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    try {
      const messages = limit
        ? await ctx.messageStore.getRecent(taskId, limit)
        : await ctx.messageStore.getByTask(taskId);

      res.json({ messages, count: messages.length });
    } catch (error) {
      logger.error({ err: error, taskId }, 'Failed to get messages');
      res.status(500).json({ error: 'Failed to get messages' });
    }
  };
}
