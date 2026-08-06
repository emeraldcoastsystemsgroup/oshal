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
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Pass the controller pool into task-bound
 *   callback issuance and revoke the exact completion grant plus staged PII when a watchdog expires.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Require an exact positive queue-claim
 *   acknowledgement before dispatch so a failed CLI mutation cannot launch an unowned/orphan run.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Thread strict controller-derived final-submit
 *   authorization into ApplyDispatchInput. Every unspecified/internal/automated call defaults to
 *   assist mode; authenticated single-job routes and authorized ticket metadata opt in explicitly.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Reap legacy/expired raw claims, bind the exact assigned worker, reconcile idle-worker divergence, and park every ambiguous submit outcome for human review with final-submit authority stripped.
 *
 * @module app/apply-submit
 */
import path from 'path';
import { spawn } from 'child_process';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { dispatchApply, removeApplyWorkspace, type ApplyDispatchInput } from '@/app/apply-dispatch';
import {
  APPLY_WORKER_ACK_TIMEOUT_MS,
  applyInFlight,
  clearInFlight,
  hasUserInFlight,
  type ApplyInFlight,
} from '@/app/apply-inflight';
import { remoteClientRegistry } from '@/app/routes/remote-client-routes';
import { revokeUnclaimedApplyCapability } from '@/app/apply-task-capability';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import {
  FINAL_SUBMIT_DENIED,
  isApplyFinalSubmitAuthorized,
  type ApplySubmitAuthorization,
} from '@/app/apply-submit-authorization';

const logger = createChildLogger({ module: 'apply-submit' });
const CLI = path.resolve(process.cwd(), 'scripts', 'oshal-apply.js');
const APPLY_TIMEOUT_MS = Number(process.env.APPLY_SUBMISSION_TIMEOUT_MS || 30 * 60 * 1000);
const RAW_CLAIM_MAX_AGE_MS = Math.max(
  APPLY_TIMEOUT_MS,
  Number(process.env.APPLY_RAW_CLAIM_MAX_AGE_MS) || 35 * 60 * 1000,
);

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

export type ApplyRecoveryReason =
  | 'apply_submission_timeout'
  | 'apply_worker_idle_orphan'
  | 'apply_controller_restart_orphan';

/** Re-arm recovery briefly when the trusted callback already owns its capability reservation. */
function deferRecovery(ctx: AppContext, task: ApplyInFlight): void {
  task.recoveryPending = false;
  const timer = setTimeout(() => { void recoverUnknownApply(ctx, task.taskId, 'apply_submission_timeout'); }, 30_000);
  if (typeof timer.unref === 'function') timer.unref();
  task.timer = timer;
}

/** Return the claim to the reviewable queue, distinguishing a callback that already wrote applied. */
async function releaseUnknownClaim(task: ApplyInFlight): Promise<'released' | 'applied' | 'failed'> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const value = await runApplyCli(task.userSub, ['queue', 'requeue', String(task.postingId)]);
    if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (row.ok === true && Number(row.posting_id) === task.postingId) return 'released';
      if (row.applied_at) return 'applied';
    }
  }
  return 'failed';
}

/** Strip auto-submit authority and park an ambiguous outcome at the human-confirmation gate. */
async function parkTicketForReview(
  ctx: AppContext,
  task: ApplyInFlight,
  reason: ApplyRecoveryReason,
  message: string,
): Promise<void> {
  if (!task.ticketId || task.settleTicket === false) return;
  await runWithRequestIdentity({ sub: task.userSub, isOperator: false }, async () => {
    const ticket = await ctx.ticketService.getTicket(task.ticketId as string);
    if (!ticket || ['complete', 'cancelled'].includes(ticket.status)) return;
    await ctx.ticketService.updateTicket(ticket.ticketId, { metadata: {
      ...ticket.metadata, applyFinalSubmitAuthorized: false,
      applyFinalSubmitAuthorizationSource: null, applyFinalSubmitAuthorizationSeal: null,
      applyRecoveryState: 'assist_review', applyRecoveryReason: reason,
      applyRecoveryTaskId: task.taskId, applyRecoveryClientId: task.clientId ?? null,
    } });
    await ctx.ticketService.updateStatus(ticket.ticketId, 'customer_action', {
      source: 'apply-recovery', reason, message, postingId: task.postingId,
    });
  });
}

/** Resolve a race where the trusted callback already durably recorded the application. */
async function finishAlreadyAppliedTicket(ctx: AppContext, task: ApplyInFlight): Promise<void> {
  if (!task.ticketId || task.settleTicket === false) return;
  await runWithRequestIdentity({ sub: task.userSub, isOperator: false }, async () => {
    const ticket = await ctx.ticketService.getTicket(task.ticketId as string);
    if (ticket && ticket.status !== 'complete') {
      await ctx.ticketService.updateStatus(ticket.ticketId, 'complete', {
        source: 'apply-recovery', reason: 'queue_already_recorded_applied', postingId: task.postingId,
      });
    }
  });
}

/** Record the ambiguous terminal trace after the claim and ticket are safely settled. */
async function traceRecovery(task: ApplyInFlight, reason: ApplyRecoveryReason, message: string): Promise<void> {
  await runApplyCli(task.userSub, ['trace'], {
    timeoutMs: 20_000,
    extraEnv: {
      APPLY_POSTING_ID: String(task.postingId), APPLY_COMPANY: task.company || '',
      APPLY_RESULT: 'assist_review', APPLY_HOW: reason, APPLY_BLOCKER: message,
    },
  });
}

/** Recover one timeout/idle divergence without ever blindly retrying an unknown final submit. */
export async function recoverUnknownApply(
  ctx: AppContext,
  taskId: string,
  reason: ApplyRecoveryReason,
): Promise<boolean> {
  const task = applyInFlight.get(taskId);
  if (!task || task.recoveryPending) return false;
  task.recoveryPending = true;
  let capability: Awaited<ReturnType<typeof revokeUnclaimedApplyCapability>> = 'missing';
  try {
    if (ctx.pool) capability = await revokeUnclaimedApplyCapability(ctx.pool, taskId);
  } catch (err) {
    logger.warn({ err, taskId }, 'apply recovery: capability state unavailable; retrying safely');
    deferRecovery(ctx, task);
    return false;
  }
  if (capability === 'processing') { deferRecovery(ctx, task); return false; }
  clearInFlight(taskId);
  const claim = await releaseUnknownClaim(task);
  const message = reason === 'apply_worker_idle_orphan'
    ? 'The assigned worker reported idle without claiming or completing this task. The posting was released; confirm whether any submission landed before retrying.'
    : reason === 'apply_controller_restart_orphan'
      ? 'The controller restarted and this prior submission never reported a trusted outcome. The posting was released; confirm whether the employer received it before retrying.'
      : `No trusted completion arrived within ${Math.round(APPLY_TIMEOUT_MS / 60000)} minutes. The posting was released; confirm whether the employer received it before retrying.`;
  try {
    if (claim === 'applied') await finishAlreadyAppliedTicket(ctx, task);
    else await parkTicketForReview(ctx, task, reason, message);
  } catch (err) { logger.warn({ err, taskId, ticketId: task.ticketId }, 'apply recovery: ticket settlement failed'); }
  await removeApplyWorkspace(taskId);
  await traceRecovery(task, reason, claim === 'failed' ? `${message} Claim release must be retried.` : message);
  logger.error({ taskId, ticketId: task.ticketId, postingId: task.postingId, reason, claim }, 'apply run recovered into human review');
  return true;
}

/** @description Release stale raw claims for one user while preserving exact in-process postings. */
export async function reapUserApplyClaims(userSub: string): Promise<Record<string, unknown> | null> {
  const live = [...applyInFlight.values()].filter((task) => task.userSub === userSub)
    .map((task) => task.postingId).filter((id) => Number.isSafeInteger(id) && id > 0);
  const value = await runApplyCli(userSub, [
    'queue', 'reap', '--older-ms', String(RAW_CLAIM_MAX_AGE_MS), '--live', live.join(','),
  ]);
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/**
 * @description Reconcile controller state against the exact assigned worker. Healthy/online workers
 * that report neither this task active nor anything queued after the ack grace are orphaned. A
 * durable terminal result means its trusted callback is pending and is never interrupted.
 */
export async function reconcileApplyInFlight(ctx: AppContext, now = Date.now()): Promise<number> {
  let recovered = 0;
  for (const task of [...applyInFlight.values()]) {
    if (!task.clientId || now - task.startedAt < APPLY_WORKER_ACK_TIMEOUT_MS) continue;
    const worker = remoteClientRegistry.getClient(task.clientId);
    if (!worker || worker.status !== 'online' || worker.healthy === false) continue;
    if (worker.activeTaskId === task.taskId || Number(worker.taskQueueDepth || 0) > 0) continue;
    try {
      if (await remoteClientRegistry.getCompletedResult(task.clientId, task.taskId)) {
        task.callbackPending = true;
        continue;
      }
    } catch { continue; }
    if (await recoverUnknownApply(ctx, task.taskId, 'apply_worker_idle_orphan')) recovered += 1;
  }
  return recovered;
}

export interface GatherResult { status: number; body: Record<string, unknown>; }

/** @description Prove the per-user CLI claimed the exact posting before browser dispatch. */
function exactClaimAcknowledged(value: unknown, postingId: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.ok === true && row.claimed === true && Number(row.posting_id) === postingId;
}

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
 * @param authorization Server-derived final-submit decision for this dispatch; omitted denies.
 */
export async function gatherAndDispatch(
  ctx: AppContext,
  userSub: string,
  ticketId?: string,
  targetPostingId?: number,
  targetRemoteClientId?: string,
  authorization: ApplySubmitAuthorization = FINAL_SUBMIT_DENIED,
): Promise<GatherResult> {
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
    const reaped = await reapUserApplyClaims(userSub);
    if (Number(reaped?.released || 0) > 0) {
      logger.warn({ userSub, released: reaped?.released, before: reaped?.before, after: reaped?.after },
        'apply dispatch released stale raw posting claims');
    }
    const nextArgs = ['queue', 'next'];
    if (targetPostingId && Number.isFinite(targetPostingId)) nextArgs.push('--posting', String(targetPostingId));
    const nextRes = await runApplyCli(userSub, nextArgs) as { item?: Record<string, unknown>; note?: string } | null;
    const item = nextRes?.item;
    if (!item) return { status: 409, body: { error: 'no submittable job ready', note: nextRes?.note } };
    const postingId = Number(item.posting_id);
    if (!Number.isSafeInteger(postingId) || postingId <= 0) {
      return { status: 409, body: { error: 'the selected queue item has an invalid posting id' } };
    }

    const profile = await runApplyCli(userSub, ['profile']);
    if (!profile) return { status: 409, body: { error: 'no career profile for this user' } };

    const claimed = await runApplyCli(userSub, ['queue', 'claim', String(postingId)]);
    if (!exactClaimAcknowledged(claimed, postingId)) {
      return { status: 503, body: { error: 'the per-user queue did not acknowledge the posting claim', retryable: true } };
    }
    const input: ApplyDispatchInput = {
      ticketId: ticketId || `apply_${postingId}_${Date.now()}`,
      settleTicket: Boolean(ticketId),
      finalSubmitAuthorized: isApplyFinalSubmitAuthorized(authorization),
      userSub, postingId,
      job: { title: String(item.title || ''), company: String(item.company || ''), url: String(item.url || ''), location: String(item.location || '') },
      profile,
      packet: { resumePdf: (item.resume_pdf as string) || null, coverPdf: (item.cover_pdf as string) || null, workdayAutofill: (item.workday_autofill as string) || null },
      // Honour the operator's node choice; dispatchApply → pickApplyClient falls back to auto-pick when unset.
      ...(targetRemoteClientId ? { targetRemoteClientId } : {}),
    };
    const d = await dispatchApply(input, { pool: ctx.pool });
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

    const timer = setTimeout(() => {
      void recoverUnknownApply(ctx, d.taskId as string, 'apply_submission_timeout');
    }, APPLY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    applyInFlight.set(d.taskId, {
      taskId: d.taskId, ticketId: input.ticketId, settleTicket: input.settleTicket,
      postingId, userSub, company: input.job.company, clientId: d.clientId,
      timer, startedAt: Date.now(),
    });
    if (ticketId) { ctx.ticketService.updateStatus(ticketId, 'in_process_build').catch((err) => logger.warn({ err, ticketId }, 'submit: in_process update failed')); }

    logger.info({ taskId: d.taskId, clientId: d.clientId, postingId, ticketId }, 'apply submission dispatched to desktop worker');
    return { status: 202, body: { ok: true, taskId: d.taskId, clientId: d.clientId, postingId, job: input.job, timeoutMs: APPLY_TIMEOUT_MS } };
  } finally {
    dispatchesInFlight.delete(userSub);
  }
}
