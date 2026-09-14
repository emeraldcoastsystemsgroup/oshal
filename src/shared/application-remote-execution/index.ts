/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Define controller-owned remote execution bindings and signed current-policy permits.
 */
import type { AuthorizationActor, AuthorizationOperation } from '@/shared/application-authorization';
import type { RecordedDelegationToken } from '@/shared/security/delegation-token';

/** @description Fixed controller endpoint; no dispatch may select a callback URL. */
export const REMOTE_EXECUTION_PATH = '/api/internal/application-executions/revalidate';
/** @description Separate permit audience prevents execution tokens from impersonating controller decisions. */
export const REMOTE_PERMIT_AUDIENCE = 'urn:oshal:application-remote-execution';
/** @description Exact permit scope, distinct from the original swarm execution scope. */
export const REMOTE_PERMIT_SCOPE = ['application:remote-permit'] as const;
/** @description Start is single-use; work/action recheck current rights; complete closes execution. */
export type RemoteExecutionPhase = 'start' | 'work' | 'action' | 'complete';
/** @description Exact immutable identity and task tuple derived only by controller composition. */
export interface RemoteExecutionBinding {
  executionId: string; app: string; agentId: string; taskId: string; workspaceId: string;
  sub: string; issuer: string; tenantId?: string;
}
/** @description A policy generation changes whenever executable package policy is replaced or removed. */
export interface RemoteApplicationSnapshot { app: string; source: string; catalogRevision: string; generation: string }
/** @description Preparation input from a verified dispatch path; app ownership is resolved by the controller. */
export interface PrepareRemoteExecutionInput {
  agentId: string; taskId: string; workspaceId: string; tenantId?: string;
}
/** @description Opaque dispatch reference returned before the existing request is signed. */
export interface PreparedRemoteExecution { executionId: string; expiresAt: string; binding: RemoteExecutionBinding }
/** @description Only same-application named operations can be revalidated during a running execution. */
export type RemoteExecutionAction = Pick<AuthorizationOperation, 'kind' | 'operation' | 'resourceId' | 'fields'>;
/** @description Wire request proves possession of the original dispatch token; actor/app are never accepted. */
export interface RemoteExecutionCheck {
  executionId: string; token: string; phase: RemoteExecutionPhase; nonce: string; action?: RemoteExecutionAction;
}
/** @description Signed response payload binds the fresh worker challenge and original immutable dispatch. */
export interface RemoteExecutionPermit extends RemoteExecutionBinding {
  phase: RemoteExecutionPhase; nonce: string; dispatchJti: string; allowedPermissions: string[];
  expiresAt: string; action?: RemoteExecutionAction;
}
/** @description The worker verifies this token against the exact permit payload before proceeding. */
export interface SignedRemoteExecutionPermit { permit: RemoteExecutionPermit; token: string }
/** @description Shared controller API used by dispatch, fixed revalidation route and result guards. */
export interface ApplicationRemoteExecutionAuthority {
  /** @description Resolve current protected ownership and retain the verified caller's ceiling.
   * @param actor Trusted initiating actor. @param input Exact dispatch identifiers.
   * @returns Opaque prepared binding, or null only for a confirmed unprotected target.
   */
  prepare(actor: AuthorizationActor, input: PrepareRemoteExecutionInput): Promise<PreparedRemoteExecution | null>;
  /** @description Persist the exact signed dispatch before it leaves the controller.
   * @param executionId Prepared reference. @param receipt Original recorded token.
   * @param request Exact body containing applicationExecutionId. @returns Completion after durable binding.
   */
  bind(executionId: string, receipt: RecordedDelegationToken, request: Record<string, unknown>): Promise<void>;
  /** @description Authenticate a worker challenge and reevaluate live policy at the named phase.
   * @param input Closed wire request. @returns A short-lived signed decision for that challenge only.
   */
  revalidate(input: RemoteExecutionCheck): Promise<SignedRemoteExecutionPermit>;
  /** @description Recheck current exact-owner access before releasing persisted or streamed results.
   * @param executionId Trusted stored lineage. @param actor Verified result viewer.
   * @returns Completion only while the viewer retains the original scope and current permission.
   */
  assertResultAccess(executionId: string, actor: AuthorizationActor, expected?: { taskId?: string; workspaceId?: string }): Promise<void>;
  /** @description Authorize every protected execution bound to this exact task or workspace and viewer.
   * @param taskId Trusted stored task identifier. @param actor Verified result viewer.
   * @returns Completion only when at least one matching execution exists and all remain readable.
   */
  assertTaskResultAccess(taskId: string, actor: AuthorizationActor): Promise<void>;
  /** @description Attach controller-owned result lineage before releasing output to an exact owner's aggregate task. */
  linkResult(executionId: string, resultTaskId: string, actor: AuthorizationActor): Promise<void>;
  /** @description Detect durable protected lineage regardless of viewer identity or missing metadata. */
  hasTaskResults(taskId: string): Promise<boolean>;
}

let authority: ApplicationRemoteExecutionAuthority | undefined;
/** @description Install the controller authority after core composition without rebuilding existing clients.
 * @param value Controller-owned authority, or undefined during teardown. @returns No value.
 */
export function configureApplicationRemoteExecutionAuthority(value: ApplicationRemoteExecutionAuthority | undefined): void { authority = value; }
/** @description Read the configured controller authority from a trusted execution boundary.
 * @returns The authority, or undefined before composition.
 */
export function getApplicationRemoteExecutionAuthority(): ApplicationRemoteExecutionAuthority | undefined { return authority; }
