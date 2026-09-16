/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard Jarvis cached and durable result sources using exact issuer identity and current protected execution lineage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Report an access check that could not be DETERMINED instead of silently answering "denied". Every guard here still fails closed  the returns are unchanged  but a thrown store/authority error used to be indistinguishable from a real denial with nothing logged, which is how a Jarvis ownership fault read as an empty history for three days. Each catch now logs at ERROR with the error, its stack and the task it was deciding.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Give the automatic derived-answer path the lineage it was withheld for. recordDerivedJarvisResultLineage re-asserts the owner's current rights on the SOURCE ticket, binds every contributing execution to the conversation and shelf task the summary will be written to, and stamps that lineage on them - so the derived answer answers to exactly the same authority as the work product it came from. canReadDerivedJarvisSources is the re-check the background summarizer runs against the captured actor before it publishes anything. Nothing here widens who may read: the destinations inherit the source's checks, and a caller who cannot read the source records nothing.
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { canReadProtectedResult, hasProtectedTaskResults, recordDerivedProtectedResult, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { persistProtectedResultTask } from './protected-result-persistence';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

const logger = createChildLogger({ module: 'jarvis-result-access' });

/** @description Durable Jarvis work row with its authoritative result and conversation references. */
export interface JarvisResultRow {
  id: string; user_sub?: string; principal_issuer?: string | null; ticket_id?: string | null; session_id?: string | null;
}

/**
 * @description Require exact current owner and issuer for a Jarvis conversation or cached job.
 * @param ctx - Canonical task store.
 * @param sub - Authenticated caller subject.
 * @param issuer - Verified issuer, or null only for legacy test/controller compatibility.
 * @param taskId - Actual conversation task.
 * @param resolveActor - Existing server-owned actor resolver.
 * @returns Whether current identity and every protected dependency permit this result.
 */
export async function canReadJarvisSession(ctx: AppContext, sub: string, issuer: string | null, taskId: string,
  resolveActor: () => Promise<AuthorizationActor>): Promise<boolean> {
  try {
    const task = await ctx.taskStore.get(taskId);
    if (!task || task.ownerSub !== sub) return false;
    const storedIssuer = readOwnerPrincipalIssuer(task.metadata);
    if (storedIssuer ? storedIssuer !== issuer : Boolean(issuer && ctx.applicationAuthorization)) return false;
    return canReadProtectedResult(task, resolveActor);
  } catch (err) {
    // Fail closed, but never silently: a thrown store/authority error is NOT a denial, and a
    // caller that renders `false` as an empty history would otherwise hide a real outage.
    logger.error({ err, taskId }, 'jarvis session access undetermined; failing closed');
    return false;
  }
}

/**
 * @description Filter durable shelf rows before displaying results, visual metadata or starting summaries.
 * @param ctx - Canonical task store.
 * @param sub - Authenticated shelf owner.
 * @param rows - Candidate durable work rows.
 * @param resolveActor - Existing verified actor resolver for current rights checks.
 * @returns Only currently readable rows across every source task and conversation reference.
 */
export async function filterJarvisResultRows<T extends JarvisResultRow>(ctx: AppContext, sub: string, rows: readonly T[],
  resolveActor: () => Promise<AuthorizationActor>): Promise<T[]> {
  const allowed: T[] = [];
  for (const row of rows) {
    try {
      if (row.user_sub && row.user_sub !== sub) continue;
      if (row.principal_issuer && (await resolveActor()).issuer !== row.principal_issuer) continue;
      let readable = true;
      for (const taskId of new Set([row.id, row.ticket_id, row.session_id].filter((id): id is string => Boolean(id)))) {
        const task = await ctx.taskStore?.get(taskId);
        if (!await canReadProtectedResult(task ?? { taskId, ownerSub: sub }, resolveActor)) { readable = false; break; }
      }
      if (readable) allowed.push(row);
    } catch (err) {
      // Unavailable authority never reveals a cached result, so the row stays dropped. Logged
      // because a shelf that quietly shrinks looks identical to one the caller may not read.
      logger.error({ err, rowId: row.id }, 'jarvis result row access undetermined; row withheld');
    }
  }
  return allowed;
}

/**
 * @description Withhold protected cached inputs from automatic derived answers until that path records full lineage.
 * @param ctx - Canonical source task store.
 * @param taskIds - Source task/workspace identifiers contributing to an automatic prompt.
 * @returns True when any source is protected or cannot be safely classified.
 */
export async function hasProtectedJarvisSource(ctx: AppContext, taskIds: readonly string[]): Promise<boolean> {
  try {
    for (const id of taskIds) {
      if (await hasProtectedTaskResults(id)) return true;
      const task = await ctx.taskStore?.get(id);
      if (task?.metadata && Object.prototype.hasOwnProperty.call(task.metadata, PROTECTED_RESULT_EXECUTIONS)) return true;
    }
    return false;
  } catch (err) {
    // Classification failed, so the source is treated as protected. That is the safe answer and
    // it is kept; the log is what distinguishes it from a source genuinely found to be protected.
    logger.error({ err, taskIds }, 'jarvis protected-source classification undetermined; treating as protected');
    return true;
  }
}

/**
 * @description Re-check, against one already-resolved actor, that every protected source of a derived
 * answer is still readable. The background summarizer holds a captured actor rather than a live request,
 * so this is the check that makes a revocation mid-summary stop the publish instead of racing it.
 * @param ctx - Canonical task store.
 * @param sub - Authenticated owner the derived answer belongs to.
 * @param taskIds - Source task, ticket and conversation identifiers contributing to the answer.
 * @param actor - The verified actor the derivation was authorized for; never a caller-supplied identity.
 * @returns Whether every source is currently readable by that exact principal.
 */
export async function canReadDerivedJarvisSources(ctx: AppContext, sub: string, taskIds: readonly string[],
  actor: AuthorizationActor): Promise<boolean> {
  try {
    if (!actor?.isActive || !actor.issuer || actor.sub !== sub) return false;
    for (const taskId of new Set(taskIds)) {
      const task = await ctx.taskStore?.get(taskId);
      if (!await canReadProtectedResult(task ?? { taskId, ownerSub: sub }, async () => actor)) return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, taskIds }, 'jarvis derived source re-check undetermined; withholding');
    return false;
  }
}

/**
 * @description Record the lineage the automatic summary path was withheld for: bind the source ticket's
 * protected executions to the exact destinations the derived answer will be written to (the conversation
 * task and the durable work task), and stamp that lineage on them. Afterwards those destinations refuse
 * every read the source refuses - a different subject, a different issuer, an unverified principal and a
 * revoked owner all fail on the same authority - so publishing the summary cannot launder it.
 * @param ctx - Canonical task store.
 * @param sub - Authenticated owner polling for their own result.
 * @param sourceTaskId - The protected ticket whose work product the summary is derived from.
 * @param destinationTaskIds - Controller-chosen destinations; never a caller-supplied identifier.
 * @param agentId - Agent recorded on a destination task this path has to create.
 * @param resolveActor - Existing server-owned actor resolver, never caller body identity.
 * @returns The verified actor the derivation is authorized for, or null when it may not be recorded.
 */
export async function recordDerivedJarvisResultLineage(ctx: AppContext, sub: string, sourceTaskId: string,
  destinationTaskIds: readonly string[], agentId: string,
  resolveActor: () => Promise<AuthorizationActor>): Promise<AuthorizationActor | null> {
  try {
    const actor = await resolveActor();
    if (!actor?.isActive || !actor.sub || !actor.issuer || actor.sub !== sub) return null;
    const source = await ctx.taskStore?.get(sourceTaskId);
    if (!source || source.ownerSub !== sub) return null;
    const storedIssuer = readOwnerPrincipalIssuer(source.metadata);
    if (storedIssuer ? storedIssuer !== actor.issuer : Boolean(ctx.applicationAuthorization)) return null;
    if (!await canReadProtectedResult(source, async () => actor)) return null;
    for (const destinationTaskId of new Set(destinationTaskIds.filter(Boolean))) {
      if (destinationTaskId === sourceTaskId) continue;
      const executions = await recordDerivedProtectedResult(source, destinationTaskId, actor);
      for (const executionId of executions) await persistProtectedResultTask(ctx, destinationTaskId, agentId, executionId, actor);
      const destination = await ctx.taskStore?.get(destinationTaskId);
      if (!destination || !await canReadProtectedResult(destination, async () => actor)) return null;
    }
    return actor;
  } catch (err) {
    // A destination that could not be bound is left unwritten: the answer stays withheld exactly as it was
    // before this path existed. Logged because a silent skip is indistinguishable from a real refusal.
    logger.error({ err, sourceTaskId, destinationTaskIds }, 'jarvis derived lineage not recorded; result withheld');
    return null;
  }
}
