/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added chat-reply bridge so A2A remote clients get a bot-reasoned conversational reply (ADR-036: the bot owns reasoning + cost)
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'remote-client-chat-bridge' });

/**
 * @description Structural view of the task orchestrator the bridge needs.
 * Declared locally (not imported from the chat-orchestration slice) so the
 * remote-client feature does not cross-import a sibling slice — Feature-Sliced
 * Design forbids same-layer cross-imports. The app layer passes the real
 * `TaskOrchestrator`, which satisfies this shape structurally.
 */
export interface RemoteChatProcessOptions {
  agenticMode: boolean;
  autoApprove: boolean;
  source: string;
  agentId?: string;
  userSub?: string;
}

export interface RemoteChatOrchestrator {
  processMessage(
    taskId: string,
    text: string,
    options: RemoteChatProcessOptions,
  ): Promise<{ success: boolean; response?: string; usageSummary?: unknown }>;
}

/**
 * @description One conversational turn requested by a remote A2A client.
 */
export interface RemoteChatTurnInput {
  /** Remote client identifier (registry key). */
  clientId: string;
  /** Target bot/agent that reasons over the turn (defaults applied by caller). */
  agentId: string;
  /** Stable conversation/task id so turns share context. */
  taskId: string;
  /** User message text. */
  text: string;
  /** Correlation id returned on the reply for request/response pairing. */
  correlationId: string;
  /** Optional OIDC sub to scope per-user connector tokens (ADR-042). */
  userSub?: string;
}

/**
 * @description Reply payload produced after the bot reasons over a turn.
 * This is the `payload` of the swarm message the remote client polls for.
 */
export interface RemoteChatReplyPayload {
  type: 'chat.reply';
  taskId: string;
  correlationId: string;
  success: boolean;
  text: string;
  error?: string;
  usageSummary?: unknown;
}

/**
 * @description Runs one remote chat turn through the orchestrator so the bot
 * (not the controller) does the LLM reasoning and cost capture, then shapes the
 * reply for delivery back over the remote-client swarm-message queue.
 *
 * Errors are caught and returned as a failed reply payload rather than thrown,
 * so the caller can always deliver something to the polling client.
 *
 * @param orchestrator - Structural orchestrator (real TaskOrchestrator at runtime)
 * @param input - The turn to process
 * @returns The reply payload to enqueue for the remote client
 */
export async function runRemoteChatTurn(
  orchestrator: RemoteChatOrchestrator,
  input: RemoteChatTurnInput,
): Promise<RemoteChatReplyPayload> {
  const startedAt = Date.now();
  logger.info(
    { clientId: input.clientId, agentId: input.agentId, taskId: input.taskId, textLength: input.text.length },
    'Processing remote chat turn',
  );

  try {
    const result = await orchestrator.processMessage(input.taskId, input.text, {
      agenticMode: true,
      autoApprove: false,
      source: 'remote-client',
      agentId: input.agentId,
      userSub: input.userSub,
    });

    logger.info(
      { clientId: input.clientId, taskId: input.taskId, success: result.success, durationMs: Date.now() - startedAt },
      'Remote chat turn processed',
    );

    return {
      type: 'chat.reply',
      taskId: input.taskId,
      correlationId: input.correlationId,
      success: Boolean(result.success),
      text: typeof result.response === 'string' ? result.response : '',
      usageSummary: result.usageSummary,
    };
  } catch (error) {
    logger.error(
      { err: error, clientId: input.clientId, taskId: input.taskId, durationMs: Date.now() - startedAt },
      'Remote chat turn failed',
    );
    return {
      type: 'chat.reply',
      taskId: input.taskId,
      correlationId: input.correlationId,
      success: false,
      text: '',
      error: error instanceof Error ? error.message : 'Remote chat turn failed',
    };
  }
}
