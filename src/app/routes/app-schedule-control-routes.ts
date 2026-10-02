/**
 * Operator control of an application's manifest schedules: list them with their live state, and
 * turn one on or off or change how often it runs. The change is stored as a standing override
 * (ManifestScheduleOverride) that the manifest registrar applies at every registration, and it is
 * applied to the live record at once.
 *
 * Both routes sit on the `/api/swarm/apps` router (already behind requiresAuth) and each carries
 * requiresOperator: a manifest schedule is shared, system-wide work, and the schedule API refuses
 * to edit one at all. This is the one sanctioned path.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | GET /:name/schedules and PATCH /:name/schedules/:id (operator ask 2026-10-02: the World screen shows its cron jobs and turns them on/off or more/less frequent). A cron tighter than APP_SCHEDULE_MIN_INTERVAL_MINUTES (default 5) between any two of its next twelve fires is refused, because a fire that outruns its interval stacks on the next one.
 *
 * @module app-schedule-control-routes
 */
import type { Request, Response, Router } from 'express';
import { createChildLogger } from '@/shared/logger';
import { getCaller, requiresOperator } from '@/shared/middleware/authz';
import type { SwarmAppManifest, SwarmAppScheduleDeclaration } from '@/features/swarm-apps';
import type { ManifestScheduleOverride, ScheduleRecord, ScheduleService } from '@/features/scheduling';
import { getHomeScheduleService } from '../home-schedule-dispatch';
import { manifestServiceRouteTaskType } from '../manifest-service-route-schedule';

const logger = createChildLogger({ module: 'app-schedule-control-routes' });

/** Default floor between two fires of an operator-set cron, in minutes. */
const MIN_INTERVAL_MINUTES_DEFAULT = 5;
/** How many upcoming fires the interval floor is checked over. */
const INTERVAL_SAMPLES = 12;

/** What these routes need from the application service. */
export interface ScheduleControlApps { getActiveManifests(): Promise<SwarmAppManifest[]> }

/** Injectable collaborators, so a spec can run the routes against a real store without the boot. */
export interface ScheduleControlDeps { scheduler: () => ScheduleService | null }

/** One manifest schedule as the schedule screen shows it. */
export interface AppScheduleRow {
  id: string;
  key: string;
  description: string | null;
  target: 'prompt' | 'service-route';
  scope: 'framework' | 'per-user';
  manifestCron: string;
  cron: string;
  enabled: boolean;
  controllable: boolean;
  registered: boolean;
  status: ScheduleRecord['status'] | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  executionCount: number | null;
  override: ManifestScheduleOverride | null;
}

/**
 * @description The floor between two fires of an operator-set cron.
 * @param env - Environment carrying APP_SCHEDULE_MIN_INTERVAL_MINUTES.
 * @returns Milliseconds; the default (5 minutes) when unset or not a positive number.
 */
export function appScheduleMinIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.APP_SCHEDULE_MIN_INTERVAL_MINUTES);
  return (Number.isFinite(n) && n >= 1 ? Math.floor(n) : MIN_INTERVAL_MINUTES_DEFAULT) * 60_000;
}

/** @description The task type a manifest schedule registers under (see swarm-app-schedule-wiring). */
function taskTypeFor(key: string, s: SwarmAppScheduleDeclaration): string {
  return s.target === 'service-route' ? manifestServiceRouteTaskType(key) : `app:${key}`;
}

/** @description Only framework-scope, manifest-enabled schedules are registered as one system record. */
function isControllable(s: SwarmAppScheduleDeclaration): boolean {
  return s.scope !== 'per-user' && s.enabled !== false;
}

/**
 * @description Describe one manifest schedule with its live record and stored override.
 * @param svc - The running schedule service.
 * @param app - The application name.
 * @param s - The manifest's declaration.
 * @returns The row the screen renders.
 */
async function describeSchedule(svc: ScheduleService, app: string, s: SwarmAppScheduleDeclaration): Promise<AppScheduleRow> {
  const key = `${app}-${s.id}`;
  const controllable = isControllable(s);
  const record = controllable ? await svc.getScheduleForTaskType(taskTypeFor(key, s)) : null;
  const override = controllable ? await svc.getManifestOverride(key) : null;
  return {
    id: s.id, key, description: s.description ?? null,
    target: s.target === 'service-route' ? 'service-route' : 'prompt',
    scope: s.scope === 'per-user' ? 'per-user' : 'framework',
    manifestCron: s.cron, cron: record?.cron ?? override?.cron ?? s.cron,
    enabled: record ? record.status === 'active' : controllable && override?.enabled !== false,
    controllable, registered: Boolean(record), status: record?.status ?? null,
    nextRunAt: record?.nextRunAt ?? null, lastRunAt: record?.lastRunAt ?? null,
    executionCount: record?.executionCount ?? null, override,
  };
}

/**
 * @description The active manifest with this name and, when an id is given, that schedule in it.
 * @param apps - The application service.
 * @param name - Application name.
 * @param id - Schedule id within the manifest (omit to look up the manifest only).
 * @returns The manifest and schedule, or null when either is absent.
 */
async function findManifest(
  apps: ScheduleControlApps,
  name: string,
  id?: string,
): Promise<{ manifest: SwarmAppManifest; schedule?: SwarmAppScheduleDeclaration } | null> {
  const manifest = (await apps.getActiveManifests()).find((m) => m.name === name);
  if (!manifest) return null;
  if (id === undefined) return { manifest };
  const schedule = (manifest.schedules ?? []).find((s) => s.id === id);
  return schedule ? { manifest, schedule } : null;
}

/** A parsed PATCH body: `enabled` and/or `cron`, where a null cron returns to the manifest's. */
interface ControlBody { enabled?: boolean; cron?: string | null }

/**
 * @description Validate the PATCH body shape (not the cron's meaning, which needs the scheduler).
 * @param body - The raw request body.
 * @returns The parsed control, or an error message.
 */
function parseControlBody(body: unknown): ControlBody | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const out: ControlBody = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return { error: 'enabled must be true or false' };
    out.enabled = b.enabled;
  }
  if (b.cron !== undefined) {
    if (b.cron !== null && (typeof b.cron !== 'string' || !b.cron.trim() || b.cron.length > 120)) {
      return { error: 'cron must be a cron expression, or null to return to the manifest schedule' };
    }
    out.cron = b.cron === null ? null : (b.cron as string).trim();
  }
  if (out.enabled === undefined && out.cron === undefined) return { error: 'send enabled, cron, or both' };
  return out;
}

/**
 * @description Refuse a cron the scheduler cannot read, or one that fires more often than the floor.
 * @param svc - The running schedule service.
 * @param cron - The candidate cron.
 * @returns An error message, or null when the cron is acceptable.
 */
function cronProblem(svc: ScheduleService, cron: string): string | null {
  if (!svc.isValidCron(cron)) return `"${cron}" is not a cron expression the scheduler can read`;
  const floor = appScheduleMinIntervalMs();
  const gap = svc.shortestCronGapMs(cron, INTERVAL_SAMPLES);
  if (gap < floor) {
    return `"${cron}" fires ${Math.round(gap / 1000)} s apart; the shortest interval allowed is ${floor / 60_000} minutes (APP_SCHEDULE_MIN_INTERVAL_MINUTES)`;
  }
  return null;
}

/**
 * @description Merge a control into the stored override. Values equal to the manifest's are dropped,
 * so returning everything to the manifest leaves no override behind.
 * @param previous - The stored override, if any.
 * @param control - The parsed PATCH body.
 * @param manifestCron - The manifest's cron.
 * @param actor - The operator's subject.
 * @returns The override to store, or null when nothing differs from the manifest.
 */
function nextOverride(
  previous: ManifestScheduleOverride | null,
  control: ControlBody,
  manifestCron: string,
  actor: string | null,
): ManifestScheduleOverride | null {
  const enabled = control.enabled ?? previous?.enabled;
  const cron = control.cron === null ? undefined : (control.cron ?? previous?.cron);
  const next: ManifestScheduleOverride = { updatedBy: actor, updatedAt: new Date().toISOString() };
  if (enabled === false) next.enabled = false;
  if (cron && cron !== manifestCron) next.cron = cron;
  return next.enabled === undefined && next.cron === undefined ? null : next;
}

/**
 * @description Store the override and apply it to the live record.
 * @param svc - The running schedule service.
 * @param key - `<app>-<scheduleId>`.
 * @param s - The manifest declaration.
 * @param override - The override to store, or null to clear it.
 * @returns Nothing.
 */
async function applyOverride(
  svc: ScheduleService,
  key: string,
  s: SwarmAppScheduleDeclaration,
  override: ManifestScheduleOverride | null,
): Promise<void> {
  if (override) await svc.saveManifestOverride(key, override);
  else await svc.clearManifestOverride(key);
  const record = await svc.getScheduleForTaskType(taskTypeFor(key, s));
  if (!record) return;
  await svc.applyControl(record.id, { cron: override?.cron ?? s.cron, status: override?.enabled === false ? 'paused' : 'active' });
}

/**
 * @description GET /:name/schedules — every schedule the active manifest declares, with its live
 * record and the operator's stored override.
 * @param apps - The application service.
 * @param deps - The schedule service accessor.
 * @returns The Express handler.
 */
function listHandler(apps: ScheduleControlApps, deps: ScheduleControlDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    const svc = deps.scheduler();
    if (!svc) { res.status(503).json({ error: 'scheduler_unavailable' }); return; }
    try {
      const found = await findManifest(apps, name);
      if (!found) { res.status(404).json({ error: 'app_not_active' }); return; }
      const schedules = await Promise.all((found.manifest.schedules ?? []).map((s) => describeSchedule(svc, name, s)));
      res.json({
        app: name, schedules, minIntervalMinutes: appScheduleMinIntervalMs() / 60_000,
        schedulerEnabled: process.env.ENABLE_AGENT_SCHEDULER === 'true',
        timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
    } catch (err) {
      logger.error({ err, name }, 'Listing application schedules failed');
      res.status(500).json({ error: 'schedule_list_failed' });
    }
  };
}

/**
 * @description PATCH /:name/schedules/:id — turn one schedule on or off and/or change its cron
 * (null returns it to the manifest's). Stored as the standing override and applied to the live record.
 * @param apps - The application service.
 * @param deps - The schedule service accessor.
 * @returns The Express handler.
 */
function controlHandler(apps: ScheduleControlApps, deps: ScheduleControlDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    const id = String(req.params.id);
    const control = parseControlBody(req.body);
    if ('error' in control) { res.status(400).json({ error: control.error }); return; }
    const svc = deps.scheduler();
    if (!svc) { res.status(503).json({ error: 'scheduler_unavailable' }); return; }
    try {
      const found = await findManifest(apps, name, id);
      if (!found?.schedule) { res.status(404).json({ error: 'schedule_not_found' }); return; }
      if (!isControllable(found.schedule)) { res.status(409).json({ error: 'schedule_not_controllable' }); return; }
      const problem = typeof control.cron === 'string' ? cronProblem(svc, control.cron) : null;
      if (problem) { res.status(400).json({ error: problem }); return; }
      const key = `${name}-${id}`;
      const actor = getCaller(req).sub;
      const override = nextOverride(await svc.getManifestOverride(key), control, found.schedule.cron, actor);
      await applyOverride(svc, key, found.schedule, override);
      logger.info({ app: name, schedule: id, enabled: override?.enabled ?? true, cron: override?.cron ?? found.schedule.cron, actor }, 'Application schedule control changed');
      res.json({ schedule: await describeSchedule(svc, name, found.schedule) });
    } catch (err) {
      logger.error({ err, name, id }, 'Changing an application schedule failed');
      res.status(500).json({ error: 'schedule_control_failed' });
    }
  };
}

/**
 * @description Register the two schedule-control routes onto the swarm-apps router. Each route
 * carries requiresOperator on top of the router's requiresAuth.
 * @param router - The `/api/swarm/apps` router, already behind requiresAuth.
 * @param apps - The application service (active manifests).
 * @param deps - The schedule service accessor (the running scheduler by default).
 * @returns Nothing; the routes are attached in place.
 */
export function registerAppScheduleControlRoutes(
  router: Router,
  apps: ScheduleControlApps,
  deps: ScheduleControlDeps = { scheduler: getHomeScheduleService },
): void {
  router.get('/:name/schedules', requiresOperator, listHandler(apps, deps));
  router.patch('/:name/schedules/:id', requiresOperator, controlHandler(apps, deps));
}
