/**
 * Shared in-flight watchdog registry for job-apply submissions. The OIDC-gated
 * /api/apply-operator/submit route ARMS an entry (with a 30-min timeout that escalates the ticket);
 * the service-secret /api/apply/ingest callback (a DIFFERENT router, reachable by the desktop box)
 * CLEARS + resolves it. Kept in one module so both routers share the same Map.
 *
 * @module app/apply-inflight
 */

export interface ApplyInFlight {
  taskId: string;            // the dispatched codex.exec task id (key)
  ticketId?: string;
  postingId: number;
  userSub: string;
  company?: string;
  timer: NodeJS.Timeout;
  startedAt: number;
}

/** Keyed by the dispatch taskId. */
export const applyInFlight = new Map<string, ApplyInFlight>();

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

export function clearInFlight(taskId: string): void {
  const e = applyInFlight.get(taskId);
  if (e) { try { clearTimeout(e.timer); } catch { /* */ } applyInFlight.delete(taskId); }
}
