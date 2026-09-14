/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Admit protected hosted reasoning through one-time current-policy permits and recheck before releasing output.
 */
import type { Pool } from 'pg';
import type { MeshEnvelope } from '@/features/agent-management';
import type { EnvelopeExecutionResult } from '@/features/swarm-orchestration';
import type { RemoteExecutionBinding, RemoteExecutionPermit } from '@/shared/application-remote-execution';
import { readProtectedBotApplication, BotApplicationAuthorizationError } from './bot-node-application-authorization';
import { createBotControllerPermitCheck } from './bot-node-controller-permit';
import { getVerifiedRemoteDispatch, runWithProtectedBotExecution, type VerifiedRemoteDispatch } from './bot-node-protected-context';
import { protectedBotWorkspaceId } from './bot-node-protected-workspace';
import { canonicalBotWorkspaceId } from './bot-node-request-scope';

type PermitCheck = ReturnType<typeof createBotControllerPermitCheck>;
type Execute = () => Promise<EnvelopeExecutionResult>;
function deny(code: string): never { throw new BotApplicationAuthorizationError(code); }

/**
 * @description Preserve durable local/requested ownership refusal unless a verified request obtains a current signed permit.
 * @param pool - Worker database pool used only for trusted ownership lookup.
 * @param localAgentId - Actual worker runtime identity.
 * @param checkPermit - Fixed controller check, injectable only by trusted composition or isolated fixtures.
 * @returns The boundary shared by raw handler, HTTP, mesh and batch execution.
 */
export function createProtectedBotExecutionBoundary(pool: Pick<Pool, 'query'> | null, localAgentId: string, checkPermit?: PermitCheck) {
  let check = checkPermit;
  return async (envelope: MeshEnvelope, execute: Execute): Promise<EnvelopeExecutionResult> => {
    const app = await readProtectedBotApplication(pool, localAgentId, envelope.toAgentId);
    const dispatch = getVerifiedRemoteDispatch();
    if (!app) {
      if (dispatch) deny('authorization_remote_ownership_changed');
      return execute();
    }
    if (!dispatch || dispatch.claims.azp !== localAgentId || envelope.toAgentId !== localAgentId) deny('authorization_remote_dispatch_required');
    assertHostedRequest(dispatch, envelope);
    check ??= createBotControllerPermitCheck();
    return executeProtected(app, dispatch, execute, check, async () => {
      if (await readProtectedBotApplication(pool, localAgentId, envelope.toAgentId) !== app) deny('authorization_remote_ownership_changed');
    });
  };
}

async function executeProtected(app: string, dispatch: VerifiedRemoteDispatch, execute: Execute,
  check: PermitCheck, assertOwner: () => Promise<void>): Promise<EnvelopeExecutionResult> {
  let binding: RemoteExecutionBinding = { executionId: dispatch.executionId, app, agentId: dispatch.claims.azp,
    taskId: dispatch.claims.task_id, workspaceId: String(dispatch.body.workspaceFolderId), sub: dispatch.claims.sub, issuer: dispatch.claims.principal_iss };
  const start = await check(binding, dispatch.claims, dispatch.token, 'start');
  await assertOwner(); assertFresh(start);
  binding = Object.freeze({ ...binding, ...(start.tenantId ? { tenantId: start.tenantId } : {}) });
  const recheck = async () => {
    await assertOwner(); const permit = await check(binding, dispatch.claims, dispatch.token, 'work');
    await assertOwner(); assertFresh(permit);
    if (permit.allowedPermissions.some(permission => !start.allowedPermissions.includes(permission))) deny('authorization_remote_scope_changed');
    return permit;
  };
  const workspaceId = protectedBotWorkspaceId({ principalIssuer: binding.issuer, userSub: binding.sub,
    app, agentId: binding.agentId, tenantId: binding.tenantId, workspaceFolderId: binding.workspaceId, executionId: binding.executionId });
  return runWithProtectedBotExecution({ binding, workspaceId, check: recheck }, start, async () => {
    await recheck();
    const result = await execute();
    if (!result.success) return result;
    await assertOwner();
    const complete = await check(binding, dispatch.claims, dispatch.token, 'complete');
    await assertOwner(); assertFresh(complete);
    return { ...result, ...(result.success ? { output: { ...(result.output as Record<string, unknown> ?? {}), applicationExecutionId: binding.executionId } } : {}) };
  });
}

function assertFresh(permit: RemoteExecutionPermit): void {
  if (Date.parse(permit.expiresAt) <= Date.now()) deny('authorization_remote_permit_expired');
}

function assertHostedRequest(dispatch: VerifiedRemoteDispatch, envelope: MeshEnvelope): void {
  const body = dispatch.body, payload = envelope.payload as Record<string, unknown>;
  const hosted = body.byoLlmConnection as Record<string, unknown> | undefined;
  if (body.direct !== true || body.agenticMode !== false || !hosted || typeof hosted !== 'object'
    || ['baseUrl','apiKey','model'].some(key => typeof hosted[key] !== 'string' || !(hosted[key] as string).trim())
    || Object.hasOwn(body, 'creds') || Object.hasOwn(body, 'providerIntent')) deny('authorization_remote_hosted_reasoning_required');
  if (payload?.userSub !== dispatch.claims.sub || payload?.principalIssuer !== dispatch.claims.principal_iss
    || payload.externalId !== dispatch.claims.task_id || payload.workspaceFolderId !== canonicalBotWorkspaceId(body.workspaceFolderId)
    || payload.text !== body.text || payload.direct !== true || payload.agenticMode !== false
    || Object.hasOwn(payload, 'creds') || Object.hasOwn(payload, 'providerIntent')
    || delegationHostedDigest(payload.byoLlmConnection) !== delegationHostedDigest(hosted)) deny('authorization_remote_envelope_mismatch');
}

function delegationHostedDigest(value: unknown): string { return JSON.stringify(value); }
