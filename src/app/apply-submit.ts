/**
 * Job-apply gather + dispatch — the shared core used by BOTH triggers:
 *   - /api/apply-operator/submit  (OIDC / cockpit)
 *   - /api/apply/dispatch         (service-secret / bot + ticket)
 *
 * Gathers the next approved, packet-ready job + the user's canonical profile + its packet, claims it,
 * dispatches the browser submission to the desktop worker (apply-dispatch), and arms the 30-minute
 * watchdog. All per-user work is OSHAL_USER_SUB-scoped. The box reports back to /api/apply/ingest.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | gatherAndDispatch: optional postingId
 *   -> `queue next --posting <id>` so the mobile review card auto-applies the specific reviewed job.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Event-loop hardening (the 07-15
 *   spawnSync wedge class): every oshal-apply.js call was spawnSync — up to four sequential 60s
 *   blocking spawns per dispatch froze the whole api event loop while they ran. runApplyCli now
 *   spawns ASYNC and awaits exit (same parse-last-stdout-line/null contract, same per-call
 *   timeouts), gatherAndDispatch is async and guarded single-flight per user (409) + a global
 *   ceiling APPLY_MAX_DISPATCHES (default 3 -> 429) so dispatches can't stack and pin the box.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scoped the detached escalate() timeout's ticket update to the submitter's OWN sub via runWithRequestIdentity — it fires with no request in scope; under OSHAL_DB_GUC_STRICT=deny an identity-less update wouldn't find the owner-RLS'd ticket row. Per-user (not systemized) because it touches one user's ticket.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | gatherAndDispatch takes an optional
 *   targetRemoteClientId → ApplyDispatchInput, so the operator's chosen leaf node (desktop / remote)
 *   drives the browser (dispatchApply→pickApplyClient already honored it; this threads it in).
 *
 * @module app/apply-submit
 */
import path from 'path';
import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { dispatchApply, type ApplyDispatchInput } from '@/app/apply-dispatch';
import { applyInFlight, hasUserInFlight } from '@/app/apply-inflight';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';

const logger = createChildLogger({ module: 'apply-submit' });
const CLI = path.resolve(process.cwd(), 'scripts', 'oshal-apply.js');
const APPLY_TIMEOUT_MS = Number(process.env.APPLY_SUBMISSION_TIMEOUT_MS || 30 * 60 * 1000);

/** Cap collected stdout at the old spawnSync maxBuffer so a runaway CLI can't balloon memory. */
const MAX_OUT_BYTES = 32 * 1024 * 1024;

/**
 * @description Runs an oshal-apply.js verb for a user WITHOUT blocking the event loop and
 * resolves with the JSON-parsed LAST stdout line (null when absent/unparseable — the exact
 * contract the old spawnSync runApply had, exit code deliberately not consulted). Was
 * spawnSync: a single dispatch chained up to four 60s synchronous spawns on the api event
 * loop — the same class that wedged the front end on 2026-07-15. Never rejects.
 * @param userSub - The OIDC sub the CLI run is scoped to (OSHAL_USER_SUB).
 * @param args - CLI argv after the script path.
 * @param opts - timeoutMs (default 60s, matches the old spawnSync timeout) + extraEnv
 *   (APPLY_* trace vars etc., merged over process.env).
 * @returns The parsed last stdout line, or null.
 */
export function runApplyCli(
  userSub: string,
  args: string[],
  opts: { timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    const proc = spawn('node', [CLI, ...args], {
      env: { ...process.env, OSHAL_USER_SUB: userSub, ...(opts.extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: opts.timeoutMs ?? 60000,
    });
    let out = '';
    proc.stdout?.on('data', (d) => { out += String(d); if (out.length > MAX_OUT_BYTES) out = out.slice(-(MAX_OUT_BYTES / 2)); });
    proc.on('close', () => {
      const last = out.trim().split('\n').filter(Boolean).pop() || 'null';
      try { resolve(JSON.parse(last)); } catch { resolve(null); }
    });
    proc.on('error', (err) => { logger.error({ err, args: args.slice(0, 2) }, 'apply CLI run failed'); resolve(null); });
  });
}

/** The 30-minute timeout fired: force this submission into an error report. */
async function escalate(ctx: AppContext, taskId: string): Promise<void> {
  const t = applyInFlight.get(taskId);
  if (!t) return;
  applyInFlight.delete(taskId);
  const message = `Submission exceeded ${Math.round(APPLY_TIMEOUT_MS / 60000)} minutes without reporting back — the desktop worker may have stalled or crashed.`;
  if (t.ticketId) {
    const ticketId = t.ticketId;
    // Detached timeout callback (no request in scope) updating the submitter's OWN ticket — scope
    // to the owner sub so RLS finds the row under OSHAL_DB_GUC_STRICT=deny (per-user, not systemized).
    try {
      await runWithRequestIdentity({ sub: t.userSub, isOperator: false }, () =>
        ctx.ticketService.updateStatus(ticketId, 'escalated', { reason: 'apply_submission_timeout', source: 'apply-submit', message }),
      );
    }
    catch (err) { logger.warn({ err, taskId, ticketId }, 'escalate: ticket update failed'); }
  }
  await runApplyCli(t.userSub, ['trace'], {
    timeoutMs: 20000,
    extraEnv: { APPLY_POSTING_ID: String(t.postingId), APPLY_COMPANY: t.company || '', APPLY_RESULT: 'escalated', APPLY_HOW: 'timeout', APPLY_BLOCKER: message },
  });
  logger.error({ taskId, ticketId: t.ticketId, postingId: t.postingId }, 'apply submission timed out -> escalated');
}

export interface GatherResult { status: number; body: Record<string, unknown>; }

// ── gather+dispatch concurrency guard (mirrors the 07-15 career-hunter fix) ──────────────────
// One dispatch chains several CLI runs; without a guard a double-tap or many users could stack
// engine processes. Single-flight per user (409) + a small global ceiling (429).
const dispatchesInFlight = new Set<string>();
const MAX_CONCURRENT_DISPATCHES = Math.max(1, Number(process.env.APPLY_MAX_DISPATCHES) || 3);

/**
 * @description Gather the next ready job, dispatch its browser submission to the desktop worker, and
 * arm the watchdog. Returns an HTTP status + body for the calling route. Never throws. Runs the
 * engine CLI async (event loop stays free), single-flight per user + globally bounded.
 * @param targetPostingId Optional: apply this SPECIFIC packet-ready posting (the mobile review card's
 *   "Auto apply" targets the job the operator just reviewed) instead of the newest-generated default.
 * @param targetRemoteClientId Optional: pin WHICH leaf node (the operator's desktop or a remote node)
 *   drives the browser. Omitted → the dispatcher auto-picks (env pin → preferred host → any online).
 */
export async function gatherAndDispatch(ctx: AppContext, userSub: string, ticketId?: string, targetPostingId?: number, targetRemoteClientId?: string): Promise<GatherResult> {
  if (dispatchesInFlight.has(userSub)) return { status: 409, body: { error: 'a submission dispatch is already running for this user', retryable: true } };
  // Serialize the DESKTOP itself, not just dispatch SETUP: dispatchesInFlight clears when the CLI
  // chain + enqueue finish (seconds), but the desktop keeps driving Chrome for up to 30 min. A second
  // apply in that window corrupts the open form. So refuse while ANY apply is still in flight for this
  // user — the durable job-apply queue depends on this to work its tickets one-at-a-time (the extra
  // approved tickets just defer + retry until ingest clears the in-flight one). retryable=true so the
  // dispatcher defers rather than escalating a ticket that only lost the race.
  if (hasUserInFlight(userSub)) return { status: 409, body: { error: 'a submission is already in progress for this user', retryable: true } };
  if (dispatchesInFlight.size >= MAX_CONCURRENT_DISPATCHES) return { status: 429, body: { error: 'busy — too many dispatches in progress, try again shortly', retryable: true } };
  dispatchesInFlight.add(userSub);
  try {
    const nextArgs = ['queue', 'next'];
    if (targetPostingId && Number.isFinite(targetPostingId)) nextArgs.push('--posting', String(targetPostingId));
    const nextRes = await runApplyCli(userSub, nextArgs) as { item?: Record<string, unknown>; note?: string } | null;
    const item = nextRes?.item;
    if (!item) return { status: 409, body: { error: 'no submittable job ready', note: nextRes?.note } };
    const postingId = Number(item.posting_id);

    const profile = await runApplyCli(userSub, ['profile']);
    if (!profile) return { status: 409, body: { error: 'no career profile for this user' } };

    await runApplyCli(userSub, ['queue', 'claim', String(postingId)]);
    const input: ApplyDispatchInput = {
      ticketId: ticketId || `apply_${postingId}_${Date.now()}`,
      userSub, postingId,
      job: { title: String(item.title || ''), company: String(item.company || ''), url: String(item.url || ''), location: String(item.location || '') },
      profile,
      packet: { resumePdf: (item.resume_pdf as string) || null, coverPdf: (item.cover_pdf as string) || null, workdayAutofill: (item.workday_autofill as string) || null },
      // Honour the operator's node choice; dispatchApply → pickApplyClient falls back to auto-pick when unset.
      ...(targetRemoteClientId ? { targetRemoteClientId } : {}),
    };
    const d = await dispatchApply(input);
    if (!d.ok || !d.taskId) {
      // The dispatch never reached the desktop, so ROLL THE CLAIM BACK (apply_active=1, and undo a
      // 'deferred' status) instead of recording an outcome. We claimed this posting moments ago; if we
      // leave it claimed/deferred the durable job-apply ticket that retries can no longer find it —
      // `queue next --posting <id>` returns nothing and the ticket escalates "no submittable job
      // ready", poisoned by its own dispatch attempt (that cost 8 tickets on 2026-07-21). requeue
      // hard-refuses when applied_at is set, so a genuinely-submitted application is never resurrected.
      await runApplyCli(userSub, ['queue', 'requeue', String(postingId)]);
      return { status: 503, body: { error: d.error || 'dispatch failed', retryable: true } };
    }

    const timer = setTimeout(() => { void escalate(ctx, d.taskId as string); }, APPLY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    applyInFlight.set(d.taskId, { taskId: d.taskId, ticketId: input.ticketId, postingId, userSub, company: input.job.company, timer, startedAt: Date.now() });
    if (ticketId) { ctx.ticketService.updateStatus(ticketId, 'in_process_build').catch((err) => logger.warn({ err, ticketId }, 'submit: in_process update failed')); }

    logger.info({ taskId: d.taskId, clientId: d.clientId, postingId, ticketId }, 'apply submission dispatched to desktop worker');
    return { status: 202, body: { ok: true, taskId: d.taskId, clientId: d.clientId, postingId, job: input.job, timeoutMs: APPLY_TIMEOUT_MS } };
  } finally {
    dispatchesInFlight.delete(userSub);
  }
}
