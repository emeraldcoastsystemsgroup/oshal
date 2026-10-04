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
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Run fresh-session protected-result admission after proving the id is unused but before creating its task row.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | ensureSessionTask now reports owned / refused / unavailable, and gateAskSession + refuseAskSession turn the whole /ask session gate into one decision. A task store that threw (live 2026-09-27: "Connection terminated due to connection timeout" during a 36-bot cold start) used to become 404 session_not_found - the words for a session somebody else owns. It is now a retryable 503 session_unavailable that says the system is busy and nothing was sent; a real foreign-owner or read-back refusal is still 404 with the same log line, and nothing reaches the model in either case.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Recheck cached and durable carriers through the current ticket verdict before reuse or close, bind fresh creation to admitted caller identity, and log touched carrier/storage catches at ERROR while preserving nonfatal open and propagated lookup failures.
 */
import type { Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import type { InternalTicket } from '@/entities/ticket';
import { readableJarvisTickets, type JarvisTicketReadAccess } from './jarvis-ticket-read-access';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { getJarvisBriefingDelivery } from './jarvis-briefing-delivery';
import { JARVIS_AGENT_ID } from './jarvis-orchestrator';
import type { JarvisSessionAccess } from './jarvis-result-access';

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
 * @param admitFresh - Access decision that must pass before an absent session may be persisted.
 * @returns 'owned' when the caller owns the session task, 'refused' for a foreign, mismatched or
 * inadmissible one, and 'unavailable' when the store could not answer (nothing was decided).
 */
export async function ensureSessionTask(ctx: AppContext, sub: string, issuer: string | null, sessionId: string, message: string,
  admitFresh: () => Promise<boolean>): Promise<SessionTaskOwnership> {
  const ownedByCaller = (task: { ownerSub?: string; metadata?: Record<string, unknown> } | null | undefined): SessionTaskOwnership => (
    task && task.ownerSub === sub && (readOwnerPrincipalIssuer(task.metadata) === issuer || !issuer && !ctx.applicationAuthorization)
      ? 'owned' : 'refused');
  try {
    if (await getJarvisBriefingDelivery()?.service.isProducerSession(sessionId)) return 'refused';
    const existing = await ctx.taskStore.get(sessionId);
    if (existing) return ownedByCaller(existing);
    if (!await admitFresh()) return 'refused';
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
    return ownedByCaller(created);
  } catch (err) {
    // Fail closed, but never mislabelled: a store that could not answer decided nothing, so the
    // caller must not hear the words used for a session somebody else owns.
    logger.error({ err, sessionId }, 'jarvis: session ownership UNDETERMINED (task store failed); /ask answers 503 session_unavailable');
    return 'unavailable';
  }
}

/** @description What registering an /ask thread decided: the caller's, refused, or not decidable right now. */
export type SessionTaskOwnership = 'owned' | 'refused' | 'unavailable';

/** @description The /ask session gate's outcome: admitted, refused by one named half, or undecided. */
export type JarvisAskSessionGate = 'admitted' | 'ownership' | 'read-back' | 'unavailable';

/** Seconds a caller is told to wait before retrying a gate that could not decide. */
const SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** @description The sentence a caller reads when the gate could not decide (the store did not answer). */
export const JARVIS_SESSION_UNAVAILABLE_MESSAGE = 'The system is busy right now, so Jarvis could not open this '
  + 'conversation. Nothing was sent. Try again in a moment.';

/**
 * @description Run both halves of the /ask session gate: register the thread owner-bound, then read it
 * back through the result boundary. A half that could not answer is 'unavailable', never a refusal.
 * @param ctx - App context (task store).
 * @param sub - The authenticated owner.
 * @param issuer - The verified principal issuer, or null under legacy compatibility.
 * @param sessionId - The conversation thread id.
 * @param message - The first line becomes a fresh task's title.
 * @param admitFresh - Access decision that must pass before an absent session may be persisted.
 * @param readBack - The read-back decision over the written session.
 * @returns 'admitted', the refusing half ('ownership' / 'read-back'), or 'unavailable'.
 */
export async function gateAskSession(ctx: AppContext, sub: string, issuer: string | null, sessionId: string, message: string,
  admitFresh: () => Promise<boolean>, readBack: () => Promise<JarvisSessionAccess>): Promise<JarvisAskSessionGate> {
  const ownership = await ensureSessionTask(ctx, sub, issuer, sessionId, message, admitFresh);
  if (ownership !== 'owned') return ownership === 'unavailable' ? 'unavailable' : 'ownership';
  const access = await readBack();
  if (access === 'allowed') return 'admitted';
  return access === 'unavailable' ? 'unavailable' : 'read-back';
}

/**
 * @description Answer a gate that did not admit. A refusal stays the deliberately uninformative 404
 * session_not_found (the log names which half refused); a gate that could not decide is a retryable
 * 503, because telling a caller their own thread is "not found" when the database was busy is false.
 * @param res - The /ask response.
 * @param sessionId - The conversation thread id (logged, never echoed to a refused caller).
 * @param gate - The gate outcome, anything but 'admitted'.
 * @returns Nothing; the response is sent.
 */
export function refuseAskSession(res: Response, sessionId: string, gate: Exclude<JarvisAskSessionGate, 'admitted'>): void {
  if (gate === 'unavailable') {
    logger.warn({ sessionId }, 'jarvis /ask deferred: session_unavailable');
    res.setHeader('Retry-After', String(SESSION_UNAVAILABLE_RETRY_AFTER_SECONDS));
    res.status(503).json({ error: 'session_unavailable', message: JARVIS_SESSION_UNAVAILABLE_MESSAGE, retryable: true });
    return;
  }
  // `ownership`: the task could not be written owner-bound (a foreign owner, a mismatched issuer, a
  // refused fresh admission). `read-back`: it was written and then would not read back.
  logger.warn({ sessionId, refusedBy: gate }, 'jarvis /ask refused: session_not_found');
  res.status(404).json({ error: 'session_not_found' });
}

/**
 * @description Opens the thread's chat-ticket on its first turn (idempotent per sessionId). Fast —
 * a single insert — and never throws: a failure just means no board card, never a blocked chat.
 * @param ctx - App context (ticket service).
 * @param sub - The authenticated owner.
 * @param sessionId - The conversation thread id.
 * @param message - The first line leads the ticket payload.
 * @param access Current request ticket read and fresh-owner admission.
 * @returns The chat-ticket id, or null if it couldn't be opened.
 */
export async function ensureThreadChatTicket(
  ctx: AppContext, sub: string, sessionId: string, message: string, access: JarvisTicketReadAccess,
): Promise<string | null> {
  const key = threadTicketKey(sub, sessionId);
  try {
    if (!await access.canOpen(sub)) return null;
    const existing = await readableCachedThreadTicket(ctx, key, sessionId, access.canRead);
    if (existing === false) return null;
    if (existing) return existing;
    const durableTicketId = await findOpenThreadChatTicket(ctx, sub, sessionId, access.canRead);
    if (durableTicketId) { threadTickets.set(key, durableTicketId); return durableTicketId; }
    const firstLine = message.split('\n')[0]?.trim() || message;   // raw request leads the payload
    const ticket = await ctx.ticketService.openChatTicket({
      taskId: sessionId, ownerSub: sub, agentId: JARVIS_AGENT_ID, text: firstLine, targetBot: 'jarvis',
    });
    threadTickets.set(key, ticket.ticketId);
    return ticket.ticketId;
  } catch (err) {
    logger.error({ err, sessionId }, 'jarvis chat-ticket open failed (non-fatal)');
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
 * @param canRead Current request-bound ticket verdict, rechecked before any status write.
 * @returns true when an admitted mapped ticket was completed; false when none is readable.
 */
export async function closeThreadChatTicket(ctx: AppContext, sub: string, sessionId: string,
  canRead: JarvisTicketReadAccess['canRead']): Promise<boolean> {
  const key = threadTicketKey(sub, sessionId);
  const ticketId = await readableCachedThreadTicket(ctx, key, sessionId, canRead);
  if (!ticketId) return false;
  await ctx.ticketService.updateStatus(ticketId, 'complete' as never);
  threadTickets.delete(key);
  return true;
}

/** @description Re-read a cached carrier before reuse or close; a stale verdict never authorizes a write.
 * @param ctx Ticket service. @param key Exact owner/issuer/session cache key. @param sessionId Conversation id.
 * @param canRead Current request ticket verdict. @returns Admitted open carrier id, or null after clearing stale state. */
async function readableCachedThreadTicket(ctx: AppContext, key: string, sessionId: string,
  canRead: JarvisTicketReadAccess['canRead']): Promise<string | null | false> {
  const id = threadTickets.get(key);
  if (!id) return null;
  const ticket = await ctx.ticketService.getTicket(id);
  if (!ticket) { threadTickets.delete(key); return null; }
  if (isThreadChatTicket(ticket, sessionId) && await canRead(ticket)) return id;
  threadTickets.delete(key);
  return false;
}

/** @description Find the currently readable durable chat carrier after a restart; an unavailable store never grants fresh creation.
 * @param ctx Ticket service. @param sub Current subject. @param sessionId Conversation id.
 * @param canRead Current record/result predicate. @returns Readable carrier id or null for none. @throws When storage cannot answer. */
async function findOpenThreadChatTicket(ctx: AppContext, sub: string, sessionId: string,
  canRead: JarvisTicketReadAccess['canRead']): Promise<string | null> {
  try {
    const tickets = await ctx.ticketService.listTickets({ ownerSub: sub, ticketType: 'chat', limit: 500 });
    const matches = (await readableJarvisTickets(tickets.filter(ticket => isOpenThreadChatTicket(ticket, sessionId)), canRead))
      .sort((left, right) => ticketUpdatedAtMs(right) - ticketUpdatedAtMs(left));
    return matches[0]?.ticketId ?? null;
  } catch (err) {
    logger.error({ err, sessionId }, 'jarvis durable chat-ticket lookup failed (non-fatal)');
    throw err;
  }
}

function isOpenThreadChatTicket(ticket: InternalTicket, sessionId: string): boolean {
  return ticket.status === 'in_process' && isThreadChatTicket(ticket, sessionId);
}

/** @description Validate cached thread binding without changing its existing admitted terminal/no-op lifecycle.
 * @param ticket Loaded carrier. @param sessionId Conversation id. @returns Whether its durable type and metadata bind this thread. */
function isThreadChatTicket(ticket: InternalTicket, sessionId: string): boolean {
  if (ticket.ticketType !== 'chat') return false;
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
