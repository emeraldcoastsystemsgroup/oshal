/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard Jarvis cached and durable result sources using exact issuer identity and current protected execution lineage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Report an access check that could not be DETERMINED instead of silently answering "denied". Every guard here still fails closed  the returns are unchanged  but a thrown store/authority error used to be indistinguishable from a real denial with nothing logged, which is how a Jarvis ownership fault read as an empty history for three days. Each catch now logs at ERROR with the error, its stack and the task it was deciding.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Give the automatic derived-answer path the lineage it was withheld for. recordDerivedJarvisResultLineage re-asserts the owner's current rights on the SOURCE ticket, binds every contributing execution to the conversation and shelf task the summary will be written to, and stamps that lineage on them - so the derived answer answers to exactly the same authority as the work product it came from. canReadDerivedJarvisSources is the re-check the background summarizer runs against the captured actor before it publishes anything. Nothing here widens who may read: the destinations inherit the source's checks, and a caller who cannot read the source records nothing.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Check fresh Jarvis sessions against the protected-result boundary before their task row can be persisted.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Distinguish unbindable lineage from access denial in recordDerivedJarvisResultLineage so unbindable results can be handled honestly.
 */
import { createChildLogger } from '@/shared/logger';
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { canReadProtectedResult, hasProtectedTaskResults, isProtectedAgent, recordDerivedProtectedResult, PROTECTED_RESULT_EXECUTIONS, readProtectedResultExecutions } from '@/shared/protected-results';
import { persistProtectedResultTask } from './protected-result-persistence';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

export { isProtectedAgent };

const logger = createChildLogger({ module: 'jarvis-result-access' });

/** @description Durable Jarvis work row with its authoritative result and conversation references. */
export interface JarvisResultRow {
  id: string; user_sub?: string; principal_issuer?: string | null; ticket_id?: string | null; session_id?: string | null;
}

/**
 * @description Check the protected-result boundary against the exact task Jarvis would create,
 * before session registration can persist a row that the same boundary will immediately refuse.
 * Durable lineage attached to a caller-selected task id and protected Jarvis ownership are both
 * evaluated here; ordinary unprotected sessions retain their existing admission path.
 * @param sub - Authenticated owner the new conversation would be bound to.
 * @param taskId - Sanitized conversation task id supplied to session registration.
 * @param agentId - Jarvis agent recorded on the session task.
 * @param resolveActor - Existing verified request-actor resolver.
 * @returns Whether the would-be session passes the same protected-result boundary as a stored task.
 */
export async function canStartJarvisSession(sub: string, taskId: string, agentId: string,
  resolveActor: () => Promise<AuthorizationActor>): Promise<boolean> {
  return canReadProtectedResult({ taskId, ownerSub: sub, agentId }, resolveActor);
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
        if (task) {
          const executions = readProtectedResultExecutions(task.metadata);
          const durable = await hasProtectedTaskResults(taskId);
          if (!executions.length && !durable) {
            const actor = await resolveActor();
            if (!actor.isActive || !actor.issuer || actor.sub !== sub) { readable = false; break; }
            continue;
          }
        }
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
      if (task?.agentId && await isProtectedAgent(task.agentId)) return true;
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

/** @description Outcome of attempting to record derived lineage from a protected source task to destination tasks. */
export type DerivedJarvisLineageResult =
  | { outcome: 'authorized'; actor: AuthorizationActor }
  | { outcome: 'denied'; actor: null }
  | { outcome: 'unbindable'; actor: AuthorizationActor; reason: 'protected_result_lineage_required' };

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
 * @returns The derived lineage outcome: authorized with actor, denied, or unbindable with actor.
 */
export async function recordDerivedJarvisResultLineage(ctx: AppContext, sub: string, sourceTaskId: string,
  destinationTaskIds: readonly string[], agentId: string,
  resolveActor: () => Promise<AuthorizationActor>): Promise<DerivedJarvisLineageResult> {
  try {
    const actor = await resolveActor();
    if (!actor?.isActive || !actor.sub || !actor.issuer || actor.sub !== sub) return { outcome: 'denied', actor: null };
    const source = await ctx.taskStore?.get(sourceTaskId);
    if (!source || source.ownerSub !== sub) return { outcome: 'denied', actor: null };
    const storedIssuer = readOwnerPrincipalIssuer(source.metadata);
    if (storedIssuer ? storedIssuer !== actor.issuer : Boolean(ctx.applicationAuthorization)) return { outcome: 'denied', actor: null };
    let executions: string[];
    try {
      executions = readProtectedResultExecutions(source.metadata);
    } catch {
      return { outcome: 'denied', actor: null };
    }
    const durable = await hasProtectedTaskResults(sourceTaskId);
    if (!executions.length && !durable) {
      return { outcome: 'unbindable', actor, reason: 'protected_result_lineage_required' };
    }
    if (!await canReadProtectedResult(source, async () => actor)) return { outcome: 'denied', actor: null };
    for (const destinationTaskId of new Set(destinationTaskIds.filter(Boolean))) {
      if (destinationTaskId === sourceTaskId) continue;
      let executions: string[];
      try {
        executions = await recordDerivedProtectedResult(source, destinationTaskId, actor);
      } catch (err) {
        if (err instanceof Error && err.message === 'protected_result_lineage_required') {
          return { outcome: 'unbindable', actor, reason: 'protected_result_lineage_required' };
        }
        throw err;
      }
      for (const executionId of executions) await persistProtectedResultTask(ctx, destinationTaskId, agentId, executionId, actor);
      const destination = await ctx.taskStore?.get(destinationTaskId);
      if (!destination || !await canReadProtectedResult(destination, async () => actor)) return { outcome: 'denied', actor: null };
    }
    return { outcome: 'authorized', actor };
  } catch (err) {
    // A destination that could not be bound is left unwritten: the answer stays withheld exactly as it was
    // before this path existed. Logged because a silent skip is indistinguishable from a real refusal.
    logger.error({ err, sourceTaskId, destinationTaskIds }, 'jarvis derived lineage not recorded; result withheld');
    return { outcome: 'denied', actor: null };
  }
}
