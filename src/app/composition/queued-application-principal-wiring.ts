/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Install durable queued principal capture before authenticated ticket creation and background execution.
 */
import type { AppContext } from './app-context';
import { PostgresQueuedApplicationPrincipalStore, ensureQueuedApplicationPrincipalSchema } from '@/features/ticketing';
import { configureQueuedApplicationPrincipals } from '@/shared/queued-application-principal';
import { createChildLogger } from '@/shared/logger';
const logger = createChildLogger({ module: 'queued-application-principals' });

/** @description Bind installation readiness and controller-only queue authority.
 * @param ctx Controller services. @param bootstrap Core schema barrier. @returns Schema readiness.
 */
export function createQueuedApplicationPrincipalWiring(ctx: AppContext, bootstrap: Promise<unknown>): Promise<void> {
  const ready = bootstrap.then(() => ensureQueuedApplicationPrincipalSchema(ctx.pool));
  configureQueuedApplicationPrincipals(new PostgresQueuedApplicationPrincipalStore(ctx.pool, ready));
  void ready.catch(err => logger.error({ err }, 'Queued application authority unavailable'));
  return ready;
}
