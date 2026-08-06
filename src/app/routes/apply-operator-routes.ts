/**
 * Apply-Operator Routes — OSHAL app API (OIDC/cockpit side of the job-apply workflow).
 *
 *   POST /submit    -> gather the next ready job + profile + packet, dispatch the browser submission
 *                      to the desktop worker, arm the 30-min watchdog (shared gatherAndDispatch).
 *   POST /complete  -> retired; trusted one-use capability callback is the only completion rail.
 *   GET  /inflight  -> retired; owner-scoped /queue is the only status rail.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | POST /submit accepts optional
 *   body.postingId so the mobile review card auto-applies the specific reviewed job.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | POST /submit awaits the now-async
 *   gatherAndDispatch (was spawnSync chains blocking the api event loop — the 07-15 wedge class).
 *   Same status/body contract; new 409/429 when a dispatch is already in flight (guard in apply-submit).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Read side for the cockpit apply
 *   queue: GET /queue (worker reachability + ticket lanes + the live slot), GET /story/:ticketId and
 *   GET /shot/:ticketId/:file (the desktop worker's narrated frames). The rail could be driven but
 *   never watched — a submission was a blank between "enqueued" and a one-line verdict. Story reads
 *   are owner-checked against the ticket's owner_sub, not just "is signed in".
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Target-computer selection: GET
 *   /workers lists the selectable leaf nodes (+ default); /enqueue, /enqueue-queue and /submit accept
 *   targetRemoteClientId to pin which node drives the browser; /queue takes ?clientId to report that
 *   node's reachability.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Remove every body/query identity fallback.
 *   Authenticated single-job submit/enqueue actions carry explicit per-task final-submit authority;
 *   bulk routes use the shared exact-user Career setting gate and return a stable denial.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Retire task-id completion and process-global in-flight enumeration; both are superseded by capability-bound ingest and owner-scoped queue snapshots.
 *
 * @module apply-operator-routes
 */
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { callerSub } from './caller-sub';
import { gatherAndDispatch } from '@/app/apply-submit';
import { stopApplyBatch, getApplyBatchStatus } from '@/app/apply-batch-runner';
import { enqueueApplyTicket, enqueueApplyQueue } from '@/app/apply-enqueue';
import { getApplyQueueSnapshot, listApplyWorkers } from '@/app/apply-queue-status';
import { readApplyStory, resolveApplyShotPath } from '@/app/apply-story';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { requireExactUserSubject } from '@/shared/security/exact-user-subject';
import { AUTHENTICATED_SINGLE_JOB_SUBMIT } from '@/app/apply-submit-authorization';

const logger = createChildLogger({ module: 'apply-operator-routes' });

/** @description Resolve only the authenticated OIDC subject and preserve it byte-for-byte. */
function authenticatedSubject(req: Request): string | null {
  const subject = callerSub(req);
  if (subject === null) return null;
  try { return requireExactUserSubject(subject, 'authenticated subject'); }
  catch { return null; }
}

export function createApplyOperatorRoutes(ctx: AppContext): Router {
  const router = Router();

  // ── POST /submit — gather next ready job, dispatch to the desktop worker, arm the watchdog.
  //    Awaits the ASYNC gatherAndDispatch (never spawnSync — the event loop stays free to serve
  //    /health + everyone else while the engine CLI chain runs). ─────────────────────────────────
  router.post('/submit', async (req: Request, res: Response) => {
    const userSub = authenticatedSubject(req);
    const ticketId = req.body?.ticketId ? String(req.body.ticketId) : undefined;
    // Optional: the mobile review card sends the specific posting the operator reviewed, so we apply
    // THAT job (not just the newest-generated one). Omitted -> unchanged "next ready" behaviour.
    const postingId = Number(req.body?.postingId) || undefined;
    const targetRemoteClientId = req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined;
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const r = await gatherAndDispatch(
      ctx, userSub, ticketId, postingId, targetRemoteClientId, AUTHENTICATED_SINGLE_JOB_SUBMIT,
    );
    res.status(r.status).json(r.body);
  });

  // ── Legacy task-id completion is intentionally gone: it had no owner/capability binding. ────────
  router.post('/complete/:taskId', (_req: Request, res: Response) => {
    res.status(410).json({ error: 'retired: trusted task-capability ingest is required' });
  });

  // ── Autonomous apply batch — start it once, walk away; the server works the whole queue
  //    sequentially (no script, no supervision). Status for the cockpit's running tally. ───────────
  // SUPERSEDED (2026-07-21 cutover): mints durable job-apply tickets instead of spinning the
  // in-memory runner (a second rail that died on every restart and drove the same desktop). ONE rail.
  router.post('/batch/start', async (req: Request, res: Response) => {
    const userSub = authenticatedSubject(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Number(req.body?.limit) || 200;
    const r = await enqueueApplyQueue(ctx, userSub, limit);
    res.status(r.ok ? 202 : 403).json({ ...r, superseded: 'the in-memory batch runner was replaced by durable job-apply tickets' });
  });
  router.post('/batch/stop', (req: Request, res: Response) => {
    const userSub = authenticatedSubject(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ ok: true, stopped: stopApplyBatch(userSub) });
  });
  router.get('/batch/status', (req: Request, res: Response) => {
    const userSub = authenticatedSubject(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ state: getApplyBatchStatus(userSub) });
  });

  // ── POST /enqueue — the cockpit "auto submit" button: file ONE durable job-apply ticket for the
  //    generated résumé the user just reviewed. Scoped to the logged-in user (callerSub). Persists,
  //    so it survives restarts and the queue works it one-at-a-time. Optional targetRemoteClientId
  //    pins WHICH leaf node (desktop / remote) drives the browser. ──────────────────────────────────
  router.post('/enqueue', async (req: Request, res: Response) => {
    const userSub = authenticatedSubject(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const r = await enqueueApplyTicket(ctx, userSub, {
      postingId: Number(req.body?.postingId),
      company: req.body?.company ? String(req.body.company) : undefined,
      title: req.body?.title ? String(req.body.title) : undefined,
      url: req.body?.url ? String(req.body.url) : undefined,
      location: req.body?.location ? String(req.body.location) : undefined,
      targetRemoteClientId: req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined,
    }, AUTHENTICATED_SINGLE_JOB_SUBMIT);
    res.status(r.ok ? (r.deduped ? 200 : 201) : 400).json(r);
  });

  // ── POST /enqueue-queue — file durable tickets for the user's WHOLE packet-ready queue (the
  //    durable, restart-surviving replacement for "batch/start"). Scoped to the logged-in user.
  //    Optional targetRemoteClientId pins every minted ticket to one leaf node. ─────────────────────
  router.post('/enqueue-queue', async (req: Request, res: Response) => {
    const userSub = authenticatedSubject(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Number(req.body?.limit) || 200;
    const targetRemoteClientId = req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined;
    const r = await enqueueApplyQueue(ctx, userSub, limit, targetRemoteClientId);
    res.status(r.ok ? 202 : (r.denialReason ? 403 : 400)).json(r);
  });

  // ── GET /workers — the selectable target-computer list: the screen-control-capable leaf nodes THIS
  //    caller may drive + which is the default. Feeds the submit dropdown so the operator picks WHERE
  //    the browser runs. Owner-scoped: this mount is requiresAuth (not operator-gated), so listing the
  //    whole fleet handed every signed-in user the client id of every other user's desktop — the exact
  //    value that pins dispatch. Operators still see everything. ─────────────────────────────────────
  router.get('/workers', (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json(listApplyWorkers({ sub }));
  });

  // ── Process-global watchdog enumeration leaked other users' task ids; /queue is owner-scoped. ──
  router.get('/inflight', (_req: Request, res: Response) => {
    res.status(410).json({ error: 'retired: use the owner-scoped /queue endpoint', replacement: '/queue' });
  });

  // ── GET /queue — the cockpit's apply queue: is the desktop reachable, what is waiting, what is
  //    being submitted right now, what finished. One poll drives the whole surface. ────────────────
  router.get('/queue', async (req: Request, res: Response) => {
    const userSub = callerSub(req);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    const limit = Number(req.query?.limit) || 100;
    const clientId = req.query?.clientId ? String(req.query.clientId) : undefined;
    res.json(await getApplyQueueSnapshot(ctx, userSub, limit, clientId));
  });

  /** Owner gate for a ticket's narration. Story frames are screenshots of the applicant's own real
   *  browser session — signed-in is NOT sufficient, the caller must own the submission. */
  async function ownsTicket(userSub: string, ticketId: string): Promise<boolean> {
    if (!ctx.pool || !/^[0-9a-fA-F-]{36}$/.test(ticketId)) return false;
    try {
      const { rows } = await runWithRequestIdentity({ sub: userSub, isOperator: false }, () => ctx.pool!.query(
        `SELECT 1 FROM tickets WHERE ticket_id = $1 AND owner_sub = $2 LIMIT 1`, [ticketId, userSub]));
      return rows.length > 0;
    } catch (err) {
      logger.error({ err, ticketId }, 'apply story: owner check failed');
      return false;
    }
  }

  // ── GET /story/:ticketId — the ordered beats the desktop worker reported for one submission ──────
  router.get('/story/:ticketId', async (req: Request, res: Response) => {
    const userSub = callerSub(req);
    const ticketId = String(req.params.ticketId);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!(await ownsTicket(userSub, ticketId))) { res.status(404).json({ error: 'not found' }); return; }
    const beats = await readApplyStory(ticketId);
    res.json({ ticketId, beats });
  });

  // ── GET /shot/:ticketId/:file — one frame's bytes (owner-checked; filename must be in the index) ─
  router.get('/shot/:ticketId/:file', async (req: Request, res: Response) => {
    const userSub = callerSub(req);
    const ticketId = String(req.params.ticketId);
    if (!userSub) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!(await ownsTicket(userSub, ticketId))) { res.status(404).json({ error: 'not found' }); return; }
    const abs = await resolveApplyShotPath(ticketId, String(req.params.file));
    if (!abs) { res.status(404).json({ error: 'not found' }); return; }
    // Frames are immutable once written, but they are private — never let a shared cache hold one.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(abs, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  return router;
}
