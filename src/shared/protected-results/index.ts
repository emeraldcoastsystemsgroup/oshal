/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bind persisted protected output to controller-owned execution lineage and current exact-principal result access.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Record derived-result lineage so a protected answer can be published to a second controller-owned destination (a Jarvis conversation) without laundering it: linkResult joins the authority port, and recordDerivedProtectedResult re-asserts the owner's current rights on the SOURCE, links every contributing execution to the destination, then proves the destination now answers to the same executions. Nothing about who may read is relaxed - the destination simply inherits the source's checks.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Export isProtectedAgent helper to detect protected execution status without exposing raw authority setter; assert executions presence before task-result assertion in recordDerivedProtectedResult.
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
  /** Durably bind an already-completed execution to a second controller-chosen destination task, under the
   *  authority's own current-rights verification. The destination then fails every later read the source
   *  would have failed; it never gains a right the source did not already grant this exact principal. */
  linkResult(executionId: string, resultTaskId: string, actor: AuthorizationActor): Promise<void>;
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
 * @description Detect whether an agent is protected under current controller execution authority.
 * @param agentId - Dispatched agent identifier.
 * @returns Whether the agent's tasks are considered protected.
 */
export async function isProtectedAgent(agentId: string): Promise<boolean> {
  return access ? access.isProtectedAgent(agentId) : false;
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
 * @description Record derived lineage so one protected result may be published into a second controller-owned
 * destination task while remaining bound to the SAME executions. This is the lineage the automatic Jarvis
 * summary path was withheld for: without it a protected answer copied into a conversation would be readable
 * through a row that no longer answered to the execution authority.
 * @param source - Stored source task carrying the controller-recorded executions, with its owner.
 * @param destinationTaskId - Controller-chosen destination task; never a caller-supplied identifier.
 * @param actor - Verified request actor, which must be the source owner acting as itself.
 * @returns The execution identifiers now bound to the destination, for stamping onto its metadata.
 */
export async function recordDerivedProtectedResult(source: ProtectedResultTask, destinationTaskId: string,
  actor: AuthorizationActor): Promise<string[]> {
  const authority = access;
  if (!authority || !actor.isActive || !actor.sub || !actor.issuer) throw new Error('protected_result_unavailable');
  if (!destinationTaskId || destinationTaskId === source.taskId) throw new Error('protected_result_binding_mismatch');
  if (actor.sub !== source.ownerSub) throw new Error('protected_result_owner_mismatch');
  const executions = readProtectedResultExecutions(source.metadata);
  if (!executions.length) throw new Error('protected_result_lineage_required');
  // The source must be readable by this exact principal RIGHT NOW, against its own binding, before any
  // part of it is republished. A durable execution the metadata lost still counts, so the task-wide
  // assertion runs too — it is what closes the "lineage append was lost" hole for the derived copy.
  for (const executionId of executions) await authority.assertResultAccess(executionId, actor, { taskId: source.taskId });
  await authority.assertTaskResultAccess(source.taskId, actor);
  for (const executionId of executions) {
    await authority.linkResult(executionId, destinationTaskId, actor);
    // Prove the link took: a destination that does not yet answer to this execution must not be stamped.
    await authority.assertResultAccess(executionId, actor, { taskId: destinationTaskId });
  }
  await authority.assertTaskResultAccess(destinationTaskId, actor);
  if (access !== authority) throw new Error('protected_result_unavailable');
  return executions;
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
