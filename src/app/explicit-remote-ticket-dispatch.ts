/**
 * Explicit remote-ticket dispatch.
 *
 * A ticket that names an exact registered `oshal-chat-*` client is a hard execution
 * target. It must bypass semantic bot bidding and run on that desktop through the
 * remote-client queue. The remote node polls the controller; the controller never
 * opens an inbound port on the desktop.
 *
 * The named target is USER-SUPPLIED — it comes from ticket metadata or, failing that, a regex over
 * the ticket's own title/description free text. So the name alone can never be the authority for
 * which machine runs the code: the ticket's owner must be authorized for that device.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | SECURITY: gate the named device
 *   on the ticket owner. The target id is scraped from user-controlled ticket text, so anyone who
 *   could file a ticket mentioning another user's node uuid got codex.exec at danger-full-access on
 *   that person's desktop. Now assertDeviceUsable(ticket.ownerSub, device) before enqueue; an
 *   owner-less ticket is platform-originated and keeps machine trust.
 *   Guard: tests/unit/device-access-dispatch.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | AT-MOST-ONCE across an api
 *   restart. This dispatcher awaited the node's result in an IN-PROCESS poll loop, so a controller
 *   restart mid-flight orphaned the await: the node (a separate process) finished the task anyway,
 *   the ticket sat in in_process_build until the queue watchdog rolled it back to approved, and the
 *   next poll dispatched it a SECOND time — running the real-world action twice. Live 2026-07-28: a
 *   contact-form message was delivered twice because the stack watchdog restarted the api 15s after
 *   dispatch. A dispatch now RECORDS its remote task id on the ticket (durable, Postgres) before
 *   enqueueing, and a later dispatch of the same ticket resolves that prior attempt instead of
 *   re-running it: completed → adopt its result; still queued/in-flight → resume waiting; unknown
 *   (registry wiped by the restart) → REFUSE and escalate, because a repeat of an outward-facing
 *   action is not a safe retry. Guard: tests/unit/explicit-remote-at-most-once.spec.ts.
 */
import type { InternalTicket } from '@/entities/ticket';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';
import { assertDeviceUsable, type DeviceRequester } from '@/features/remote-client';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'explicit-remote-ticket-dispatch' });

const CLIENT_ID = /\boshal-chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Ticket-metadata key holding the remote task id of the dispatch already made for this ticket. */
export const EXPLICIT_REMOTE_TASK_ID_KEY = 'explicitRemoteTaskId';

export function explicitRemoteClientId(ticket: InternalTicket): string | null {
  const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
  const structured = typeof metadata.targetRemoteClientId === 'string'
    ? metadata.targetRemoteClientId.trim()
    : '';
  if (structured) return structured;
  const text = `${ticket.title || ''}\n${ticket.description || ''}`;
  return text.match(CLIENT_ID)?.[0] ?? null;
}

/**
 * @description The remote task id a previous dispatch of this ticket recorded, if any. Its
 * presence is the durable "this ticket has already been sent to a machine once" marker that
 * survives a controller restart — the in-memory registry does not.
 * @param ticket - The ticket being dispatched.
 * @returns The recorded task id, or null when this ticket has never been dispatched.
 */
export function priorRemoteTaskId(ticket: InternalTicket): string | null {
  const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
  const recorded = metadata[EXPLICIT_REMOTE_TASK_ID_KEY];
  const value = typeof recorded === 'string' ? recorded.trim() : '';
  return value.length > 0 ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injected side effects, so the dispatcher stays testable and owns no persistence itself. */
export interface ExplicitRemoteDispatchDeps {
  /**
   * Durably record (ticketId → remote taskId) BEFORE the task is enqueued. Must persist somewhere
   * that outlives the process — the whole point is surviving a restart. A throw is treated as
   * "cannot guarantee at-most-once" and aborts the dispatch rather than risking a duplicate.
   */
  recordDispatch?: (ticketId: string, taskId: string) => Promise<void>;
}

export async function dispatchExplicitRemoteTicket(
  ticket: InternalTicket,
  deps: ExplicitRemoteDispatchDeps = {},
): Promise<{
  handled: boolean;
  success?: boolean;
  clientId?: string;
  taskId?: string;
  error?: string;
}> {
  const clientId = explicitRemoteClientId(ticket);
  if (!clientId) return { handled: false };

  const client = remoteClientRegistry.getClient(clientId);
  if (!client) return { handled: true, success: false, clientId, error: 'The explicitly named remote client is not registered' };
  if (client.status !== 'online' || client.healthy === false) {
    return { handled: true, success: false, clientId, error: 'The explicitly named remote client is offline or unhealthy' };
  }
  if (!(client.capabilities ?? []).includes('codex.exec')) {
    return { handled: true, success: false, clientId, error: 'The explicitly named remote client does not advertise codex.exec' };
  }

  // The device is real and capable — but is it THIS ticket's owner's to drive? An owner-less ticket
  // is platform-originated (no end user to scope to) and keeps the existing machine trust.
  const requester: DeviceRequester = ticket.ownerSub ? { sub: ticket.ownerSub } : { system: true };
  const denied = assertDeviceUsable(requester, client, 'explicit-remote-ticket');
  if (denied) return { handled: true, success: false, clientId, error: denied };

  const timeoutMs = Math.max(1_000, Number(process.env.EXPLICIT_REMOTE_TICKET_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);

  // ── At-most-once: has this ticket already been handed to a machine? ──────────────────────────
  // Re-entry here means the first dispatch's await did not resolve (an api restart, or a watchdog
  // rollback). The node may well have DONE the work. Adopt the known outcome; never re-run blind.
  const prior = priorRemoteTaskId(ticket);
  if (prior) {
    const completed = remoteClientRegistry.getCompletedResult(clientId, prior);
    if (completed) {
      logger.info({ ticketId: ticket.ticketId, clientId, taskId: prior, status: completed.status }, 'Adopted the prior dispatch result — not re-running');
      return {
        handled: true,
        success: completed.status === 'completed',
        clientId,
        taskId: prior,
        ...(completed.error ? { error: completed.error } : {}),
      };
    }
    if (remoteClientRegistry.getInFlightTask(clientId, prior)) {
      logger.info({ ticketId: ticket.ticketId, clientId, taskId: prior }, 'Prior dispatch still in flight — resuming the wait instead of re-dispatching');
      return waitForResult(clientId, prior, timeoutMs);
    }
    // No record either way. The registry is in-memory, so a restart erases the evidence while the
    // node keeps working — exactly the state that produced a duplicate send. Refuse.
    logger.error(
      { ticketId: ticket.ticketId, clientId, taskId: prior },
      'Prior dispatch outcome is unknown (registry has no record) — refusing to repeat an outward action',
    );
    return {
      handled: true,
      success: false,
      clientId,
      taskId: prior,
      error: `This ticket was already dispatched to ${clientId} as task ${prior} and the controller lost track of it (a restart clears the in-memory task registry). Re-running could repeat a real-world action, so it was not re-dispatched — confirm on the machine whether the work completed, then close or re-file this ticket.`,
    };
  }

  const taskId = `ticket-${ticket.ticketId}-${Date.now()}`;

  // Record BEFORE enqueue. The reverse order loses the race the guard exists for: a restart
  // between enqueue and record leaves a running task nobody knows about.
  if (deps.recordDispatch) {
    try {
      await deps.recordDispatch(ticket.ticketId, taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to record the dispatch';
      logger.error({ err: error, ticketId: ticket.ticketId, clientId, taskId }, 'Could not record the dispatch — refusing to enqueue unguarded');
      return { handled: true, success: false, clientId, error: `Refused to dispatch: the at-most-once marker could not be recorded (${message})` };
    }
  }

  remoteClientRegistry.enqueueTask(clientId, {
    taskId,
    correlationId: ticket.ticketId,
    fromAgentId: 'queue-manager',
    toAgentId: client.agentId || clientId,
    intent: 'mcp.call-tool',
    input: {
      name: 'codex.exec',
      arguments: {
        sandbox: 'danger-full-access',
        prompt: [
          'Execute this OSHAL ticket on this computer. This is an execution task, not a request for a proposed report.',
          'Use the locally installed skills and real desktop/browser controls required by the task.',
          'Do not claim success without performing the work and collecting the requested confirmation artifacts.',
          'If the task performs an outward-facing action (sending a message, submitting a form, posting), do it EXACTLY ONCE:',
          'check first whether it already happened and report that instead of repeating it.',
          `TICKET_ID: ${ticket.ticketId}`,
          `TITLE: ${ticket.title || ''}`,
          'DESCRIPTION:',
          ticket.description || '',
        ].join('\n'),
      },
    },
    createdAt: new Date().toISOString(),
  });

  return waitForResult(clientId, taskId, timeoutMs);
}

/**
 * @description Poll the registry for one task's completion until the deadline.
 * @param clientId - The device running the task.
 * @param taskId - The task to await.
 * @param timeoutMs - How long to wait before giving up.
 * @returns The dispatch outcome; a timeout is reported as an unsuccessful, still-identified task.
 */
async function waitForResult(
  clientId: string,
  taskId: string,
  timeoutMs: number,
): Promise<{ handled: boolean; success?: boolean; clientId?: string; taskId?: string; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = remoteClientRegistry.getCompletedResult(clientId, taskId);
    if (result) {
      return {
        handled: true,
        success: result.status === 'completed',
        clientId,
        taskId,
        ...(result.error ? { error: result.error } : {}),
      };
    }
    await sleep(1_000);
  }
  return { handled: true, success: false, clientId, taskId, error: `Remote execution timed out after ${timeoutMs}ms` };
}
