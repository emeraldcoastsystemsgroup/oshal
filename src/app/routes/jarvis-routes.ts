/**
 * Jarvis routes — the unified assistant that sits over every OSHAL app (ADR-050).
 *
 * One chat box, the whole swarm behind it. Jarvis does NOT own a domain and never calls an
 * LLM to reason about jobs/email/home/etc. itself — it is a ROUTE-LAYER ORCHESTRATOR. As of the
 * 2026-07-18 decomposition this file is the THIN ROUTER + the request-scoped glue only; the heavy
 * logic lives in cohesive siblings imported below:
 *
 *   - jarvis-orchestrator.ts        — the accountable bot-node turn (runJarvisBot), the app catalog
 *                                     (APP_ROUTES/loadEffectiveRoutes), and the completed-task
 *                                     summarizer + poll-time claim/repair.
 *   - jarvis-directives.ts          — server-only handoff/visual fence parsing + the shared types.
 *   - jarvis-provider-intent-detect.ts — the deterministic weather/priority-email/walmart guard.
 *   - jarvis-visuals.ts             — fact-locked visual-spec builders + trusted provider records.
 *   - jarvis-tool-catalog.ts        — the auto tool-feed + the image-deliverable contract.
 *   - jarvis-overview.ts            — the Command Center glance panels.
 *   - jarvis-task-store.ts          — the durable jarvis_tasks store + turn persistence.
 *
 * The public symbols those siblings own are RE-EXPORTED from here so existing importers and the unit
 * tests keep resolving them from `jarvis-routes` unchanged.
 *
 * Every route is auth-gated at mount (auth is opt-in per route, CLAUDE.md): an OIDC session
 * (browser surface) OR the trusted-service secret + x-oshal-user-sub (headless swarm CLI /
 * internal bots) — the same serviceSecretOr pattern as the message routes and /api/graph.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — unified Jarvis assistant: GET / + /ui (surface), GET /catalog (the apps Jarvis can reach), POST /ask (classify via oshal-assistant → delegate self-serve bots via BotNodeClient.execute with userSub+creds → synthesize one answer; data-apps handed off with a deep link). Route-layer orchestrator, ADR-050.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Serve the authenticated response-stage and ambient-listening browser assets used by the Jarvis surface.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Headless access: callerSub falls back to the trusted-service identity (X-Service-Secret + x-oshal-user-sub) so the swarm CLI and internal bots drive /ask like the chat window.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Decomposition: split this 2.5×-over-cap file into cohesive jarvis-* siblings (orchestrator/directives/provider-intent-detect/visuals/tool-catalog/overview/task-store). This file is now the router + request glue; the moved public symbols are re-exported so importers + tests are unchanged. No behaviour change.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Allowlisted the three jarvis-ambient decomposition siblings (core/ui/recognition) in JARVIS_CLIENT_ASSETS so the load-ordered classic scripts serve from /assets like the existing jarvis-speakers siblings. jarvis-ambient.js itself was over the 1000-code-line cap; behavior is unchanged.
 *
 * @module jarvis-routes
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import * as path from 'path';
import * as crypto from 'crypto';
import { createChildLogger } from '@/shared/logger';
import { getTrustedServiceUserSub } from '@/shared/middleware/authz';
import type { AppContext } from '@/app/composition/app-context';
import type { InternalTicket } from '@/entities/ticket';
import {
  VisualResponseService,
  inferVisualSpec,
  type VisualResponseArtifact,
} from '@/features/visual-response';
import { isBotAccessibleTo } from '@/app/extensions/swarm/swarm-bot-registry';
import {
  extractPlanDirective,
  isMultiAppPlan,
  stripPlanDirective,
} from '@/features/swarm-orchestration';
import {
  detectRecallIntent,
  recallQuery,
  buildRecallSpokenAnswer,
  ownerHasAmbientData,
} from '@/features/person-model';
import { createJarvisVisualRoutes, createOptionalJarvisVisual } from './jarvis-visual-response';

// ── Locally-used logic from the decomposed siblings ──────────────────────────
import {
  JARVIS_AGENT_ID,
  DECISION_TIMEOUT_MS,
  APP_ROUTES,
  PLAN_DIRECTIVE_GUIDANCE,
  loadEffectiveRoutes,
  runJarvisBot,
  compileAndDispatchPlan,
  maskPendingComplexSummaries,
  repairCompletedTaskTableVisuals,
} from './jarvis-orchestrator';
import { extractJarvisDirectives, type HandoffDirective } from './jarvis-directives';
import { buildAttachmentEnrichment } from './jarvis-attachments';
import { detectProviderBoundHandoff, classifyWeatherLocationFollowUp } from './jarvis-provider-intent-detect';
import { visualSpecForDirectRequest } from './jarvis-visuals';
import { buildToolsBlock, withImageDeliverableContract } from './jarvis-tool-catalog';
import { buildBots, buildComms, buildActivity, buildCalendar } from './jarvis-overview';
import {
  ensureJarvisSchema,
  saveTaskPending,
  buildOpenWorkBlock,
  persistJarvisTurn,
  markJarvisSessionTaskStatus,
  mapJarvisTaskStatusFromTicketStatus,
  storedVisual,
} from './jarvis-task-store';

// ── Re-exports: keep the public surface the unit tests + external importers resolve from here. ──
export {
  extractHandoffs,
  extractJarvisDirectives,
  type HandoffDirective,
  type ProviderBoundHandoffIntent,
  type JarvisDirectives,
} from './jarvis-directives';
export {
  detectProviderBoundHandoff,
  resolveWeatherLocationFollowUp,
} from './jarvis-provider-intent-detect';
export {
  detectExplicitDirectVisualKind,
  visualSpecForOutcome,
  visualSpecForDelayedCompletion,
  visualSpecForDirectRequest,
  visualSpecFromCompletedMarkdownTable,
  workspaceGalleryFromCompletedResult,
  trustedProviderRecordsFromJarvisWorkMessage,
  providerRecordsMatchingTrustedIntent,
  summarizeProviderBoundRecords,
} from './jarvis-visuals';
export { withImageDeliverableContract } from './jarvis-tool-catalog';
export {
  ensureJarvisSchema,
  saveTaskPending,
  finishTask,
  findJarvisTaskSessionId,
  persistJarvisTurn,
  markJarvisSessionTaskStatus,
  mapJarvisTaskStatusFromTicketStatus,
  storedVisual,
} from './jarvis-task-store';
export { maskPendingComplexSummaries, JARVIS_AGENT_ID } from './jarvis-orchestrator';

const logger = createChildLogger({ module: 'jarvis-routes' });

/** The ticketType for a hand-off (ADR-083): platform-dev work is EXPLICIT — Jarvis marks
 *  the directive `"platform": true` and it rides the superadmin-gated 'oshal-dev' queue
 *  (whose workflow declares the oshal-developer worker). Everything else is 'task', whose
 *  owner the queue manager resolves by call-out — Jarvis never names a bot. */
function ticketTypeForHandoff(h: Pick<HandoffDirective, 'platform'>): string {
  return h.platform ? 'oshal-dev' : 'task';
}

/** Caller's sub: the OIDC session (browser surface) first, else the trusted-service identity
 *  (X-Service-Secret + x-oshal-user-sub — headless swarm CLI / internal bots). Same resolution
 *  order as message-routes; the header is honored ONLY with a valid service secret. */
function callerSub(req: Request): string | null {
  const u = (req as { oidc?: { user?: { sub?: string; oid?: string } } }).oidc?.user;
  const sub = u?.sub || u?.oid;
  if (sub) return String(sub);
  return getTrustedServiceUserSub(req);
}

/** Serve a static surface file from the api dir. */
function servePage(apiDir: string, file: string): RequestHandler {
  return (_req, res) => {
    // Always revalidate so a rebuilt jarvis.html isn't served stale by browser/CF cache.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err) { logger.error({ err, file }, 'serve jarvis surface failed'); res.status(404).send('Not found'); }
    });
  };
}

/**
 * In-process async job store for POST /ask. The full turn routinely runs past Cloudflare's ~100s
 * edge timeout, which 524s a held connection. So /ask returns a jobId immediately and the surface
 * polls GET /ask/result. Single controller instance, so an in-memory Map suffices; jobs are scoped
 * to the caller and GC'd after 60 minutes.
 */
interface AskJob {
  sub: string;
  label: string;            // short request text — the shelf item's title
  taskId: string;           // the bot task/workspace this job ran in (clickable from the shelf)
  status: 'pending' | 'done' | 'error';
  // 'chat' = a conversational turn (answered inline); 'work' = a handed-off background work item
  // (the "queue") that the surface announces when done, voice-gated.
  kind?: 'chat' | 'work';
  result?: {
    answer: string;
    routed: Array<{ key: string; name: string; deepLink: string }>;
    handoffs: Array<{ key: string; name: string; deepLink: string }>;
    // Work items Jarvis handed off on this turn — the surface tracks + announces these.
    dispatched?: Array<{ workJobId: string; title: string }>;
    // Optional image for the cloud/scene renderer. The text answer remains authoritative.
    visual?: VisualResponseArtifact;
  };
  error?: string;
  createdAt: number;
  finishedAt?: number;
}
const askJobs = new Map<string, AskJob>();

/**
 * @description Turns Jarvis's hand-off directives into background work: best-effort owner-scoped
 * visibility ticket + a polled work job per directive. Returns the dispatched list for the surface.
 */
async function dispatchHandoffs(
  ctx: AppContext, sub: string, sessionId: string, handoffs: HandoffDirective[],
): Promise<Array<{ workJobId: string; title: string }>> {
  const dispatched: Array<{ workJobId: string; title: string }> = [];
  for (const h of handoffs) {
    const workJobId = crypto.randomUUID();

    // EVERY tool/work hand-off goes through the QUEUE — a `status:'approved'` ticket the
    // queue-manager picks up and routes by CALL-OUT (ADR-083): it broadcasts a BID_REQUEST
    // to the online knowledge owners, they self-score from their declared capabilities, and
    // the AgentRouter cascade decides. Jarvis NEVER runs the tool itself, NEVER names the
    // owner, and NEVER waits — it returns immediately; the ticket carries the result/status.
    let ticketId: string | undefined;
    try {
      const ticket = await ctx.ticketService.createTicket({
        title: h.title,
        description: withImageDeliverableContract(h),
        status: 'approved',
        priority: 'medium',
        ownerSub: sub,
        // Platform-dev asks are EXPLICIT (h.platform) and ride the privileged 'oshal-dev'
        // queue (superadmin-gated at dispatch) so the developer bot owns them.
        ticketType: ticketTypeForHandoff(h),
        metadata: {
          source: 'jarvis', sessionId, complexity: h.complexity || 'simple',
          ...(h.providerIntent ? { providerIntent: h.providerIntent } : {}),
        },
      } as never);
      ticketId = (ticket as { ticketId?: string; id?: string }).ticketId ?? (ticket as { id?: string }).id;
    } catch (err) {
      logger.error({ err, title: h.title }, 'jarvis: failed to file task with the build queue');
    }
    void saveTaskPending(ctx.pool, workJobId, sub, sessionId, h.title, 'complex', ticketId);
    dispatched.push({ workJobId, title: h.title });
  }
  return dispatched;
}

// Results PERSIST (not one-shot) so the session-manager shelf can re-open a finished item; GC'd
// after 60 min. The surface lists them via GET /ask/jobs and dismisses via POST /ask/dismiss.
function gcAskJobs(): void {
  const now = Date.now();
  for (const [id, job] of askJobs) { if (now - job.createdAt > 60 * 60 * 1000) askJobs.delete(id); }
  for (const [key, pending] of pendingWeatherClarifications) {
    if (now - pending.createdAt > PENDING_WEATHER_TTL_MS) pendingWeatherClarifications.delete(key);
  }
}

/** Remove ephemeral answers immediately when an owner invokes the privacy erasure workflow. */
export function purgeJarvisAskJobsForOwner(userSub: string): number {
  let deleted = 0;
  for (const [id, job] of askJobs) {
    if (job.sub !== userSub) continue;
    askJobs.delete(id);
    deleted += 1;
  }
  const ownerPrefix = `${userSub}\u0000`;
  for (const key of pendingWeatherClarifications.keys()) {
    if (key.startsWith(ownerPrefix)) pendingWeatherClarifications.delete(key);
  }
  return deleted;
}

/**
 * Open chat-ticket per conversation thread (sessionId → ticketId). A direct Jarvis chat thread gets
 * ONE workflow-less `chat`-ticket in the "Chat" queue (targeted at jarvis), opened on its first turn
 * and kept `in_process` until the user closes it (POST /thread/close). In-memory like askJobs — a
 * controller restart forgets the mapping (worst case: a new chat-ticket opens for an old thread).
 */
const threadTickets = new Map<string, string>();
const PENDING_WEATHER_TTL_MS = 10 * 60 * 1000;
const pendingWeatherClarifications = new Map<string, { request: string; createdAt: number }>();

/** Keep in-memory chat-ticket ownership explicit; a client-supplied session id is not globally unique. */
function threadTicketKey(ownerSub: string, sessionId: string): string {
  return `${ownerSub}\u0000${sessionId}`;
}

/**
 * @description Registers the Jarvis thread (sessionId) as a `chat_tasks` row. The chat-ticket link
 * (ticket_task_links) AND conversation persistence (chat_messages) both FK-reference this task id;
 * without it every persistence write fails (observed live: history never saved). Idempotent + best-effort.
 */
async function ensureSessionTask(ctx: AppContext, sub: string, sessionId: string, message: string): Promise<boolean> {
  try {
    const existing = await ctx.taskStore.get(sessionId);
    if (existing) return existing.ownerSub === sub;
    const created = await ctx.taskStore.create({
      taskId: sessionId,
      title: (message.split('\n')[0] || message).slice(0, 90) || 'Jarvis chat',
      processingMode: 'agentic',
      agentId: JARVIS_AGENT_ID,
      ownerSub: sub, // per-owner budget attribution (Phase 2)
      metadata: { origin: 'jarvis-chat' },
    });
    // `create` returns an existing row when a concurrent caller wins the task-id race. Re-check the
    // returned owner so a guessed session id can never become a cross-tenant append channel.
    return !created || created.ownerSub === sub;
  } catch (err) {
    logger.warn({ err, sessionId }, 'jarvis: ensureSessionTask failed (non-fatal)');
    return false;
  }
}

/**
 * @description Opens the thread's chat-ticket on its first turn (idempotent per sessionId). Fast —
 * a single insert — and never throws: a failure just means no board card, never a blocked chat.
 * @returns The chat-ticket id, or null if it couldn't be opened.
 */
async function ensureThreadChatTicket(
  ctx: AppContext, sub: string, sessionId: string, message: string,
): Promise<string | null> {
  const key = threadTicketKey(sub, sessionId);
  const existing = threadTickets.get(key);
  if (existing) return existing;
  const durableTicketId = await findOpenThreadChatTicket(ctx, sub, sessionId);
  if (durableTicketId) {
    threadTickets.set(key, durableTicketId);
    return durableTicketId;
  }
  try {
    const firstLine = message.split('\n')[0]?.trim() || message;   // raw request leads the payload
    const ticket = await ctx.ticketService.openChatTicket({
      taskId: sessionId, ownerSub: sub, agentId: JARVIS_AGENT_ID, text: firstLine, targetBot: 'jarvis',
    });
    threadTickets.set(key, ticket.ticketId);
    return ticket.ticketId;
  } catch (err) {
    logger.warn({ err, sessionId }, 'jarvis chat-ticket open failed (non-fatal)');
    return null;
  }
}

async function findOpenThreadChatTicket(ctx: AppContext, sub: string, sessionId: string): Promise<string | null> {
  try {
    const tickets = await ctx.ticketService.listTickets({ ownerSub: sub, ticketType: 'chat', limit: 500 });
    const matches = tickets
      .filter((ticket) => isOpenThreadChatTicket(ticket, sessionId))
      .sort((left, right) => ticketUpdatedAtMs(right) - ticketUpdatedAtMs(left));
    return matches[0]?.ticketId ?? null;
  } catch (err) {
    logger.warn({ err, sessionId }, 'jarvis durable chat-ticket lookup failed (non-fatal)');
    return null;
  }
}

function isOpenThreadChatTicket(ticket: InternalTicket, sessionId: string): boolean {
  if (ticket.status !== 'in_process' || ticket.ticketType !== 'chat') {
    return false;
  }
  const metadata = ticketMetadata(ticket);
  return metadata.taskId === sessionId
    && (metadata.kind === 'chat-thread' || metadata.origin === 'bot-chat' || metadata.targetBot === 'jarvis');
}

function ticketMetadata(ticket: InternalTicket): Record<string, unknown> {
  return ticket.metadata && typeof ticket.metadata === 'object'
    ? ticket.metadata as Record<string, unknown>
    : {};
}

function ticketUpdatedAtMs(ticket: InternalTicket): number {
  return Date.parse(ticket.updatedAt || ticket.createdAt || '') || 0;
}

const JARVIS_CLIENT_ASSETS = new Map([
  ['jarvis-stage.js', 'application/javascript; charset=utf-8'],
  ['jarvis-stage.css', 'text/css; charset=utf-8'],
  ['jarvis-ambient-core.js', 'application/javascript; charset=utf-8'],
  ['jarvis-ambient-ui.js', 'application/javascript; charset=utf-8'],
  ['jarvis-ambient-recognition.js', 'application/javascript; charset=utf-8'],
  ['jarvis-ambient.js', 'application/javascript; charset=utf-8'],
  ['jarvis-ambient.css', 'text/css; charset=utf-8'],
  ['jarvis-speakers.js', 'application/javascript; charset=utf-8'],
  ['jarvis-speakers.css', 'text/css; charset=utf-8'],
  ['jarvis-speaker-capture.js', 'application/javascript; charset=utf-8'],
  ['jarvis-person-consent.js', 'application/javascript; charset=utf-8'],
]);

/** Serve only the explicit Jarvis client assets; the parent router is authentication-gated. */
function serveJarvisClientAsset(apiDir: string): RequestHandler {
  return (req, res) => {
    const file = String(req.params.file || '');
    const contentType = JARVIS_CLIENT_ASSETS.get(file);
    if (!contentType) { res.status(404).send('Not found'); return; }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.join(apiDir, file), (err) => {
      if (err && !res.headersSent) res.status(404).send('Not found');
    });
  };
}

/** Return only the bounded opaque ids written by the delayed-task completion path. */
function storedJarvisSourceId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 180 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) return undefined;
  return value;
}

/**
 * @description Builds the Jarvis router (mount at /api/jarvis behind requiresAuth).
 * @param ctx - App context (Postgres pool).
 * @param apiDir - Directory holding the HTML surface.
 * @returns Express router.
 */
export function createJarvisRoutes(ctx: AppContext, apiDir: string): Router {
  const router = Router();
  const visualResponseService = new VisualResponseService(ctx.pool);
  void ensureJarvisSchema(ctx.pool);   // durable Tasks list table

  router.get('/', servePage(apiDir, 'jarvis.html'));
  router.get('/ui', servePage(apiDir, 'jarvis.html'));
  router.get('/assets/:file', serveJarvisClientAsset(apiDir));
  router.use('/visuals', createJarvisVisualRoutes(visualResponseService));

  /** GET /catalog — the apps Jarvis can reach (drives the surface's "what I can do" chips).
   *  Uses the SAME effective-route set as classify/delegate (loadEffectiveRoutes): the curated
   *  APP_ROUTES PLUS installed store apps discovered from swarm_applications. ADR-085: a carved
   *  app's static row is gone, so without the dynamic set the chips would silently drop every
   *  store-installed app (movies/spotify/rides/eats/finance/…). ADR-087: loadEffectiveRoutes
   *  already role-filters, so scoped bots never reach the chips. */
  router.get('/catalog', async (_req: Request, res: Response) => {
    try {
      const { routes } = await loadEffectiveRoutes(ctx);
      res.json({ apps: routes.map((r) => ({ key: r.key, name: r.name, blurb: r.blurb, mode: r.mode, deepLink: r.deepLink })) });
    } catch (err) {
      logger.warn({ err }, 'Jarvis /catalog dynamic build failed — falling back to curated routes');
      const visible = APP_ROUTES.filter((r) => isBotAccessibleTo(r.agentId, 'jarvis'));
      res.json({ apps: visible.map((r) => ({ key: r.key, name: r.name, blurb: r.blurb, mode: r.mode, deepLink: r.deepLink })) });
    }
  });

  /** GET /history?sessionId — past conversation turns for this user's thread, so the surface can
   *  re-render the conversation when the user returns. Reads the persisted chat messages. */
  router.get('/history', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const rawSession = String(req.query.sessionId || '').trim();
    const sessionId = /^[\w.-]{6,128}$/.test(rawSession) ? rawSession : `jarvis-${sub}`;
    try {
      const task = await ctx.taskStore.get(sessionId);
      // Missing and foreign sessions deliberately produce the same empty history. This keeps a
      // guessed id from becoming an existence oracle and prevents both text and visual metadata
      // from crossing the task-owner boundary.
      if (!task || task.ownerSub !== sub) { res.json({ turns: [] }); return; }
      const msgs = (await ctx.messageStore.getByTask(sessionId)) as Array<{
        role?: string; type?: string; text?: string; metadata?: Record<string, unknown>;
      }>;
      // A bounded lazy repair can attach an artifact to an older jarvis_tasks row after its original
      // Discussion turn was saved. Rejoin that owner-scoped artifact by the persisted source task id
      // so history/reload presents the exact same visual without duplicating the text turn.
      const repairTaskIds = [...new Set((msgs || []).map((message) => (
        storedJarvisSourceId(message.metadata?.sourceJarvisTaskId)
      )).filter((id): id is string => Boolean(
        id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      )))].slice(0, 50);
      const repairedVisuals = new Map<string, VisualResponseArtifact>();
      if (repairTaskIds.length) {
        try {
          const repairedRows = (await ctx.pool.query(
            // jarvis_tasks.id is TEXT (session/job ids are not universally UUIDs). The candidates
            // above are UUID-shaped for this bounded legacy join, but the SQL array must still use
            // the column's real type or Postgres rejects text = uuid before returning any row.
            'SELECT id, visual FROM jarvis_tasks WHERE user_sub = $1 AND id = ANY($2::text[])',
            [sub, repairTaskIds],
          )).rows as Array<{ id: string; visual?: unknown }>;
          repairedRows.forEach((row) => {
            const visual = storedVisual({ visual: row.visual });
            if (visual) repairedVisuals.set(String(row.id), visual);
          });
        } catch (err) {
          logger.warn({ err, sessionId }, 'jarvis: repaired history visual lookup skipped');
        }
      }
      const turns = (msgs || [])
        .map((m) => {
          const sourceJarvisTaskId = storedJarvisSourceId(m.metadata?.sourceJarvisTaskId);
          const sourceTicketId = storedJarvisSourceId(m.metadata?.sourceTicketId);
          const visual = storedVisual(m.metadata)
            || (sourceJarvisTaskId ? repairedVisuals.get(sourceJarvisTaskId) : undefined);
          return {
            role: m.role === 'user' || m.type === 'task' ? 'user' : 'jarvis',
            text: String(m.text || '').trim(),
            ...(sourceJarvisTaskId ? { sourceJarvisTaskId } : {}),
            ...(sourceTicketId ? { sourceTicketId } : {}),
            ...(visual ? { visual } : {}),
          };
        })
        .filter((t) => t.text.length > 0);
      res.json({ turns });
    } catch (err) {
      logger.warn({ err }, 'jarvis history failed');
      res.json({ turns: [] });
    }
  });

  /** GET /tasks — this user's batched work items + results (durable; survives restarts). The
   *  surface lists these on open so you see your old tasks, not just the in-session shelf. */
  router.get('/tasks', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const rows = (await ctx.pool.query(
        `SELECT id, title, status, result, error, kind, ticket_id, visual, delivered, created_at, finished_at
           FROM jarvis_tasks WHERE user_sub = $1 ORDER BY created_at DESC LIMIT 50`, [sub])).rows;
      // For complex tasks (filed with the swarm), the live status lives on the ticket — map it in.
      const hasComplex = rows.some((r) => r.kind === 'complex' && r.ticket_id);
      let ticketStatus = new Map<string, string>();
      if (hasComplex) {
        try {
          const tickets = await ctx.ticketService.listTickets({ ownerSub: sub, limit: 200 });
          ticketStatus = new Map(tickets.map((t) => [String(t.ticketId), String(t.status)]));
        } catch { /* fall back to the stored status */ }
      }
      const tasks = rows.map((r) => {
        let status = r.status;
        if (r.kind === 'complex' && r.ticket_id && ticketStatus.has(r.ticket_id)) {
          const ts = ticketStatus.get(r.ticket_id)!;
          status = mapJarvisTaskStatusFromTicketStatus(ts);
        }
        const visual = storedVisual({ visual: r.visual });
        return {
          id: r.id, title: r.title, status, result: r.result as string | null, error: r.error,
          kind: r.kind, ticketId: r.ticket_id, delivered: r.delivered === true, createdAt: r.created_at, finishedAt: r.finished_at,
          ...(visual ? { visual } : {}),
        };
      });
      // For finished complex tasks, have Jarvis READ the deliverable and summarize it in his voice
      // (once, in the background). Until that lands, the task stays masked as in-flight — see
      // maskPendingComplexSummaries for why it must never surface as 'done' early.
      await maskPendingComplexSummaries(ctx, sub, tasks);
      // Older completed rows may already contain a useful Markdown table but predate persisted
      // visual metadata. Repair at most three per owner poll; ordinary prose remains text-only.
      await repairCompletedTaskTableVisuals(ctx, visualResponseService, sub, tasks);
      res.json({ tasks });
    } catch (err) {
      logger.warn({ err }, 'jarvis tasks failed');
      res.json({ tasks: [] });
    }
  });

  /** POST /tasks/:id/delivered — mark a finished task's result as delivered to the conversation, so
   *  it's pushed exactly once and never re-announced (survives reloads). Caller-scoped. */
  router.post('/tasks/:id/delivered', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      await ctx.pool.query('UPDATE jarvis_tasks SET delivered = TRUE WHERE id = $1 AND user_sub = $2', [String(req.params.id), sub]);
      res.json({ ok: true });
    } catch (err) {
      logger.warn({ err }, 'jarvis mark-delivered failed');
      res.json({ ok: false });
    }
  });

  /** GET /overview — the Command Center glance: swarm map, comms highlights, queue activity, calendar. */
  router.get('/overview', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const [bots, comms, activity, calendar] = await Promise.all([
        buildBots(ctx), buildComms(ctx, sub), buildActivity(ctx, sub), buildCalendar(ctx, sub),
      ]);
      res.json({ bots, comms, activity, calendar });
    } catch (err) {
      logger.error({ err }, 'jarvis overview failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** POST /ask — { message } → { jobId }. Forwards to the Jarvis BOT-NODE (which runs in the any-bot
   *  wrapper with real tools); the surface polls GET /ask/result?jobId. Async because a tool-using
   *  agentic turn exceeds Cloudflare's ~100s edge timeout if the connection is held. */
  router.post('/ask', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const body = (req.body || {}) as { message?: string; sessionId?: string; attachments?: unknown };
    let message = String(body.message || '').trim();
    // Attached media arrives already reduced to text (image → /api/vision/describe description,
    // doc → extracted text). Fold it into an authoritative-context block for the Codex Jarvis turn.
    const attachments = buildAttachmentEnrichment(body.attachments);
    const hasAttachments = attachments.hasAny;
    // A bare "" message is fine when the user only attached media; give the bot an implicit prompt.
    if (!message && !hasAttachments) { res.status(400).json({ error: 'message required' }); return; }
    if (!message && hasAttachments) message = 'Please look at the attached media and tell me what it shows.';
    // Stable per-conversation thread id so the bot keeps context across turns — one persistent
    // "session folder" in the jarvis-bot runtime (the runtime reuses the task when taskId repeats,
    // appending to its history). Falls back to a per-user thread when the surface omits one.
    // Sanitized to a safe task-id token (the surface sends a localStorage UUID).
    const rawSession = String(body.sessionId || '').trim();
    const sessionId = /^[\w.-]{6,128}$/.test(rawSession) ? rawSession : `jarvis-${sub}`;
    gcAskJobs();
    // Register the thread as a chat_task FIRST — the chat-ticket link + saveTurn (chat_messages) both
    // FK-reference it; without it every persistence write fails (no durable history). Idempotent.
    const ownsSession = await ensureSessionTask(ctx, sub, sessionId, message);
    if (!ownsSession) { res.status(404).json({ error: 'session_not_found' }); return; }
    await markJarvisSessionTaskStatus(ctx, sessionId, 'processing');
    // Quick push on send: open (or reuse) this thread's chat-ticket before we ack — one fast insert.
    const chatTicketId = await ensureThreadChatTicket(ctx, sub, sessionId, message);
    await persistJarvisTurn(ctx, sessionId, 'user', (message.split('\n')[0] || message) + attachments.turnNote);   // persist the turn for replay
    if (hasAttachments) logger.info({ sessionId, images: attachments.imageCount, docs: attachments.docCount }, 'jarvis /ask: attachments enriched');
    const jobId = crypto.randomUUID();
    const label = message.replace(/\s+/g, ' ').trim().slice(0, 90);
    askJobs.set(jobId, { sub, label, taskId: sessionId, kind: 'chat', status: 'pending', createdAt: Date.now() });
    // Provider-bound information must be fetched by the worker that owns the live provider. This
    // deterministic guard runs before the direct model turn, preventing a plausible-looking weather
    // or inbox answer from model memory. Product/code asks intentionally fall through to Jarvis.
    // Ambient recall (ADR-100): a recall-shaped ask ("how many times has X mentioned Y", "what did X
    // say about Y") is answered DETERMINISTICALLY from the owner's own transcript store — a literal
    // count + verbatim quotes, no model turn, so the number is never a model estimate. Gated on the
    // owner actually having ambient data, so an ordinary question is never hijacked into an empty read.
    // Media turns go straight to an enriched Jarvis turn — the deterministic weather/inbox/recall
    // guards would only misfire on "what's in this photo?" and never own the attached context.
    const recallIntent = hasAttachments ? null : detectRecallIntent(message);
    const doRecall = recallIntent ? await ownerHasAmbientData(ctx.pool, sub) : false;
    const clarificationKey = threadTicketKey(sub, sessionId);
    const pendingWeather = pendingWeatherClarifications.get(clarificationKey);
    let providerBoundIntent = (doRecall || hasAttachments) ? undefined : detectProviderBoundHandoff(message);
    if (!doRecall && !hasAttachments && pendingWeather && Date.now() - pendingWeather.createdAt <= PENDING_WEATHER_TTL_MS) {
      const followUp = classifyWeatherLocationFollowUp(pendingWeather.request, message);
      if (followUp.action === 'resolved') {
        providerBoundIntent = followUp.intent;
        pendingWeatherClarifications.delete(clarificationKey);
      } else if (followUp.action === 'clear') {
        pendingWeatherClarifications.delete(clarificationKey);
      }
    }
    let providerClarification: string | undefined;
    if (providerBoundIntent?.kind === 'weather' && !providerBoundIntent.handoff.providerIntent) {
      pendingWeatherClarifications.set(clarificationKey, { request: message, createdAt: Date.now() });
      providerClarification = 'What city or ZIP code should I use for the live weather check?';
      providerBoundIntent = undefined;
    } else if (providerBoundIntent?.kind === 'weather' && providerBoundIntent.handoff.providerIntent) {
      pendingWeatherClarifications.delete(clarificationKey);
    }
    // Prepend the auto tool-feed (what Jarvis can actually DO) + the user's recent tasks/results only
    // when a direct model decision is still needed; the deterministic provider path needs neither.
    let botMessage = message;
    if (!providerBoundIntent) {
      const tools = buildToolsBlock();
      const openWork = await buildOpenWorkBlock(ctx, sub);
      const ctxBlocks = [tools, openWork, PLAN_DIRECTIVE_GUIDANCE].filter(Boolean).join('\n\n');
      // Attached media (image descriptions + doc text) sits right before the user's words.
      const userPart = attachments.hasAny ? `${attachments.promptBlock}\n\n${message}` : message;
      botMessage = ctxBlocks ? `${ctxBlocks}\n\n---\n\n${userPart}` : userPart;
    }
    // MUST be agentic:true — the codex provider has no plain-LLM path (agenticMode:false →
    // "activeLlm.generateResponse is not a function"). The persona is what keeps the decision turn
    // from running heavy tools: it answers, or emits a handoff directive, without shelling out.
    void (async () => {
      try {
        if (doRecall && recallIntent) {
          // Deterministic transcript read — the count/quotes come straight from the owner's store.
          let answer: string;
          try {
            const result = await recallQuery(ctx.pool, sub, recallIntent);
            answer = buildRecallSpokenAnswer(recallIntent, result);
          } catch (err) {
            logger.warn({ err }, 'jarvis: ambient recall failed');
            answer = 'I could not reach your ambient recall just now — try again in a moment.';
          }
          await persistJarvisTurn(ctx, sessionId, 'assistant', answer);
          await markJarvisSessionTaskStatus(ctx, sessionId, 'active');
          const j = askJobs.get(jobId);
          askJobs.set(jobId, {
            sub, label, taskId: sessionId, kind: 'chat', status: 'done',
            createdAt: j?.createdAt ?? Date.now(), finishedAt: Date.now(),
            result: { answer, routed: [], handoffs: [], dispatched: [] },
          });
          return;
        }
        if (providerClarification) {
          await persistJarvisTurn(ctx, sessionId, 'assistant', providerClarification);
          await markJarvisSessionTaskStatus(ctx, sessionId, 'active');
          const j = askJobs.get(jobId);
          askJobs.set(jobId, {
            sub, label, taskId: sessionId, kind: 'chat', status: 'done',
            createdAt: j?.createdAt ?? Date.now(), finishedAt: Date.now(),
            result: { answer: providerClarification, routed: [], handoffs: [], dispatched: [] },
          });
          return;
        }
        if (providerBoundIntent) {
          const dispatched = await dispatchHandoffs(ctx, sub, sessionId, [providerBoundIntent.handoff]);
          // An acknowledgement has no provider facts yet, so it is deliberately persisted without
          // visual metadata. The completed worker/ticket summarizer is the only visual-producing path.
          await persistJarvisTurn(ctx, sessionId, 'assistant', providerBoundIntent.acknowledgement);
          await markJarvisSessionTaskStatus(ctx, sessionId, 'active');
          const j = askJobs.get(jobId);
          askJobs.set(jobId, {
            sub, label, taskId: sessionId, kind: 'chat', status: 'done',
            createdAt: j?.createdAt ?? Date.now(), finishedAt: Date.now(),
            result: {
              answer: providerBoundIntent.acknowledgement,
              routed: [], handoffs: [], dispatched,
            },
          });
          return;
        }

        // The decision turn should be quick (answer or emit a hand-off). But the persona is only
        // model judgment — on a "build me X" request the codex agent will sometimes IGNORE the
        // hand-off rule and grind the whole build inline (observed: 8.6 min, 1.8M tokens). So we
        // race it against a hard timeout: if it hasn't decided in time, it's clearly doing heavy
        // work — stop waiting, FILE the request with the PM/swarm, and ack. (The grinding turn
        // finishes harmlessly server-side; we just don't block the user on it.)
        let answer: string;
        try {
          const raced = await Promise.race([
            runJarvisBot(ctx, sub, botMessage, sessionId, true),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('DECISION_TIMEOUT')), DECISION_TIMEOUT_MS)),
          ]);
          answer = raced.answer;
        } catch (e) {
          if ((e as Error).message !== 'DECISION_TIMEOUT') throw e;
          const workJobId = crypto.randomUUID();
          let ticketId: string | undefined;
          try {
            // ADR-083: the auto-file names no owner — the queue manager's call-out routes
            // it (and, filed as 'complex', an unclaimed ask promotes to the build lane).
            const ticket = await ctx.ticketService.createTicket({
              title: message.slice(0, 120), description: message, status: 'approved', priority: 'medium',
              ownerSub: sub, ticketType: 'task',
              metadata: {
                source: 'jarvis', sessionId, complexity: 'complex', autoFiled: true,
              },
            } as never);
            ticketId = (ticket as { ticketId?: string; id?: string }).ticketId ?? (ticket as { id?: string }).id;
          } catch (err) { logger.error({ err }, 'jarvis: auto-file on decision timeout failed'); }
          void saveTaskPending(ctx.pool, workJobId, sub, sessionId, message.slice(0, 120), 'complex', ticketId);
          const ack = "That's a bigger build — I've handed it to the team and I'll let you know when it's ready.";
          // A timeout acknowledgement contains no completed data. Never materialize a generic image
          // for it, even if the timed-out model later emits a stale visual directive.
          await persistJarvisTurn(ctx, sessionId, 'assistant', ack);
          await markJarvisSessionTaskStatus(ctx, sessionId, 'active');
          const j = askJobs.get(jobId);
          askJobs.set(jobId, {
            sub, label, taskId: sessionId, kind: 'chat', status: 'done', createdAt: j?.createdAt ?? Date.now(), finishedAt: Date.now(),
            result: { answer: ack, routed: [], handoffs: [], dispatched: [{ workJobId, title: message.slice(0, 120) }] },
          });
          return;
        }

        // Multi-app plan (SEAM D): a data-dependent, cross-app request compiles to ONE 'graph' ticket
        // that the engine runs step-by-step (data passed between app bots; outward steps gated). A
        // single-step "plan" is not a plan — it falls through to the normal handoff path below.
        const plan = extractPlanDirective(answer);
        if (isMultiAppPlan(plan)) {
          const { byKey } = await loadEffectiveRoutes(ctx);
          const planDispatched = await compileAndDispatchPlan(ctx, sub, sessionId, plan, byKey);
          if (planDispatched.length) {
            const ack = stripPlanDirective(extractJarvisDirectives(answer).cleanAnswer)
              || `On it — I've lined up ${plan.steps.length} steps across your apps and started them. I'll let you know when they're done.`;
            await persistJarvisTurn(ctx, sessionId, 'assistant', ack);
            await markJarvisSessionTaskStatus(ctx, sessionId, 'active');
            const jp = askJobs.get(jobId);
            askJobs.set(jobId, {
              sub, label, taskId: sessionId, kind: 'chat', status: 'done',
              createdAt: jp?.createdAt ?? Date.now(), finishedAt: Date.now(),
              result: { answer: ack, routed: [], handoffs: [], dispatched: planDispatched },
            });
            return;
          }
        }

        // Split conversational reply from any hand-off directives; dispatch the work, show only the ack.
        const directives = extractJarvisDirectives(answer);
        const { handoffs } = directives;
        // Also strip any oshal:plan control fence — extractJarvisDirectives doesn't know that channel,
        // so an UN-dispatched plan (single-step, unreachable app, or a registration/ticket failure that
        // fell through here) would otherwise leak raw ```oshal:plan JSON into the user's answer.
        const cleanAnswer = stripPlanDirective(directives.cleanAnswer);
        const dispatched = handoffs.length ? await dispatchHandoffs(ctx, sub, sessionId, handoffs) : [];
        const directAnswerSource = `jarvis-answer:${jobId}`;
        // An explicit "show me a diagram" request wins; otherwise the deterministic default picker
        // gives a structured direct answer a fitting visual. Acks and plain prose stay text-only.
        const directVisualSpec = visualSpecForDirectRequest(directives, message, directAnswerSource)
          ?? (!directives.hadHandoffFence && handoffs.length === 0
            ? inferVisualSpec({ answer: cleanAnswer, request: message }) ?? undefined
            : undefined);
        const directVisual = directVisualSpec
          ? await createOptionalJarvisVisual(visualResponseService, sub, {
              factLocked: true,
              sourceSurface: 'jarvis-direct',
              sourceSessionId: sessionId,
              sourceJobId: jobId,
              request: message,
              answer: cleanAnswer,
              visualSpec: directVisualSpec,
              sources: [{ type: 'agent', id: directAnswerSource, label: 'Authoritative Jarvis answer' }],
            })
          : undefined;
        // The exact visual reference lives beside the authoritative text so history/replay never
        // asks the model to rebuild it. Renderer/persistence failure leaves this as a normal answer.
        await persistJarvisTurn(ctx, sessionId, 'assistant', cleanAnswer, directVisual ? { visual: directVisual } : undefined);
        await markJarvisSessionTaskStatus(ctx, sessionId, 'active');
        const j = askJobs.get(jobId);
        askJobs.set(jobId, {
          sub, label, taskId: sessionId, kind: 'chat', status: 'done', createdAt: j?.createdAt ?? Date.now(), finishedAt: Date.now(),
          result: { answer: cleanAnswer, routed: [], handoffs: [], dispatched, ...(directVisual ? { visual: directVisual } : {}) },
        });
      } catch (err) {
        logger.error({ err }, 'jarvis ask failed');
        await markJarvisSessionTaskStatus(ctx, sessionId, 'failed');
        const j = askJobs.get(jobId);
        askJobs.set(jobId, { sub, label, taskId: sessionId, kind: 'chat', status: 'error', error: (err as Error).message, createdAt: j?.createdAt ?? Date.now(), finishedAt: Date.now() });
      }
    })();
    res.status(202).json({ jobId, sessionId, chatTicketId });
  });

  /** POST /thread/close — { sessionId } → complete this thread's chat-ticket (X on the summary
   *  bubble / End chat). Idempotent; caller-scoped via the in-memory thread map. */
  router.post('/thread/close', async (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const sessionId = String((req.body as { sessionId?: string })?.sessionId || '').trim();
    const key = sessionId ? threadTicketKey(sub, sessionId) : '';
    if (key) pendingWeatherClarifications.delete(key);
    const ticketId = key ? threadTickets.get(key) : undefined;
    if (!ticketId) { res.json({ ok: true, closed: false }); return; }
    try {
      await ctx.ticketService.updateStatus(ticketId, 'complete' as never);
      threadTickets.delete(key);
      res.json({ ok: true, closed: true });
    } catch (err) {
      logger.error({ err, sessionId }, 'jarvis thread close failed');
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** GET /ask/result?jobId — status for one job. PERSISTENT (not one-shot) so the shelf can
   *  re-open a finished item. Caller-scoped. */
  router.get('/ask/result', (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const job = askJobs.get(String(req.query.jobId || ''));
    if (!job || job.sub !== sub) { res.json({ status: 'expired' }); return; }
    if (job.status === 'pending') { res.json({ status: 'pending', label: job.label }); return; }
    if (job.status === 'error') { res.json({ status: 'error', error: job.error, label: job.label, taskId: job.taskId }); return; }
    res.json({ status: 'done', label: job.label, taskId: job.taskId, ...job.result });
  });

  /** GET /ask/jobs — the caller's session-manager shelf: every non-expired request + its status. */
  router.get('/ask/jobs', (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    gcAskJobs();
    // The shelf is the WORK QUEUE — handed-off background items only. Chat turns are answered
    // inline and never belong on the shelf.
    const jobs = [...askJobs.entries()]
      .filter(([, j]) => j.sub === sub && j.kind === 'work')
      .map(([jobId, j]) => ({ jobId, label: j.label, status: j.status, taskId: j.taskId, createdAt: j.createdAt, finishedAt: j.finishedAt }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ jobs });
  });

  /** POST /ask/dismiss?jobId — clear a finished item off the shelf. */
  router.post('/ask/dismiss', (req: Request, res: Response) => {
    const sub = callerSub(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    const id = String((req.query.jobId || (req.body as { jobId?: string })?.jobId) || '');
    const job = askJobs.get(id);
    if (job && job.sub === sub) askJobs.delete(id);
    res.json({ ok: true });
  });

  return router;
}
