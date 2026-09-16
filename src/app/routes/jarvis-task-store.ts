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
 * 7 | maintainer@emeraldcoastsystemsgroup.com | Atomically admit completed registered briefings without an ordinary-task fallback or stranded pending row.
 * 6 | maintainer@emeraldcoastsystemsgroup.com | Scope durable work rows to verified issuer and withhold protected source text from automatic prompts without derived lineage.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from jarvis-routes.ts: ensureJarvisSchema / saveTaskPending / finishTask / findJarvisTaskSessionId / buildOpenWorkBlock / persistJarvisTurn / markJarvisSessionTaskStatus / mapJarvisTaskStatusFromTicketStatus / storedVisual (route decomposition, no behaviour change).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | jarvisFailureNoteForTicketStatus: an escalated/cancelled ticket left the shelf row's error column NULL, so a failed multi-app plan rendered as status 'error' with no message. Say the run stopped — never summarize an outcome that does not exist.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Stale DONE results are WITHHELD from the block (title + age stay): the fourth live iteration proved guidance cannot stop the model quoting numbers it can see - the month-old demo-era pull kept winning however it was framed. Deterministic beats instruction: past STALE_RESULT_DAYS the result text simply is not in the context.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | OPEN WORK results carry their AGE and are scoped to their own task. Live verification on the gsquared staging box: with no dates and a preamble commanding "read the RESULT and report it", Jarvis quoted a month-old demo-era CRM pull as the current pipeline ("0 in docs out, 4 opportunities" against a live 473/7/2) even after the catalog freshness rule shipped — the two guidances conflicted and this one won. Now they agree: a result answers questions about that task; current-state questions file a fresh handoff.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Persist captured deliverables on the task (files JSONB) so a finished task still offers its download after a reload, not only in the reply that happened to be on screen. Reset files alongside result/visual on re-file: a task re-run under the same id must never surface the previous run's links.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | The return leg's failure half: finishFailedComplexTask/returnFailedComplexTasks claim a dead ticket's shelf row with one guarded UPDATE and persist the honest sentence into the Jarvis thread. finishTask is called only from success paths, so a ticket that escalated left its row at 'queued' with a NULL error forever and buildOpenWorkBlock injected it into every turn as "in progress" — two live rows did exactly that for 18 hours (2026-09-15). 'dead_letter' joins the error branch of the ticket-status map: it is terminal and read 'in progress' forever.
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
import type { TicketEscalationDetail } from '@/entities/ticket';
import type { CapturedFile } from './jarvis-deliverable-files';
import { getJarvisBriefingDelivery } from './jarvis-briefing-delivery';
import { getRequestIdentity } from '@/shared/services/database/request-identity';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { filterJarvisResultRows, hasProtectedJarvisSource } from './jarvis-result-access';

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
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS briefing_source_id TEXT',
        'ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS principal_issuer TEXT',
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
            'briefing_source_id',
            'principal_issuer',
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
): Promise<boolean> {
  const status = kind === 'complex' ? 'queued' : 'pending';
  try {
    const briefings = getJarvisBriefingDelivery();
    if (briefings) {
      const accepted = await briefings.service.publish(sub, sessionId, async (client, issuer, sourceId) => {
        const result = await client.query(`INSERT INTO jarvis_tasks
          (id,user_sub,session_id,title,status,kind,ticket_id,briefing_source_id,principal_issuer) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT(id) DO NOTHING RETURNING id`,
        [id,sub,sessionId,title.slice(0,200),status,kind,ticketId ?? null,sourceId,issuer]);
        return Boolean(result.rowCount);
      });
      if (accepted !== undefined) return accepted;
    }
    const identity = getRequestIdentity();
    const issuer = identity?.sub === sub ? identity.principalIssuer ?? null : null;
    const result = await pool.query(
      `INSERT INTO jarvis_tasks (id, user_sub, session_id, title, status, kind, ticket_id, principal_issuer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET title = $4, status = $5, kind = $6, ticket_id = COALESCE($7, jarvis_tasks.ticket_id), error = NULL, result = NULL, visual = NULL, files = NULL, finished_at = NULL
       WHERE jarvis_tasks.user_sub=EXCLUDED.user_sub AND jarvis_tasks.principal_issuer IS NOT DISTINCT FROM EXCLUDED.principal_issuer`,
      [id, sub, sessionId, title.slice(0, 200), status, kind, ticketId ?? null, issuer],
    );
    return result.rowCount !== 0;
  } catch (err) { logger.warn({ err }, 'jarvis: saveTaskPending failed'); return false; }
}

/**
 * @description Atomically store one completed registered briefing under current exact-principal rights and preferences.
 * @param id - Producer-owned deterministic completion identifier; an existing row is never replaced.
 * @param sub - Recorded owner subject requiring unambiguous current issuer resolution.
 * @param sessionId - Permanently registered producer session; ordinary sessions are refused.
 * @param title - Human-readable description of the recorded completion.
 * @param payload - Existing result, not a request to generate or execute work.
 * @returns True only after the completed row commits; unavailable, suppressed and duplicate writes return false.
 */
export async function saveCompletedBriefing(
  id: string, sub: string, sessionId: string, title: string, payload: string,
): Promise<boolean> {
  if (![id, sub, sessionId, title, payload].every(value => typeof value === 'string' && value.trim())) return false;
  if (id.length > 200 || sub.length > 512 || sessionId.length > 180) return false;
  const runtime = getJarvisBriefingDelivery();
  if (!runtime) return false;
  try {
    const accepted = await runtime.service.publish(sub, sessionId, async (client, issuer, sourceId) => {
      const result = await client.query(`INSERT INTO jarvis_tasks
        (id,user_sub,session_id,title,status,kind,result,finished_at,briefing_source_id,principal_issuer)
        VALUES($1,$2,$3,$4,'done','simple',$5,NOW(),$6,$7)
        ON CONFLICT(id) DO NOTHING RETURNING id`,
      [id, sub, sessionId, title.slice(0, 200), payload.slice(0, 20000), sourceId, issuer]);
      return Boolean(result.rowCount);
    });
    return accepted === true;
  } catch (err) { logger.warn({ err }, 'jarvis: completed briefing admission failed'); return false; }
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
/** DONE results older than this leave the auto-injected prompt (title + age remain). */
const STALE_RESULT_DAYS = 7;

async function automaticWorkRows<T extends { id: string; principal_issuer?: string | null; ticket_id?: string | null; session_id?: string | null }>(
  ctx: AppContext, sub: string, rows: T[],
): Promise<T[]> {
  const visible = await filterJarvisResultRows(ctx, sub, rows, async () => {
    const actor = getApplicationAuthorizationActor();
    if (actor) return actor;
    const issuer = getRequestIdentity()?.principalIssuer;
    const target = issuer ? await getJarvisBriefingDelivery()?.targetActor(sub, issuer) : null;
    if (!target) throw new Error('Jarvis result identity unavailable');
    return target;
  });
  const safe = [];
  for (const row of visible) if (!await hasProtectedJarvisSource(ctx, [row.id, row.ticket_id, row.session_id].filter((id): id is string => Boolean(id)))) safe.push(row);
  return safe;
}

export async function buildOpenWorkBlock(ctx: AppContext, sub: string): Promise<string> {
  try {
    let rows = (await ctx.pool.query(
      `SELECT id, user_sub, session_id, ticket_id, briefing_source_id, principal_issuer, title, status, kind, result, created_at FROM jarvis_tasks WHERE user_sub = $1 ORDER BY created_at DESC LIMIT 8`,
      [sub],
    )).rows as Array<{ id: string; session_id?: string; ticket_id?: string; briefing_source_id?: string; principal_issuer?: string; title: string; status: string; kind: string; result: string | null; created_at?: string | Date }>;
    const briefings = getJarvisBriefingDelivery();
    if (briefings) {
      const issuer = getRequestIdentity()?.principalIssuer;
      const actor = issuer ? await briefings.targetActor(sub, issuer) : null;
      rows = await briefings.service.listTasks(sub, actor, 8);
    }
    rows = await automaticWorkRows(ctx, sub, rows);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      // The age is part of the record: without it a month-old demo-era pull read exactly like
      // this morning's, and Jarvis quoted it as the current pipeline (2026-09-04, gsquared).
      const ageDays = r.created_at ? Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000) : null;
      const age = ageDays == null ? '' : ageDays <= 0 ? ' (today)' : ageDays === 1 ? ' (1 day ago)' : ` (${ageDays} days ago)`;
      if (r.status === 'done' && r.result && r.result.trim()) {
        // A stale result's TEXT never enters the prompt. Three guidance iterations on the
        // gsquared box proved the model quotes whatever numbers it can see, however framed -
        // the only reliable fix is that month-old numbers are not in the context at all. The
        // task stays listed (title + age) so 'show me that report' still resolves by id.
        if (ageDays != null && ageDays > STALE_RESULT_DAYS) {
          return `- [${r.id}] ${r.title} — DONE${age}. (result withheld as stale — for current data file a fresh handoff; the user can still ask for this task's result by name)`;
        }
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
  // `dead_letter` is the DLQ quarantine and it is TERMINAL (entities/ticket/types.ts) — the queue
  // never retries it and only an operator requeue releases it. Left out of this branch it fell
  // through to 'running', so a quarantined ticket's work item read "in progress" forever.
  if (ticketStatus === 'cancelled' || ticketStatus === 'escalated' || ticketStatus === 'dead_letter') return 'error';
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
  if (ticketStatus === 'dead_letter') {
    return 'This one stopped for good — it failed repeatedly and was quarantined for review. Nothing was made up in its place; open the ticket for the details.';
  }
  if (ticketStatus === 'cancelled') {
    return 'This one was cancelled before it finished.';
  }
  return null;
}

/**
 * A recorded failure reason is a CODE the swarm writes (`manifest_worker_dispatch_failed`,
 * `superadmin_required`, …), and this is the fixed code → plain-words map the returned sentence is
 * built from. Two rules hold it together.
 *
 * It is keyed on the CODE alone. The same transition also records a free-text `message` written by
 * whatever failed — the live 2026-09-15 pair carried `authorization_remote_execution_failed` — and
 * text that came out of a worker must never be echoed into a conversation turn, both because it is
 * an injection surface and because it is not a sentence anyone can read.
 *
 * And the sentences are fixed literals, never generated prose, for exactly the reason
 * jarvisFailureNoteForTicketStatus above is: there is no result to summarize here, and a model
 * asked to explain a failure it cannot see will invent one. An unrecognised code contributes
 * nothing and the honest terminal-status line still ships on its own.
 */
const JARVIS_FAILURE_REASON_SENTENCES: Readonly<Record<string, string>> = {
  manifest_worker_dispatch_failed: 'The app that owns this work would not accept the handoff.',
  manifest_worker_agent_unresolved: 'No bot is registered to do this kind of work yet.',
  multi_owner_dispatch_failed: 'Every app this was split across failed to take its part.',
  invalid_provider_intent: 'The request did not match what the connected service accepts.',
  superadmin_required: 'It needs an operator with higher privileges than the run had.',
  explicit_remote_target_unhandled: 'The remote machine it was addressed to never picked it up.',
  browser_submission_dispatch_failed: 'The browser step could not be started on the machine that runs it.',
  remote_execution_failed: 'The remote machine took the work and then failed part-way.',
  worker_bot_first_pass_failed: 'The bot working on it failed on its first pass.',
  worker_bot_revision_failed: 'The bot failed while revising its earlier answer.',
  reviewer_unavailable_deliverables_missing: 'The review step had nothing to review — the work produced no output.',
  incident_rca_pipeline_failed: 'The investigation pipeline failed before it reached a finding.',
  graph_workflow_definition_missing: 'The workflow it needs is not installed on this deployment.',
  graph_workflow_dispatch_failed: 'The workflow could not be started.',
  child_ticket_escalated: 'A step further down the plan failed, so the whole plan stopped.',
  routing_failed_max_retries_exhausted: 'Routing could not find a bot for it after repeated tries.',
  unspecified_escalation: 'The run stopped without recording why.',
  escalation_loop_poison: 'It failed the same way repeatedly and was quarantined.',
  max_dispatch_attempts_poison: 'It could not be handed off after repeated attempts and was quarantined.',
  unspecified_dead_letter: 'It was quarantined without recording why.',
};

/** Longest failure sentence that may enter a thread turn. */
const FAILURE_SENTENCE_LIMIT = 600;

/** At most this many dead tickets are returned to their threads per owner poll — the same bound
 *  repairCompletedTaskTableVisuals uses, so a backlog drains over a few polls instead of posting a
 *  burst of messages into several conversations at once. */
const FAILURE_RETURNS_PER_POLL = 3;

/** A failure note is never dated retroactively into a conversation older than this. Six live rows
 *  across four sessions qualified for the first flush and one of them was 15 days old; a note
 *  arriving under a two-week-old question reads as a new event, which it is not. Matches
 *  STALE_RESULT_DAYS above — past it, a work item is history, not an open thread. */
const FAILURE_RETURN_MAX_AGE_DAYS = STALE_RESULT_DAYS;

/**
 * @description Composes the one sentence a dead ticket returns with: the honest terminal-status
 * line, plus the plain-words half-sentence for the recorded reason CODE when there is one. Newlines
 * are collapsed and the whole thing is bounded before anything reaches a thread turn.
 * @param note - The fixed line for the ticket's terminal status.
 * @param detail - The recorded escalation detail, when the transition recorded one.
 * @returns A single bounded line of plain text.
 */
function jarvisFailureSentence(note: string, detail: TicketEscalationDetail | null): string {
  const extra = JARVIS_FAILURE_REASON_SENTENCES[detail?.reason ?? ''];
  return `${note}${extra ? ` ${extra}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, FAILURE_SENTENCE_LIMIT);
}

/**
 * @description The failure half of the return leg. A handed-off task whose ticket ended badly is
 * marked errored in the durable shelf AND told to the user in the thread they asked in — because
 * finishTask is only ever called from success paths, a ticket that escalated used to leave its row
 * at 'queued' with a NULL error indefinitely (two live rows sat that way for 18 hours on
 * 2026-09-15) while buildOpenWorkBlock injected both into every subsequent turn as "in progress".
 *
 * The guarded UPDATE is the once-only guard: the turn is persisted only when THIS call is the one
 * that moved the row, so a second poll adds no second message and no separate delivered/claim flag
 * is needed. A row a summarizer claimed less than three minutes ago is deliberately left alone —
 * finishTask carries no status guard of its own and would overwrite this 'error' straight back to
 * 'done' after the failure turn had already posted.
 *
 * @param ctx - App context: its pool owns the shelf row, its messageStore owns the thread.
 * @param sub - The owner the row must belong to; the UPDATE is scoped to it.
 * @param task - The shelf task, taken from the owner-filtered poll list.
 * @param ticketStatus - The linked ticket's terminal status.
 * @param detail - The recorded escalation detail, when the transition recorded one.
 * @returns True when this call claimed the row and wrote the thread turn.
 */
export async function finishFailedComplexTask(
  ctx: AppContext,
  sub: string,
  task: { id: string; kind: string; ticketId: string | null },
  ticketStatus: string,
  detail: TicketEscalationDetail | null,
): Promise<boolean> {
  if (task.kind !== 'complex' || !task.ticketId) return false;
  const note = jarvisFailureNoteForTicketStatus(ticketStatus);
  if (!note) return false;
  const sentence = jarvisFailureSentence(note, detail);
  try {
    const claimed = await ctx.pool.query(
      `UPDATE jarvis_tasks SET status = 'error', error = $3, finished_at = NOW()
        WHERE id = $1 AND user_sub = $2 AND status NOT IN ('error', 'done')
          AND (status <> 'summarizing' OR summarize_started_at IS NULL
               OR summarize_started_at < NOW() - INTERVAL '3 minutes')
        RETURNING id`,
      [task.id, sub, sentence],
    );
    if (!claimed.rowCount) return false;
    const sessionId = await findJarvisTaskSessionId(ctx, sub, task.id);
    if (sessionId) {
      await persistJarvisTurn(ctx, sessionId, 'assistant', sentence, {
        sourceJarvisTaskId: task.id,
        sourceTicketId: task.ticketId,
      });
    }
    logger.info({ taskId: task.id, ticketId: task.ticketId, ticketStatus, reason: detail?.reason ?? null },
      'jarvis: returned a terminal ticket failure to its thread');
    return true;
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'jarvis: finishFailedComplexTask failed');
    return false;
  }
}

/** One task the owner poll saw whose linked ticket has reached a terminal failure. `storedStatus`
 *  is the row's own durable status, so the per-poll budget is spent on rows that still need the
 *  return rather than on ones a previous poll already closed. */
export interface JarvisFailedTaskCandidate {
  id: string;
  kind: string;
  ticketId: string | null;
  ticketStatus: string;
  storedStatus: string;
  createdAt?: string | Date | null;
}

/**
 * @description Returns a bounded batch of dead tickets to their threads on one owner poll. Bounded
 * on two axes deliberately: at most FAILURE_RETURNS_PER_POLL rows move per poll so a backlog drains
 * over several polls instead of dropping a burst of messages into several conversations at once,
 * and a row older than FAILURE_RETURN_MAX_AGE_DAYS is skipped entirely rather than dating a
 * retroactive failure note into a conversation from two weeks ago.
 * @param ctx - App context (Postgres pool and message store).
 * @param sub - The polling owner; every row and turn is scoped to them.
 * @param candidates - Terminal-failure tasks from the owner-filtered poll list.
 * @param details - The recorded escalation detail per ticket id, read once from the tickets the
 *   poll already loaded so this adds no per-task query.
 * @param maximumReturns - Test seam; never raises the per-poll ceiling.
 * @returns How many rows this poll actually claimed and returned.
 */
export async function returnFailedComplexTasks(
  ctx: AppContext,
  sub: string,
  candidates: readonly JarvisFailedTaskCandidate[],
  details: ReadonlyMap<string, TicketEscalationDetail | null>,
  maximumReturns = FAILURE_RETURNS_PER_POLL,
): Promise<number> {
  const limit = Math.max(0, Math.min(FAILURE_RETURNS_PER_POLL, Math.floor(maximumReturns)));
  const oldest = Date.now() - FAILURE_RETURN_MAX_AGE_DAYS * 86400000;
  let returned = 0;
  for (const candidate of candidates) {
    if (returned >= limit) break;
    if (candidate.storedStatus === 'error' || candidate.storedStatus === 'done') continue;
    const createdAt = candidate.createdAt ? new Date(candidate.createdAt).getTime() : Number.NaN;
    if (Number.isFinite(createdAt) && createdAt < oldest) continue;
    if (await finishFailedComplexTask(ctx, sub, candidate, candidate.ticketStatus, details.get(candidate.ticketId ?? '') ?? null)) {
      returned += 1;
    }
  }
  return returned;
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
