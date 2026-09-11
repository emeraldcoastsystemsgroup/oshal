/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Exercise real application policy and signed remote provenance without providers or deployment data.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { ApplicationAuthorizationService, MemoryAuthorizationStore } from '@/features/application-authorization';
import { ApplicationRemoteExecutionService, MemoryRemoteExecutionStore, type RemoteExecutionStore } from '@/features/application-remote-execution';
import type { AuthorizationActor, AuthorizationCatalog, AuthorizationChange, AuthorizationResourceAdapter } from '@/shared/application-authorization';
import type { RemoteApplicationSnapshot, RemoteExecutionPhase } from '@/shared/application-remote-execution';
import { createDelegationTokenVerifier, createRecordedDelegationTokenIssuer } from '@/shared/security/delegation-token';
import { delegationRequestBodySha256 } from '@/shared/security/delegation-request-binding';

/** @description Real named bot/tool catalog with separately grantable rights. */
export const REMOTE_FIXTURE_CATALOG: AuthorizationCatalog = {
  version: 1, resources: { records: { scopes: ['own'] } },
  permissions: { 'bot.execute': { resource: 'records', effect: 'execute', minimumTier: 'editor' },
    'record.read': { resource: 'records', effect: 'read', minimumTier: 'viewer' } },
  roles: { runner: { tier: 'editor', grants: [{ permission: 'bot.execute', scope: 'own' }] },
    reader: { tier: 'viewer', grants: [{ permission: 'record.read', scope: 'own' }] } },
  bindings: { bots: [{ id: 'fixture-bot', allOf: ['bot.execute'] }], tools: [{ id: 'fixture-read', allOf: ['record.read'] }] },
};

function signingEnvironment() {
  const pair = generateKeyPairSync('ed25519');
  return { OSHAL_DELEGATION_SIGNING_KID: 'remote-fixture', OSHAL_DELEGATION_TTL_SECONDS: '300',
    OSHAL_DELEGATION_SIGNING_PRIVATE_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    OSHAL_DELEGATION_PUBLIC_KEYS: JSON.stringify({ 'remote-fixture': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) };
}

/** @description Shared controller fixture suitable for real HTTP/worker/result integration tests. */
export class RemoteExecutionFixture {
  now = Date.now(); available = true; active = true;
  readonly actor: AuthorizationActor = { sub: 'same-subject', issuer: 'https://accounts.google.com', isActive: true, isSwarmAdmin: false, tenantIds: [] };
  readonly admin: AuthorizationActor = { sub: 'root', issuer: 'urn:fixture:local', isActive: true, isSwarmAdmin: true };
  readonly policyStore = new MemoryAuthorizationStore();
  readonly policy = new ApplicationAuthorizationService(this.policyStore, { now: () => this.now });
  snapshot!: RemoteApplicationSnapshot;
  adapter: AuthorizationResourceAdapter = { authorize: async () => true };
  beforeAuthorize: (() => Promise<void>) | undefined;
  readonly issuer; readonly verifier; readonly authority: ApplicationRemoteExecutionService;
  /** @description Build real signing and policy ports, optionally reusing worker keys and PostgreSQL.
   * @param store Isolated durable repository. @param env Disposable signing keys. @returns Fixture instance.
   */
  constructor(readonly store: RemoteExecutionStore = new MemoryRemoteExecutionStore(), readonly env = signingEnvironment()) {
    this.issuer = createRecordedDelegationTokenIssuer({ env, nowEpochSeconds: () => Math.floor(this.now / 1000) });
    this.verifier = createDelegationTokenVerifier({ env: { OSHAL_DELEGATION_PUBLIC_KEYS: env.OSHAL_DELEGATION_PUBLIC_KEYS }, nowEpochSeconds: () => Math.floor(this.now / 1000) });
    this.authority = new ApplicationRemoteExecutionService(store, {
      now: () => this.now, issuer: this.issuer, verifier: this.verifier, tokenIssuer: 'urn:oshal:controller', dispatchAudience: 'urn:oshal:bot-node',
      snapshot: () => this.available ? this.snapshot : null,
      owner: async (kind, id) => (kind === 'bots' && id === 'fixture-bot') || (kind === 'tools' && id === 'fixture-read') ? { app: 'fixture-app', protected: true } : undefined,
      refreshActor: async actor => this.active && actor.sub === this.actor.sub && actor.issuer === this.actor.issuer ? { ...actor, isActive: true } : null,
      authorize: async (actor, operation) => { await this.beforeAuthorize?.(); return this.policy.authorize(actor, operation); },
      effective: (actor, app, tenantId) => this.policy.effective(actor, { app, tenantId }),
    });
  }
  /** @description Register an application and explicit runner grant through actual preview/apply.
   * @param catalog Fixture imported contract or explicit fallback. @param role Initial direct role. @returns Ready fixture.
   */
  async start(catalog: AuthorizationCatalog | null = REMOTE_FIXTURE_CATALOG, role = 'runner'): Promise<this> {
    await this.policy.registerApp({ app: 'fixture-app', version: '1', source: 'fixture-source', catalog,
      mode: 'enforce', agentIds: ['fixture-bot'], toolNames: ['fixture-read'], adapters: { records: { authorize: input => this.adapter.authorize(input) } } });
    this.snapshot = { app: 'fixture-app', source: 'fixture-source', catalogRevision: this.policy.getApp('fixture-app')!.catalogRevision, generation: randomUUID() };
    await this.change({ role }); return this;
  }
  /** @description Mutate real application grants for revocation and ceiling regressions.
   * @param overrides Explicit fixture change. @returns Applied receipt.
   */
  async change(overrides: Partial<AuthorizationChange> = {}) {
    const preview = await this.policy.previewChange(this.admin, { app: 'fixture-app', action: 'grant', role: 'runner',
      targetSub: this.actor.sub, targetIssuer: this.actor.issuer, expectedRevision: (await this.policyStore.read()).revision,
      reason: 'Isolated remote authorization test', ...overrides });
    return this.policy.applyChange(this.admin, { previewId: preview.previewId, idempotencyKey: randomUUID() });
  }
  /** @description Prepare and bind the exact signed body used by a remote dispatch.
   * @param actor Authenticated initiating principal. @param extra Controlled body values. @returns Signed dispatch and durable ID.
   */
  async dispatch(actor = this.actor, extra: Record<string, unknown> = {}) {
    const prepared = (await this.authority.prepare(actor, { agentId: 'fixture-bot', taskId: 'fixture-task', workspaceId: 'fixture-workspace' }))!;
    const body = { taskId: 'fixture-task', workspaceFolderId: 'fixture-workspace', userSub: actor.sub, principalIssuer: actor.issuer,
      applicationExecutionId: prepared.executionId, ...extra };
    const receipt = this.issuer.issue({ iss: 'urn:oshal:controller', aud: 'urn:oshal:bot-node', azp: 'fixture-bot', task_id: body.taskId,
      sub: actor.sub, principal_iss: actor.issuer, method: 'POST', path: '/api/swarm-execute', scope: ['swarm:execute'], body_sha256: delegationRequestBodySha256(body) });
    await this.authority.bind(prepared.executionId, receipt, body);
    return { executionId: prepared.executionId, token: receipt.token, receipt, body };
  }
  /** @description Issue a unique worker challenge for a fixture dispatch.
   * @param dispatch Bound execution. @param phase Requested phase. @returns Real signed current-rights permit.
   */
  check(dispatch: { executionId: string; token: string }, phase: RemoteExecutionPhase) {
    return this.authority.revalidate({ executionId: dispatch.executionId, token: dispatch.token, phase, nonce: randomUUID() });
  }
}
