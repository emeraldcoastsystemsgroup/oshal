/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Cost-governance interactive gate: executeBotOrInline is the chokepoint both remote BotNodeClient.execute and inline-orchestrator executions flow through (ADR-036 direct sync path), so a HARD user-scope budget breach now blocks interactive execution here — queued dispatch is separately gated in the queue manager. Fail-open on infra gaps per BudgetService semantics.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-090 skill-profile GENERAL carrier: executeBotOrInline is the shared bot-execution chokepoint, so resolve the calling app's domain profile ONCE here (controller-side; the bot holds no registry — ADR-036), guarded on request.app && request.capability. Inline path weaves the composed block into the text before processMessage; remote path sets request.pattern so it rides to the bot node's assembled-prompt append. Generalizes email-routes' hand-wired composition off request.app/capability instead of a hardcoded app. No-op for every call that omits app/capability.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | BACKLOG "Bot-endpoint privilege model" (diagnosis bot-endpoint-priv): executeBotOrInline now runs assertExecuteEntitlement BEFORE dispatching either branch — controller-INLINE bots resolve to a null endpoint (CONTROLLER_INLINE_CONTAINERS) and bypassed the bot-node HTTP entitlement gate entirely, so exactly the ADR-087 operator/swarm-scoped machinery (project-manager, codex-packer) had NO execute-time per-caller check; remote calls now also get an early controller-side denial. Reuses the SAME pure decideExecuteEntitlement the bot-node gate runs (no policy copy to drift). Mode: warn default (log-only), enforce throws CallerNotEntitledError (statusCode 403).
 */

import type { AppContext } from '@/app/composition/app-context';
import type { BotNodeClient, BotNodeRequest, BotNodeResponse } from '@/features/agent-management';
import type { TaskUsageSummary } from '@/shared/types';
import { BudgetService } from '@/features/cost-governance';
import { composeSkillProfilePrompt, resolveSkillProfileByApp } from '@/shared/skill-profiles';
import { assertExecuteEntitlement } from '@/app/bot-node-execute-entitlement';

/**
 * @description Executes a bot request on its remote any-bot node when one exists;
 * otherwise runs controller-inline bots through the local orchestrator. Both paths sit
 * behind the cost-governance budget gate: a HARD user-scope daily cap definitively
 * exceeded throws before any LLM work starts (fail-open on infra gaps — a missing
 * budgets table or DB hiccup never blocks execution).
 * @param ctx - App context (pool + inline orchestrator).
 * @param botClient - Bot-node client used for remote any-bot execution.
 * @param agentId - The target bot's agent UUID.
 * @param request - The execution request (userSub is the accountable spend owner).
 * @returns The bot-node response (remote or inline-normalized).
 * @throws CallerNotEntitledError (statusCode 403) in enforce mode when an interactive
 *   identity caller (userSub + direct:true) is not entitled to the target bot.
 */
export async function executeBotOrInline(
  ctx: AppContext,
  botClient: BotNodeClient,
  agentId: string,
  request: BotNodeRequest,
): Promise<BotNodeResponse> {
  // Execute-time entitlement (BACKLOG "Bot-endpoint privilege model"): the SAME pure decision
  // the bot-node HTTP gate runs, applied at THIS controller chokepoint because inline bots
  // (null endpoint) never reach that gate and remote calls deserve an early denial. Runs
  // FIRST — an unentitled caller must not consume budget checks or profile resolution.
  // warn (default): logs the would-be denial and proceeds; enforce: throws (403).
  assertExecuteEntitlement({
    userSub: request.userSub,
    direct: request.direct === true,
    targetAgentId: agentId,
    taskId: request.taskId ?? null,
    surface: 'executeBotOrInline',
  });

  // BudgetService holds no per-instance caches, so per-call construction is safe.
  const verdict = await new BudgetService(ctx.pool).checkBudget(request.userSub ?? null);
  if (!verdict.allowed) {
    throw new Error(
      `Budget governance blocked execution (${verdict.reason}): spend $${verdict.spend?.toFixed(2)} >= cap $${verdict.cap}`,
    );
  }

  // ADR-090 skill-profile GENERAL carrier: resolve the calling app's domain profile for this
  // capability ONCE, controller-side (the bot holds no registry — ADR-036). Guarded on BOTH app +
  // capability, so every non-app call resolves to '' — an exact no-op. composeSkillProfilePrompt
  // returns '' when no app registered a profile for that capability. This generalizes email-routes'
  // hand-wired composition to ANY app's execute / inline-concierge path, keyed off the request.
  const skillPattern = request.app && request.capability
    ? composeSkillProfilePrompt('', request.capability, resolveSkillProfileByApp(request.app, request.capability))
    : '';

  if (botClient.hasEndpoint(agentId)) {
    // Remote path: the resolved block rides to the bot node as request.pattern (→ envelope.payload).
    // The bot-node execution handler appends it to its assembled prompt in BOTH prompt branches —
    // the layered branch builds from persona layers + buildUserMessage, never from `text`, which is
    // exactly why weaving into `text` (as the inline path does) would never reach it there.
    if (skillPattern) request.pattern = skillPattern;
    return botClient.execute(agentId, request);
  }

  const start = Date.now();
  // Inline (controller-hosted concierge) path: no envelope/bot node, so weave the resolved block into
  // the text before processMessage — same effect as the remote append, one place.
  const inlineText = skillPattern ? `${request.text}${skillPattern}` : request.text;
  const result = await ctx.orchestrator.processMessage(request.taskId, inlineText, {
    agenticMode: request.agenticMode ?? true,
    autoApprove: false,
    source: 'inline-bot',
    agentId,
    userSub: request.userSub,
    creds: request.creds,
    providerId: request.providerId,
    model: request.model,
    interactionMode: request.direct ? 'task' : 'chat',
    byoLlmConnection: request.byoLlmConnection,
  } as any);

  if (!result.success) {
    throw new Error(`Inline bot execution failed: ${result.error || 'Unknown error'}`);
  }

  const usage = result.usageSummary;
  const model = firstUsageModel(usage) ?? request.model ?? 'inline-orchestrator';
  return {
    success: true,
    response: result.response ?? '',
    usage: {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    cost: usage?.totalCost ?? 0,
    model,
    provider: request.byoLlmConnection ? 'byo-llm' : 'inline-orchestrator',
    durationMs: Date.now() - start,
    taskId: request.taskId,
  };
}

function firstUsageModel(usage?: TaskUsageSummary): string | null {
  const names = Object.keys(usage?.byModel ?? {});
  return names.length > 0 ? names[0] : null;
}
