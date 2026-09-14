/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Stamp verified remote result lineage before controller history writes.
 */
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { appendProtectedResultExecution, assertProtectedResultAccess, canReadProtectedResult, readProtectedResultExecutions } from '@/shared/protected-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';

/**
 * @description Persist a task's protected marker before any remote response enters shared history.
 * @param ctx - Canonical controller task store.
 * @param taskId - Exact logical task/workspace bound by controller execution authority.
 * @param agentId - Actual dispatched agent.
 * @param executionId - Controller-validated protected execution, never a request metadata value.
 * @param actor - Verified initiating actor.
 * @returns Completion after durable task lineage; failures prevent dependent message writes.
 */
export async function persistProtectedResultTask(ctx: AppContext, taskId: string, agentId: string,
  executionId: string, actor: AuthorizationActor): Promise<void> {
  await assertProtectedResultAccess(executionId, taskId, actor);
  let task = await ctx.taskStore.get(taskId);
  if (!task) task = await ctx.taskStore.create({ taskId, agentId, title: 'Protected application result', processingMode: 'direct', ownerSub: actor.sub,
    metadata: { ...appendProtectedResultExecution({}, executionId), [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: actor.issuer } });
  if (task.ownerSub !== actor.sub) throw new Error('protected_result_owner_mismatch');
  const issuer = readOwnerPrincipalIssuer(task.metadata);
  if (issuer ? issuer !== actor.issuer : !readProtectedResultExecutions(task.metadata).length
    || !await canReadProtectedResult(task, async () => actor)) throw new Error('protected_result_owner_issuer_required');
  const candidate = { ...task, metadata: { ...appendProtectedResultExecution(task.metadata, executionId), [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: actor.issuer } };
  if (!await canReadProtectedResult(candidate, async () => actor)) throw new Error('protected_result_unavailable');
  await ctx.taskStore.replace(candidate);
}
