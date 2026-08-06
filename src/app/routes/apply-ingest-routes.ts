/**
 * Apply control and trusted completion routes.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added service-triggered Apply dispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Corrected the packaged CLI path.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added narrated progress beats.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit remote-client selection.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Scoped ticket writes to the asserted owner.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Replace model-visible fleet-secret callbacks
 *   and body-asserted identity with a hashed, expiring, one-use task capability. The controller
 *   derives exact owner/ticket/posting/client/generation from PostgreSQL, rejects stale tasks, proves
 *   the queue write succeeded before ticket settlement, consumes before watchdog cleanup, and
 *   retires interactive email/vault/screenshot callbacks that exposed cross-user body identifiers.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Persist callback outcomes as task-bound
 *   worker reports and require the Career CLI to acknowledge the exact provenance before settlement.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Internal dispatch derives owner, posting,
 *   target, and final-submit authority from the durable ticket when present. Body-only service calls
 *   default to assist mode and bulk calls cannot manufacture a request identity from userSub.
 * 9 | maintainer@emeraldcoastsystemsgroup.com | Promote a worker report to verified-submission only after a named PNG/JPEG is link-free, bounded, and retained inside the exact Career user store.
 *
 * @module app/routes/apply-ingest-routes
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { applyInFlight, clearInFlight, findByTicket } from '@/app/apply-inflight';
import { removeApplyWorkspace } from '@/app/apply-dispatch';
import { gatherAndDispatch, runApplyCli } from '@/app/apply-submit';
import { enqueueApplyTicket, enqueueApplyQueue } from '@/app/apply-enqueue';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { stopApplyBatch, getApplyBatchStatus } from '@/app/apply-batch-runner';
import {
  consumeApplyCapability,
  readApplyCapabilityHeader,
  releaseApplyCapability,
  reserveApplyCapability,
  type ApplyCapabilityClaim,
} from '@/app/apply-task-capability';
import { timingSafeSecretEquals } from '@/features/remote-client';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';
import { persistApplyConfirmationArtifact } from '@/app/apply-confirmation-artifact';
import {
  applySubmitAuthorizationFromMetadata,
  FINAL_SUBMIT_DENIED,
} from '@/app/apply-submit-authorization';

const logger = createChildLogger({ module: 'apply-ingest-routes' });
const CompletionSchema = z.object({
  taskId: z.string().regex(/^apply-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  context: z.object({ workflow: z.literal('apply'), generation: z.number().int().positive() }).strict(),
  result: z.object({
    result: z.enum(['applied', 'deferred', 'dismissed', 'failed']),
    note: z.string().max(4000),
    confirmationFile: z.string().max(132)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g)$/i).optional(),
  }).strict(),
}).strict();
type CompletionBody = z.infer<typeof CompletionSchema>;
interface RouteResult { status: number; body: Record<string, unknown>; }

/** Injectable completion side effects used by focused tests; production uses the exact defaults. */
export interface ApplyCompletionRuntime {
  reserve: typeof reserveApplyCapability;
  consume: typeof consumeApplyCapability;
  release: typeof releaseApplyCapability;
  runCli: typeof runApplyCli;
  removeWorkspace: typeof removeApplyWorkspace;
  persistConfirmation: typeof persistApplyConfirmationArtifact;
}

const DEFAULT_COMPLETION_RUNTIME: ApplyCompletionRuntime = {
  reserve: reserveApplyCapability,
  consume: consumeApplyCapability,
  release: releaseApplyCapability,
  runCli: runApplyCli,
  removeWorkspace: removeApplyWorkspace,
  persistConfirmation: persistApplyConfirmationArtifact,
};

/** @description Constant-time authentication for internal dispatch and queue-control callers. */
function serviceSecretOk(req: Request): boolean {
  const secret = String(process.env.SWARM_SERVICE_SECRET || '').trim();
  return secret.length > 0 && timingSafeSecretEquals(req.header('x-service-secret'), secret);
}

/** @description Reject an internal route before parsing its asserted operational subject. */
function requireService(req: Request, res: Response): boolean {
  if (serviceSecretOk(req)) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

/** @description Read a nonblank exact subject while preserving every identity byte. */
function exactSubject(value: unknown): string | null {
  try { return requireExactUserSubject(value); }
  catch { return null; }
}

/** @description Internal service-triggered single-job dispatch handler. */
function dispatchHandler(ctx: AppContext): RequestHandler {
  return (req, res) => void (async () => {
    if (!requireService(req, res)) return;
    const assertedUserSub = exactSubject(req.body?.userSub);
    const ticketId = req.body?.ticketId ? String(req.body.ticketId) : undefined;
    if (ticketId) {
      const ticket = await runWithSystemIdentity(() => ctx.ticketService.getTicket(ticketId));
      if (!ticket) { res.status(404).json({ error: 'Apply ticket not found' }); return; }
      const userSub = exactSubject(ticket.ownerSub);
      if (!userSub || (assertedUserSub !== null && assertedUserSub !== userSub)) {
        res.status(409).json({ error: 'Apply ticket owner binding mismatch' });
        return;
      }
      const metadata = (ticket.metadata ?? {}) as Record<string, unknown>;
      const postingId = Number(metadata.postingId) || undefined;
      const assertedPostingId = Number(req.body?.postingId) || undefined;
      if (postingId && assertedPostingId && postingId !== assertedPostingId) {
        res.status(409).json({ error: 'Apply ticket posting binding mismatch' });
        return;
      }
      const clientId = typeof metadata.targetRemoteClientId === 'string'
        ? metadata.targetRemoteClientId : undefined;
      const authorization = postingId
        ? applySubmitAuthorizationFromMetadata(metadata, { ticketId, userSub, postingId })
        : FINAL_SUBMIT_DENIED;
      const result = await gatherAndDispatch(ctx, userSub, ticketId, postingId, clientId, authorization);
      res.status(result.status).json(result.body);
      return;
    }
    if (!assertedUserSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const postingId = Number(req.body?.postingId) || undefined;
    const clientId = req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined;
    const result = await gatherAndDispatch(
      ctx, assertedUserSub, undefined, postingId, clientId, FINAL_SUBMIT_DENIED,
    );
    res.status(result.status).json(result.body);
  })();
}

/** @description Internal durable single-ticket enqueue handler. */
function enqueueHandler(ctx: AppContext): RequestHandler {
  return (req, res) => void (async () => {
    if (!requireService(req, res)) return;
    const userSub = exactSubject(req.body?.userSub);
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const result = await enqueueApplyTicket(ctx, userSub, {
      postingId: Number(req.body?.postingId),
      company: req.body?.company ? String(req.body.company) : undefined,
      title: req.body?.title ? String(req.body.title) : undefined,
      url: req.body?.url ? String(req.body.url) : undefined,
      location: req.body?.location ? String(req.body.location) : undefined,
      targetRemoteClientId: req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined,
    });
    res.status(result.ok ? (result.deduped ? 200 : 201) : 400).json(result);
  })();
}

/** @description Internal durable queue expansion handler. */
function enqueueQueueHandler(ctx: AppContext): RequestHandler {
  return (req, res) => void (async () => {
    if (!requireService(req, res)) return;
    const userSub = exactSubject(req.body?.userSub);
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const limit = Number(req.body?.limit) || 200;
    const clientId = req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined;
    const result = await enqueueApplyQueue(ctx, userSub, limit, clientId);
    logger.info({ userSub, created: result.created, deduped: result.deduped }, 'apply enqueue-queue requested');
    res.status(result.ok ? 202 : (result.denialReason ? 403 : 400)).json(result);
  })();
}

/** @description Register service-authenticated dispatch and durable enqueue operations. */
function registerDispatchRoutes(router: Router, ctx: AppContext): void {
  router.post('/dispatch', dispatchHandler(ctx));
  router.post('/enqueue', enqueueHandler(ctx));
  router.post('/enqueue-queue', enqueueQueueHandler(ctx));
}

/** @description Register compatibility batch controls backed by durable ticket enqueue. */
function registerBatchRoutes(router: Router, ctx: AppContext): void {
  router.post('/batch/start', (req, res) => void (async () => {
    if (!requireService(req, res)) return;
    const userSub = exactSubject(req.body?.userSub);
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const result = await enqueueApplyQueue(ctx, userSub, Number(req.body?.limit) || 200);
    res.status(result.ok ? 202 : 403).json({ ...result, superseded: 'durable job-apply tickets' });
  })());
  router.post('/batch/stop', (req, res) => {
    if (!requireService(req, res)) return;
    const userSub = exactSubject(req.body?.userSub);
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    res.json({ ok: true, stopped: stopApplyBatch(userSub) });
  });
  router.get('/batch/status', (req, res) => {
    if (!requireService(req, res)) return;
    const userSub = exactSubject(req.query?.userSub);
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    res.json({ state: getApplyBatchStatus(userSub) });
  });
}

/** @description Retire model-driven endpoints that formerly exposed global-secret user selection. */
function registerRetiredInteractiveRoutes(router: Router): void {
  const retired: RequestHandler = (_req, res) => {
    res.status(410).json({ error: 'retired: interactive Apply callbacks cannot access email, credentials, or progress storage' });
  };
  router.post('/email-code', retired);
  router.post('/site-cred', retired);
  router.post('/site-cred/get', retired);
  router.post('/shot', retired);
}

/** @description Ensure an in-memory watchdog, when present, names the exact durable capability. */
function currentRunMatches(claim: ApplyCapabilityClaim): boolean {
  const exact = applyInFlight.get(claim.taskId);
  if (exact && (exact.ticketId !== claim.ticketId || exact.userSub !== claim.userSub || exact.postingId !== claim.postingId)) return false;
  const ticketRun = findByTicket(claim.ticketId);
  return !ticketRun || ticketRun.taskId === claim.taskId;
}

interface QueueRecordResult { accepted: boolean; applicationSource: string | null }

/** @description Persist one outcome and accept verified provenance only for a retained artifact. */
async function recordQueueOutcome(
  runtime: ApplyCompletionRuntime,
  claim: ApplyCapabilityClaim,
  result: string,
  note: string,
  confirmationFile?: string,
): Promise<QueueRecordResult> {
  const retained = result === 'applied'
    ? runtime.persistConfirmation(claim.userSub, claim.taskId, confirmationFile) : null;
  const source = result === 'applied'
    ? (retained ? 'verified-submission' : 'worker-reported') : null;
  const args = ['queue', 'record', String(claim.postingId), result, '--note', note];
  if (source) args.push('--source', source, '--task', claim.taskId);
  if (retained) args.push('--confirmation', retained);
  const output = await runtime.runCli(claim.userSub, args, { timeoutMs: 30000 });
  if (!output || typeof output !== 'object') return { accepted: false, applicationSource: source };
  const row = output as Record<string, unknown>;
  const accepted = row.ok === true && Number(row.posting_id) === claim.postingId
    && row.status === result && row.application_source === source
    && row.application_task_id === (source ? claim.taskId : null)
    && (source !== 'verified-submission' || row.confirmation_verified === true);
  return { accepted, applicationSource: source };
}

/** @description Resolve the exact owner ticket only after the queue outcome is durable. */
async function resolveApplyTicket(
  ctx: AppContext,
  claim: ApplyCapabilityClaim,
  result: string,
  applicationSource: string | null,
): Promise<void> {
  if (!claim.settleTicket) return;
  const status = result === 'applied' ? 'complete' : result === 'dismissed' ? 'cancelled' : 'customer_action';
  await runWithRequestIdentity({ sub: claim.userSub, isOperator: false }, () =>
    ctx.ticketService.updateStatus(claim.ticketId, status, {
      source: 'apply-trusted-completion', taskId: claim.taskId,
      postingId: claim.postingId, generation: claim.generation, result, applicationSource,
    }),
  );
}

/** @description Best-effort post-commit trace plus immediate deletion of staged applicant PII. */
function finishApplyRun(runtime: ApplyCompletionRuntime, claim: ApplyCapabilityClaim, result: string, note: string): void {
  clearInFlight(claim.taskId);
  void runtime.removeWorkspace(claim.taskId);
  void runtime.runCli(claim.userSub, ['trace'], {
    timeoutMs: 20000,
    extraEnv: {
      APPLY_POSTING_ID: String(claim.postingId), APPLY_RESULT: result,
      APPLY_HOW: 'desktop', APPLY_BLOCKER: result === 'applied' ? '' : note,
    },
  });
}

/** @description Release a retryable claim without hiding the original processing failure. */
async function releaseClaim(ctx: AppContext, runtime: ApplyCompletionRuntime, claim: ApplyCapabilityClaim): Promise<void> {
  try { await runtime.release(ctx.pool, claim); }
  catch (error) { logger.error({ err: error, taskId: claim.taskId }, 'apply completion claim release failed'); }
}

/** @description Validate bindings and commit one capability-authenticated terminal outcome. */
async function processCompletion(ctx: AppContext, runtime: ApplyCompletionRuntime, token: string, body: CompletionBody): Promise<RouteResult> {
  const claim = await runtime.reserve(ctx.pool, token);
  if (!claim) return { status: 401, body: { error: 'invalid, expired, busy, or consumed capability' } };
  const matches = body.taskId === claim.taskId && body.context.generation === claim.generation && currentRunMatches(claim);
  if (!matches) {
    await releaseClaim(ctx, runtime, claim);
    return { status: 409, body: { error: 'stale or mismatched Apply completion' } };
  }
  const result = body.result.result === 'failed' ? 'deferred' : body.result.result;
  try {
    const recorded = await recordQueueOutcome(
      runtime, claim, result, body.result.note, body.result.confirmationFile,
    );
    if (!recorded.accepted) {
      await releaseClaim(ctx, runtime, claim);
      return { status: 503, body: { error: 'queue outcome was not durably recorded', retryable: true } };
    }
    await resolveApplyTicket(ctx, claim, result, recorded.applicationSource);
    if (!(await runtime.consume(ctx.pool, claim))) throw new Error('capability settlement lost its reservation');
    finishApplyRun(runtime, claim, result, body.result.note);
    logger.info({ taskId: claim.taskId, ticketId: claim.ticketId, postingId: claim.postingId, result }, 'trusted Apply outcome committed');
    return { status: 200, body: { ok: true, result } };
  } catch (error) {
    await releaseClaim(ctx, runtime, claim);
    logger.error({ err: error, taskId: claim.taskId }, 'trusted Apply outcome failed before settlement');
    return { status: 503, body: { error: 'Apply completion was not settled', retryable: true } };
  }
}

/** @description Model-hidden trusted completion endpoint; all identity comes from the capability. */
function completionHandler(ctx: AppContext, runtime: ApplyCompletionRuntime): RequestHandler {
  return (req, res) => void (async () => {
    const parsed = CompletionSchema.safeParse(req.body);
    const capability = readApplyCapabilityHeader(req.header('x-oshal-callback-capability'));
    if (!parsed.success || !capability) {
      res.status(400).json({ error: 'invalid trusted completion request' });
      return;
    }
    const result = await processCompletion(ctx, runtime, capability, parsed.data);
    res.status(result.status).json(result.body);
  })();
}

/**
 * @description Mount internal Apply controls and the separate task-capability completion endpoint.
 * Model-driven callbacks cannot use the fleet service secret or assert another user's identifiers.
 */
export function createApplyIngestRoutes(ctx: AppContext, runtime: ApplyCompletionRuntime = DEFAULT_COMPLETION_RUNTIME): Router {
  const router = Router();
  registerDispatchRoutes(router, ctx);
  registerBatchRoutes(router, ctx);
  registerRetiredInteractiveRoutes(router);
  router.post('/ingest', completionHandler(ctx, runtime));
  return router;
}
