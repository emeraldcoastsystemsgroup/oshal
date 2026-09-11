/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
import type { AuthorizationActor, AuthorizationChange, AuthorizationPreview, AuthorizationReceipt } from '@/shared/application-authorization';
export interface AuthorizationAssignment {
  id: string; app: string; source: string; catalogRevision: string;
  targetSub?: string; targetIssuer?: string; tenantId?: string;
  group?: { issuer: string; tenantId: string; id: string };
  role?: string; permission?: string; deny: boolean; expiresAt?: string;
}
export interface StoredAuthorizationPreview extends AuthorizationPreview {
  actor: { sub: string; issuer: string }; receipt?: AuthorizationReceipt; idempotencyKey?: string;
}
export interface AuthorizationState {
  revision: number; assignments: AuthorizationAssignment[]; previews: StoredAuthorizationPreview[];
}
export interface AuthorizationAudit {
  id: string; actor: Pick<AuthorizationActor, 'sub' | 'issuer'>; at: string;
  change: AuthorizationChange; revision: number; previewId: string;
}
export interface AuthorizationTransaction { state: AuthorizationState; audit(event: AuthorizationAudit): void }
export interface AuthorizationStore {
  publishAppPosture(app: string, protectedApp: boolean, agentIds: readonly string[], toolNames?: readonly string[]): Promise<void>;
  read(): Promise<AuthorizationState>;
  transaction<T>(operation: (transaction: AuthorizationTransaction) => Promise<T>): Promise<T>;
}
/** Structured expected denial; HTTP/tool adapters should preserve status/code, not expose stacks. */
export class ApplicationAuthorizationError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'ApplicationAuthorizationError'; }
}
