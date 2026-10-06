/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Record controller-inline application output under the same current principal and durable lineage as remote output.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add bounded lifecycle/error diagnostics and document exact owner, history and release boundaries.
 */
import type { AppContext } from '../composition-root';
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { isApplicationExecutionProtected } from '@/shared/application-authorization-execution';
import { getApplicationRemoteExecutionAuthority } from '@/shared/application-remote-execution';
import { canReadProtectedResult, isProtectedAgent, readProtectedTaskNoticeState } from '@/shared/protected-results';
import { runWithRequestIdentity, runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { captureRemoteExecutionResult } from '@/shared/remote-execution-results';
import { OWNER_PRINCIPAL_ISSUER_METADATA_KEY, readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { persistProtectedResultTask } from './protected-result-persistence';
import { createChildLogger, observeAsyncOperation } from '@/shared/logger';

const logger = createChildLogger({ module: 'protected-inline-execution' });

interface InlineTaskBinding { taskId: string; workspaceId: string; userSub?: string }

/** @description Reject unavailable task ownership without revealing any stored task data. */
export class ProtectedInlineTaskUnavailableError extends Error {
  readonly status = 404;
  /**
   * @description Keep owner and issuer details out of the public refusal.
   * @returns A not-found error with no stored ownership details.
   */
  constructor() { super('not found'); this.name = 'ProtectedInlineTaskUnavailableError'; }
}

/**
 * @description Apply durable original-scope authority to either controller-inline entry point before model work.
 * @param ctx Canonical stores.
 * @param agentId Actual target.
 * @param input Controller-selected identifiers.
 * @param execute Existing hosted recovery turn.
 * @param verifiedActor Trusted request actor, never request content.
 * @returns The existing outcome with controller-owned execution lineage when the bot is protected.
 */
export async function runProtectedInlineTurn<T extends { result: { success: boolean } }>(ctx: AppContext,
  agentId: string, input: InlineTaskBinding, execute: () => Promise<T>, verifiedActor = getApplicationAuthorizationActor(),
): Promise<T & { applicationExecutionId?: string }> {
  return observeAsyncOperation(logger, 'runProtectedInlineTurn', { agentId, taskId: input.taskId, workspaceId: input.workspaceId }, async () => {
    const authority = getApplicationRemoteExecutionAuthority();
    const protectedTarget = await isApplicationExecutionProtected({ kind: 'bots', operation: agentId }) || await isProtectedAgent(agentId);
    if (!authority) {
      if (protectedTarget) throw new Error('protected_result_unavailable');
      return execute();
    }
    const original = verifiedActor ?? { sub: '', issuer: '', isActive: false, isSwarmAdmin: false };
    if (protectedTarget) {
      if (!original.isActive || input.userSub !== undefined && input.userSub !== original.sub) throw new Error('protected_result_owner_mismatch');
      await authority.assertEmptyTaskAccess(agentId, original);
      await validateInlineTask(ctx, input.taskId, original, true);
    }
    const started = await authority.startInline(original, { agentId, taskId: input.taskId, workspaceId: input.workspaceId }, async actor => {
      if (input.userSub !== undefined && input.userSub !== actor.sub) throw new ProtectedInlineTaskUnavailableError();
      await validateInlineTask(ctx, input.taskId, actor, true);
    });
    if (!started) {
      if (protectedTarget) throw new Error('protected_result_unavailable');
      return execute();
    }
    const actor = started.actor;
    if (input.userSub !== undefined && input.userSub !== actor.sub) throw new Error('protected_result_owner_mismatch');
    return ctx.streamManager.withDeferredTaskEvents(input.taskId, () => runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: false }, async () => {
      await ensureInlineTask(ctx, input.taskId, agentId, actor);
      const outcome = await execute();
      if (!outcome.result.success) throw new Error('protected_inline_execution_failed');
      if (getApplicationRemoteExecutionAuthority() !== authority) throw new Error('protected_result_unavailable');
      // Complete, persist and recheck before the deferred stream can expose any model output.
      await authority.completeInline(started.executionId, actor);
      await persistProtectedResultTask(ctx, input.taskId, agentId, started.executionId, actor);
      await captureRemoteExecutionResult(authority, started.executionId, actor);
      if (getApplicationRemoteExecutionAuthority() !== authority) throw new Error('protected_result_unavailable');
      await authority.assertResultAccess(started.executionId, actor, { taskId: input.taskId, workspaceId: input.workspaceId });
      if (getApplicationRemoteExecutionAuthority() !== authority) throw new Error('protected_result_unavailable');
      return { ...outcome, applicationExecutionId: started.executionId };
    })));
  });
}

/** @description Bind new controller tasks to the verified issuer; refuse adoption of unstamped existing output.
 * @param ctx Canonical store.
 * @param taskId Exact controller destination.
 * @param agentId Actual bot.
 * @param actor Restricted initiating principal.
 * @returns Completion before any inline message is persisted.
 */
async function ensureInlineTask(ctx: AppContext, taskId: string, agentId: string, actor: AuthorizationActor): Promise<void> {
  if (await validateInlineTask(ctx, taskId, actor, false)) return;
  await ctx.taskStore.create({ taskId, agentId, title: 'Application conversation', processingMode: 'direct', ownerSub: actor.sub,
    metadata: { [OWNER_PRINCIPAL_ISSUER_METADATA_KEY]: actor.issuer } });
}

/** @description Reject an existing foreign or unstamped destination before recording provisional lineage.
 * @param ctx Canonical store.
 * @param taskId Controller destination.
 * @param actor Verified principal.
 * @param checkHistory Whether existing output must pass the current protected-result gate before provisional lineage.
 * @returns The existing validated task, or null for a genuinely new controller destination.
 */
async function validateInlineTask(ctx: AppContext, taskId: string, actor: AuthorizationActor, checkHistory: boolean) {
  // The controller must distinguish an absent destination from an existing row hidden by RLS
  // before recording lineage. This confined lookup is used only for identity comparison.
  const task = await runWithSystemIdentity(() => ctx.taskStore.get(taskId));
  if (task && (task.ownerSub !== actor.sub || readOwnerPrincipalIssuer(task.metadata) !== actor.issuer)) {
    throw new ProtectedInlineTaskUnavailableError();
  }
  if (task && checkHistory) {
    const state = await readProtectedTaskNoticeState(task);
    if (state === 'protected-empty' ? await ctx.messageStore.count(taskId) !== 0 : !await canReadProtectedResult(task, async () => actor)) {
      throw new ProtectedInlineTaskUnavailableError();
    }
  }
  return task;
}
