/**
 * Jarvis durable task store — the per-user jarvis_tasks table (batched work + results that survive a
 * restart, independent of the in-memory askJobs shelf and the ticket lifecycle) plus the conversation
 * turn-persistence and stored-visual validation helpers.
 *
 * Extracted from jarvis-routes.ts (2026-07-18, ADR-050 route decomposition). All pure DB / validation
 * work — no LLM, no orchestration. Behaviour unchanged.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: ensureJarvisSchema / saveTaskPending / finishTask / findJarvisTaskSessionId / buildOpenWorkBlock / persistJarvisTurn / markJarvisSessionTaskStatus / mapJarvisTaskStatusFromTicketStatus / storedVisual (route decomposition, no behaviour change).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | jarvisFailureNoteForTicketStatus: an escalated/cancelled ticket left the shelf row's error column NULL, so a failed multi-app plan rendered as status 'error' with no message. Say the run stopped — never summarize an outcome that does not exist.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | OPEN WORK results carry their AGE and are scoped to their own task. Live verification on the gsquared staging box: with no dates and a preamble commanding "read the RESULT and report it", Jarvis quoted a month-old demo-era CRM pull as the current pipeline ("0 in docs out, 4 opportunities" against a live 473/7/2) even after the catalog freshness rule shipped — the two guidances conflicted and this one won. Now they agree: a result answers questions about that task; current-state questions file a fresh handoff.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Persist captured deliverables on the task (files JSONB) so a finished task still offers its download after a reload, not only in the reply that happened to be on screen. Reset files alongside result/visual on re-file: a task re-run under the same id must never surface the previous run's links.
 *
 * @module jarvis-task-store
 */

import type { AppContext } from '@/app/composition/app-context';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';
import { type TaskStatus } from '@/shared/types';
import {
  VISUAL_RESPONSE_KINDS,
  type VisualResponseArtifact,
} from '@/features/visual-response';
import { createChildLogger } from '@/shared/logger';
import type { CapturedFile } from './jarvis-deliverable-files';

const logger = createChildLogger({ module: 'jarvis-task-store' });

// ── Durable Tasks list ──────────────────────────────────────────────────────
// A per-user table so a returning user sees their batched work + results, independent of the
// in-memory askJobs (session-scoped + GC'd) and the ticket lifecycle. (Conversation turns persist
// separately via ctx.messageStore — see persistJarvisTurn below.)

let jarvisSchemaReady = false;
/** @description Ensures the jarvis_tasks table exists (idempotent, once per process). */
export async function ensureJarvisSchema(pool: AppContext['pool']): Promise<void> {
  if (jarvisSchemaReady) return;
  try {
    await runRuntimeSchemaBootstrap({
      pool,
      moduleName: 'jarvis routes',
      statements: [
        `CREATE TABLE IF NOT EXISTS jarvis_tasks (
          id TEXT PRIMARY KEY,
          user_sub TEXT NOT NULL,
          session_id TEXT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          result TEXT,
          error TEXT,
          kind TEXT DEFAULT 'simple',
          ticket_id TEXT,
          visual JSONB,
          delivered BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          finished_at TIMESTAMPTZ,
          summarize_started_at TIMESTAMPTZ
        )`,
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT \'simple\'',
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS ticket_id TEXT',
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS visual JSONB',
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT FALSE',
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS files JSONB',
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS summarize_started_at TIMESTAMPTZ',
        'CREATE INDEX IF NOT EXISTS idx_jarvis_tasks_user ON jarvis_tasks (user_sub, created_at DESC)',
      ],
      requirements: [
        {
          table: 'jarvis_tasks',
          columns: [
            'id',
            'user_sub',
            'session_id',
            'title',
            'status',
            'result',
            'error',
            'kind',
            'ticket_id',
            'visual',
            'delivered',
            'files',
            'created_at',
            'finished_at',
            'summarize_started_at',
          ],
        },
      ],
    });
    jarvisSchemaReady = true;
  } catch (err) {
    logger.warn({ err }, 'jarvis: tasks schema bootstrap deferred');
  }
}

/** @description Records a new work task. kind 'complex' = filed with the PM/swarm (status follows
 *  the linked ticket); 'simple' = Jarvis does it (status follows finishTask). */
export async function saveTaskPending(
  pool: AppContext['pool'], id: string, sub: string, sessionId: string, title: string,
  kind: 'simple' | 'complex' = 'simple', ticketId?: string,
): Promise<void> {
  const status = kind === 'complex' ? 'queued' : 'pending';
  try {
    await pool.query(
      `INSERT INTO jarvis_tasks (id, user_sub, session_id, title, status, kind, ticket_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET title = $4, status = $5, kind = $6, ticket_id = COALESCE($7, jarvis_tasks.ticket_id), error = NULL, result = NULL, visual = NULL, files = NULL, finished_at = NULL`,
      [id, sub, sessionId, title.slice(0, 200), status, kind, ticketId ?? null],
    );
  } catch (err) { logger.warn({ err }, 'jarvis: saveTaskPending failed'); }
}

/** @description Marks a work task done (with result) or errored — durable so it survives restarts.
 *  `files` are deliverables already copied into the OWNER's private folder by
 *  captureDeliverableFiles; storing them here is what lets a completed task still offer its
 *  download after a reload, rather than only in the reply that happened to be on screen. */
export async function finishTask(
  pool: AppContext['pool'],
  id: string,
  ok: boolean,
  payload: string,
  visual?: VisualResponseArtifact,
  files?: CapturedFile[],
): Promise<void> {
  try {
    await pool.query(
      `UPDATE jarvis_tasks SET status = $2, ${ok ? 'result' : 'error'} = $3,
        visual = $4::jsonb, files = $5::jsonb, finished_at = NOW() WHERE id = $1`,
      [
        id, ok ? 'done' : 'error', (payload || '').slice(0, 20000),
        visual ? JSON.stringify(visual) : null,
        files && files.length ? JSON.stringify(files) : null,
      ],
    );
  } catch (err) { logger.warn({ err }, 'jarvis: finishTask failed'); }
}

/** Resolve the original conversation so completed background work is durable in Discussion. */
export async function findJarvisTaskSessionId(
  ctx: Pick<AppContext, 'pool'>,
  sub: string,
  taskId: string,
): Promise<string | null> {
  try {
    const row = (await ctx.pool.query(
      'SELECT session_id FROM jarvis_tasks WHERE id = $1 AND user_sub = $2 LIMIT 1',
      [taskId, sub],
    )).rows[0] as { session_id?: string } | undefined;
    const sessionId = String(row?.session_id || '').trim();
    return /^[\w.-]{6,180}$/.test(sessionId) ? sessionId : null;
  } catch (err) {
    logger.warn({ err, taskId }, 'jarvis: task discussion lookup failed');
    return null;
  }
}

/**
 * @description Builds the OPEN WORK block injected ahead of each message: the user's recent tasks
 * WITH their results (from the durable jarvis_tasks store), so Jarvis can (a) update an in-flight item
 * instead of duplicating, and crucially (b) READ a finished result and report it directly when the
 * user asks — instead of saying "I don't have it" and re-filing. Async (DB-backed).
 * @returns A text block, or '' when the user has no recent work.
 */
export async function buildOpenWorkBlock(ctx: AppContext, sub: string): Promise<string> {
  try {
    const rows = (await ctx.pool.query(
      `SELECT id, title, status, kind, result, created_at FROM jarvis_tasks WHERE user_sub = $1 ORDER BY created_at DESC LIMIT 8`,
      [sub],
    )).rows as Array<{ id: string; title: string; status: string; kind: string; result: string | null; created_at?: string | Date }>;
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      // The age is part of the record: without it a month-old demo-era pull read exactly like
      // this morning's, and Jarvis quoted it as the current pipeline (2026-09-04, gsquared).
      const ageDays = r.created_at ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000) : null;
      const age = ageDays == null ? '' : ageDays <= 0 ? ' (today)' : ageDays === 1 ? ' (1 day ago)' : ` (${ageDays} days ago)`;
      if (r.status === 'done' && r.result && r.result.trim()) {
        // Include the actual result so Jarvis can report it. Cap so the prompt stays bounded.
        return `- [${r.id}] ${r.title} — DONE${age}. RESULT:\n${r.result.trim().slice(0, 1500)}`;
      }
      const live = (r.status === 'queued' || r.status === 'summarizing' || r.status === 'pending') ? 'in progress' : r.status;
      return `- [${r.id}] ${r.title} — ${live}${age}`;
    });
    return [
      'OPEN WORK — your recent tasks. If the user asks about ONE OF THESE TASKS, read its RESULT',
      'below and report it directly in your voice (rich if it helps) — never say you don\'t have it,',
      'and never re-file a task that is already DONE. To continue/refine an in-progress item,',
      'update it by its id. SCOPE: each RESULT is a record of that past task at its stated age —',
      'it is NOT the current state of any app or dataset. For a question about current data',
      '(counts, stages, what is in a list right now), file a fresh handoff to the owning domain',
      'instead of quoting an old result as today\'s numbers.',
      ...lines,
    ].join('\n');
  } catch (err) {
    logger.warn({ err }, 'jarvis: buildOpenWorkBlock failed');
    return '';
  }
}

/**
 * @description Persist one chat turn under the thread's sessionId so a previous conversation can be
 * replayed via GET /api/:taskId/messages (the surface's "Conversations" resume). The message store
 * is Postgres-backed (chat_messages) whenever a DB is present — it is here ("persistence mode
 * enabled") — so turns persist DURABLY across restarts; it falls back to memory only with no DB.
 * Best-effort: a failure never blocks the chat.
 * @param ctx - Application context containing the durable message and task stores.
 * @param taskId - Jarvis conversation/session identifier.
 * @param role - Speaker role for this turn.
 * @param text - Authoritative text retained for replay and accessibility.
 * @param metadata - Optional structured response metadata, including a persisted visual reference.
 * @returns A promise that resolves after best-effort persistence.
 */
export async function persistJarvisTurn(
  ctx: AppContext,
  taskId: string,
  role: 'user' | 'assistant',
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const body = String(text || '').trim();
  if (!body) return;
  try {
    await ctx.messageStore.save({ taskId, role, type: role === 'user' ? 'task' : 'say', text: body, contentBlocks: [], metadata } as never);
    await ctx.taskStore.incrementMessageCount(taskId);
    if (role === 'assistant') {
      await ctx.taskStore.incrementTurnCount(taskId, 1);
    }
  } catch (err) {
    logger.warn({ err, taskId }, 'jarvis saveTurn skipped (non-fatal)');
  }
}

/** @description Best-effort status update for the Jarvis session's chat_task row. */
export async function markJarvisSessionTaskStatus(ctx: AppContext, taskId: string, status: TaskStatus): Promise<void> {
  try {
    await ctx.taskStore.updateStatus(taskId, status);
  } catch (err) {
    logger.warn({ err, taskId, status }, 'jarvis task status update skipped (non-fatal)');
  }
}

/** @description Maps a linked ticket's status onto the Jarvis shelf's task status. */
export function mapJarvisTaskStatusFromTicketStatus(ticketStatus: string): string {
  // `customer_action` is terminal work with a usable result that now needs the user's next step
  // (for example, a checkout handoff or one successful owner in a partial multi-owner run).
  // Surface and summarize that durable completion instead of leaving the Jarvis shelf "running".
  if (ticketStatus === 'complete' || ticketStatus === 'customer_action') return 'done';
  if (ticketStatus === 'cancelled' || ticketStatus === 'escalated') return 'error';
  return 'running';
}

/**
 * @description The sentence a work item shows when its ticket ended badly. A ticket that escalates
 * (a multi-app plan step whose bot could not be reached, a graph run that failed) leaves the shelf
 * row's own `error` column NULL, because nothing wrote to it — so the surface used to render a
 * failed item as status 'error' with no message at all. The honest fix is to SAY the run did not
 * finish. It deliberately does not summarize or guess an outcome: there is no result to summarize,
 * and inventing one is exactly the fabrication the planner must never do.
 * @param ticketStatus - The linked ticket's terminal status.
 * @returns A user-facing failure line, or null when the status is not a failure.
 */
export function jarvisFailureNoteForTicketStatus(ticketStatus: string): string | null {
  if (ticketStatus === 'escalated') {
    return 'This one did not finish — a step failed and the run stopped there. Nothing was made up in its place; open the ticket for the details.';
  }
  if (ticketStatus === 'cancelled') {
    return 'This one was cancelled before it finished.';
  }
  return null;
}

/** @description Validates and returns persisted visual-artifact metadata, or undefined if it fails
 *  the bounded owner-scoped image contract. */
export function storedVisual(metadata: Record<string, unknown> | undefined): VisualResponseArtifact | undefined {
  const candidate = metadata?.visual;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const visual = candidate as Partial<VisualResponseArtifact>;
  const artifactId = typeof visual.artifactId === 'string' ? visual.artifactId : '';
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const dimensionsAreSafe = Number.isInteger(visual.width)
    && Number.isInteger(visual.height)
    && Number(visual.width) > 0
    && Number(visual.height) > 0
    && Number(visual.width) <= 16_384
    && Number(visual.height) <= 16_384;
  if (
    !uuidPattern.test(artifactId)
    || visual.type !== 'image'
    || visual.mimeType !== 'image/svg+xml'
    || typeof visual.kind !== 'string'
    || !(VISUAL_RESPONSE_KINDS as readonly string[]).includes(visual.kind)
    || typeof visual.alt !== 'string'
    || !visual.alt.trim()
    || visual.alt.length > 420
    || !dimensionsAreSafe
  ) return undefined;
  if (visual.url !== `/api/jarvis/visuals/${visual.artifactId}`) return undefined;
  return candidate as VisualResponseArtifact;
}

/** The only URL shape a captured deliverable may ever be offered under. Anchored, so a stored row
 *  cannot smuggle an absolute `https://…` (or a protocol-relative `//host/…`) into the download
 *  control and turn a task result into an off-site link the user would reasonably trust. */
const DOWNLOAD_URL_PREFIX = '/api/files/download?';

/**
 * @description Validate the `files` column before it is handed to a browser.
 *
 * The column is server-written, so this is defence in depth rather than a suspected hole — but it
 * is the difference between a malformed row rendering nothing and a malformed row rendering an
 * attacker-controlled link, and it costs one pass over at most five entries.
 *
 * @param raw - The parsed `files` JSONB value.
 * @returns The valid entries, or an empty array.
 */
export function storedFiles(raw: unknown): CapturedFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is CapturedFile => {
    if (!entry || typeof entry !== 'object') return false;
    const f = entry as Partial<CapturedFile>;
    return typeof f.name === 'string'
      && f.name.trim().length > 0
      && f.name.length <= 260
      && typeof f.downloadUrl === 'string'
      && f.downloadUrl.startsWith(DOWNLOAD_URL_PREFIX)
      && Number.isFinite(f.bytes)
      && Number(f.bytes) >= 0;
  }).slice(0, 5);
}
