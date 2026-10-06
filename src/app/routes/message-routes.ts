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
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 inline hosted brain: this route calls ctx.orchestrator.processMessage DIRECTLY (see seq 9), so it now resolves the caller's hosted user-brain ladder via the SAME shared helper executeBotOrInline uses (resolveHostedBrainForCliAgent — one condition, no drift) when the resolved agent's registry harness is an unbrokered CLI, and threads it as options.byoLlmConnection. Runs BEFORE ticket creation so a turn that cannot run never opens a ticket. NO_HOSTED_BRAIN maps to a clean 422 whose `error` field carries the friendly Settings → AI Providers message the cockpit chat panel renders (throwResponseError shows error.error).
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Turn-time hosted-brain failover: a lane that passes its resolution probe can exhaust its quota mid-turn (Gemini free tier = 20 requests/day), and the provider's 429 was handed to the caller AS THE ANSWER. The turn now reports the failure (cools the free-tier row / drops the cached operator-lane verdict) and replays ONCE on the next resolved lane via retryHostedBrainTurn — same bounded-retry shape the Jarvis path uses. Explicit BYO connections keep surfacing their own failures unretried.
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Close seq 17's blind spot (live 2026-08-11: the 429 STILL became the answer on THIS route): agentic turns catch provider errors inside task-orchestrator.handleError and RESOLVE with { success:false, error }, so the catch never fired. swallowedTurnFailure inspects the resolved result and feeds the same retryHostedBrainTurn; a non-retryable failure (reportResolvedLlmFailure's gate) keeps the original failed result.
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | ONE-CHOKEPOINT node dispatch: when the resolved agent has a dedicated node endpoint, this route now executes the turn through executeBotOrInline (budget gate + ADR-090 skills + the ADR-127 REMOTE brain stamp — the demo operator's mounted CLI, a guest's hosted lane) instead of calling the controller orchestrator directly with the hosted-ONLY ladder — which is exactly how a node-backed bot's chat turns kept dying on an exhausted hosted key while a healthy CLI login sat mounted at its node. The controller persists both turns (persistJarvisTurn, the shared chat-turn writer) so GET /api/:taskId/messages replays node threads; ticket/chat-task bookkeeping and guest chatOnly containment are identical to the inline path. Inline bots are byte-identical to seq 18.
 * 20 | maintainer@emeraldcoastsystemsgroup.com | Require current exact-principal authorization for protected thread writes and history reads, including after asynchronous history retrieval.
 * 21 | maintainer@emeraldcoastsystemsgroup.com | ONE-CHOKEPOINT admission on the INLINE half (BACKLOG "One bot-invocation chokepoint - the INLINE half of /api/send-message"). Seq 19 routed the NODE half through executeBotOrInline, so a chat turn to a bot with its own node endpoint has cleared the cost-governance gate since then; a bot the registry binds to the controller took the other branch and called ctx.orchestrator.processMessage DIRECTLY - no budget check, no specialist-context or credential-carrier refusal. A user sitting on a tripped HARD daily cap could therefore keep spending through the cockpit chat panel indefinitely, as long as the bot they were talking to was inline, which is most of the concierge fleet. That branch now calls the SAME decision executeBotOrInline applies (assertBotInvocationAdmissible, extracted for exactly this caller - this route's turn carries a ticketContext and an interactionMode BotNodeRequest cannot hold), ahead of the hosted-brain ladder and ticket creation, and BudgetBlockedError maps to 402 budget_cap_exceeded so the refusal names its reason instead of arriving as an anonymous 500. Guard: tests/unit/send-message-budget-gate.spec.ts.
 * 22 | maintainer@emeraldcoastsystemsgroup.com | Bounded SAME-endpoint retry on the cockpit chat path (operator decision 2026-09-22), the twin of inline-bot-execution seq 14. This route had the same two outcomes for a provider wall - rotate, or surface it - and rotation is permanently refused for an explicitly chosen BYO endpoint, so exactly those turns got no retry and an intermittently tripping provider spend cap became the assistant answer. When isExplicitByoTurn says the ladder resolved the user own BYO row, the first attempt runs inside runWithSameEndpointRetry (same URL, same key, same account; attempt, backoff and wall-clock bounds) reading swallowedTurnFailure so it also sees the resolved-failure shape the agentic loop produces. The rotation legs below are unchanged and resolver-owned lanes are not wrapped.
 * 23 | maintainer@emeraldcoastsystemsgroup.com | The inline branch now rides runInlineTurnWithRecovery, the ONE turn body it shares with executeBotOrInline (inline-bot-execution seq 15): the same-endpoint replay moved INTO the orchestrator's provider call (options.byoLlmRetry — one saved user message, one error broadcast per turn, where the seq-22 wrapper had re-done both per attempt), rotation is unchanged, and an exhausted explicit endpoint falls, for the deployment operator only, through the readiness-gated configured chain. A fallback turn answers with the brainFallback marker; a fallback that was not ready answers 503 BYO_FALLBACK_NOT_READY whose `error` names the endpoint, the attempts and every rung's reason — the field the cockpit renders.
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Keep task and actual ticket ownership separate from protected lineage, refuse unresolved existing threads and prioritize authenticated users over legacy service headers.
 * 25 | maintainer@emeraldcoastsystemsgroup.com | Record inline protected conversation lineage and defer stream publication until completion and current owner access are proved.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Diagnose protected empty-thread and inline refusals with ERROR, bounded identifiers, duration and scrubbed stacks while preserving response contracts.
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | ADR-149 protected node bots accept cockpit and rail chat. Every chat client posts agenticMode:true or omits it, and a protected node admits only direct configured reasoning (direct:true, agenticMode:false, one server-resolved brain), so each turn to a protected node bot was refused with authorization_remote_hosted_reasoning_required. nodeChatTurnShape decides the node request shape server-side with the inline branch's exact protection expression (isApplicationExecutionProtected OR isProtectedAgent, the ownership claim BotNodeClient's protected prepare decides from): an interactive turn to a protected bot is non-agentic whatever the body says; machine calls and unprotected bots keep their shape. The node reply the controller persists is now also published on the task stream after protected lineage, both turns and the caller read are proved, so the rail shows it without a reload; the stream route still authorizes every subscriber per event. Guards: tests/unit/protected-node-chat-turn.spec.ts, tests/unit/bot-node-protected-execution.spec.ts.
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Concierge node route. The transport is decided BEFORE ticket intake by resolveBotDispatchRoute (inline-bot-execution seq 22), with the same interactive rule nodeChatTurnShape uses (isInteractiveChatCall, now shared by both), so an inline app bot whose operator turn can run on the concierge node takes the existing node branch - server-side turn shape, ticket intake, persist, re-check, publish - and hands the decided route to executeBotOrInline so it is not recomputed. The inline branch is unchanged except that an unhealthy concierge plus an empty hosted ladder names itself: NoHostedBrainError's detail (concierge_node_unavailable) is included in the 422 body.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createChildLogger, logOperationError, observeOperation, observeAsyncOperation } from '@/shared/logger';
import { DEFAULT_CHAT_AGENT_ID, resolveProjectManagerTicketExecutionContext } from '@/features/chat-orchestration';
import { getCaller, hasAuthenticatedUserIdentity, hasValidServiceSecret, getTrustedServiceUserSub } from '@/shared/middleware/authz';
import { assertExecuteEntitlement, CallerNotEntitledError } from '@/app/bot-node-execute-entitlement';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { requireTrustedServiceUserIdentity } from '@/shared/middleware/trusted-service-user-identity';
import { requireAiEnabled } from '@/shared/middleware/ai-availability';
import { getAuthenticatedPrincipalIssuer } from '@/shared/middleware/principal-issuer';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { BudgetBlockedError, NoHostedBrainError, assertBotInvocationAdmissible, executeBotOrInline, hostedBrainWire, isExplicitByoTurn, resolveBotDispatchRoute, resolveInlineHostedBrain, runInlineTurnWithRecovery, type InlineTurnOptions } from './inline-bot-execution';
import { ByoFallbackUnavailableError } from './byo-hot-fallback';
import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { persistJarvisTurn } from './jarvis-task-store';
import type { AppContext } from '../composition-root';
import { callerCanReadTaskResult } from './protected-result-access';
import { persistProtectedResultTask } from './protected-result-persistence';
import { hasProtectedTaskResults, isProtectedAgent, readProtectedResultExecutions, type ProtectedResultTask } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer, OWNER_PRINCIPAL_ISSUER_METADATA_KEY } from '@/shared/security/owner-principal-issuer';
import { isAuthenticatedGuest, type OwnedRecord } from './record-ownership';
import { ProtectedInlineTaskUnavailableError, runProtectedInlineTurn } from './protected-inline-execution';
import { isApplicationExecutionProtected } from '@/shared/application-authorization-execution';

const logger = createChildLogger({ module: 'message-routes' });

/** Dedicated-node transport for bots the registry binds to their own container (standard idiom). */
const botClient = new BotNodeClient(createRegistryEndpointResolver());

/**
 * @description Object-level authorization for posting to a task thread. Existing
 * tasks must have current canonical ownership; only successful absent lookups with
 * no ticket, history or protected output allow a brand-new unlinked chat thread.
 */
async function callerMayAccessTask(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const binding = await readMessageTaskBinding(ctx, taskId);
    if (binding.ownership) {
      return await callerCanReadTaskResult(ctx, req, binding.task, binding.ownership)
        || binding.stored && await mayStartEmptyTask(ctx, req, binding.task);
    }
    return !binding.stored && await mayStartUnlinkedTask(ctx, req, taskId);
  } catch (err) {
    logOperationError(logger, 'callerMayAccessTask', { taskId }, err, startedAt);
    return false;
  }
}

async function readMessageTaskBinding(ctx: AppContext, taskId: string): Promise<{
  task: ProtectedResultTask; stored: boolean; ownership: OwnedRecord | null;
}> {
  const task = await ctx.taskStore.get(taskId);
  if (task?.ownerSub) return { task, stored: true, ownership: task };
  const ticket = await ctx.workspaceService.resolveTaskOwnership(taskId);
  const ownership = ticket ? { ownerSub: ticket.ownerSub,
    metadata: ticket.ownerPrincipalIssuer ? { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: ticket.ownerPrincipalIssuer } : undefined } : task;
  return { task: task ?? { taskId }, stored: Boolean(task), ownership };
}

async function mayStartUnlinkedTask(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  if (!messageCallerSub(req) || isGuestRequest(req) && !isAuthenticatedGuest(req)) return false;
  if (await hasProtectedTaskResults(taskId)) return false;
  return !(await ctx.messageStore.getByTask(taskId)).length;
}

/**
 * @description Allow an exact stamped owner's empty shell without manufacturing result lineage.
 * @param ctx Canonical stores and trusted actor resolver.
 * @param req Authenticated transport request.
 * @param task Stored destination already admitted by the existing ownership gate.
 * @returns The unchanged empty-shell write decision; any lookup fault remains a refusal.
 */
async function mayStartEmptyTask(ctx: AppContext, req: Request, task: ProtectedResultTask): Promise<boolean> {
  const startedAt = Date.now();
  return observeAsyncOperation(logger, 'mayStartEmptyTask', { taskId: task.taskId }, async () => {
    try {
      if (!ctx.applicationAuthorization || readProtectedResultExecutions(task.metadata).length
        || await hasProtectedTaskResults(task.taskId)) return false;
      const actor = await ctx.applicationAuthorization.resolveActor(req);
      if (!actor.isActive || actor.sub !== task.ownerSub || actor.issuer !== readOwnerPrincipalIssuer(task.metadata)) return false;
      return !(await ctx.messageStore.getByTask(task.taskId)).length;
    } catch (error) {
      logOperationError(logger, 'mayStartEmptyTask', { taskId: task.taskId }, error, startedAt);
      return false;
    }
  });
}

/**
 * @description Object-level authorization for reading message history. Unlike
 * write/new-thread checks, history reads fail closed when the task row is not
 * visible under RLS and no ticket owner can be resolved.
 */
async function callerMayReadMessages(ctx: AppContext, req: Request, taskId: string): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const binding = await readMessageTaskBinding(ctx, taskId);
    return Boolean(binding.ownership && await callerCanReadTaskResult(ctx, req, binding.task, binding.ownership));
  } catch (err) {
    logOperationError(logger, 'callerMayReadMessages', { taskId }, err, startedAt);
    return false;
  }
}

function isBareServiceMessage(req: Request): boolean {
  return !hasAuthenticatedUserIdentity(req) && hasValidServiceSecret(req);
}

/** Resolve the owner only from authenticated transport identity, never request content. */
function messageCallerSub(req: Request): string | undefined {
  return (hasAuthenticatedUserIdentity(req) ? getCaller(req).sub : getTrustedServiceUserSub(req)) ?? undefined;
}

/**
 * @description Execute-time entitlement for THIS endpoint (BACKLOG "Bot-endpoint privilege
 * model"). The service secret proves a trusted machine is calling and the IDOR guard proves the
 * caller owns the THREAD; neither says the caller is entitled to the BOT they just named. Reuses
 * the same decision the bot-node HTTP gate and executeBotOrInline run, so there is no policy
 * copy to drift.
 *
 * `direct` is what separates the two caller classes the model already distinguishes:
 *   - a bare valid service-secret call is swarm/queue dispatch threading a ticket owner's sub for
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
  const isMachineCall = isBareServiceMessage(req);
  const sessionSub = hasAuthenticatedUserIdentity(req) ? getCaller(req).sub : null;
  assertExecuteEntitlement({
    userSub: isMachineCall ? getTrustedServiceUserSub(req) ?? sessionSub : sessionSub,
    direct: !isMachineCall && Boolean(sessionSub),
    targetAgentId: resolvedAgentId,
    taskId,
    surface: 'POST /api/send-message',
  });
}

/**
 * @description Whether this chat call is interactive per-user delegation: the same interactive-vs-swarm
 * distinction assertSendMessageEntitlement applies (seq 9). Only a bare service-secret call is swarm
 * dispatch; an independently authenticated user is direct. One rule for the node turn shape and the
 * concierge route, so the two cannot disagree about who is interactive.
 * @param req - The inbound request; only its identity and service-secret facts are read.
 * @returns True for an interactive identity caller.
 */
function isInteractiveChatCall(req: Request): boolean {
  const sessionSub = hasAuthenticatedUserIdentity(req) ? getCaller(req).sub : null;
  return !isBareServiceMessage(req) && Boolean(sessionSub);
}

/**
 * @description Decide a node-bound chat turn's request shape on the server. Every chat client posts
 * agenticMode:true or omits it, while a protected node admits only direct configured reasoning
 * (direct:true, agenticMode:false, one server-resolved brain), so an interactive turn to a protected
 * bot is made non-agentic whatever the body says. The protection check is the inline branch's exact
 * expression (protected-inline-execution.ts): the execution policy OR the controller's own
 * protected-agent read, which is the ownership claim BotNodeClient's protected prepare decides from,
 * so the shape always follows what dispatch will actually prepare. It runs only for interactive
 * identity callers: a bare service-secret call (swarm dispatch) and an unprotected bot keep exactly
 * the shape they had.
 * @param req - The inbound request; only its identity and service-secret facts are read.
 * @param agentId - The node-bound bot the turn executes on.
 * @param requestedAgenticMode - The client's agenticMode, honoured only for an unprotected target.
 * @returns The agenticMode the node receives and the seq-9 interactive direct flag, in wire order.
 * @throws ApplicationOwnershipUnavailableError when the installed owner cannot be read, so the turn
 *   fails closed before a ticket, a brain-ladder walk or a dispatch.
 */
async function nodeChatTurnShape(req: Request, agentId: string, requestedAgenticMode: boolean | undefined):
  Promise<{ agenticMode: boolean; direct: boolean }> {
  const direct = isInteractiveChatCall(req);
  const protectedTarget = direct
    && (await isApplicationExecutionProtected({ kind: 'bots', operation: agentId }) || await isProtectedAgent(agentId));
  return { agenticMode: protectedTarget ? false : requestedAgenticMode ?? true, direct };
}

/**
 * @description Publish a node reply the controller has already persisted on the task stream, so the
 * rail and /chat render it live the way they render an inline reply (the orchestrator publishes
 * those itself). The caller invokes this only after protected lineage, both saved turns and the
 * caller's read re-check are proved; the stream route still re-authorizes every subscriber for the
 * event. A failed publish never fails the turn, because the reply is durable and replays on reload.
 * @param ctx - Application context holding the stream manager.
 * @param taskId - The thread both turns were persisted to.
 * @param response - The node's reply, normalized to the same text persistJarvisTurn stored.
 * @returns Nothing; a publish fault is logged at ERROR with the task id only, never the reply text.
 */
function publishNodeAssistantTurn(ctx: AppContext, taskId: string, response: unknown): void {
  const text = String(response || '').trim();
  if (!text) return;
  const startedAt = Date.now();
  try {
    ctx.streamManager.broadcastMessage(taskId, { role: 'assistant', type: 'say', text });
  } catch (error) {
    logOperationError(logger, 'publishNodeAssistantTurn', { taskId }, error, startedAt);
  }
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
  return observeOperation(logger, 'createMessageRoutes', {}, () => {
    const router = Router();
    // The explicit no-AI state is evaluated before user-row attribution so every authenticated chat
    // write has the same 503 contract. History remains available on model-less deployments.
    router.post('/send-message', requireAiEnabled, requireMessageWriteIdentity, handleSendMessage(ctx));
    router.post('/tasks/:taskId/messages', requireAiEnabled, requireMessageWriteIdentity, handleSendMessage(ctx));
    router.get('/:taskId/messages', requireTrustedServiceUserIdentity, handleGetMessages(ctx));

    return router;
  });
}

/**
 * @description Time the complete request, including early validation and access refusals, without retaining request content.
 * @param operation Fixed route operation label.
 * @param handle Existing request work with its current response and error contract.
 * @returns An observed handler that retains the caller's asynchronous request identity.
 */
function observeMessageHandler(operation: string, handle: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): Promise<void> => observeAsyncOperation(logger, operation,
    { taskId: req.params.taskId as string || req.body?.taskId }, () => handle(req, res));
}

/**
 * @description Handler: Send a message to be processed by the orchestrator.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleSendMessage(ctx: AppContext) {
  return observeMessageHandler('sendMessageRoute', async (req: Request, res: Response): Promise<void> => {
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
      // ONE-CHOKEPOINT node dispatch (2026-08-12): a bot the registry binds to its own node takes
      // this turn AT the node via executeBotOrInline — budget gate, ADR-090 skill profile, and the
      // ADR-127 REMOTE brain (stampRemoteBrain: the demo operator's mounted CLI stamped as the
      // authoritative provider, a guest's hosted lane threaded as byoLlmConnection). The inline
      // path below resolves the hosted-ONLY ladder, which is exactly wrong for a node-backed bot:
      // it is how a career chat turn kept landing on an exhausted hosted key while a healthy CLI
      // login sat mounted at the bot's node. Ticket/chat-task bookkeeping is identical to inline.
      // The transport, decided once and BEFORE ticket intake: the bot's own node, the concierge node
      // (an inline app bot on the carved operator's CLI login), or inline. A node route takes the
      // branch below and the decided route rides into executeBotOrInline so it is not recomputed.
      const route = await resolveBotDispatchRoute(ctx, botClient, resolvedAgentId,
        { userSub: callerSub, direct: isInteractiveChatCall(req) });
      if (route.kind !== 'inline') {
        // Decided before ticket intake, so an ownership read that cannot be determined opens nothing.
        const turnShape = await nodeChatTurnShape(req, resolvedAgentId, agenticMode);
        const nodeContext = await resolveProjectManagerTicketExecutionContext(
          { taskStore: ctx.taskStore, ticketService: ctx.ticketService },
          {
            requestedTaskId: taskId,
            resolvedAgentId,
            source: source ?? 'api',
            text,
            ownerSub: callerSub,
            // Same guest containment as the inline path below — not overridable from the body.
            chatOnly: chatOnly === true || isGuestRequest(req),
          },
        );
        executionContext = {
          taskId,
          taskIdUsed: nodeContext.taskId,
          ticketCreated: nodeContext.ticketCreated,
          ticketId: nodeContext.ticketId ?? null,
          ticketStatus: nodeContext.ticketStatus ?? null,
          ticketTitle: nodeContext.ticketTitle ?? null,
        };
        const result = await executeBotOrInline(ctx, botClient, resolvedAgentId, {
          text,
          taskId: nodeContext.taskId,
          workspaceFolderId: nodeContext.taskId,
          agentId: resolvedAgentId,
          ...turnShape,
          userSub: callerSub,
        }, route);
        const executionId = (result as { applicationExecutionId?: string }).applicationExecutionId;
        if (executionId) {
          if (!ctx.applicationAuthorization) throw new Error('protected_result_identity_unavailable');
          await persistProtectedResultTask(ctx, nodeContext.taskId, resolvedAgentId, executionId,
            await ctx.applicationAuthorization.resolveActor(req));
        }
        // The turn executed remotely, so the controller owns thread durability: persist both
        // turns to the SAME store GET /api/:taskId/messages replays. persistJarvisTurn is the
        // shared best-effort chat-turn writer (one save shape, no drift) despite its name.
        await persistJarvisTurn(ctx, nodeContext.taskId, 'user', text);
        await persistJarvisTurn(ctx, nodeContext.taskId, 'assistant', String(result.response || ''));
        if (executionId && !await callerMayReadMessages(ctx, req, nodeContext.taskId)) {
          res.status(404).json({ error: 'not found' }); return;
        }
        // The inline protected order: complete, persist, re-check, and only then publish.
        publishNodeAssistantTurn(ctx, nodeContext.taskId, result.response);

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
        return;
      }
      // ONE-CHOKEPOINT admission, the INLINE half: this branch cannot hand the turn to
      // executeBotOrInline (it carries a ticketContext and an interactionMode BotNodeRequest
      // has no room for), so it clears that function's OWN admission decision instead — the
      // specialist-context refusal, the credential-carrier refusals, and the cost-governance
      // HARD cap. Without this an inline bot was the way around the cap: the node half has been
      // gated since #186, the inline half went straight to the orchestrator. FIRST, ahead of
      // the brain ladder and ticket creation — a refused turn must not consume a free-tier
      // slot or open a ticket on its way to being refused.
      await assertBotInvocationAdmissible(ctx, resolvedAgentId, { userSub: callerSub }, false);
      // ADR-127 inline hosted brain: direct chat runs in-process on the controller, where an
      // unbrokered-CLI registry harness is refused unconditionally (SEC-05) — so when the target
      // bot declares one, resolve the caller's hosted brain via the SAME shared helper
      // executeBotOrInline uses. Also before ticket creation: a turn with no admissible brain
      // must not open a ticket on its way to being refused (NO_HOSTED_BRAIN → 422 below).
      const resolvedBrain = await resolveInlineHostedBrain(ctx.pool, resolvedAgentId, callerSub, route);
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

      const runTurn = (byoLlmConnection: ReturnType<typeof hostedBrainWire>, turn: InlineTurnOptions) =>
        ctx.orchestrator.processMessage(resolvedContext.taskId, text, {
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
          // Caller's resolved hosted brain (server-side resolution above — never from the body).
          byoLlmConnection,
          // Operator decision 2026-09-22: an explicitly chosen endpoint replays a retryable
          // wall against ITSELF at the model call — same URL, key and billing account — and,
          // for the operator, switches to a ready fallback rung there once it is exhausted.
          ...turn,
        } as any);
      // The cockpit chat panel is the other conversational entry point, and it rides the SAME
      // turn body as the inline chokepoint: first attempt (with the same-endpoint replay inside
      // the orchestrator when the ladder resolved the user's own BYO row), rotation for a
      // resolver-owned lane, and — for the deployment operator only — the readiness-gated hot
      // fallback when an explicit endpoint exhausted its replay.
      const verifiedActor = hasAuthenticatedUserIdentity(req) && !isGuestRequest(req) && ctx.applicationAuthorization
        ? await ctx.applicationAuthorization.resolveActor(req) : undefined;
      const { result, fallback, applicationExecutionId } = await runProtectedInlineTurn(ctx, resolvedAgentId,
        { taskId: resolvedContext.taskId, workspaceId: resolvedContext.taskId, userSub: callerSub }, () => runInlineTurnWithRecovery({
        pool: ctx.pool, agentId: resolvedAgentId, userSub: callerSub, resolvedBrain,
        firstEndpoint: hostedBrainWire(resolvedBrain),
        explicit: isExplicitByoTurn(undefined, resolvedBrain),
        runTurn,
      }), verifiedActor);


      res.json({
        ...result,
        taskId: executionContext.taskIdUsed,
        taskIdUsed: executionContext.taskIdUsed,
        requestedTaskId: taskId,
        agentId: resolvedAgentId,
        ticketCreated: executionContext.ticketCreated,
        ...(applicationExecutionId ? { applicationExecutionId } : {}),
        ticketId: executionContext.ticketId ?? null,
        ticketStatus: executionContext.ticketStatus ?? null,
        ticketTitle: executionContext.ticketTitle ?? null,
        // A fallback turn says so: the surface renders "answered by X — Y was unavailable".
        ...(fallback ? { brainFallback: fallback } : {}),
      });
    } catch (error) {
      logOperationError(logger, 'sendMessage', { taskId }, error, startTime);
      if (error instanceof ProtectedInlineTaskUnavailableError) {
        res.status(404).json({ error: 'not found' }); return;
      }
      // Typed refusals retain their actionable HTTP status; the catch above records the diagnostic separately.
      if (error instanceof CallerNotEntitledError) {
        res.status(403).json({ success: false, error: error.code });
        return;
      }
      // Cost governance refused this turn (HARD cap / runaway halt). A 500 would tell the
      // cockpit the server broke; 402 with the machine code tells it — and the person — that
      // the daily cap is the reason, which is the only actionable version of that answer.
      if (error instanceof BudgetBlockedError) {
        res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
        return;
      }
      // No hosted brain anywhere on the caller's ladder (ADR-127): a clean 422 whose `error`
      // field is the friendly Settings → AI Providers message — the cockpit chat panel renders
      // exactly that field (api-client throwResponseError), never the raw SEC-05 refusal.
      if (error instanceof NoHostedBrainError) {
        // `detail` names a known cause beyond the empty ladder (concierge_node_unavailable).
        res.status(422).json({ success: false, error: error.message, code: error.code,
          ...(error.detail ? { detail: error.detail } : {}) });
        return;
      }
      // The operator's chosen endpoint exhausted its retry and the hot fallback could not take
      // the turn: a 503 whose `error` names the endpoint, the attempts, and every rung's reason
      // — the one field the cockpit chat panel renders — instead of an anonymous failure.
      if (error instanceof ByoFallbackUnavailableError) {
        res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
        return;
      }
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
  });
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
  const startedAt = Date.now();
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
    logOperationError(logger, 'resolveMessageAgentId', { taskId }, error, startedAt);
  }

  return DEFAULT_CHAT_AGENT_ID;
}

/**
 * @description Handler: Get message history for a task.
 * @param ctx - Application context
 * @returns Express request handler
 */
function handleGetMessages(ctx: AppContext) {
  return observeMessageHandler('getMessagesRoute', async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const taskId = req.params.taskId as string;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;


    // IDOR guard: a caller may only read the history of a task they own (or an operator).
    if (!(await callerMayReadMessages(ctx, req, taskId))) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    try {
      const messages = limit
        ? await ctx.messageStore.getRecent(taskId, limit)
        : await ctx.messageStore.getByTask(taskId);

      if (!await callerMayReadMessages(ctx, req, taskId)) {
        res.status(404).json({ error: 'not found' }); return;
      }

      res.json({ messages, count: messages.length });
    } catch (error) {
      logOperationError(logger, 'getMessagesRoute', { taskId }, error, startedAt);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });
}
