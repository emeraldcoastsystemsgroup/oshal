/**
 * Apply Ingest Route — the desktop worker's callback surface for the job-apply workflow.
 *
 *   POST /ingest  -> the box (edge-node-1) reports the submission outcome. Service-secret authed
 *                    (the box is not OIDC), so this lives in its OWN router mounted WITHOUT
 *                    requiresAuth (like /api/lora/ingest). It clears the watchdog, records the
 *                    per-user outcome (apply_record + apply_trace), and resolves the ticket.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                     | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Event-loop hardening (the 07-15
 *   spawnSync wedge class): /ingest ran the record + trace CLI verbs via spawnSync — 30s + 20s
 *   blocking the whole api event loop; now awaits the shared ASYNC runApplyCli with the same
 *   timeouts + best-effort semantics, and /dispatch awaits the now-async gatherAndDispatch.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed a boot crash-loop: the
 *   top-level require of the site-cred helper used ../../scripts (correct for a src/app/ file like
 *   bot-node-provider-intent.ts, but WRONG here in src/app/routes/ — one level deeper). From the
 *   compiled dist/app/routes/*.js that resolves to dist/scripts/ (absent) instead of /app/scripts/,
 *   so the unguarded require threw MODULE_NOT_FOUND and crash-looped the api at boot, blocking every
 *   deploy of HEAD. Corrected to ../../../scripts (matches the sibling's intent for the deeper path).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added POST /shot — the worker's
 *   mid-run progress beat (caption + optional screenshot) so a submission is watchable while it
 *   happens instead of only at /ingest. Best-effort by design: telemetry never fails an application.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | /dispatch + /enqueue + /enqueue-queue
 *   accept targetRemoteClientId so a ticket/cron can pin the leaf node that drives the browser.
 *
 * @module apply-ingest-routes
 */
import { Router, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '@/app/composition/app-context';
import { findByTicket, clearInFlight } from '@/app/apply-inflight';
import { gatherAndDispatch, runApplyCli } from '@/app/apply-submit';
import { enqueueApplyTicket, enqueueApplyQueue } from '@/app/apply-enqueue';
import { resolveBotCreds } from './connector-token-broker';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { stopApplyBatch, getApplyBatchStatus } from '@/app/apply-batch-runner';
import { recordApplyBeat } from '@/app/apply-story';
// Reuse the site-credential AES envelope + password generator (require-safe: its CLI is gated on
// require.main). The store is the FORCE-RLS ats_site_credentials table (migration 086).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const siteCreds = require('../../../scripts/oshal-site-creds.js') as {
  encrypt: (p: string) => string; decrypt: (b: string) => string; generatePassword: (len?: number) => string;
};

const logger = createChildLogger({ module: 'apply-ingest-routes' });
const ALLOWED = new Set(['applied', 'deferred', 'dismissed']);
/** Normalize a site to its bare host (the vault key) — codex may pass a full URL. */
function siteHost(value: string): string {
  const v = String(value || '').trim();
  try { return new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return v.toLowerCase().replace(/^www\./, ''); }
}

function serviceSecretOk(req: Request): boolean {
  const secret = (process.env.SWARM_SERVICE_SECRET || '').trim();
  return secret.length > 0 && String(req.header('x-service-secret') || '').trim() === secret;
}

export function createApplyIngestRoutes(ctx: AppContext): Router {
  const router = Router();

  // ── POST /dispatch — bot/ticket trigger (service-secret): gather the ready job + dispatch to the
  //    desktop worker. Body: { userSub, ticketId?, postingId? }. Mirrors /api/apply-operator/submit
  //    for callers that authenticate with the shared secret instead of an OIDC session. When postingId
  //    is present (a durable per-résumé job-apply ticket) THAT specific packet is applied; omitted →
  //    the legacy "newest generated first" behaviour. ─────────────────────────────────────────────
  router.post('/dispatch', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    const ticketId = req.body?.ticketId ? String(req.body.ticketId) : undefined;
    const postingId = Number(req.body?.postingId) || undefined;
    // The ticket's chosen leaf node (from metadata.targetRemoteClientId), forwarded by the dispatcher.
    const targetRemoteClientId = req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined;
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const r = await gatherAndDispatch(ctx, userSub, ticketId, postingId, targetRemoteClientId);
    res.status(r.status).json(r.body);
  });

  // ── POST /enqueue — file ONE durable job-apply ticket for a specific packet-ready posting
  //    (service-secret). This is the durable, restart-surviving "auto submit this résumé" action:
  //    the queue manager dispatches the ticket to the desktop node, which applies + reports to
  //    /ingest. Body: { userSub, postingId, company?, title?, url?, location? }. ──────────────────
  router.post('/enqueue', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const r = await enqueueApplyTicket(ctx, userSub, {
      postingId: Number(req.body?.postingId),
      company: req.body?.company ? String(req.body.company) : undefined,
      title: req.body?.title ? String(req.body.title) : undefined,
      url: req.body?.url ? String(req.body.url) : undefined,
      location: req.body?.location ? String(req.body.location) : undefined,
      targetRemoteClientId: req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined,
    });
    res.status(r.ok ? (r.deduped ? 200 : 201) : 400).json(r);
  });

  // ── POST /enqueue-queue — bulk mint one durable ticket per packet-ready posting (service-secret).
  //    The durable replacement for the in-memory apply-batch-runner: the whole backlog becomes
  //    persisted tickets worked one-at-a-time. Body: { userSub, limit? }. ────────────────────────
  router.post('/enqueue-queue', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const limit = Number(req.body?.limit) || 200;
    const targetRemoteClientId = req.body?.targetRemoteClientId ? String(req.body.targetRemoteClientId) : undefined;
    const r = await enqueueApplyQueue(ctx, userSub, limit, targetRemoteClientId);
    logger.info({ userSub, created: r.created, deduped: r.deduped }, 'apply enqueue-queue requested');
    res.status(r.ok ? 202 : 400).json(r);
  });

  // ── POST /email-code — the desktop worker asks the CONTROLLER to read the newest ATS
  //    verification code from the applicant's connected Gmail (Greenhouse/ATS human-check gate).
  //    The box has no DB/SESSION_SECRET, and oshal_connections is force-RLS, so the controller
  //    resolves the caller's OWN google access token here (RLS-safe: runWithRequestIdentity sets
  //    oshal.current_sub, ctx.pool is the GUC-wrapped pool → the token broker sees the row) and
  //    runs the email-code fetcher with it. Service-secret authed (the box is not OIDC). ─────────
  router.post('/email-code', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    try {
      const result = await runWithRequestIdentity({ sub: userSub, isOperator: false }, async () => {
        const creds = await resolveBotCreds(ctx.pool, userSub, ['google']);
        const token = creds.OSHAL_CRED_GOOGLE;
        if (!token) return { code: null, note: 'no google connection for this user' };
        // The CLI reads OSHAL_CRED_GOOGLE directly (resolveProvidedToken) — no DB, RLS-safe.
        return await runApplyCli(userSub, ['email-code'], { timeoutMs: 25000, extraEnv: { OSHAL_CRED_GOOGLE: token } });
      });
      const body = (result && typeof result === 'object') ? result as Record<string, unknown> : { code: null };
      logger.info({ userSub, found: Boolean(body.code) }, 'apply email-code fetch');
      res.json(body);
    } catch (err) {
      logger.error({ err, userSub }, 'apply email-code fetch failed');
      res.status(500).json({ code: null, error: err instanceof Error ? err.message : 'email-code failed' });
    }
  });

  // ── Autonomous batch (service-secret): start/stop/status the hands-off apply loop that works the
  //    user's whole queue sequentially with no external script or human supervision. ───────────────
  // SUPERSEDED (2026-07-21 cutover): this used to spin the in-memory apply-batch-runner, a second
  // apply rail that died on every api restart and drove the same desktop as the durable ticket queue.
  // It now mints durable job-apply tickets instead, so there is exactly ONE rail and an old caller
  // gets the restart-surviving behaviour automatically.
  router.post('/batch/start', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    const limit = Number(req.body?.limit) || 200;
    const r = await enqueueApplyQueue(ctx, userSub, limit);
    logger.info({ userSub, limit, created: r.created, deduped: r.deduped }, 'apply batch start -> durable ticket mint (in-memory runner superseded)');
    res.status(202).json({ ...r, superseded: 'the in-memory batch runner was replaced by durable job-apply tickets' });
  });
  router.post('/batch/stop', (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    res.json({ ok: true, stopped: stopApplyBatch(userSub) });
  });
  router.get('/batch/status', (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.query?.userSub ? String(req.query.userSub) : '';
    if (!userSub) { res.status(400).json({ error: 'userSub required' }); return; }
    res.json({ state: getApplyBatchStatus(userSub) });
  });

  // ── Site-credentials vault (service-secret): store + retrieve the user's per-employer ATS account
  //    (Workday/Lever/iCIMS/BrassRing need an account per tenant). AES-256-GCM at rest, FORCE-RLS
  //    ats_site_credentials, RLS-satisfied via runWithRequestIdentity (oshal.current_sub) + ctx.pool.
  //    codex calls /site-cred/get on a login wall; /site-cred stores (or generates) one. ───────────
  router.post('/site-cred', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    const site = req.body?.site ? siteHost(String(req.body.site)) : '';
    const username = req.body?.username ? String(req.body.username) : '';
    const family = req.body?.family ? String(req.body.family).slice(0, 24) : null;
    const generate = req.body?.generate === true || req.body?.generate === 'true';
    const password = generate || !req.body?.password ? siteCreds.generatePassword(20) : String(req.body.password);
    if (!userSub || !site || !username) { res.status(400).json({ error: 'userSub, site, username required' }); return; }
    try {
      await runWithRequestIdentity({ sub: userSub, isOperator: false }, () => ctx.pool.query(
        `INSERT INTO ats_site_credentials (user_sub, site, ats_family, username, password_enc)
           VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_sub, site) DO UPDATE SET
           username=EXCLUDED.username, password_enc=EXCLUDED.password_enc,
           ats_family=COALESCE(EXCLUDED.ats_family, ats_site_credentials.ats_family), updated_at=NOW()`,
        [userSub, site, family, username, siteCreds.encrypt(password)]));
      logger.info({ userSub, site, generated: generate }, 'site-cred stored');
      // Return the password ONLY when we just generated it (codex needs it to register the account).
      res.json({ ok: true, site, username, ...(generate ? { password } : {}) });
    } catch (err) {
      logger.error({ err, userSub, site }, 'site-cred store failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'store failed' });
    }
  });
  router.post('/site-cred/get', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const userSub = req.body?.userSub ? String(req.body.userSub) : '';
    const site = req.body?.site ? siteHost(String(req.body.site)) : '';
    if (!userSub || !site) { res.status(400).json({ error: 'userSub, site required' }); return; }
    try {
      const row = await runWithRequestIdentity({ sub: userSub, isOperator: false }, () => ctx.pool.query(
        `SELECT username, password_enc FROM ats_site_credentials WHERE user_sub=$1 AND site=$2 AND status='active' LIMIT 1`,
        [userSub, site]));
      if (!row.rows[0]) { res.json({ found: false, site }); return; }
      res.json({ found: true, site, username: row.rows[0].username, password: siteCreds.decrypt(row.rows[0].password_enc) });
    } catch (err) {
      logger.error({ err, userSub, site }, 'site-cred get failed');
      res.status(500).json({ found: false, error: err instanceof Error ? err.message : 'get failed' });
    }
  });

  // ── POST /shot — a PROGRESS BEAT from the desktop worker mid-submission (service-secret): a short
  //    caption and, optionally, the screenshot it just looked at. Append-only per ticket. This is the
  //    only channel the operator has into a run: /ingest fires once at the very end, so without this
  //    an eight-minute submission is eight minutes of nothing. Deliberately best-effort — a failed
  //    beat returns 200 with recorded:false so the worker NEVER aborts a real application over
  //    telemetry. Body: { ticketId, label, note?, imageBase64? }. ──────────────────────────────────
  router.post('/shot', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const ticketId = req.body?.ticketId ? String(req.body.ticketId) : '';
    const label = req.body?.label ? String(req.body.label) : '';
    if (!ticketId) { res.status(400).json({ error: 'ticketId required' }); return; }
    const beat = await recordApplyBeat({
      ticketId,
      label,
      note: req.body?.note ? String(req.body.note) : undefined,
      imageBase64: req.body?.imageBase64 ? String(req.body.imageBase64) : undefined,
    });
    res.json({ ok: true, recorded: Boolean(beat), seq: beat?.seq ?? null });
  });

  router.post('/ingest', async (req: Request, res: Response) => {
    if (!serviceSecretOk(req)) { res.status(401).json({ error: 'unauthorized' }); return; }

    const ticketId = req.body?.ticketId ? String(req.body.ticketId) : undefined;
    const postingId = Number(req.body?.postingId);
    const userSub = req.body?.userSub ? String(req.body.userSub) : undefined;
    const result = ALLOWED.has(String(req.body?.result)) ? String(req.body.result) : 'deferred';
    const note = req.body?.note ? String(req.body.note) : '';

    // 1) clear the 30-min watchdog for this ticket (so it doesn't later escalate a done submission)
    if (ticketId) { const e = findByTicket(ticketId); if (e) clearInFlight(e.taskId); }

    // 2) record the per-user outcome (queue status + learning trace), OSHAL_USER_SUB-scoped.
    //    Async + awaited IN ORDER (record before trace, both before ticket resolve) — never
    //    spawnSync: these two calls blocked the api event loop up to 50s per ingest.
    if (userSub && Number.isFinite(postingId)) {
      await runApplyCli(userSub, ['queue', 'record', String(postingId), result, '--note', note], { timeoutMs: 30000 });
      await runApplyCli(userSub, ['trace'], {
        timeoutMs: 20000,
        extraEnv: { APPLY_POSTING_ID: String(postingId), APPLY_RESULT: result, APPLY_HOW: 'desktop', APPLY_BLOCKER: result === 'applied' ? '' : note },
      });
    }

    // 3) resolve the ticket
    if (ticketId) {
      const status = result === 'applied' ? 'complete' : (result === 'dismissed' ? 'cancelled' : 'customer_action');
      try { await ctx.ticketService.updateStatus(ticketId, status); }
      catch (err) { logger.warn({ err, ticketId, result }, 'ingest: ticket update failed'); }
    }

    logger.info({ ticketId, postingId, result }, 'apply outcome ingested from desktop worker');
    res.json({ ok: true, result });
  });

  return router;
}
