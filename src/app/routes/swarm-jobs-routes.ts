/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-174 Amendment B (step B5-9): GET /api/admin/jobs, every scheduled job on the box for the Swarm Admin jobs screen. The platform scheduler's records are read the way the operator's ?scope=all listing reads them (ScheduleService.listSchedules through the process-lifetime handle schedule-runtime sets, never Redis directly), each with a kind derived from its taskType. Every ACTIVE application's declared service-route schedules come with their activation state through the same ADR-157 activation authority the /api/swarm/apps/:name/services route uses (composed once in application-service-activation-wiring), each saying whether the package registered an authorization catalog, because a system service without one is refused under the enforce posture and the screen says so before offering the button. The core's built-in in-process timers report their env gates read at request time, booleans and intervals only. Each manifest schedule (taskType app:{app}-{id} or app-route:{app}-{id}, no per-user suffix) carries the operator's standing override from the same store PATCH /api/swarm/apps/:name/schedules/:id writes (ScheduleService.getManifestOverride), so the screen can say "paused by the operator" and offer Pause or Resume through that route. An application whose listing throws becomes a warning instead of failing the reply. Mounted behind requiresAuth and requiresOperator.
 */

import { Router as createRouter, type Request, type Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import type { AuthorizationActor } from '@/shared/application-authorization';
import type { ApplicationServicesView } from '@/features/application-authorization';
import type { ScheduleRecord, ScheduleService } from '@/features/scheduling';
import { getHomeScheduleService } from '../home-schedule-dispatch';
import { getApplicationServiceActivations } from '../application-service-activation-wiring';
import { readBuiltInTimers, readSchedulerGate, type BuiltInTimer } from './swarm-jobs-timers';

const logger = createChildLogger({ module: 'swarm-jobs-routes' });

/** What a scheduled record is for, derived from its taskType prefix. */
export type SwarmJobKind = 'service' | 'prompt' | 'trading' | 'workflow' | 'reminder' | 'home' | 'other';

/** One scheduler record as the jobs screen shows it. */
export interface SwarmJobScheduleView {
  id: string;
  taskType: string;
  kind: SwarmJobKind;
  /** The application (queue) it belongs to; null for a system or legacy record. */
  app: string | null;
  cron: string;
  /** IANA zone the cron is read in; null = the server clock. */
  timezone: string | null;
  status: 'active' | 'paused';
  /** The person who created it; null = the system. */
  ownerSub: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  executionCount: number;
  once: boolean;
  /** For a manifest schedule, the operator's standing override (enabled false = paused by the operator; cron when changed), null when none; null for every other record. */
  override: { enabled: boolean; cron: string | null } | null;
}

/** One declared service-route schedule of an active application with its activation state. */
export interface SwarmJobServiceView {
  app: string;
  /** The full schedule id the scheduler dispatches: `{app}-{id}`; its record's taskType is `app-route:{scheduleId}`. */
  scheduleId: string;
  id: string;
  cron: string;
  /** The live activation's class, else the package's proposed class, else null (unclassified). */
  runsAs: 'system' | 'user' | null;
  /** The permission names the package declares for the job. */
  requires: string[];
  state: 'not-activated' | 'active' | 'suspended';
  /** True when the package registered an authorization catalog: without one, a system activation is refused under the enforce posture. */
  catalog: boolean;
}

/** One application (or port) whose part of the listing could not be read. */
export interface SwarmJobsWarning {
  app: string;
  error: string;
}

/** The ADR-157 activation ports the listing borrows, narrowed to what it reads. */
export interface SwarmJobsActivationPorts {
  listServices(actor: AuthorizationActor, app: string): Promise<ApplicationServicesView>;
  resolveActor(req: Request): Promise<AuthorizationActor>;
  describeApp(app: string): { catalog: unknown } | null;
  activeServiceApps(): Promise<string[]>;
}

/** The process-lifetime handles the route reads, resolved per request so boot order never matters. */
export interface SwarmJobsDeps {
  scheduler(): Pick<ScheduleService, 'listSchedules' | 'getManifestOverride'> | null;
  activations(): SwarmJobsActivationPorts | undefined;
  env(): NodeJS.ProcessEnv;
}

/** The reply of GET /api/admin/jobs. */
export interface SwarmJobsView {
  generatedAt: string;
  scheduler: { enabled: boolean; pollIntervalMs: number };
  schedules: SwarmJobScheduleView[];
  services: SwarmJobServiceView[];
  timers: BuiltInTimer[];
  warnings: SwarmJobsWarning[];
}

/**
 * @description Derives what a scheduler record is for from its taskType prefix, so the screen can
 * group trading legs, package prompts, service routes, workflows and reminders without reading
 * task data.
 * @param taskType - The record's taskType.
 * @returns The kind.
 */
export function jobKind(taskType: string): SwarmJobKind {
  if (taskType.startsWith('app-route:')) return 'service';
  if (taskType.startsWith('app:')) return 'prompt';
  if (taskType.startsWith('trading-')) return 'trading';
  if (taskType.startsWith('workflow:')) return 'workflow';
  if (taskType === 'jarvis-reminder') return 'reminder';
  if (taskType.startsWith('home')) return 'home';
  return 'other';
}

/**
 * @description The override key of a manifest schedule, `{app}-{id}`, from its taskType: the
 * framework-scope record of a prompt (app:{key}) or a service route (app-route:{key}). A per-user
 * instance carries a `:{suffix}` after the key and has no override, like every other record.
 * @param taskType - The record's taskType.
 * @returns The key, or null when the record is not a manifest schedule.
 */
export function manifestScheduleKey(taskType: string): string | null {
  const kind = jobKind(taskType);
  if (kind !== 'service' && kind !== 'prompt') return null;
  const key = taskType.slice(taskType.indexOf(':') + 1);
  return key && !key.includes(':') ? key : null;
}

/** @description A scheduler record as the screen shows it: the identifying and timing fields, never task data. */
function toScheduleView(record: ScheduleRecord, override: SwarmJobScheduleView['override']): SwarmJobScheduleView {
  return {
    id: record.id, taskType: record.taskType, kind: jobKind(record.taskType), app: record.queue ?? null, cron: record.cron,
    timezone: record.timezone ?? null, status: record.status, ownerSub: record.ownerSub ?? null,
    lastRunAt: record.lastRunAt, nextRunAt: record.nextRunAt, executionCount: record.executionCount, once: record.once === true,
    override,
  };
}

/** @description The operator's standing override of a manifest schedule from the store the control route writes, or null. */
async function overrideOf(scheduler: NonNullable<ReturnType<SwarmJobsDeps['scheduler']>>, record: ScheduleRecord): Promise<SwarmJobScheduleView['override']> {
  const key = manifestScheduleKey(record.taskType);
  if (!key) return null;
  const stored = await scheduler.getManifestOverride(key);
  return stored ? { enabled: stored.enabled !== false, cron: stored.cron ?? null } : null;
}

/** @description An error's authorization code when it carries one, else its message. */
function errorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.message : String(err);
}

/** @description Every scheduler record, as the operator's ?scope=all listing reads them; a warning when the scheduler is not wired. */
async function listSchedules(deps: SwarmJobsDeps, warnings: SwarmJobsWarning[]): Promise<SwarmJobScheduleView[]> {
  const scheduler = deps.scheduler();
  if (!scheduler) {
    warnings.push({ app: 'scheduler', error: 'scheduler_unavailable' });
    return [];
  }
  const records = await scheduler.listSchedules({ scope: 'all' });
  return Promise.all(records.map(async (record) => toScheduleView(record, await overrideOf(scheduler, record))));
}

/** @description One application's services with the catalog posture stamped on each. */
function toServiceViews(app: string, view: ApplicationServicesView, catalog: boolean): SwarmJobServiceView[] {
  return view.services.map((service) => ({
    app, scheduleId: service.scheduleId, id: service.id, cron: service.cron,
    runsAs: service.runsAs ?? service.proposedRunsAs ?? null,
    requires: service.requires.map((entry) => entry.permission), state: service.state, catalog,
  }));
}

/**
 * @description The declared services of every active application that has any, through the same
 * activation authority the services route uses. An application that throws becomes a warning.
 */
async function listServices(deps: SwarmJobsDeps, req: Request, warnings: SwarmJobsWarning[]): Promise<SwarmJobServiceView[]> {
  const ports = deps.activations();
  if (!ports) {
    warnings.push({ app: 'activations', error: 'authorization_service_unavailable' });
    return [];
  }
  let actor: AuthorizationActor;
  try {
    actor = await ports.resolveActor(req);
  } catch (err) {
    logger.error({ err }, 'Swarm jobs: the caller could not be resolved as an authorization actor');
    warnings.push({ app: 'activations', error: errorText(err) });
    return [];
  }
  const services: SwarmJobServiceView[] = [];
  for (const app of await ports.activeServiceApps()) {
    try {
      services.push(...toServiceViews(app, await ports.listServices(actor, app), Boolean(ports.describeApp(app)?.catalog)));
    } catch (err) {
      logger.error({ err, app }, "Swarm jobs: an application's services could not be listed");
      warnings.push({ app, error: errorText(err) });
    }
  }
  return services;
}

/**
 * @description Reads everything the jobs screen shows: the scheduler's records, the active
 * applications' services with their activation state, and the built-in timers' gates.
 * @param deps - The process-lifetime handles.
 * @param req - The operator's request (the activation authority resolves the caller from it).
 * @returns The reply.
 */
export async function readSwarmJobs(deps: SwarmJobsDeps, req: Request): Promise<SwarmJobsView> {
  const warnings: SwarmJobsWarning[] = [];
  const schedules = await listSchedules(deps, warnings);
  const services = await listServices(deps, req, warnings);
  const env = deps.env();
  return { generatedAt: new Date().toISOString(), scheduler: readSchedulerGate(env), schedules, services, timers: readBuiltInTimers(env), warnings };
}

/**
 * @description The production handles: the scheduler schedule-runtime exposes and the activation
 * authority application-service-activation-wiring composes, both read per request.
 * @returns The deps.
 */
export function defaultSwarmJobsDeps(): SwarmJobsDeps {
  return {
    scheduler: () => getHomeScheduleService(),
    activations: () => {
      const handles = getApplicationServiceActivations();
      if (!handles) return undefined;
      return {
        listServices: (actor, app) => handles.service.listServices(actor, app),
        resolveActor: (req) => handles.resolveActor(req),
        describeApp: (app) => handles.describeApp(app),
        activeServiceApps: () => handles.activeServiceApps(),
      };
    },
    env: () => process.env,
  };
}

/**
 * @description Builds the /api/admin/jobs router. Mounted behind requiresAuth and requiresOperator;
 * the reply names jobs and gates, never task data, prompts or environment values beyond the
 * registered booleans and intervals.
 * @param deps - The process-lifetime handles (defaultSwarmJobsDeps in production).
 * @returns The router.
 */
export function createSwarmJobsRoutes(deps: SwarmJobsDeps): Router {
  const router = createRouter();
  router.get('/', async (req: Request, res) => {
    const started = Date.now();
    try {
      const view = await readSwarmJobs(deps, req);
      logger.info({ schedules: view.schedules.length, services: view.services.length, warnings: view.warnings.length, durationMs: Date.now() - started }, 'GET /api/admin/jobs');
      res.json(view);
    } catch (err) {
      logger.error({ err, durationMs: Date.now() - started }, 'GET /api/admin/jobs failed');
      res.status(500).json({ error: 'jobs_unavailable' });
    }
  });
  return router;
}
