/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Define the durable SEC-01 workload credential, user delegation, rollout, and atomic-consumption contracts.
 */

import type { DelegationTokenClaims } from '@/shared/types';

/** @description Workload classes admitted by the durable machine-identity authority. */
export type WorkloadKind = 'bot' | 'node' | 'controller' | 'automation';

/** @description Administrative lifecycle applied before any workload may receive user authority. */
export type WorkloadStatus = 'active' | 'suspended' | 'revoked';

/** @description Compatibility stages for migration away from the fleet-wide service secret. */
export type WorkloadDelegationMode = 'legacy' | 'shadow' | 'enforce';

/** @description Durable public metadata for one workload; no reusable credential is returned. */
export interface WorkloadIdentityRecord {
  workloadId: string;
  workloadKind: WorkloadKind;
  allowedScopes: string[];
  status: WorkloadStatus;
  expiresAt: Date | null;
  currentKeyId: string;
  rotatedAt: Date | null;
  previousKeyId: string | null;
  previousValidUntil: Date | null;
}

/** @description Input used once to register a hash-only 256-bit static workload credential. */
export interface RegisterWorkloadIdentityInput {
  workloadId: string;
  workloadKind: WorkloadKind;
  credential: string;
  keyId: string;
  allowedScopes: readonly string[];
  expiresAt?: Date | null;
}

/** @description Compare-and-set input for overlapping workload credential rotation. */
export interface RotateWorkloadCredentialInput {
  workloadId: string;
  expectedCurrentKeyId: string;
  nextCredential: string;
  nextKeyId: string;
  previousValidUntil: Date;
  rotatedAt?: Date;
}

/** @description Static credential assertion accepted only by deterministic non-model code. */
export interface AuthenticateWorkloadCredentialInput {
  workloadId: string;
  keyId: string;
  credential: string;
  requiredScopes: readonly string[];
  at?: Date;
}

/** @description Dispatch identity persisted beside the exact signed delegation claims. */
export interface RecordUserDelegationInput {
  claims: DelegationTokenClaims;
  ticketId?: string;
  runId?: string;
}

/** @description Result of the final locked durable authorization and replay decision. */
export type WorkloadDelegationConsumeOutcome =
  | 'authorized'
  | 'not_found'
  | 'revoked'
  | 'replayed'
  | 'expired'
  | 'not_active'
  | 'binding_mismatch'
  | 'insufficient_scope';

/** @description PostgreSQL authority used by issuance, rotation, revocation, and route middleware. */
export interface WorkloadDelegationStore {
  /** @description Registers a new hash-only workload identity without overwriting an existing id. */
  registerWorkload(input: RegisterWorkloadIdentityInput): Promise<WorkloadIdentityRecord>;
  /** @description Rotates a workload secret while retaining one explicitly bounded previous key. */
  rotateWorkloadCredential(input: RotateWorkloadCredentialInput): Promise<boolean>;
  /** @description Authenticates a static workload credential and its exact required scopes. */
  authenticateWorkloadCredential(input: AuthenticateWorkloadCredentialInput): Promise<boolean>;
  /** @description Checks workload lifecycle/scope before the controller signs user authority. */
  canIssueForWorkload(workloadId: string, scopes: readonly string[], at?: Date): Promise<boolean>;
  /** @description Persists every immutable signed claim before its token leaves the controller. */
  recordDelegation(input: RecordUserDelegationInput): Promise<void>;
  /** @description Atomically validates and consumes one signed durable delegation tuple. */
  consumeDelegation(claims: DelegationTokenClaims, at?: Date): Promise<WorkloadDelegationConsumeOutcome>;
  /** @description Irreversibly revokes an unexpired delegation by jti. */
  revokeDelegation(jti: string, revokedAt?: Date): Promise<boolean>;
}
