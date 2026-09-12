/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Retain verified queue initiators outside mutable ticket metadata and restore restricted execution context.
 */
import type { AuthorizationActor } from '@/shared/application-authorization';
import { getApplicationAuthorizationActor, runWithApplicationAuthorizationActor } from '@/shared/application-authorization-context';
import { getRequestIdentity, runWithRequestIdentity } from '@/shared/services/database/request-identity';

/** @description Controller-only durable provenance port; captured actors contain no credentials. */
export interface QueuedApplicationPrincipalStore {
  capture(ticketId: string, actor: AuthorizationActor): Promise<void>;
  read(ticketId: string): Promise<AuthorizationActor | null>;
}
let store: QueuedApplicationPrincipalStore | undefined;

/** @description Install durable provenance from controller composition.
 * @param value Trusted store, or undefined in isolated teardown. @returns Nothing.
 */
export function configureQueuedApplicationPrincipals(value: QueuedApplicationPrincipalStore | undefined): void { store = value; }

/** @description Capture only the authenticated creator, never body or ticket metadata authority.
 * @param ticketId Newly created ticket. @param ownerSub Chosen owner. @returns Completion after immutable persistence.
 */
export async function captureQueuedApplicationPrincipal(ticketId: string, ownerSub: string | null | undefined): Promise<void> {
  const actor = getApplicationAuthorizationActor(), identity = getRequestIdentity();
  if (!store || !actor?.isActive || !ownerSub) return;
  if (actor.sub !== ownerSub || identity?.sub !== actor.sub || identity.principalIssuer !== actor.issuer) return;
  await store.capture(ticketId, structuredClone(actor));
}

/** @description Restore a persisted initiator only for a protected target; current policy still authorizes every dispatch.
 * @param ticket Trusted durable ticket identifiers. @param required Whether target requires application authority.
 * @param execute Controller bot call. @returns Its result under the original exact user's restricted identity.
 */
export async function runWithQueuedApplicationPrincipal<T>(ticket: { ticketId: string; ownerSub: string | null; issuer: string | null },
  required: boolean, execute: () => Promise<T>): Promise<T> {
  if (!required) return execute();
  const actor = await store?.read(ticket.ticketId);
  if (!actor?.isActive || !actor.issuer || !ticket.issuer || actor.sub !== ticket.ownerSub || actor.issuer !== ticket.issuer) {
    throw new Error('authorization_queue_provenance_required');
  }
  return runWithApplicationAuthorizationActor(actor, () => runWithRequestIdentity({ sub: actor.sub,
    principalIssuer: actor.issuer, isOperator: false }, execute));
}
