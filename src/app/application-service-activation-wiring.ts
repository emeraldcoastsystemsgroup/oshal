/**
 * ADR-157: assemble the activation authority from the pieces that already exist — the durable
 * activation rows, the ADR-149 policy store, the active manifests, and the shared scheduler that
 * owns per-user schedule instances. Nothing here decides authority; it wires the ports the
 * activation service and the routes both read.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157 S1: compose the scheduled-service activation authority, register it with the service-route runner, and expose it to the kernel-served services routes the way the scheduler handle is already exposed.
 *
 * @module application-service-activation-wiring
 */
import type { Request } from 'express';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { AuthorizationActor, AuthorizationDecision, AuthorizationOperation } from '@/shared/application-authorization';
import {
  ApplicationServiceActivationService, PostgresApplicationServiceActivationStore,
  ensureApplicationServiceActivationSchema,
  type ApplicationServiceDeclaration, type AuthorizationStore,
} from '@/features/application-authorization';
import type { SwarmAppServiceRouteScheduleDeclaration, SwarmAppService } from '@/features/swarm-apps';
import { MANIFEST_SERVICE_ROUTE_TASK_KIND } from '@/features/scheduling';
import { getHomeScheduleService } from './home-schedule-dispatch';
import { manifestServiceRouteTaskType } from './manifest-service-route-schedule';
import { setManifestServiceActivationRuntime } from './manifest-service-route-activation';

const logger = createChildLogger({ module: 'application-service-activation-wiring' });

/** What the kernel's services routes need: the authority, and the verified caller behind a request. */
export interface ApplicationServiceActivationHandles {
  service: ApplicationServiceActivationService;
  resolveActor(req: Request): Promise<AuthorizationActor>;
}

let handles: ApplicationServiceActivationHandles | undefined;

/**
 * @description The process-lifetime activation authority, or undefined before boot has wired it.
 * Routes read it through this holder so the kernel's services endpoints need no new constructor
 * argument threaded through the swarm-app router — the same shape the scheduler handle uses.
 * @returns The activation service and actor resolver once composed.
 */
export function getApplicationServiceActivations(): ApplicationServiceActivationHandles | undefined {
  return handles;
}

/** @description Replace the composed handles. Tests use it to install isolated ports and clear them. */
export function setApplicationServiceActivations(value: ApplicationServiceActivationHandles | undefined): void {
  handles = value;
}

/** Ports the composition root already owns and this wiring borrows. */
export interface ApplicationServiceActivationWiringDeps {
  pool: Pool;
  /** Schema readiness for the ADR-149 control plane. */
  ready: Promise<unknown>;
  policy: AuthorizationStore;
  describeApp(app: string): { source: string; catalogRevision: string; catalog: import('@/shared/application-authorization').AuthorizationCatalog | null } | null;
  authorize(actor: AuthorizationActor, operation: AuthorizationOperation): Promise<AuthorizationDecision>;
  getApps(): SwarmAppService;
  /** Resolves the verified caller behind an authenticated request. */
  resolveActor(req: Request): Promise<AuthorizationActor>;
}

/** @description Sanitised, bounded per-user schedule suffix — the same shape the prompt polls use. */
function instanceSuffix(userSub: string): string {
  return userSub.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
}

/** @description Read one application's declared service-route schedules from its ACTIVE manifest. */
async function declaredServices(getApps: () => SwarmAppService, app: string): Promise<ApplicationServiceDeclaration[]> {
  const manifest = (await getApps().getActiveManifests()).find(item => item.name === app);
  const declared = (manifest?.schedules ?? []).filter(
    (schedule): schedule is SwarmAppServiceRouteScheduleDeclaration =>
      schedule.target === 'service-route' && schedule.enabled !== false,
  );
  return declared.map(schedule => ({
      app, id: schedule.id, scheduleId: `${app}-${schedule.id}`, cron: schedule.cron,
      ...(schedule.description ? { description: schedule.description } : {}),
      ...(schedule.runsAs ? { runsAs: schedule.runsAs } : {}),
      requires: [...(schedule.requires ?? [])], queue: app,
    }));
}

/** @description Register or remove the per-user schedule instance one user activation runs on. */
async function userInstance(
  input: { declaration: ApplicationServiceDeclaration; userSub: string },
  action: 'register' | 'remove',
): Promise<void> {
  const scheduler = getHomeScheduleService();
  if (!scheduler) throw new Error('Scheduler unavailable for a user service activation');
  const taskType = `${manifestServiceRouteTaskType(input.declaration.scheduleId)}:${instanceSuffix(input.userSub)}`;
  if (action === 'remove') {
    const all = await scheduler.listSchedules({ scope: 'all' } as never);
    for (const record of all.filter(row => String(row.taskType || '') === taskType)) {
      await scheduler.deleteSchedule(record.id);
    }
    return;
  }
  await scheduler.createSchedule({
    taskType, schedule: input.declaration.cron,
    taskData: { kind: MANIFEST_SERVICE_ROUTE_TASK_KIND, scheduleKey: input.declaration.scheduleId },
    ownerSub: input.userSub, queue: input.declaration.queue,
  });
}

/**
 * @description Compose the ADR-157 activation authority and hand it to the service-route runner.
 * Called once from the application-authorization composition, after the policy store exists.
 * @param deps - The control-plane ports this wiring borrows.
 * @returns The activation service, also reachable through getApplicationServiceActivationService.
 */
export function createApplicationServiceActivationWiring(
  deps: ApplicationServiceActivationWiringDeps,
): ApplicationServiceActivationService {
  const schemaReady = deps.ready.then(() => ensureApplicationServiceActivationSchema(deps.pool));
  void schemaReady.catch(error => logger.error({ err: error }, 'Scheduled service activations unavailable'));
  const activations = new PostgresApplicationServiceActivationStore(deps.pool, schemaReady);
  const service = new ApplicationServiceActivationService({
    activations, policy: deps.policy, describeApp: deps.describeApp, authorize: deps.authorize,
    declaredServices: app => declaredServices(deps.getApps, app),
    registerUserInstance: input => userInstance(input, 'register'),
    removeUserInstance: input => userInstance(input, 'remove'),
  });
  handles = { service, resolveActor: deps.resolveActor };
  setManifestServiceActivationRuntime({
    resolveDispatch: input => service.resolveDispatch(input),
    suspend: (activation, reason) => service.suspend(activation, reason),
  });
  return service;
}
