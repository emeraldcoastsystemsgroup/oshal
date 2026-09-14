/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind persisted protected output to controller-owned execution lineage and current exact-principal result access.
 */
import type { AuthorizationActor } from '@/shared/application-authorization';

/** @description Reserved task metadata containing controller-created protected execution identifiers. */
export const PROTECTED_RESULT_EXECUTIONS = 'oshalProtectedExecutions';
const MAX_EXECUTIONS = 128;

/** @description Trusted controller ports for durable execution ownership and current application policy. */
export interface ProtectedResultAccess {
  assertResultAccess(executionId: string, actor: AuthorizationActor, binding?: { taskId?: string; workspaceId?: string }): Promise<void>;
  assertTaskResultAccess(taskId: string, actor: AuthorizationActor): Promise<void>;
  hasTaskResults(taskId: string): Promise<boolean>;
  isProtectedAgent(agentId: string): boolean | Promise<boolean>;
}

/** @description Stored task fields needed to constrain result history and streaming. */
export interface ProtectedResultTask {
  taskId: string;
  ownerSub?: string | null;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

let access: ProtectedResultAccess | undefined;

/**
 * @description Install the controller-owned result authority; package code never receives this setter.
 * @param value - Durable authority service, or undefined during isolated test teardown.
 * @returns Nothing.
 */
export function configureProtectedResultAccess(value: ProtectedResultAccess | undefined): void { access = value; }

/**
 * @description Detect durable protected lineage independently of mutable task metadata or the requesting principal.
 * @param taskId - Exact stored task, linked parent or workspace identifier.
 * @returns Whether the controller has protected executions contributing to this task.
 */
export async function hasProtectedTaskResults(taskId: string): Promise<boolean> {
  return access ? access.hasTaskResults(taskId) : false;
}

/**
 * @description Read bounded execution lineage, rejecting malformed metadata instead of falling back to legacy access.
 * @param metadata - Stored task metadata.
 * @returns Valid execution identifiers, or an empty array for an unmarked legacy task.
 */
export function readProtectedResultExecutions(metadata?: Record<string, unknown>): string[] {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, PROTECTED_RESULT_EXECUTIONS)) return [];
  const value = metadata[PROTECTED_RESULT_EXECUTIONS];
  if (!Array.isArray(value) || !value.length || value.length > MAX_EXECUTIONS
    || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))
    || new Set(value).size !== value.length) throw new Error('invalid_protected_result_lineage');
  return [...value];
}

/**
 * @description Append a trusted execution to stored metadata without discarding previous protected dependencies.
 * @param metadata - Existing stored metadata; persistence must serialize concurrent appends.
 * @param executionId - Controller-created execution identifier after successful authority validation.
 * @returns New metadata with bounded complete execution lineage.
 */
export function appendProtectedResultExecution(metadata: Record<string, unknown> | undefined, executionId: string): Record<string, unknown> {
  const ids = [...new Set([...readProtectedResultExecutions(metadata), executionId])];
  const result = { ...metadata, [PROTECTED_RESULT_EXECUTIONS]: ids };
  readProtectedResultExecutions(result); return result;
}

/**
 * @description Strip reserved protected lineage from caller-supplied task metadata.
 * @param metadata - Untrusted task creation payload.
 * @returns Plain metadata with no caller-selected execution binding.
 */
export function stripProtectedResultMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const result = { ...metadata } as Record<string, unknown>;
  delete result[PROTECTED_RESULT_EXECUTIONS]; return result;
}

/**
 * @description Validate one controller-backed result against its exact destination before persistence or response release.
 * @param executionId - Trusted execution returned by the controller dispatch path.
 * @param taskId - Destination task or logical workspace identifier.
 * @param actor - Verified initiating/viewing actor.
 * @returns Completion only while current result authority permits the exact binding.
 */
export async function assertProtectedResultAccess(executionId: string, taskId: string, actor: AuthorizationActor): Promise<void> {
  const authority = access;
  if (!authority || !actor.isActive || !actor.sub || !actor.issuer) throw new Error('protected_result_unavailable');
  await authority.assertResultAccess(executionId, actor, { taskId });
  await authority.assertTaskResultAccess(taskId, actor);
  if (access !== authority) throw new Error('protected_result_unavailable');
}

/**
 * @description Require current exact-principal rights for every protected execution contributing to a task.
 * @param task - Current stored task and its server-owned lineage.
 * @param resolveActor - Existing verified request-actor resolver, never caller body identity.
 * @returns Whether the protected-result boundary permits this read; legacy ownership still applies separately.
 */
export async function canReadProtectedResult(task: ProtectedResultTask, resolveActor: () => Promise<AuthorizationActor>): Promise<boolean> {
  try {
    const authority = access;
    const executions = readProtectedResultExecutions(task.metadata);
    const durable = authority ? await authority.hasTaskResults(task.taskId) : false;
    if (!executions.length && !durable) return !(task.agentId && authority && await authority.isProtectedAgent(task.agentId));
    if (!authority) return false;
    const actor = await resolveActor();
    if (!actor.isActive || !actor.issuer || actor.sub !== task.ownerSub) return false;
    for (const executionId of executions) await authority.assertResultAccess(executionId, actor, { taskId: task.taskId });
    await authority.assertTaskResultAccess(task.taskId, actor);
    return access === authority;
  } catch { return false; }
}
