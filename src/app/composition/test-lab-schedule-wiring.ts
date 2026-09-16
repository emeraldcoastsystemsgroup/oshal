/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resume administrator-owned local schedules through current exact-principal account and policy resolution.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Carry the saved package selector through fresh scheduled visibility resolution.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Ask the run-wiring readiness per schedule operation. Chaining off it once inherited a boot-time bootstrap failure permanently, so schedule reads stayed dead after the bootstrap itself recovered.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Start the poll timer independently of the boot-time bootstrap attempt. Reads already recovered per operation, but the timer was started inside that one attempt's continuation, so a single lost boot acquire left local scheduling stopped until the process restarted.
 */
import type { AppContext } from './app-context';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { SwarmAppService } from '@/features/swarm-apps';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';
import { createRetryableReady } from '@/shared/services/database';
import type { TestLabRunService } from '../routes/test-lab-run-service';
import type { TestLabPrincipal } from '../routes/test-lab-run-types';
import { TestLabScheduleService } from '../routes/test-lab-schedule-service';
import { PostgresTestLabScheduleStore } from '../routes/test-lab-schedule-store';
import { ensureTestLabScheduleSchema } from '../routes/test-lab-schedule-schema';

export interface TestLabScheduledActorPorts {
  targetActor(sub: string, issuer: string): Promise<AuthorizationActor | null>;
  refreshActor(original: AuthorizationActor): Promise<AuthorizationActor | null>;
}
const logger = createChildLogger({ module: 'test-lab-schedules' });

/** @description Refresh the exact owner of an already authorized server-owned schedule without retaining token or group claims. */
export async function resolveTestLabScheduledActor(ports: TestLabScheduledActorPorts, principal: TestLabPrincipal): Promise<AuthorizationActor> {
  const target = await ports.targetActor(principal.sub, principal.issuer);
  if (!target?.isActive || target.sub !== principal.sub || target.issuer !== principal.issuer) throw new Error('Scheduled account is unavailable.');
  // Creation requires a current administrator. This bit is that original capability ceiling;
  // refreshActor independently recomputes current account/provider/administrator authority.
  const current = await ports.refreshActor({ ...target, isSwarmAdmin: true, directory: [], allowedPermissions: undefined });
  if (!current?.isActive || !current.isSwarmAdmin || current.sub !== principal.sub || current.issuer !== principal.issuer
    || current.allowedPermissions !== undefined) throw new Error('Scheduled administrator authority is unavailable.');
  return { ...current, directory: [] };
}

/** @description Start catalog scheduling, each cycle carrying its own schema readiness, and stop it through the existing shutdown lifecycle. */
export function createTestLabScheduleWiring(options: {
  ctx: AppContext; apps: SwarmAppService; runs: TestLabRunService; ready(): Promise<unknown>;
  authorization: TestLabScheduledActorPorts; visible: (actor: AuthorizationActor, appName?: string) => Promise<Map<string, string>>;
}): TestLabScheduleService {
  const ready = createRetryableReady(async () => {
    await options.ready();
    await runWithSystemIdentity(() => ensureTestLabScheduleSchema(options.ctx.pool));
  });
  const service = new TestLabScheduleService({ store: new PostgresTestLabScheduleStore(options.ctx.pool, ready),
    runs: options.runs, catalog: options.apps.testLabCatalog,
    resolveScheduledContext: async (principal, appName) => {
      await ready();
      const actor = await resolveTestLabScheduledActor(options.authorization, principal);
      return { actor: { issuer: actor.issuer, sub: actor.sub }, visibleApps: await options.visible(actor, appName), auth: { canRunSuites: actor.isSwarmAdmin } };
    } });
  // Bootstrap eagerly so a due occurrence is not what pays for the schema, but do NOT make the poll
  // timer depend on that one attempt. `ready` is re-requestable and every schedule read asks it
  // again, so a cycle that runs before the schema exists fails and the next cycle re-attempts the
  // bootstrap. Starting the timer inside this attempt's continuation is what left local scheduling
  // stopped until the process restarted after a single lost boot-time pool acquire — long after the
  // bootstrap underneath had recovered.
  void ready().catch(error => logger.error({ err: error }, 'Local Test Lab schedule bootstrap failed; the next poll cycle retries it'));
  service.startPolling();
  registerShutdownHook('test-lab-schedules', () => service.stop());
  return service;
}
