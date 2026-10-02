/**
 * Jarvis bounded brain steps — the in-process follow-ups of a Jarvis turn (haven passive learning,
 * the legacy classify/synthesize) and the brain they ride.
 *
 * Carved out of jarvis-orchestrator.ts (already past the 800-code-line decomposition threshold) when
 * `runInline` stopped calling the orchestrator directly. A step goes through `executeBotOrInline`,
 * the SAME chokepoint as the turn itself: it carries the caller's brain to wherever the bot runs — a
 * dedicated node takes the turn's CLI stamp or hosted connection (and walks the ladder itself when
 * none is carried), an inline bot takes the hosted ladder — and settles the cost in chat_tasks under
 * the agent id (ADR-036/050). Calling the orchestrator directly skipped all of that: the step built
 * the controller's configured CLI harness in-process, which SEC-05 refuses unattended, so passive
 * learning failed on every CLI-brain turn (live 2026-10-02 08:13 UTC on main bbf062ce:
 * `jarvis-haven-learn-…` → UNBROKERED_AUTONOMOUS_PROVIDER while the turn itself had just answered).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | TurnBrain, hostedWire and runBrainStep: a bounded Jarvis step is dispatched through executeBotOrInline with the brain the orchestrator resolved for the turn (CLI stamp, hosted trio, or the retry's endpoint), never through the controller's in-process CLI harness.
 *
 * @module jarvis-brain-steps
 */

import type { AppContext } from '@/app/composition/app-context';
import type { BotNodeClient } from '@/features/agent-management';
import type { ByoLlmConnection } from './byo-llm-routes';
import { executeBotOrInline } from './inline-bot-execution';

/**
 * @description The brain a Jarvis turn ran on, carried to its bounded follow-up steps: the hosted
 * connection the orchestrator resolved (or retried onto), and/or the CLI stamp the node reconciles
 * onto. An empty carry lets the chokepoint resolve the ladder itself.
 */
export interface TurnBrain {
  byoLlmConnection?: ByoLlmConnection;
  providerId?: string;
  model?: string;
}

/**
 * @description The wire trio of a resolved hosted connection — exactly what rides to a node as
 * `byoLlmConnection` (the controller-side resolution metadata never travels).
 * @param connection - A resolved connection, or nothing.
 * @returns The trio, or undefined when there is no connection.
 */
export function hostedWire(
  connection: { baseUrl: string; apiKey: string; model: string } | null | undefined,
): ByoLlmConnection | undefined {
  return connection ? { baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model } : undefined;
}

/**
 * @description Run one bounded step for a bot through `executeBotOrInline` with the request shape the
 * turn itself uses (direct, agentic, the caller's sub, the caller-minted task id) and the brain carried
 * from the turn. Returns the bot's final text.
 * @param ctx - App context (pool + orchestrator for the inline branch).
 * @param botClient - The node client the chokepoint dispatches with.
 * @param agentId - The bot that reasons for this step.
 * @param prompt - The step's complete prompt.
 * @param sub - The caller's OIDC sub; scopes data access and cost.
 * @param taskId - Fresh per step (no cross-turn history bleed); doubles as the workspace folder id.
 * @param brain - What the turn ran on; an empty carry lets the chokepoint resolve the ladder.
 * @returns The bot's final text, trimmed.
 */
export async function runBrainStep(
  ctx: AppContext, botClient: BotNodeClient, agentId: string, prompt: string, sub: string, taskId: string,
  brain: TurnBrain = {},
): Promise<string> {
  const result = await executeBotOrInline(ctx, botClient, agentId, {
    text: prompt,
    taskId,
    workspaceFolderId: taskId,
    agentId,
    agenticMode: true,
    direct: true,
    userSub: sub,
    ...(brain.byoLlmConnection ? { byoLlmConnection: brain.byoLlmConnection } : {}),
    ...(brain.providerId ? { providerId: brain.providerId } : {}),
    ...(brain.model ? { model: brain.model } : {}),
  });
  return String(result.response || '').trim();
}
