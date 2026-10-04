/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Extract the existing Jarvis ticket-linked shelf read/projection/return pipeline, admitting linked tickets before any projection or return effect and logging its failure envelope at ERROR.
 */
import type { Request, RequestHandler } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { InternalTicket } from '@/entities/ticket';
import { deriveTicketEscalationDetail } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type { VisualResponseService } from '@/features/visual-response';
import { getJarvisBriefingDelivery } from './jarvis-briefing-delivery';
import { filterJarvisResultRows, hasProtectedJarvisSource } from './jarvis-result-access';
import { maskPendingComplexSummaries, returnProtectedComplexSummaries, repairCompletedTaskTableVisuals } from './jarvis-orchestrator';
import { mapJarvisTaskStatusFromTicketStatus, jarvisFailureNoteForTicketStatus, returnFailedComplexTasks,
  type JarvisFailedTaskCandidate, storedVisual, storedFiles } from './jarvis-task-store';
import { createJarvisTicketReadAccess, readJarvisComplexTickets } from './jarvis-ticket-read-access';

const logger = createChildLogger({ module: 'jarvis-routes' });

/** @description Existing durable shelf fields; both the direct SQL source and registered briefing source use this shape. */
interface ShelfRow {
  id: string; user_sub?: string; principal_issuer?: string | null; session_id?: string | null;
  title: string; status: string; result: string | null; error: string | null; kind: string; ticket_id: string | null;
  visual?: unknown; files?: unknown; delivered?: boolean; created_at?: string | Date; finished_at?: string | Date | null;
  briefing?: unknown;
}

/** @description Read the same bounded owner shelf or registered briefing source, preserving existing result filtering.
 * @param ctx Existing pool and task authorities. @param sub Current caller. @param req Verified request.
 * @param actor Current actor resolver. @returns Readable durable rows before ticket-linked projection.
 */
async function readShelf(ctx: AppContext, sub: string, req: Request,
  actor: (req: Request) => Promise<AuthorizationActor>): Promise<ShelfRow[]> {
  let rows = (await ctx.pool.query<ShelfRow>(
    `SELECT id, user_sub, session_id, briefing_source_id, principal_issuer, title, status, result, error, kind, ticket_id, visual, files, delivered, created_at, finished_at
       FROM jarvis_tasks WHERE user_sub = $1 ORDER BY created_at DESC LIMIT 50`, [sub])).rows;
  const briefings = getJarvisBriefingDelivery();
  if (briefings) rows = await briefings.service.listTasks(sub, await briefings.resolveActor(req), 50) as ShelfRow[];
  return filterJarvisResultRows(ctx, sub, rows, () => actor(req));
}

/** @description Project the existing shelf envelope from admitted records, collecting only admitted terminal failures.
 * @param rows Already-readable linked/ordinary rows. @param tickets Only admitted linked tickets.
 * @returns Existing response fields and failure candidates; no persistence runs here.
 */
function projectShelf(rows: readonly ShelfRow[], tickets: ReadonlyMap<string, InternalTicket>) {
  const failures: JarvisFailedTaskCandidate[] = [];
  const tasks = rows.map(r => {
    let status = r.status, error = r.error;
    if (r.kind === 'complex' && r.ticket_id && tickets.has(r.ticket_id)) {
      const ts = String(tickets.get(r.ticket_id)!.status);
      status = mapJarvisTaskStatusFromTicketStatus(ts);
      if (!error) error = jarvisFailureNoteForTicketStatus(ts);
      if (status === 'error') failures.push({ id: r.id, kind: r.kind, ticketId: r.ticket_id,
        ticketStatus: ts, storedStatus: String(r.status || ''), createdAt: r.created_at });
    }
    const visual = storedVisual({ visual: r.visual }), files = storedFiles(r.files);
    return { id: r.id, title: r.title, status, result: r.result, error, kind: r.kind, ticketId: r.ticket_id,
      delivered: r.delivered === true, createdAt: r.created_at, finishedAt: r.finished_at,
      ...(visual ? { visual } : {}), ...(r.briefing ? { briefing: r.briefing } : {}), ...(files.length ? { files } : {}) };
  });
  return { tasks, failures };
}
type ShelfTask = ReturnType<typeof projectShelf>['tasks'][number];

/** @description Preserve the existing ordinary/protected success halves and bounded visual repair after admission.
 * @param ctx Existing services. @param sub Current owner. @param rows Admitted shelf rows. @param tasks Existing projections.
 * @param visual Existing visual service. @param actor Current actor callback. @returns Resolves after original return effects.
 */
async function returnShelf(ctx: AppContext, sub: string, rows: readonly ShelfRow[], tasks: ShelfTask[],
  visual: VisualResponseService, actor: () => Promise<AuthorizationActor>): Promise<void> {
  const ordinary: ShelfTask[] = [], protectedTasks: ShelfTask[] = [];
  const sessions = new Map(rows.map(row => [row.id, row.session_id]));
  for (const task of tasks) {
    if (!await hasProtectedJarvisSource(ctx, [task.id, task.ticketId, sessions.get(task.id)].filter((id): id is string => Boolean(id)))) ordinary.push(task);
    else protectedTasks.push(task);
  }
  await maskPendingComplexSummaries(ctx, sub, ordinary);
  await returnProtectedComplexSummaries(ctx, sub, protectedTasks, sessions, actor);
  await repairCompletedTaskTableVisuals(ctx, visual, sub, ordinary);
}

/** @description The extracted GET /tasks handler: deny unreadable ticket contributions before any count/projection/return effect.
 * @param ctx Existing services. @param visual Existing visual service. @param caller Existing canonical Jarvis subject callback.
 * @param actor Existing current actor callback. @returns Request handler with the original empty-on-failure envelope.
 */
export function createJarvisTicketShelfHandler(ctx: AppContext, visual: VisualResponseService,
  caller: (req: Request) => string | null, actor: (req: Request) => Promise<AuthorizationActor>): RequestHandler {
  return async (req, res) => {
    const sub = caller(req);
    if (!sub) { res.status(401).json({ error: 'not_authenticated' }); return; }
    try {
      const source = await readShelf(ctx, sub, req, actor);
      const linked = await readJarvisComplexTickets(ctx, sub, source, createJarvisTicketReadAccess(ctx, req).canRead);
      const { tasks, failures } = projectShelf(linked.rows, linked.tickets);
      await returnFailedComplexTasks(ctx, sub, failures, new Map(failures.map(task => [task.ticketId ?? '',
        deriveTicketEscalationDetail(null, linked.tickets.get(task.ticketId ?? '')?.metadata)])));
      await returnShelf(ctx, sub, linked.rows, tasks, visual, () => actor(req));
      const visible = new Set((await filterJarvisResultRows(ctx, sub, linked.rows, () => actor(req))).map(row => row.id));
      res.json({ tasks: tasks.filter(task => visible.has(task.id)) });
    } catch (err) { logger.error({ err }, 'jarvis tasks failed'); res.json({ tasks: [] }); }
  };
}
