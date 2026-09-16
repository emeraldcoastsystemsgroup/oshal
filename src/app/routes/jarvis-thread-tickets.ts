/**
 * Jarvis thread tickets — the per-conversation chat-ticket and session-task registration that the
 * router (jarvis-routes.ts) used to carry inline. Split out on 2026-09-14 to bring that file back
 * under the decomposition threshold; no behaviour change.
 *
 * A direct Jarvis chat thread (sessionId) is registered as ONE `chat_tasks` row — the chat-ticket
 * link (ticket_task_links) and conversation persistence (chat_messages) both FK-reference it — and
 * gets ONE workflow-less `chat`-ticket in the "Chat" queue (targeted at jarvis), opened on its first
 * turn and kept `in_process` until the user closes it (POST /thread/close). The sessionId → ticketId
 * map is in-memory like the ask-job store: a controller restart forgets the mapping, and the durable
 * lookup (findOpenThreadChatTicket) re-finds the still-open ticket by its stored metadata rather
 * than opening a second one for the same thread.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Extracted from jarvis-routes.ts (804 code lines, over the 800-line decomposition threshold): threadTicketKey, ensureSessionTask, ensureThreadChatTicket and the durable open-ticket lookup move here unchanged; closeThreadChatTicket wraps the map access POST /thread/close used to do inline.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Stop calling an ensureSessionTask failure non-fatal. It is fatal to the ask: the caller turns the false into 404 session_not_found, so a store that could not answer is refused in exactly the words used for a session somebody else owns. The guard still fails closed - nothing about the decision changes - but the cause is now logged at ERROR, which is the only thing that tells an undetermined check apart from a real denial.
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { InternalTicket } from '@/entities/ticket';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { getJarvisBriefingDelivery } from './jarvis-briefing-delivery';
import { JARVIS_AGENT_ID } from './jarvis-orchestrator';

const logger = createChildLogger({ module: 'jarvis-thread-tickets' });

/** Open chat-ticket per conversation thread (owner-scoped key → ticketId). */
const threadTickets = new Map<string, string>();

/**
 * @description Keys the in-memory chat-ticket map by owner + issuer + session so a client-supplied
 * session id (which is not globally unique) can never alias another owner's thread. The router
 * uses the same key for its per-thread clarification state so both maps agree on thread identity.
 * @param ownerSub - The authenticated owner.
 * @param sessionId - The client-supplied conversation thread id.
 * @returns The composite thread key.
 */
export function threadTicketKey(ownerSub: string, sessionId: string): string {
  return `${ownerSub}\u0000${getApplicationAuthorizationActor()?.issuer ?? ''}\u0000${sessionId}`;
}

/**
 * @description Registers the Jarvis thread (sessionId) as a `chat_tasks` row. The chat-ticket link
 * (ticket_task_links) AND conversation persistence (chat_messages) both FK-reference this task id;
 * without it every persistence write fails (observed live: history never saved). Idempotent + best-effort.
 * @param ctx - App context (task store).
 * @param sub - The authenticated owner.
 * @param issuer - The verified principal issuer, or null under legacy compatibility.
 * @param sessionId - The conversation thread id.
 * @param message - The first line becomes the task title.
 * @returns Whether the caller owns the session task (a foreign or mismatched row yields false).
 */
export async function ensureSessionTask(ctx: AppContext, sub: string, issuer: string | null, sessionId: string, message: string): Promise<boolean> {
  try {
    if (await getJarvisBriefingDelivery()?.service.isProducerSession(sessionId)) return false;
    const existing = await ctx.taskStore.get(sessionId);
    if (existing) return existing.ownerSub === sub && (readOwnerPrincipalIssuer(existing.metadata) === issuer
      || !issuer && !ctx.applicationAuthorization);
    const created = await ctx.taskStore.create({
      taskId: sessionId,
      title: (message.split('\n')[0] || message).slice(0, 90) || 'Jarvis chat',
      processingMode: 'agentic',
      agentId: JARVIS_AGENT_ID,
      ownerSub: sub, // per-owner budget attribution (Phase 2)
      metadata: { origin: 'jarvis-chat', ...(issuer ? { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: issuer } : {}) },
    });
    // `create` returns an existing row when a concurrent caller wins the task-id race. Re-check the
    // returned owner so a guessed session id can never become a cross-tenant append channel.
    return Boolean(created && created.ownerSub === sub && (readOwnerPrincipalIssuer(created.metadata) === issuer
      || !issuer && !ctx.applicationAuthorization));
  } catch (err) {
    // Fail closed, but never silently and never mislabelled: the caller answers 404
    // session_not_found on this false, so an unavailable store is refused with the same words as a
    // foreign owner. The log is what separates "denied" from "could not be determined".
    logger.error({ err, sessionId }, 'jarvis: session ownership UNDETERMINED (task store failed); /ask will refuse with session_not_found');
    return false;
  }
}

/**
 * @description Opens the thread's chat-ticket on its first turn (idempotent per sessionId). Fast —
 * a single insert — and never throws: a failure just means no board card, never a blocked chat.
 * @param ctx - App context (ticket service).
 * @param sub - The authenticated owner.
 * @param sessionId - The conversation thread id.
 * @param message - The first line leads the ticket payload.
 * @returns The chat-ticket id, or null if it couldn't be opened.
 */
export async function ensureThreadChatTicket(
  ctx: AppContext, sub: string, sessionId: string, message: string,
): Promise<string | null> {
  const key = threadTicketKey(sub, sessionId);
  const existing = threadTickets.get(key);
  if (existing) return existing;
  const durableTicketId = await findOpenThreadChatTicket(ctx, sub, sessionId);
  if (durableTicketId) {
    threadTickets.set(key, durableTicketId);
    return durableTicketId;
  }
  try {
    const firstLine = message.split('\n')[0]?.trim() || message;   // raw request leads the payload
    const ticket = await ctx.ticketService.openChatTicket({
      taskId: sessionId, ownerSub: sub, agentId: JARVIS_AGENT_ID, text: firstLine, targetBot: 'jarvis',
    });
    threadTickets.set(key, ticket.ticketId);
    return ticket.ticketId;
  } catch (err) {
    logger.warn({ err, sessionId }, 'jarvis chat-ticket open failed (non-fatal)');
    return null;
  }
}

/**
 * @description Completes the thread's open chat-ticket (X on the summary bubble / End chat) and
 * forgets the mapping. A thread with no mapped ticket reports false without touching the ticket
 * service; a ticket-service failure propagates so the route answers 500 exactly as before.
 * @param ctx - App context (ticket service).
 * @param sub - The authenticated owner.
 * @param sessionId - The conversation thread id.
 * @returns true when a mapped ticket was completed; false when the thread had none.
 */
export async function closeThreadChatTicket(ctx: AppContext, sub: string, sessionId: string): Promise<boolean> {
  const key = threadTicketKey(sub, sessionId);
  const ticketId = threadTickets.get(key);
  if (!ticketId) return false;
  await ctx.ticketService.updateStatus(ticketId, 'complete' as never);
  threadTickets.delete(key);
  return true;
}

/** The still-open chat-ticket for this thread, found by its stored metadata after a restart. */
async function findOpenThreadChatTicket(ctx: AppContext, sub: string, sessionId: string): Promise<string | null> {
  try {
    const tickets = await ctx.ticketService.listTickets({ ownerSub: sub, ticketType: 'chat', limit: 500 });
    const matches = tickets
      .filter((ticket) => isOpenThreadChatTicket(ticket, sessionId))
      .sort((left, right) => ticketUpdatedAtMs(right) - ticketUpdatedAtMs(left));
    return matches[0]?.ticketId ?? null;
  } catch (err) {
    logger.warn({ err, sessionId }, 'jarvis durable chat-ticket lookup failed (non-fatal)');
    return null;
  }
}

function isOpenThreadChatTicket(ticket: InternalTicket, sessionId: string): boolean {
  if (ticket.status !== 'in_process' || ticket.ticketType !== 'chat') {
    return false;
  }
  const metadata = ticketMetadata(ticket);
  return metadata.taskId === sessionId
    && (metadata.kind === 'chat-thread' || metadata.origin === 'bot-chat' || metadata.targetBot === 'jarvis');
}

function ticketMetadata(ticket: InternalTicket): Record<string, unknown> {
  return ticket.metadata && typeof ticket.metadata === 'object'
    ? ticket.metadata as Record<string, unknown>
    : {};
}

function ticketUpdatedAtMs(ticket: InternalTicket): number {
  return Date.parse(ticket.updatedAt || ticket.createdAt || '') || 0;
}
