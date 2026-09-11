/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 */
/** Narrow composition-injected boundary for controller tool/bot/job execution. */
import type { AuthorizationActor, AuthorizationBindingKind, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { runWithRequestIdentity } from '@/shared/services/database/request-identity';
export interface ApplicationExecutionPolicy {
  owner(kind: 'bots' | 'tools', id: string): string | undefined | Promise<string | undefined>;
  protectedApp(app: string): boolean | Promise<boolean>;
  authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision>;
}
export interface ApplicationExecutionInput {
  kind: Exclude<AuthorizationBindingKind, 'http'>;
  operation: string;
  /** Supplied only by a code-owned schedule/artifact registration, never model input. */
  app?: string;
  userSub?: string;
  tenantId?: string;
}
let policy: ApplicationExecutionPolicy | undefined;
/** The application composition root owns this port; features never import the runtime implementation. */
export function configureApplicationExecutionPolicy(value: ApplicationExecutionPolicy | undefined): void { policy = value; }
export class ApplicationExecutionDeniedError extends Error {
  readonly status = 403;
  readonly statusCode = 403;
  constructor(public readonly code: string) { super(code); this.name = 'ApplicationExecutionDeniedError'; }
}
/** Recheck current rights, then constrain all transitive database work to the actual business user. */
export async function runWithApplicationExecution<T>(input: ApplicationExecutionInput, execute: () => Promise<T>): Promise<T> {
  const currentPolicy = policy;
  if (!currentPolicy) return execute();
  const app = input.app ?? (input.kind === 'bots' || input.kind === 'tools' ? await currentPolicy?.owner(input.kind, input.operation) : undefined);
  if (!app || !await currentPolicy.protectedApp(app)) return execute();
  const actor = getApplicationAuthorizationActor();
  if (!actor?.isActive || !actor.sub || !actor.issuer || (input.userSub !== undefined && input.userSub !== actor.sub)) {
    throw new ApplicationExecutionDeniedError('authorization_execution_identity_required');
  }
  return runWithRequestIdentity({ sub: actor.sub, principalIssuer: actor.issuer, isOperator: false }, async () => {
    const decision = await currentPolicy.authorize(actor, { app, kind: input.kind, operation: input.operation,
      ...(input.tenantId ? { tenantId: input.tenantId } : {}) });
    if (!decision.allowed) throw new ApplicationExecutionDeniedError(decision.reason);
    return execute();
  });
}
