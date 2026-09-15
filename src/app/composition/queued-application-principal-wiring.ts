/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Install durable queued principal capture before authenticated ticket creation and background execution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Ask authorization readiness per capture instead of chaining off it once. Derived once, this readiness inherited a boot-time bootstrap failure permanently, and every authenticated ticket creation threw on the capture that follows the insert.
 */
import type { AppContext } from './app-context';
import { PostgresQueuedApplicationPrincipalStore, ensureQueuedApplicationPrincipalSchema } from '@/features/ticketing';
import { configureQueuedApplicationPrincipals } from '@/shared/queued-application-principal';
import { createChildLogger } from '@/shared/logger';
import { createRetryableReady } from '@/shared/services/database';
const logger = createChildLogger({ module: 'queued-application-principals' });

/** @description Bind installation readiness and controller-only queue authority.
 * The barrier is a thunk, and this wiring's own readiness is re-requestable for the same reason:
 * every authenticated ticket creation captures its initiator, so a readiness that cached one
 * boot-time failure refused ticket creation for the life of the process.
 * @param ctx Controller services. @param bootstrap Re-requestable core schema barrier. @returns Re-requestable schema readiness.
 */
export function createQueuedApplicationPrincipalWiring(ctx: AppContext, bootstrap: () => Promise<unknown>): () => Promise<void> {
  const ready = createRetryableReady(async () => {
    await bootstrap();
    await ensureQueuedApplicationPrincipalSchema(ctx.pool);
  });
  configureQueuedApplicationPrincipals(new PostgresQueuedApplicationPrincipalStore(ctx.pool, ready));
  void ready().catch(err => logger.error({ err },
    'Queued application authority unavailable; the next capture retries the schema bootstrap'));
  return ready;
}
