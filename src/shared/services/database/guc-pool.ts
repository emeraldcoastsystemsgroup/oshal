/**
 * GUC-aware Postgres pool wrapper — the keystone that makes row-level security (RLS)
 * safe to turn on (see docs/governance/RLS-RUNBOOK.md).
 *
 * Restrictive RLS scopes rows by comparing a column to a per-connection session GUC
 * (`oshal.current_sub` / `oshal.is_operator`). If the app never sets that GUC, every
 * owner-bearing table returns ZERO rows once RLS is forced — an instant outage. This
 * wrapper closes that gap: for every `query()` / `connect()` it checks out a dedicated
 * connection, stamps it with the current request's identity (from request-identity's
 * AsyncLocalStorage), runs the work, then RESETs the GUCs before the connection returns
 * to the pool so identity never leaks to the next user.
 *
 * SAFETY MODEL:
 *   - ON by default. Set OSHAL_DB_GUC=off/false/0/no only for break-glass rollback; otherwise
 *     pools are wrapped so RLS is ready before restrictive policies are applied.
 *   - Even when ON, before any RLS policy exists these GUCs are simply unread session
 *     settings — so you can enable the wrapper, verify stability/perf, and only THEN
 *     apply rls-policies.sql. The two steps are independent.
 *   - Legitimate background work (schedulers, queue manager, bots, boot, crons) marks itself
 *     trusted by running under {@link module:shared/services/database/request-identity}'s
 *     `runWithSystemIdentity` sentinel => is_operator='on', so internal work is never starved.
 *   - A bare "no request identity in scope at all" (NEITHER a user request NOR the SYSTEM
 *     sentinel) is fail-CLOSED by default (OSHAL_DB_GUC_STRICT=deny): stamped anonymous
 *     non-operator, so RLS scopes such a query to nothing. This is the security posture —
 *     an un-migrated background caller fails loudly (zero rows) instead of silently reading
 *     cross-tenant. Break-glass = OSHAL_DB_GUC_STRICT=off (historical fail-open-to-operator);
 *     `warn` keeps the operator behavior but LOGS each identity-less call site once so an
 *     operator can find any un-migrated path before enforcing deny (see {@link gucStrictMode}).
 *   - Callback-style query(...) calls (last arg is a function) bypass the wrapper to
 *     avoid changing their control flow; the codebase uses the promise form.
 *
 * @module shared/services/database/guc-pool
 */

/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added the explicit SYSTEM sentinel branch (isSystemIdentity → always operator) so runWithSystemIdentity marks trusted background work independent of strict mode.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Flipped gucStrictMode() default off→deny (fail-CLOSED) and made unrecognized values fall back to deny. A bare identity-less DB access (neither a user request nor the SYSTEM sentinel) is now stamped anonymous non-operator → RLS scopes it to nothing, so an un-migrated background caller fails loudly instead of silently reading cross-tenant. Break-glass = OSHAL_DB_GUC_STRICT=off; audit-first = warn. Safe because every legitimate background path was migrated to runWithSystemIdentity (enforced by tests/unit/background-system-identity.spec.ts).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Hardened the identity-less warn/deny audit so it always names an APPLICATION frame, not a node-internal one. The old find() returned the first non-guc-pool frame (processTicksAndRejections) and the 5-frame sample truncated before the async-stitched caller — so a real offender showed as "unknown". Now: bump stackTraceLimit at capture, skip node-internal frames for the reported site, and sample 12 app frames. This is what lets the warn soak positively identify every un-migrated site before the deny promotion.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Log the SQL text (normalized, 160-char) in the identity-less audit. A fully-detached async caller (single node-internal frame, no app stack) can't be named by the stack alone — but the query itself identifies it. Threaded firstSql(args) → setIdentityGucs → resolveFailOpen. Permanent improvement, not throwaway.
 */

import type { Pool, PoolClient } from 'pg';
import { getRequestIdentity, isSystemIdentity, type RequestIdentity } from './request-identity';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'guc-pool' });

/** Is the GUC wrapper enabled? On by default; explicit false flags are the rollback switch. */
export function gucEnabled(): boolean {
  const v = (process.env.OSHAL_DB_GUC ?? 'on').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
}

/**
 * @description Strictness for the "no request identity in scope at all" branch (NOT the SYSTEM
 * sentinel — that is always operator). Default `deny` (fail-CLOSED, 2026-07-20): an identity-less
 * query is stamped anonymous non-operator, so RLS scopes it to nothing. This is safe because every
 * legitimate background path was migrated to `runWithSystemIdentity` (the positive trusted-system
 * sentinel) — enforced by tests/unit/background-system-identity.spec.ts. Any UN-migrated background
 * caller now fails loudly (zero rows) instead of silently reading cross-tenant. `off` is the
 * break-glass rollback (historical fail-open-to-operator). `warn` keeps the operator behavior but
 * LOGS each identity-less call site once — run it in a live environment first to catch any path the
 * static guard can't see before enforcing `deny`. Any unrecognized value falls back to `deny`.
 * @returns The configured strict level.
 */
export function gucStrictMode(): 'off' | 'warn' | 'deny' {
  const v = (process.env.OSHAL_DB_GUC_STRICT ?? 'deny').trim().toLowerCase();
  // Fail-CLOSED: deny is the default and the fallback for any unrecognized value. Only an
  // explicit `off` (break-glass) or `warn` (audit) relaxes it. Legitimate background work runs
  // under the positive runWithSystemIdentity sentinel, which is stamped operator regardless.
  return v === 'off' ? 'off' : v === 'warn' ? 'warn' : 'deny';
}

const RESET_SQL = 'RESET oshal.current_sub; RESET oshal.is_operator';

/** Call sites already reported under `warn` — each is logged once so the audit isn't a firehose. */
const reportedFailOpenSites = new Set<string>();

/** Reset the once-per-site warn dedup (test seam so specs start clean). */
export function _resetFailOpenAudit(): void {
  reportedFailOpenSites.clear();
}

/**
 * Resolve the identity-less (fail-open) disposition under the configured strict mode, emitting
 * a once-per-call-site audit warning under `warn`/`deny`. Returns whether the connection should
 * be stamped as trusted `system` (operator) or `deny` (anonymous, RLS-scoped-to-nothing).
 */
function resolveFailOpen(queryText?: string): 'system' | 'deny' {
  const mode = gucStrictMode();
  if (mode === 'off') return 'system';

  const priorLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const frames = (new Error().stack || '').split('\n').slice(1).map((s) => s.trim());
  Error.stackTraceLimit = priorLimit;
  // A node-internal frame (task_queues, the async trampoline) never identifies the offending
  // call site — an async boundary detaches the real app frame past a couple of internals. Skip
  // guc-pool AND node-internal frames so `site` (the dedup key AND the audit's answer) always
  // names an APPLICATION frame; fall back progressively so we never report 'unknown' when any
  // frame exists. The sample keeps every non-guc-pool frame (12 deep) so the async-stitched
  // caller is visible even when it sits behind processTicksAndRejections/runNextTicks.
  const isInternal = (f: string) =>
    f.includes('node:internal') ||
    /processTicksAndRejections|runNextTicks|new Promise|<anonymous>$/.test(f);
  const appFrames = frames.filter((f) => f && !f.includes('guc-pool'));
  const site =
    appFrames.find((f) => !isInternal(f)) || appFrames[0] || frames[0] || 'unknown';
  if (!reportedFailOpenSites.has(site)) {
    reportedFailOpenSites.add(site);
    logger.warn(
      { site, query: queryText, sample: appFrames.slice(0, 12), mode },
      mode === 'deny'
        ? 'DB access with NO request identity DENIED (OSHAL_DB_GUC_STRICT=deny) — this path must run under runWithSystemIdentity if it is legitimately trusted/background'
        : 'DB access ran with NO request identity — fail-open to trusted/operator context (OSHAL_DB_GUC_STRICT=warn). Confirm this call site is background/trusted, NOT a user-facing read',
    );
  }
  return mode === 'deny' ? 'deny' : 'system';
}

/** Stamp the connection with the caller identity (or the fail-open disposition for background work). */
async function setIdentityGucs(client: PoolClient, id: RequestIdentity | undefined, queryText?: string): Promise<void> {
  if (isSystemIdentity(id)) {
    // Positive SYSTEM sentinel (runWithSystemIdentity): trusted background/system context,
    // established on purpose. ALWAYS stamp trusted operator, regardless of OSHAL_DB_GUC_STRICT —
    // this is what keeps schedulers / queue / workers / boot code visible after the strict mode
    // denies the "no context at all" case. Distinct from the fail-open branch below (bare undefined).
    await client.query(
      "SELECT set_config('oshal.current_sub', '', false), set_config('oshal.is_operator', 'on', false)",
    );
    return;
  }
  if (id === undefined) {
    // NEITHER a user request NOR the SYSTEM sentinel — no context was established at all.
    // Default (OSHAL_DB_GUC_STRICT=deny): stamp anonymous non-operator, so RLS scopes this
    // query to nothing — an un-migrated background caller fails loudly instead of reading
    // cross-tenant. Legitimate background work runs under runWithSystemIdentity (handled above).
    // Break-glass `off` (or audit-only `warn`) restores the historical trusted-operator stamp.
    if (resolveFailOpen(queryText) === 'deny') {
      await client.query(
        "SELECT set_config('oshal.current_sub', '', false), set_config('oshal.is_operator', 'off', false)",
      );
    } else {
      // Break-glass / audit — historical fail-open-to-operator behavior.
      await client.query(
        "SELECT set_config('oshal.current_sub', '', false), set_config('oshal.is_operator', 'on', false)",
      );
    }
  } else {
    await client.query(
      "SELECT set_config('oshal.current_sub', $1, false), set_config('oshal.is_operator', $2, false)",
      [id.sub ?? '', id.isOperator ? 'on' : 'off'],
    );
  }
}

/** First-arg SQL text (normalized, truncated) for the identity-less audit — a detached async
 * caller often has no app stack frame, so the query itself is what names it. */
function firstSql(args: unknown[]): string | undefined {
  const q = args[0];
  const text =
    typeof q === 'string'
      ? q
      : q && typeof q === 'object' && typeof (q as { text?: unknown }).text === 'string'
        ? (q as { text: string }).text
        : undefined;
  return text ? text.replace(/\s+/g, ' ').trim().slice(0, 160) : undefined;
}

/** A query() that scopes its connection to the current identity, then resets it. */
async function gucQuery(target: Pool, args: unknown[]): Promise<unknown> {
  // Callback-style: don't change control flow — delegate straight through (no GUC).
  if (args.length > 0 && typeof args[args.length - 1] === 'function') {
    return (target.query as (...a: unknown[]) => unknown)(...args);
  }
  const id = getRequestIdentity();
  const client = await target.connect();
  let reset = false;
  try {
    await setIdentityGucs(client, id, firstSql(args));
    return await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
  } finally {
    try {
      await client.query(RESET_SQL);
      reset = true;
    } catch (err) {
      logger.warn({ err }, 'failed to reset identity GUCs; destroying connection');
    }
    // If reset failed the connection must NOT go back to the pool carrying our GUCs.
    client.release(reset ? undefined : true);
  }
}

/** A connect() whose client is identity-stamped and self-resets on release. */
async function gucConnect(target: Pool): Promise<PoolClient> {
  const id = getRequestIdentity();
  const client = await target.connect();
  try {
    await setIdentityGucs(client, id);
  } catch (err) {
    client.release(true);
    throw err;
  }
  const origRelease = client.release.bind(client);
  let released = false;
  // Reset our GUCs before the connection returns to the pool. release() is sync and
  // not awaited by callers, so we reset on the still-active client then delegate.
  (client as PoolClient).release = ((arg?: Error | boolean) => {
    if (released) return;
    released = true;
    client
      .query(RESET_SQL)
      .then(() => origRelease(arg as boolean | undefined))
      .catch(() => origRelease(true));
  }) as PoolClient['release'];
  return client;
}

/**
 * Wrap a pg Pool so query()/connect() set the caller-identity GUCs. Returns a Proxy
 * that intercepts only those two methods and delegates everything else (end, on,
 * totalCount, ...) untouched. Call this only when {@link gucEnabled} is true.
 */
export function wrapPoolWithGuc(pool: Pool): Pool {
  logger.info('GUC-aware pool wrapper enabled (OSHAL_DB_GUC); queries stamp oshal.current_sub/is_operator');
  return new Proxy(pool, {
    get(t, prop, receiver) {
      if (prop === 'query') return (...args: unknown[]) => gucQuery(t, args);
      if (prop === 'connect') {
        return (cb?: unknown) => {
          // Only the promise form is supported with GUC stamping; if a callback is
          // passed, fall back to the raw connect to preserve its contract.
          if (typeof cb === 'function') return (t.connect as (...a: unknown[]) => unknown)(cb);
          return gucConnect(t);
        };
      }
      const value = Reflect.get(t, prop, receiver);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}
