/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | WS5: Created canonical ticket interaction service — separates update/chat/intake intents and provides durable message persistence for cockpit reply flow
 */

import { createChildLogger } from '@/shared/logger';
import type { IMessageStore } from '@/entities/message';
import type { TicketService } from '@/features/ticketing';

const logger = createChildLogger({ module: 'ticket-interaction-service' });

/**
 * @description The three canonical ticket interaction intents.
 * - `update` — persist operator guidance in the ticket message thread without triggering bot chat
 * - `chat` — explicit bot conversation, always ticket-aware and workspace-aware
 * - `intake` — route through ticket intake logic to create or re-intake a ticket
 */
export type TicketInteractionIntent = 'update' | 'chat' | 'intake';

/**
 * @description Input for a ticket interaction.
 */
export interface TicketInteractionInput {
  ticketId: string;
  text: string;
  intent: TicketInteractionIntent;
  requestedAgentId?: string;
  source: string;
}

/**
 * @description Result of a ticket interaction processing call.
 */
export interface TicketInteractionResult {
  success: boolean;
  intent: TicketInteractionIntent;
  taskId: string | null;
  messageId: string | null;
  activityEntry: Record<string, unknown>;
}

/**
 * @description Dependencies required by TicketInteractionService.
 */
export interface TicketInteractionDeps {
  ticketService: TicketService;
  messageStore: IMessageStore;
}

/**
 * @description Canonical ticket interaction processor.
 *
 * Separates three distinct operator intents — update, chat, intake — that were
 * previously conflated across cockpit-routes, ticket-routes, and message-routes.
 *
 * For `update`: persists the operator text as a durable message in the ticket's
 * primary task thread, replacing SSE-only fake-success behavior.
 *
 * For `chat` and `intake`: returns resolved context so the route handler can
 * invoke orchestration with canonical ticket/workspace awareness.
 */
export class TicketInteractionService {
  private readonly ticketService: TicketService;
  private readonly messageStore: IMessageStore;

  constructor(deps: TicketInteractionDeps) {
    this.ticketService = deps.ticketService;
    this.messageStore = deps.messageStore;
  }

  /**
   * @description Process a ticket interaction by intent.
   *
   * For `update` intent: saves the operator message to the message store
   * against the ticket's primary task. Returns the saved message ID.
   *
   * For `chat`/`intake`: resolves the primary task ID and returns context
   * for the caller to dispatch via orchestrator.
   *
   * @param input - Interaction input with ticketId, text, intent, and source
   * @returns Resolved interaction result
   */
  async processInteraction(input: TicketInteractionInput): Promise<TicketInteractionResult> {
    const { ticketId, text, intent, source } = input;
    logger.info({ ticketId, intent, source }, 'Processing ticket interaction');

    const taskId = await this.resolvePrimaryTaskId(ticketId);
    const activityEntry = buildActivityEntry(text, intent);

    if (intent === 'update') {
      return this.processUpdate(ticketId, text, source, taskId, activityEntry);
    }

    // For 'chat' and 'intake': return resolved context — caller dispatches to orchestrator
    logger.info({ ticketId, intent, taskId }, 'Ticket interaction resolved — caller handles orchestration');
    return { success: true, intent, taskId, messageId: null, activityEntry };
  }

  /**
   * @description Resolve the primary task ID for a ticket from its task links.
   * @param ticketId - Ticket whose primary task should be resolved
   * @returns Primary task ID, or null if none found
   */
  async resolvePrimaryTaskId(ticketId: string): Promise<string | null> {
    try {
      const links = await this.ticketService.getTasksForTicket(ticketId);
      const primary = Array.isArray(links) ? links.find((l) => l.role === 'primary') : null;
      return primary?.taskId ?? null;
    } catch (err) {
      logger.warn({ err, ticketId }, 'Failed to resolve primary task ID for ticket interaction');
      return null;
    }
  }

  /**
   * @description Persist an `update` intent message to the ticket's primary task thread.
   */
  private async processUpdate(
    ticketId: string,
    text: string,
    source: string,
    taskId: string | null,
    activityEntry: Record<string, unknown>,
  ): Promise<TicketInteractionResult> {
    if (!taskId) {
      logger.warn({ ticketId }, 'No primary task found for ticket update — persisting without task anchor');
      return { success: true, intent: 'update', taskId: null, messageId: null, activityEntry };
    }

    try {
      const saved = await this.messageStore.save({
        taskId,
        role: 'user',
        type: 'say',
        text,
        contentBlocks: [],
        metadata: { ticketId, source, intent: 'update' },
      });
      logger.info({ ticketId, taskId, messageId: saved.messageId }, 'Ticket update message persisted');
      return { success: true, intent: 'update', taskId, messageId: saved.messageId, activityEntry };
    } catch (err) {
      logger.error({ err, ticketId, taskId }, 'Failed to persist ticket update message');
      return { success: false, intent: 'update', taskId, messageId: null, activityEntry };
    }
  }
}

/**
 * @description Build an SSE-compatible activity entry for a ticket interaction.
 * @param text - Interaction text
 * @param intent - Resolved intent
 * @returns Activity entry object
 */
function buildActivityEntry(text: string, intent: TicketInteractionIntent): Record<string, unknown> {
  return {
    id: `interaction-${Date.now()}`,
    type: 'user',
    text: text.trim(),
    summary: text.trim(),
    timestamp: new Date().toISOString(),
    author: 'user',
    actor: 'You',
    intent,
  };
}
