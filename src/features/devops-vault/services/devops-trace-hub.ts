/**
 * DevopsTraceHub — the live process-trace bus for the DevOps/Vault console.
 *
 * When the console is actively making changes (a broker issue/revoke, a KV write, a future
 * CLI shell-out or remote-node dispatch), the operator watches it happen in a live terminal
 * scroll. This hub is the server-side pub/sub behind that: publishers (the route handlers)
 * emit TraceFrames; subscribers (superadmin SSE connections) receive them.
 *
 * SECURITY — owner-scoped by construction (the lesson from the old cross-bot SSE fan-out,
 * where clients subscribed to everything instead of their own channel): a frame is delivered
 * ONLY to sinks registered under `frame.actor`. A subscriber for one superadmin sub can never
 * receive another actor's frames, even if it knew the id — there is no "all" channel and no
 * taskId a caller can pass to widen its subscription. Subscription itself is gated upstream by
 * requireSuperAdmin on the route; this hub adds the per-actor delivery scope.
 *
 * Frame text must never carry secret material — publishers redact (paths/versions/accessors/
 * ttls/counts, never secret values or tokens). The hub relays whatever it is given.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — owner-scoped live process-trace pub/sub for the activated DevOps/Vault console (ADR-040): per-actor delivery so a subscriber only ever sees its own actions, the deliberate answer to the cross-bot SSE fan-out.
 *
 * @module features/devops-vault/services/devops-trace-hub
 */

/** Severity/phase of one trace line. */
export type TraceLevel = 'start' | 'ok' | 'error' | 'info';

/** One line in the live process trace. `text` is pre-redacted by the publisher (no secrets). */
export interface TraceFrame {
  ts: number;
  /** The acting superadmin sub — the OWNER scope; delivery is confined to this sub's sinks. */
  actor: string;
  action: string;
  resource?: string;
  level: TraceLevel;
  text?: string;
}

/** A subscriber callback (writes one frame to an SSE response). */
export type TraceSink = (frame: TraceFrame) => void;

/**
 * @description Owner-scoped in-memory pub/sub for the DevOps live process trace. A singleton
 * (`devopsTraceHub`) shared between the per-request publishers and the long-lived SSE subscribers.
 */
export class DevopsTraceHub {
  private readonly sinks = new Map<string, Set<TraceSink>>();

  /**
   * @description Register a sink for one actor sub. Returns an unsubscribe fn (call on connection
   * close). A falsy sub registers nothing (fail-closed — an unauthenticated caller gets no stream).
   * @param sub - the subscriber's superadmin sub (the ONLY frames it will receive are this sub's)
   * @param sink - called with each frame for this sub
   * @returns an idempotent unsubscribe function
   */
  subscribe(sub: string, sink: TraceSink): () => void {
    if (!sub) return () => {};
    let set = this.sinks.get(sub);
    if (!set) { set = new Set(); this.sinks.set(sub, set); }
    set.add(sink);
    return () => {
      const s = this.sinks.get(sub);
      if (!s) return;
      s.delete(sink);
      if (!s.size) this.sinks.delete(sub);
    };
  }

  /**
   * @description Deliver a frame — ONLY to sinks registered under `frame.actor`. A frame with no
   * actor, or no matching subscriber, is dropped (never broadcast). A throwing sink (client gone)
   * never affects the others.
   * @param frame - the trace line to deliver
   */
  publish(frame: TraceFrame): void {
    const set = frame.actor ? this.sinks.get(frame.actor) : undefined;
    if (!set) return;
    for (const sink of set) {
      try { sink(frame); } catch { /* client gone — dropped on next close */ }
    }
  }

  /** How many live subscribers a given actor sub has (diagnostics/tests). */
  subscriberCount(sub: string): number {
    return this.sinks.get(sub)?.size ?? 0;
  }
}

/** Process-wide singleton — publishers and subscribers must share one instance. */
export const devopsTraceHub = new DevopsTraceHub();
