/**
 * Per-request caller identity, carried through async work via AsyncLocalStorage.
 *
 * This is the application half of the RLS contract (see docs/governance/RLS-RUNBOOK.md):
 * the GUC-aware pool wrapper ({@link module:shared/services/database/guc-pool}) reads the
 * identity stashed here and sets `oshal.current_sub` / `oshal.is_operator` on the
 * connection it runs each query on, so Postgres row-level security can scope rows to
 * the caller. A request middleware populates the store right after auth; everything
 * that awaits within that request sees the same identity.
 *
 * When there is NO identity in scope (background work — schedulers, the queue manager,
 * bot runtimes), the pool wrapper treats it as trusted system context, NOT as an
 * anonymous user, so internal machinery is never starved to zero rows under RLS.
 *
 * `OSHAL_DB_GUC` is on by default; set it to `off` only for break-glass rollback.
 * When the wrapper is disabled, the store may still be populated but no pool reads it.
 *
 * @module shared/services/database/request-identity
 */
/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added runWithoutRequestIdentity (store.exit) so machine-authenticated detached work can run as trusted system context instead of inheriting an anonymous request identity that RLS starves
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the positive SYSTEM identity sentinel (runWithSystemIdentity / SYSTEM_IDENTITY / isSystemIdentity) so legitimate background work marks itself trusted-operator on PURPOSE, instead of relying on the fail-open "no context" branch. This is the escape hatch that lets OSHAL_DB_GUC_STRICT flip to deny-by-default: bare undefined = "no context established" (deny under strict), SYSTEM sentinel = "trusted background" (always operator).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Removed runWithoutRequestIdentity (store.exit): its lone caller (remote-client-routes no-sub branch) now uses runWithSystemIdentity, which is a POSITIVE trusted marker rather than the ambiguous "no context" state. store.exit produced bare undefined — indistinguishable from a never-established context, which deny-by-default must starve. The sentinel is the intentional trusted path.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The caller identity used to scope database rows for one request. */
export interface RequestIdentity {
  /** OIDC sub of the caller, or null for anonymous/unauthenticated requests. */
  sub: string | null;
  /** Whether the caller is an operator (admin) — bypasses ownership scoping. */
  isOperator: boolean;
  /**
   * Present + true ONLY on the frozen {@link SYSTEM_IDENTITY} sentinel — a positive marker
   * that trusted background/system work established this context on purpose (via
   * {@link runWithSystemIdentity}). Never set on a user request. The GUC pool stamps such a
   * context as operator unconditionally, so background machinery is never starved even when
   * OSHAL_DB_GUC_STRICT denies the "no context at all" case.
   */
  system?: boolean;
}

const store = new AsyncLocalStorage<RequestIdentity>();

/**
 * The single frozen SYSTEM identity — trusted background/system context (operator visibility).
 * Established via {@link runWithSystemIdentity}. Distinct from bare `undefined` ("no context
 * established"): `undefined` follows the OSHAL_DB_GUC_STRICT disposition (deny under strict),
 * whereas this sentinel is ALWAYS stamped operator so schedulers / queue / workers / boot code
 * keep full visibility after the deny-by-default flip.
 */
export const SYSTEM_IDENTITY: Readonly<RequestIdentity> = Object.freeze({
  sub: null,
  isOperator: true,
  system: true,
});

/**
 * Run `fn` with `identity` available to all async work it transitively performs.
 * Use from a request middleware: `runWithRequestIdentity(id, () => next())`.
 */
export function runWithRequestIdentity<T>(identity: RequestIdentity, fn: () => T): T {
  return store.run(identity, fn);
}

/**
 * Run `fn` under the trusted SYSTEM sentinel, so the pool wrapper stamps it as operator
 * unconditionally (full visibility) regardless of OSHAL_DB_GUC_STRICT. Use this to mark
 * legitimate background/system work on PURPOSE — schedulers, the queue manager, swarm/bot
 * runtimes, boot code, watchdogs, cron ticks — so it is never starved once the strict mode
 * denies the "no request identity at all" case. Prefer this over leaving background work to
 * the fail-open branch: the branch is going away as a source of trust (deny-by-default).
 */
export function runWithSystemIdentity<T>(fn: () => T): T {
  return store.run(SYSTEM_IDENTITY, fn);
}

/**
 * True only when `id` is the SYSTEM sentinel established by {@link runWithSystemIdentity}.
 * A bare `undefined` (no context) is NOT system; neither is any real user identity. Used by
 * the GUC pool to decide the trusted-operator stamp, and by the static seam guard.
 */
export function isSystemIdentity(id: RequestIdentity | undefined): boolean {
  return id !== undefined && id.system === true;
}

/** The identity for the current async context, or undefined for background work. */
export function getRequestIdentity(): RequestIdentity | undefined {
  return store.getStore();
}
