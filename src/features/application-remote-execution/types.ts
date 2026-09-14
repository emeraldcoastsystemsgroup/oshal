/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Keep immutable remote execution provenance separate from live policy decisions.
 */
import type { AuthorizationActor, AuthorizationDecision, AuthorizationEffective, AuthorizationGrant, AuthorizationOperation } from '@/shared/application-authorization';
import type { RemoteApplicationSnapshot, RemoteExecutionBinding } from '@/shared/application-remote-execution';
import type { DelegationTokenClaims } from '@/shared/types';
import type { DelegationTokenVerifier, RecordedDelegationTokenIssuer } from '@/shared/security/delegation-token';

/** @description Durable controller record; signed body content and tokens are never stored. */
export interface RemoteExecutionRecord {
  version: 1; binding: RemoteExecutionBinding; actor: AuthorizationActor; snapshot: RemoteApplicationSnapshot;
  status: 'prepared' | 'bound' | 'started' | 'completed' | 'revoked';
  createdAt: string; expiresAt: string; claims?: DelegationTokenClaims; tokenHash?: string;
  nonces: string[]; permissionGrants?: AuthorizationGrant[]; resultTaskIds?: string[]; startedAt?: string; completedAt?: string;
}
/** @description Transaction port used identically by PostgreSQL and isolated memory tests. */
export interface RemoteExecutionStore {
  insert(record: RemoteExecutionRecord): Promise<void>;
  read(executionId: string): Promise<RemoteExecutionRecord | null>;
  byTask(taskId: string): Promise<RemoteExecutionRecord[]>;
  update<T>(executionId: string, operation: (record: RemoteExecutionRecord) => Promise<T>): Promise<T>;
}
/** @description Live controller policy and signing seams; no worker can supply these implementations. */
export interface RemoteExecutionPorts {
  owner(kind: 'bots' | 'tools', id: string): Promise<{ app: string; protected: boolean } | undefined>;
  snapshot(app: string): RemoteApplicationSnapshot | null;
  refreshActor(actor: AuthorizationActor): Promise<AuthorizationActor | null>;
  authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision>;
  effective(actor: AuthorizationActor, app: string, tenantId?: string): Promise<AuthorizationEffective>;
  verifier: DelegationTokenVerifier;
  issuer: RecordedDelegationTokenIssuer;
  tokenIssuer: string;
  dispatchAudience: string;
  now?: () => number;
}
/** @description Sanitized failure suitable for controller and worker refusal responses. */
export class RemoteExecutionError extends Error {
  /** @description Preserve an explicit refusal status without revealing stored execution data.
   * @param code Public reason. @param status HTTP status. @returns The sanitized error instance.
   */
  constructor(public readonly code: string, public readonly status = 403) { super(code); this.name = 'RemoteExecutionError'; }
}
