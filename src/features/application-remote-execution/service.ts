/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Revalidate controller-owned remote executions against current account, package generation and permission state.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Refuse effective grant expansion as well as revocation across context loading, signing and execution.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuthorizationActor, AuthorizationGrant, AuthorizationOperation } from '@/shared/application-authorization';
import { REMOTE_EXECUTION_PATH, REMOTE_PERMIT_AUDIENCE, REMOTE_PERMIT_SCOPE,
  type ApplicationRemoteExecutionAuthority, type PrepareRemoteExecutionInput, type PreparedRemoteExecution,
  type RemoteExecutionCheck, type RemoteExecutionPermit, type SignedRemoteExecutionPermit } from '@/shared/application-remote-execution';
import { SWARM_EXECUTE_DELEGATION_METHOD, SWARM_EXECUTE_DELEGATION_PATH, SWARM_EXECUTE_DELEGATION_SCOPE } from '@/shared/security/delegation-http-policy';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';
import type { RecordedDelegationToken } from '@/shared/security/delegation-token';
import { runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
import { RemoteExecutionError, type RemoteExecutionPorts, type RemoteExecutionRecord, type RemoteExecutionStore } from './types';
import { executionActor, parseRemoteExecutionCheck, parseRemotePreparation, requireExecutionId } from './validation';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(code: string, status = 403): never { throw new RemoteExecutionError(code, status); }

/** @description One controller authority for dispatch provenance, worker permits and scoped result release. */
export class ApplicationRemoteExecutionService implements ApplicationRemoteExecutionAuthority {
  private readonly now: () => number;
  /** @description Compose storage and existing live policy without a second permission evaluator.
   * @param store Durable execution repository. @param ports Trusted controller policy/signing. @returns The service.
   */
  constructor(private readonly store: RemoteExecutionStore, private readonly ports: RemoteExecutionPorts) { this.now = ports.now ?? Date.now; }

  /** @description Preserve exact caller evidence and its current permission ceiling before signing.
   * @param original Trusted initiating actor. @param raw Exact dispatch identifiers. @returns Prepared reference or confirmed legacy null.
   */
  async prepare(original: AuthorizationActor, raw: PrepareRemoteExecutionInput): Promise<PreparedRemoteExecution | null> {
    const input = parseRemotePreparation(raw);
    const owner = await this.ports.owner('bots', input.agentId);
    if (!owner?.protected) return null;
    const actor = await this.freshActor(executionActor(original));
    const snapshot = this.ports.snapshot(owner.app); if (!snapshot) refuse('remote_execution_app_unavailable', 503);
    const record: RemoteExecutionRecord = { version: 1, actor, snapshot, status: 'prepared', nonces: [],
      binding: { executionId: randomUUID(), app: owner.app, agentId: input.agentId, taskId: input.taskId,
        workspaceId: input.workspaceId, sub: actor.sub, issuer: actor.issuer, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 300_000).toISOString() };
    await this.checkPolicy(record, actor);
    const effective = await this.ports.effective(actor, owner.app, input.tenantId);
    const ceiling = effective.status === 'admin-required' && effective.roles.includes('@app-admin')
      ? [`${owner.app}:@app-admin`] : effective.permissions.map(grant => `${owner.app}:${grant.permission}`);
    record.actor = executionActor(actor, [...new Set(ceiling)]);
    record.permissionGrants = structuredClone(effective.permissions);
    await this.checkPolicy(record, record.actor); this.assertGeneration(record);
    await this.store.insert(record);
    this.assertGeneration(record);
    return { executionId: record.binding.executionId, expiresAt: record.expiresAt, binding: structuredClone(record.binding) };
  }

  /** @description Bind the exact controller-issued token and body without retaining prompts or secrets.
   * @param executionId Prepared ID. @param receipt Signed dispatch. @param request Exact final body. @returns Durable completion.
   */
  async bind(executionId: string, receipt: RecordedDelegationToken, request: Record<string, unknown>): Promise<void> {
    await this.store.update(requireExecutionId(executionId), async record => {
      this.assertLive(record);
      if (record.status !== 'prepared') refuse('remote_execution_already_bound', 409);
      const binding = record.binding;
      if (request.applicationExecutionId !== executionId || request.taskId !== binding.taskId
        || request.workspaceFolderId !== binding.workspaceId || request.userSub !== binding.sub
        || request.principalIssuer !== binding.issuer || (request.agentId !== undefined && request.agentId !== binding.agentId)) {
        refuse('remote_execution_binding_mismatch');
      }
      const claims = this.ports.verifier.verify(receipt.token, { iss: this.ports.tokenIssuer, aud: this.ports.dispatchAudience,
        azp: binding.agentId, task_id: binding.taskId, sub: binding.sub, principal_iss: binding.issuer,
        method: SWARM_EXECUTE_DELEGATION_METHOD, path: SWARM_EXECUTE_DELEGATION_PATH,
        scope: SWARM_EXECUTE_DELEGATION_SCOPE, body_sha256: delegationRequestBodySha256(request) });
      if (delegationRequestBodySha256(claims) !== delegationRequestBodySha256(receipt.claims)) refuse('remote_execution_binding_mismatch');
      if (claims.exp * 1000 > Date.parse(record.createdAt) + 5_400_000) refuse('remote_execution_expiry_invalid');
      await this.checkPolicy(record);
      record.claims = structuredClone(claims); record.tokenHash = hash(receipt.token);
      record.expiresAt = new Date(claims.exp * 1000).toISOString(); record.status = 'bound';
      this.assertGeneration(record);
    });
  }

  /** @description Consume a fresh challenge under one row lock and sign only a current allowed decision.
   * @param raw Closed worker request. @returns Signed permit bound to that exact challenge and phase.
   */
  async revalidate(raw: RemoteExecutionCheck): Promise<SignedRemoteExecutionPermit> {
    const input = parseRemoteExecutionCheck(raw);
    return this.store.update(input.executionId, async record => {
      this.assertLive(record); this.verifyOriginal(record, input.token); this.assertPhase(record, input);
      const actor = await this.checkPolicy(record);
      if (input.action) await this.checkAction(record, actor, input.action);
      const now = this.now();
      const permit: RemoteExecutionPermit = { ...record.binding, phase: input.phase, nonce: input.nonce,
        dispatchJti: record.claims!.jti, allowedPermissions: [...(record.actor.allowedPermissions ?? [])],
        expiresAt: new Date(Math.min(now + 15_000, Date.parse(record.expiresAt))).toISOString(),
        ...(input.action ? { action: structuredClone(input.action) } : {}) };
      const signed = this.ports.issuer.issue({ iss: this.ports.tokenIssuer, aud: REMOTE_PERMIT_AUDIENCE,
        sub: record.binding.sub, principal_iss: record.binding.issuer, azp: record.binding.agentId, task_id: record.binding.taskId,
        method: 'POST', path: REMOTE_EXECUTION_PATH, scope: [...REMOTE_PERMIT_SCOPE], body_sha256: delegationRequestBodySha256(permit) },
      { expiresAtEpochSeconds: Math.floor(now / 1000) + 300 });
      this.assertGeneration(record); this.assertLive(record);
      record.nonces.push(input.nonce);
      if (input.phase === 'start') { record.status = 'started'; record.startedAt = new Date(now).toISOString(); }
      if (input.phase === 'complete') { record.status = 'completed'; record.completedAt = new Date(now).toISOString(); }
      return { permit, token: signed.token };
    });
  }

  /** @description Authorize result release under both original and current viewer permissions.
   * @param executionId Trusted result lineage. @param viewer Authenticated viewer. @param expected Stored identifiers.
   * @returns Completion only when exact ownership and current policy still hold.
   */
  async assertResultAccess(executionId: string, viewer: AuthorizationActor, expected?: { taskId?: string; workspaceId?: string }): Promise<void> {
    const record = await this.store.read(requireExecutionId(executionId));
    if (!record || record.status !== 'completed') refuse('remote_execution_result_unavailable');
    if (viewer.sub !== record.binding.sub || viewer.issuer !== record.binding.issuer) refuse('remote_execution_result_owner_mismatch');
    if ((expected?.taskId && expected.taskId !== record.binding.taskId && expected.taskId !== record.binding.workspaceId && !record.resultTaskIds?.includes(expected.taskId))
      || (expected?.workspaceId && expected.workspaceId !== record.binding.workspaceId)) refuse('remote_execution_result_binding_mismatch');
    await this.checkPolicy(record);
    await this.checkPolicy(record, executionActor(viewer, record.actor.allowedPermissions));
    this.assertGeneration(record);
  }

  /** @description Prevent lost lineage appends from hiding another protected execution on the same task.
   * @param taskId Trusted stored task/workspace. @param actor Authenticated viewer. @returns Completion after all matching current checks.
   */
  async assertTaskResultAccess(taskId: string, actor: AuthorizationActor): Promise<void> {
    const records = await this.store.byTask(taskId);
    if (!records.length) refuse('remote_execution_result_unavailable');
    for (const record of records) await this.assertResultAccess(record.binding.executionId, actor, { taskId });
  }

  /** @description Detect output provenance even when a caller supplies no lineage metadata.
   * @param taskId Exact persisted task. @returns Whether any bound execution belongs to this task.
   */
  async hasTaskResults(taskId: string): Promise<boolean> { return (await this.store.byTask(taskId)).length > 0; }

  /** @description Bind aggregate output to the exact initiating principal before publishing it.
   * @param executionId Trusted dispatch reference. @param resultTaskId Controller-selected aggregate. @param actor Current exact owner.
   * @returns Durable relation after current-rights verification.
   */
  async linkResult(executionId: string, resultTaskId: string, actor: AuthorizationActor): Promise<void> {
    if (!resultTaskId || resultTaskId.length > 512 || /[\x00-\x1f]/.test(resultTaskId)) refuse('remote_execution_result_binding_mismatch');
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.assertResultAccess(executionId, actor);
      try {
        await this.store.update(executionId, async record => {
          await this.checkPolicy(record, executionActor(actor, record.actor.allowedPermissions));
          record.resultTaskIds = [...new Set([...(record.resultTaskIds ?? []), resultTaskId])];
          if (record.resultTaskIds.length > 256) refuse('remote_execution_result_link_limit');
        });
        return;
      } catch (error) { if (!(error instanceof RemoteExecutionError) || error.code !== 'remote_execution_concurrent_change' || attempt === 4) throw error; }
    }
  }

  private async freshActor(original: AuthorizationActor): Promise<AuthorizationActor> {
    const current = await this.ports.refreshActor(original);
    if (!current?.isActive || current.sub !== original.sub || current.issuer !== original.issuer) refuse('remote_execution_identity_required');
    return executionActor({ ...current, directory: original.directory,
      tenantIds: current.tenantIds?.filter(tenant => original.tenantIds?.includes(tenant)) }, original.allowedPermissions);
  }
  private async checkPolicy(record: RemoteExecutionRecord, candidate = record.actor): Promise<AuthorizationActor> {
    this.assertGeneration(record);
    const owner = await this.ports.owner('bots', record.binding.agentId);
    if (!owner?.protected || owner.app !== record.binding.app) refuse('remote_execution_owner_changed');
    const actor = await this.freshActor(candidate);
    const revision = await this.assertOriginalGrants(record, actor);
    const decision = await this.authorize(actor, { app: record.binding.app, kind: 'bots', operation: record.binding.agentId,
      ...(record.binding.tenantId ? { tenantId: record.binding.tenantId } : {}) });
    this.assertGeneration(record);
    if (!decision.allowed) refuse(decision.reason);
    if (revision !== undefined && revision !== decision.revision) refuse('remote_execution_policy_changed');
    this.assertGrantCeiling(record, decision.grants);
    return actor;
  }
  private async checkAction(record: RemoteExecutionRecord, actor: AuthorizationActor, action: NonNullable<RemoteExecutionCheck['action']>): Promise<void> {
    if (action.kind !== 'bots' && action.kind !== 'tools') refuse('remote_execution_action_unbound');
    const owner = await this.ports.owner(action.kind, action.operation!);
    if (!owner?.protected || owner.app !== record.binding.app) refuse('remote_execution_action_unbound');
    const decision = await this.authorize(actor, { ...action, app: record.binding.app,
      ...(record.binding.tenantId ? { tenantId: record.binding.tenantId } : {}) });
    if (!decision.allowed) refuse(decision.reason);
    this.assertGrantCeiling(record, decision.grants);
    this.assertGeneration(record);
  }
  private assertGrantCeiling(record: RemoteExecutionRecord, grants: AuthorizationGrant[]): void {
    if (record.status === 'prepared' && record.permissionGrants === undefined) return;
    if (grants.some(grant => !record.permissionGrants?.some(original => original.permission === grant.permission
      && original.scope === grant.scope && original.fields === grant.fields))) refuse('remote_execution_grant_scope_expanded');
  }
  private async assertOriginalGrants(record: RemoteExecutionRecord, actor: AuthorizationActor): Promise<number | undefined> {
    if (record.permissionGrants === undefined) {
      if (record.status !== 'prepared') refuse('remote_execution_grant_evidence_unavailable');
      return undefined;
    }
    const current = await this.ports.effective(actor, record.binding.app, record.binding.tenantId);
    if (current.denied || record.permissionGrants.some(original => !current.permissions.some(grant =>
      original.permission === grant.permission && original.scope === grant.scope && original.fields === grant.fields))) {
      refuse('remote_execution_original_grant_revoked');
    }
    this.assertGrantCeiling(record, current.permissions);
    return current.revision;
  }
  private authorize(actor: AuthorizationActor, operation: AuthorizationOperation) {
    return runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
      principalIssuer: actor.issuer, isOperator: false }, () => this.ports.authorize(actor, operation)));
  }
  private assertGeneration(record: RemoteExecutionRecord): void {
    const current = this.ports.snapshot(record.binding.app);
    if (!current || Object.keys(record.snapshot).some(key => current[key as keyof typeof current] !== record.snapshot[key as keyof typeof current])) {
      refuse('remote_execution_generation_changed');
    }
  }
  private assertLive(record: RemoteExecutionRecord): void {
    if (record.version !== 1 || record.status === 'revoked' || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= this.now()) {
      refuse('remote_execution_expired_or_revoked');
    }
  }
  private verifyOriginal(record: RemoteExecutionRecord, token: string): void {
    if (!record.claims || record.tokenHash !== hash(token)) refuse('remote_execution_token_mismatch');
    this.ports.verifier.verify(token, { ...record.claims, scope: SWARM_EXECUTE_DELEGATION_SCOPE });
  }
  private assertPhase(record: RemoteExecutionRecord, input: RemoteExecutionCheck): void {
    if (record.nonces.includes(input.nonce)) refuse('remote_execution_challenge_replayed', 409);
    if (record.nonces.length >= 4096) refuse('remote_execution_challenge_limit');
    if (input.phase === 'start' ? record.status !== 'bound' : record.status !== 'started') refuse('remote_execution_phase_refused', 409);
  }
}
