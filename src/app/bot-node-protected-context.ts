/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry verified remote execution authority outside request payloads and restrict protected work to exact business identity.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { RemoteExecutionBinding, RemoteExecutionPermit } from '@/shared/application-remote-execution';
import type { DelegationTokenClaims } from '@/shared/types';
import { DELEGATION_HTTP_HEADER } from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getVerifiedDelegationClaims } from './bot-node-delegation';

/** @description Data admitted only after the worker's signed-request and nonce middleware succeeds. */
export interface VerifiedRemoteDispatch {
  claims: DelegationTokenClaims;
  token: string;
  executionId: string;
  body: Readonly<Record<string, unknown>>;
}
/** @description Runtime-owned current-rights lease, never reconstructed from model or request flags. */
export interface ProtectedBotExecution {
  binding: Readonly<RemoteExecutionBinding>;
  workspaceId: string;
  check(): Promise<RemoteExecutionPermit>;
}
const dispatches = new AsyncLocalStorage<VerifiedRemoteDispatch>();
const executions = new AsyncLocalStorage<ProtectedBotExecution>();

/**
 * @description Capture verified dispatch identity after the single-use delegation gate, without trusting body actors.
 * @returns Middleware that refuses malformed references or references without verified signed claims.
 */
export function createProtectedBotDispatchContext(): RequestHandler {
  return (req, res, next) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || !Object.hasOwn(body, 'applicationExecutionId')) { next(); return; }
    const claims = getVerifiedDelegationClaims(res), token = req.get(DELEGATION_HTTP_HEADER);
    if (!claims || !token || typeof body.applicationExecutionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.applicationExecutionId)
      || claims.body_sha256 !== delegationRequestBodySha256(body)) {
      res.status(403).json({ success: false, error: 'authorization_remote_dispatch_required' }); return;
    }
    dispatches.run(Object.freeze({ claims: structuredClone(claims), token, executionId: body.applicationExecutionId,
      body: Object.freeze(structuredClone(body)) }), next);
  };
}

/** @description Read only the dispatch admitted by actual HTTP delegation middleware.
 * @returns Verified dispatch context, absent for raw, mesh and batch entry paths.
 */
export function getVerifiedRemoteDispatch(): VerifiedRemoteDispatch | undefined { return dispatches.getStore(); }

/** @description Read the currently authorized protected execution from its runtime boundary.
 * @returns Current exact execution or undefined for legacy unprotected work.
 */
export function getProtectedBotExecution(): ProtectedBotExecution | undefined { return executions.getStore(); }

/**
 * @description Run application business work under the exact delegated caller with no operator bypass.
 * @param execution - Controller-authorized execution bound by trusted worker code.
 * @param permit - Fresh signed start permit and its permission ceiling.
 * @param operation - Work performed only within this context.
 * @returns The operation result with restricted identity across asynchronous calls.
 */
export function runWithProtectedBotExecution<T>(execution: ProtectedBotExecution, permit: RemoteExecutionPermit, operation: () => T): T {
  const actor = { sub: permit.sub, issuer: permit.issuer, isActive: true, isSwarmAdmin: false,
    allowedPermissions: [...permit.allowedPermissions], ...(permit.tenantId ? { tenantIds: [permit.tenantId] } : {}) };
  return executions.run(execution, () => runWithApplicationAuthorizationActor(actor,
    () => runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, operation)));
}
