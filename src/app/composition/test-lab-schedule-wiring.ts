/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Resume administrator-owned local schedules through current exact-principal account and policy resolution.
 */
import type { AppContext } from './app-context';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { SwarmAppService } from '@/features/swarm-apps';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import { registerShutdownHook } from '@/shared/services/shutdown-hooks';
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

/** @description Start catalog scheduling only after schema readiness and stop it through the existing shutdown lifecycle. */
export function createTestLabScheduleWiring(options: {
  ctx: AppContext; apps: SwarmAppService; runs: TestLabRunService; ready: Promise<unknown>;
  authorization: TestLabScheduledActorPorts; visible: (actor: AuthorizationActor) => Promise<Map<string, string>>;
}): TestLabScheduleService {
  let stopping = false;
  const ready = options.ready.then(() => runWithSystemIdentity(() => ensureTestLabScheduleSchema(options.ctx.pool)));
  const service = new TestLabScheduleService({ store: new PostgresTestLabScheduleStore(options.ctx.pool, ready),
    runs: options.runs, catalog: options.apps.testLabCatalog,
    resolveScheduledContext: async principal => {
      await ready;
      const actor = await resolveTestLabScheduledActor(options.authorization, principal);
      return { actor: { issuer: actor.issuer, sub: actor.sub }, visibleApps: await options.visible(actor), auth: { canRunSuites: actor.isSwarmAdmin } };
    } });
  void ready.then(() => { if (!stopping) service.startPolling(); }).catch(error => logger.error({ err: error }, 'Local Test Lab schedules unavailable'));
  registerShutdownHook('test-lab-schedules', () => { stopping = true; service.stop(); });
  return service;
}
