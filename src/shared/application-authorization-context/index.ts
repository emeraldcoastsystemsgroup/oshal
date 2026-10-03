/**
 * CHANGE LOG
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Carry the authenticated business principal through asynchronous package and Jarvis work.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Clear ambient application authority for the scoped anonymous package byte reader.
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
/**
 * @description Prevent a public byte reader from inheriting upstream application authority.
 * @param operation Anonymous handler scope; the surrounding actor is restored afterward.
 * @returns The handler result without manufacturing a user or service principal.
 */
export function runWithoutApplicationAuthorizationActor<T>(operation: () => T): T { return actors.exit(operation); }
