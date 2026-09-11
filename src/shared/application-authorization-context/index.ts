/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry the authenticated business principal through asynchronous package and Jarvis work.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthorizationActor } from '@/shared/application-authorization';

const actors = new AsyncLocalStorage<AuthorizationActor>();
/** Establish an actor only at a trusted authentication/delegation boundary. */
export function runWithApplicationAuthorizationActor<T>(actor: AuthorizationActor, operation: () => T): T {
  return actors.run(actor, operation);
}
/** Read the verified actor; absence is never a system or admin grant. */
export function getApplicationAuthorizationActor(): AuthorizationActor | undefined { return actors.getStore(); }
