/**
 * Shared in-flight watchdog registry for job-apply submissions. The OIDC-gated
 * /api/apply-operator/submit route ARMS an entry (with a 30-min timeout that escalates the ticket);
 * the task-capability /api/apply/ingest callback (delivered by the trusted remote daemon, not the
 * model) CLEARS + resolves it only after durable outcome settlement. Kept in one module so both
 * routers share the same Map; PostgreSQL capabilities remain authoritative across restarts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Document the model-hidden capability callback
 *   and exact post-settlement watchdog cleanup; complete exported API documentation.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Retain the exact assigned worker and recovery state so queue truth can distinguish queued, claimed, idle-orphaned, and callback-processing work.
 *
 * @module app/apply-inflight
 */

/** In-process watchdog facts for one exact durable Apply task generation. */
export interface ApplyInFlight {
  taskId: string;            // the dispatched codex.exec task id (key)
  ticketId?: string;
  /** False when ticketId is only a correlation id for a direct OIDC Apply request. */
  settleTicket?: boolean;
  postingId: number;
  userSub: string;
  company?: string;
  /** Exact worker selected by dispatch and durably bound in the callback capability. */
  clientId?: string;
  /** Prevent concurrent watchdog/reaper reconciliation from settling one run twice. */
  recoveryPending?: boolean;
  /** Durable worker result exists; the trusted controller callback/outbox is still settling. */
  callbackPending?: boolean;
  timer: NodeJS.Timeout;
  startedAt: number;
}

/** Grace for a selected worker to expose the exact task as queued or active. */
export const APPLY_WORKER_ACK_TIMEOUT_MS = Math.max(
  15_000,
  Math.min(5 * 60_000, Number(process.env.APPLY_WORKER_ACK_TIMEOUT_MS) || 90_000),
);

/** Keyed by the dispatch taskId. */
export const applyInFlight = new Map<string, ApplyInFlight>();

/** @description Find the current in-process watchdog for an exact durable ticket id. */
export function findByTicket(ticketId: string): ApplyInFlight | undefined {
  for (const e of applyInFlight.values()) if (e.ticketId === ticketId) return e;
  return undefined;
}

/**
 * @description True if this user already has a submission in flight (dispatched to the desktop, not
 * yet reported back). ONE desktop drives ONE Chrome, so a second concurrent apply would corrupt the
 * open form — the durable job-apply queue relies on this to work its tickets strictly one-at-a-time:
 * gatherAndDispatch refuses (409) while an entry exists, so extra approved apply tickets just defer
 * and retry until the in-flight one's /api/apply/ingest callback (or the 30-min watchdog) clears it.
 * @param userSub - The OIDC sub to check.
 * @returns Whether an in-flight apply exists for that user.
 */
export function hasUserInFlight(userSub: string): boolean {
  for (const e of applyInFlight.values()) if (e.userSub === userSub) return true;
  return false;
}

/** @description Clear only the watchdog keyed by this exact random task id. */
export function clearInFlight(taskId: string): void {
  const e = applyInFlight.get(taskId);
  if (e) { try { clearTimeout(e.timer); } catch { /* */ } applyInFlight.delete(taskId); }
}
