/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard Jarvis cached and durable result sources using exact issuer identity and current protected execution lineage.
 */
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { canReadProtectedResult, hasProtectedTaskResults, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

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
  } catch { return false; }
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
    } catch { /* Unavailable authority never reveals a cached result. */ }
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
  } catch { return true; }
}
