/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Publish only a fixed completion notice for current exact owners of protected tasks whose configured authority proves no execution result; require its actual saved turn, preserve durable delivery state and keep notice rows outside private shelf projection.
 */
import type { Request } from 'express';
import type { AppContext } from '@/app/composition/app-context';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { RemoteApplicationSnapshot } from '@/shared/application-remote-execution';
import { createChildLogger } from '@/shared/logger';
import { getCaller, hasAuthenticatedUserIdentity } from '@/shared/middleware/authz';
import { getAuthenticatedPrincipalIssuer, GUEST_PRINCIPAL_ISSUER } from '@/shared/middleware/principal-issuer';
import { isGuestRequest } from '@/shared/middleware/guest-session';
import { getVerifiedWorkloadDelegation } from '@/features/security';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { isProtectedTaskWithoutResult, readProtectedTaskNoticeState, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { ensureSessionTask } from './jarvis-thread-tickets';
import { canReadJarvisSession, canStartJarvisSession } from './jarvis-result-access';
import { JARVIS_AGENT_ID } from './jarvis-orchestrator';

const logger = createChildLogger({ module: 'jarvis-completion-notice' });
/** @description Controller-authored status text; never a model response or stored private result. */
export const JARVIS_COMPLETION_NOTICE = 'The task completed, but carries no verifiable execution lineage for this protected result.';
/** @description Only durable binding/status fields may enter the notice decision. */
export interface CompletionNoticeRow {
  id: string; user_sub?: string; principal_issuer?: string | null; session_id?: string | null;
  ticket_id: string | null; status: string; kind: string; result: string | null; delivered?: boolean;
}
type ActorResolver = () => Promise<AuthorizationActor>;
type NoticeSource = { actor: AuthorizationActor; agentId: string; app: string; snapshot: RemoteApplicationSnapshot;
  runtime: NonNullable<AppContext['applicationAuthorization']> };
/** @description Notice disposition is separate from admission to private result projection. */
export interface CompletionNoticeDisposition { withheld: Set<string>; completed: string[] }

/** @description Compare every immutable installed generation field. @param a Initial snapshot. @param b Current snapshot. @returns Exact equality. */
function sameSnapshot(a: RemoteApplicationSnapshot, b: RemoteApplicationSnapshot | null): boolean {
  return !!b && a.app === b.app && a.source === b.source && a.catalogRevision === b.catalogRevision && a.generation === b.generation;
}

/** @description Require a current verified human principal for this notice only. @param req Authenticated request. @param actor Current actor. @returns Exact identity admission. */
function noticeIdentity(req: Request, actor: AuthorizationActor): boolean {
  const issuer = getAuthenticatedPrincipalIssuer(req);
  const oidc = (req as Request & { oidc?: { idToken?: string } }).oidc;
  return hasAuthenticatedUserIdentity(req) && !isGuestRequest(req) && issuer !== GUEST_PRINCIPAL_ISSUER
    && !getVerifiedWorkloadDelegation(req) && oidc?.idToken !== 'cli-token'
    && actor.isActive && !!issuer && actor.issuer === issuer && actor.sub === getCaller(req).sub;
}

/** @description Check real source records and current named bot rights without reading any work product.
 * @param ctx Canonical authorities. @param req Verified request. @param row Durable source binding. @param actor Current resolver.
 * @returns Strict source capability for a fixed status notice only, otherwise null; storage failures propagate.
 */
async function noticeSource(ctx: AppContext, req: Request, row: CompletionNoticeRow, actor: ActorResolver): Promise<NoticeSource | null> {
  const current = await actor();
  if (!noticeIdentity(req, current) || row.user_sub !== current.sub || row.principal_issuer !== current.issuer
    || row.kind !== 'complex' || row.status !== 'done' || !row.ticket_id || !/^[\w.-]{6,180}$/.test(row.session_id ?? '')
    || !row.id || row.id.length > 200 || ![null, '', JARVIS_COMPLETION_NOTICE].includes(row.result)) return null;
  const ticket = await ctx.ticketService.getTicket(row.ticket_id), task = await ctx.taskStore.get(row.ticket_id);
  if (!ticket || ticket.ticketId !== row.ticket_id || ticket.status !== 'complete' || ticket.ownerSub !== current.sub
    || readOwnerPrincipalIssuer(ticket.metadata) !== current.issuer || !task || task.taskId !== row.ticket_id
    || task.ownerSub !== current.sub || readOwnerPrincipalIssuer(task.metadata) !== current.issuer
    || !task.agentId || !await isProtectedTaskWithoutResult(task)) return null;
  const runtime = ctx.applicationAuthorization;
  if (!runtime) return null;
  const app = runtime.owner('bots', task.agentId), snapshot = app ? runtime.snapshot(app) : null;
  if (!app || !snapshot) return null;
  const decision = await runtime.authorize(current, { app, kind: 'bots', operation: task.agentId });
  if (!decision.allowed || ctx.applicationAuthorization !== runtime || runtime.owner('bots', task.agentId) !== app
    || !sameSnapshot(snapshot, runtime.snapshot(app)) || !noticeIdentity(req, await actor())) return null;
  return { actor: current, agentId: task.agentId, app, snapshot, runtime };
}

/** @description Recheck a captured policy generation and exact principal after a yielding operation.
 * @param ctx Current composition. @param req Verified request. @param row Exact stored binding. @param actor Fresh resolver. @param initial Initial admission.
 * @returns Current status-only capability, with no fallback when policy changes.
 */
async function noticeStillCurrent(ctx: AppContext, req: Request, row: CompletionNoticeRow,
  actor: ActorResolver, initial: NoticeSource): Promise<boolean> {
  const current = await noticeSource(ctx, req, row, actor);
  return !!current && current.runtime === initial.runtime && current.app === initial.app && current.agentId === initial.agentId
    && current.actor.sub === initial.actor.sub && current.actor.issuer === initial.actor.issuer
    && sameSnapshot(initial.snapshot, current.snapshot);
}

/** @description Prepare only a canonical caller-owned conversation; race winners and read-back are checked.
 * @param ctx Canonical stores. @param req Verified request. @param row Binding. @param actor Fresh resolver. @param source Initial capability.
 * @returns Whether the actual conversation is readable by this current exact principal.
 */
async function noticeSession(ctx: AppContext, req: Request, row: CompletionNoticeRow, actor: ActorResolver,
  source: NoticeSource): Promise<boolean> {
  const sessionId = row.session_id!;
  if (row.result !== JARVIS_COMPLETION_NOTICE && await ensureSessionTask(ctx, source.actor.sub, source.actor.issuer,
    sessionId, 'Jarvis session', async () => await canStartJarvisSession(source.actor.sub, sessionId, JARVIS_AGENT_ID, actor)
      && await noticeStillCurrent(ctx, req, row, actor, source)) !== 'owned') return false;
  return await canReadJarvisSession(ctx, source.actor.sub, source.actor.issuer, sessionId, actor)
    && await noticeStillCurrent(ctx, req, row, actor, source);
}

/** @description Claim only the exact empty completed work row; no private cached result is overwritten.
 * @param ctx Durable shelf. @param row Exact binding. @param source Current capability. @returns Whether this request won the claim.
 */
async function claimNotice(ctx: AppContext, row: CompletionNoticeRow, source: NoticeSource): Promise<boolean> {
  const claimed = await ctx.pool.query(
    `UPDATE jarvis_tasks SET result=$6, finished_at=NOW()
       WHERE id=$1 AND user_sub=$2 AND principal_issuer=$3 AND ticket_id=$4 AND session_id=$5
         AND kind='complex' AND status='done' AND (result IS NULL OR result='') RETURNING id`,
    [row.id, source.actor.sub, source.actor.issuer, row.ticket_id, row.session_id, JARVIS_COMPLETION_NOTICE]);
  return Boolean(claimed.rowCount);
}

/** @description Save only the fixed checked notice; failed persistence remains observable, never reported as thread success.
 * @param ctx Canonical message/task stores. @param row Exact owned binding. @returns Resolves after each real persistence operation.
 */
async function saveNotice(ctx: AppContext, row: CompletionNoticeRow): Promise<void> {
  await ctx.messageStore.save({ taskId: row.session_id!, role: 'assistant', type: 'say', text: JARVIS_COMPLETION_NOTICE,
    contentBlocks: [], metadata: { sourceJarvisTaskId: row.id, sourceTicketId: row.ticket_id, completionNotice: true } });
  await ctx.taskStore.incrementMessageCount(row.session_id!);
  await ctx.taskStore.incrementTurnCount(row.session_id!, 1);
}

/** @description Verify the exact canonical saved fixed turn without projecting any private conversation content.
 * @param ctx Canonical stores. @param req Verified request. @param row Work binding. @param actor Current resolver. @param source Initial admission.
 * @returns Actual message witness only under current session/source rights; missing persistence is logged and withheld.
 */
async function noticeTurnSaved(ctx: AppContext, req: Request, row: CompletionNoticeRow,
  actor: ActorResolver, source: NoticeSource): Promise<boolean> {
  if (!await canReadJarvisSession(ctx, source.actor.sub, source.actor.issuer, row.session_id!, actor)
    || !await noticeStillCurrent(ctx, req, row, actor, source)) return false;
  const turns = await ctx.messageStore.getByTask(row.session_id!);
  if (!await canReadJarvisSession(ctx, source.actor.sub, source.actor.issuer, row.session_id!, actor)
    || !await noticeStillCurrent(ctx, req, row, actor, source)) return false;
  const saved = turns.some(turn => turn.taskId === row.session_id && turn.role === 'assistant' && turn.type === 'say'
    && turn.text === JARVIS_COMPLETION_NOTICE && turn.metadata.completionNotice === true
    && turn.metadata.sourceJarvisTaskId === row.id && turn.metadata.sourceTicketId === row.ticket_id);
  if (!saved) logger.error({ err: new Error('jarvis_completion_notice_turn_missing'), workId: row.id,
    ticketId: row.ticket_id, sessionId: row.session_id }, 'Jarvis claimed completion notice has no saved turn; response withheld');
  return saved;
}

/** @description Publish or recognize one fixed notice after canonical current source and session checks.
 * @param ctx Services. @param req Verified request. @param row Binding. @param actor Current resolver.
 * @returns Successful/repeated notice id only; partial persistence faults propagate and produce no new response.
 */
async function completeNotice(ctx: AppContext, req: Request, row: CompletionNoticeRow, actor: ActorResolver): Promise<boolean> {
  const source = await noticeSource(ctx, req, row, actor);
  if (!source || !await noticeSession(ctx, req, row, actor, source)) return false;
  if (row.result === JARVIS_COMPLETION_NOTICE) return noticeTurnSaved(ctx, req, row, actor, source);
  if (!await claimNotice(ctx, row, source)) return false;
  if (!await canReadJarvisSession(ctx, source.actor.sub, source.actor.issuer, row.session_id!, actor)
    || !await noticeStillCurrent(ctx, req, row, actor, source)) return false;
  await saveNotice(ctx, row);
  return noticeTurnSaved(ctx, req, row, actor, source);
}

/** @description Intercept actual protected-empty/undetermined sources before private shelf admission.
 * @param ctx Authorities. @param req Verified request. @param rows Existing filtered source. @param actor Current resolver.
 * @returns Withheld source ids plus successful notices; positively unprotected or real-lineage sources keep their existing path.
 */
export async function returnJarvisCompletionNotices(ctx: AppContext, req: Request,
  rows: readonly CompletionNoticeRow[], actor: ActorResolver): Promise<CompletionNoticeDisposition> {
  const withheld = new Set<string>(), completed: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'complex' || row.status !== 'done' || !row.ticket_id) continue;
    try {
      const task = await ctx.taskStore.get(row.ticket_id);
      if (!task || !task.agentId && !Object.prototype.hasOwnProperty.call(task.metadata ?? {}, PROTECTED_RESULT_EXECUTIONS)) continue;
      const state = await readProtectedTaskNoticeState(task);
      if (state !== 'protected-empty' && row.result !== JARVIS_COMPLETION_NOTICE
        && !(state === 'durable-only' && !row.result)) continue;
      withheld.add(row.id);
      if (state === 'protected-empty' && await completeNotice(ctx, req, row, actor)) completed.push(row.id);
    } catch (err) {
      withheld.add(row.id);
      logger.error({ err, workId: row.id, ticketId: row.ticket_id }, 'Jarvis completion notice undetermined; row withheld');
    }
  }
  return { withheld, completed };
}

/** @description Rebuild only fixed status fields after all ordinary return effects and a final fresh durable/current-rights check.
 * @param ctx Authorities. @param req Verified request. @param ids Successful notice ids. @param actor Current resolver.
 * @returns Safe fixed DTOs, with no stored title/result/error/visual/files/briefing projection.
 */
export async function currentJarvisCompletionNotices(ctx: AppContext, req: Request, ids: readonly string[], actor: ActorResolver) {
  const notices: Array<{ id: string; title: string; status: string; kind: string; result: string; delivered: boolean }> = [];
  for (const id of ids) {
    try {
      const row = (await ctx.pool.query<CompletionNoticeRow>(
        `SELECT id,user_sub,principal_issuer,session_id,ticket_id,status,kind,result,delivered FROM jarvis_tasks
           WHERE id=$1 AND user_sub=$2 AND principal_issuer=$3`, [id, getCaller(req).sub, getAuthenticatedPrincipalIssuer(req)])).rows[0];
      if (!row || row.result !== JARVIS_COMPLETION_NOTICE) continue;
      const source = await noticeSource(ctx, req, row, actor);
      if (!source || !await noticeSession(ctx, req, row, actor, source)
        || !await noticeTurnSaved(ctx, req, row, actor, source)) continue;
      notices.push({ id: row.id, title: 'Task completed', status: 'done', kind: 'complex',
        result: JARVIS_COMPLETION_NOTICE, delivered: row.delivered === true });
    } catch (err) { logger.error({ err, workId: id }, 'Jarvis current completion notice unavailable; response withheld'); }
  }
  return notices;
}
