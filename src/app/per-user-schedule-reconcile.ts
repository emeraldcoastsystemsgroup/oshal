/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user schedule reconcile hook — leaf holder so the connector connect-write path can trigger registration of a user's per-user manifest "polls" without importing the swarm-app/scheduler services (wired from server.ts via setPerUserScheduleReconciler).
 */

/**
 * @description A per-user manifest-schedule reconciler. Given the user who just
 * connected an account (and optionally the provider they connected), it registers
 * any per-user "polls" that loaded apps declared for that connector. Implemented in
 * server.ts (where the swarm-app + scheduling services live) and injected here so
 * the connector write-path stays decoupled from those slices.
 */
type PerUserScheduleReconciler = (userSub: string, provider?: string) => Promise<void>;

let reconciler: PerUserScheduleReconciler | null = null;

/** @description Provide the reconciler implementation (called once at boot from server.ts). */
export function setPerUserScheduleReconciler(fn: PerUserScheduleReconciler): void {
  reconciler = fn;
}

/**
 * @description Fire-and-forget: kick a per-user schedule reconcile after a connect.
 * Never throws and never blocks the caller — a scheduling hiccup must not affect the
 * connection write. No-op until the reconciler is wired.
 */
export function reconcilePerUserSchedules(userSub: string, provider?: string): void {
  if (!reconciler || !userSub) return;
  reconciler(userSub, provider).catch(() => { /* best-effort */ });
}
