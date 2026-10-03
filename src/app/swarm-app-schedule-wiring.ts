/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (1000-line cap decomposition): swarm-app manifest schedule registrar/deregistrar factories, the per-user schedule reconciler, and the nightly oshal-dev docs-quality schedule (ADR-081). Verbatim moves — server.ts calls these at the exact same points in createApp, so wiring order and env handling are unchanged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Register deterministic service-route targets separately from prompt jobs and retract their active registry entries before persisted schedule teardown.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Fail activation closed when a deterministic service-route schedule cannot reach the scheduler; prompt schedules retain their historical best-effort boot behavior.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-157: tear down the per-user instances of a deterministic service-route schedule too (`app-route:{app}-{id}:{sub}`). A user activation registers one of these; toggling the app off has to remove them, exactly as it already removes the per-user prompt polls.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Apply the operator's standing control (ManifestScheduleOverride, set on an application's schedule screen) every time a framework-scope manifest schedule registers: the override cron replaces the manifest cron and `enabled` sets the record's status, so the control survives a restart, a reload and an app toggle. A stored cron that no longer parses, or an override read that fails, registers the manifest default and logs ERROR — a bad override never stops a schedule from registering.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SwarmAppService, ManifestScheduleRegistrar, ManifestScheduleDeregistrar } from '@/features/swarm-apps';
import type { ScheduleRecord, ScheduleService } from '@/features/scheduling';
import { getHomeScheduleService } from './home-schedule-dispatch';
import { setPerUserScheduleReconciler } from './per-user-schedule-reconcile';
import { accessibleConnections } from './routes/connector-tenancy';
import {
  type ManifestServiceRouteScheduleRegistry,
  manifestServiceRouteTaskType,
} from './manifest-service-route-schedule';

const logger = createChildLogger({ module: 'swarm-app-schedule-wiring' });

/** The cron a manifest schedule registers on and, when an operator set one, whether it fires. */
interface ManifestControl { cron: string; enabled?: boolean }

/**
 * @description The operator's standing control for one manifest schedule, resolved against the
 * manifest's own cron. No override means the manifest's values. A stored cron that no longer parses,
 * or a failed read, falls back to the manifest cron (logged at ERROR): a bad override must never keep
 * a schedule from registering.
 * @param svc - The running schedule service.
 * @param manifestScheduleId - `<app>-<scheduleId>`.
 * @param manifestCron - The cron the manifest declares.
 * @returns The cron to register and the operator's on/off, if any.
 */
async function readManifestControl(svc: ScheduleService, manifestScheduleId: string, manifestCron: string): Promise<ManifestControl> {
  try {
    const override = await svc.getManifestOverride(manifestScheduleId);
    if (!override) return { cron: manifestCron };
    if (override.cron && !svc.isValidCron(override.cron)) {
      logger.error({ manifestScheduleId, cron: override.cron }, 'Stored schedule override cron does not parse — registering the manifest cron');
      return { cron: manifestCron, enabled: override.enabled };
    }
    return { cron: override.cron ?? manifestCron, enabled: override.enabled };
  } catch (err) {
    logger.error({ err, manifestScheduleId }, 'Reading the operator control for a manifest schedule failed — registering the manifest default');
    return { cron: manifestCron };
  }
}

/**
 * @description Give a freshly registered record the on/off the operator chose. A record with no
 * operator choice keeps whatever status it already had (create-or-replace preserves it).
 * @param svc - The running schedule service.
 * @param record - The record the registration just saved.
 * @param enabled - The operator's choice, when there is one.
 * @returns Nothing; the record is saved when its status changes.
 */
async function applyManifestStatus(svc: ScheduleService, record: ScheduleRecord, enabled: boolean | undefined): Promise<void> {
  if (enabled === undefined) return;
  const status = enabled ? 'active' : 'paused';
  if (record.status === status) return;
  await svc.applyControl(record.id, { cron: record.cron, status });
  logger.info({ scheduleId: record.id, status }, 'Manifest schedule registered with the operator on/off setting');
}

/**
 * @description Builds the bridge that registers a manifest's framework-scope schedules onto the
 * shared scheduling service. Lazy lookup: the scheduler is wired earlier in boot
 * (createScheduleController) than the app autoload, so the handle resolves by registration time;
 * if absent, it's a safe no-op. Prompt jobs use `app:`; deterministic named handlers use
 * `app-route:`. Both bypass the per-agent user-scheduling tool gate because they are
 * operator/system-declared defaults. ownerSub null = system-wide. Schedules only EXECUTE when
 * ENABLE_AGENT_SCHEDULER=true.
 *
 * @returns Registrar passed into SwarmAppService at construction.
 */
export function createManifestScheduleRegistrar(
  serviceRouteRegistry: ManifestServiceRouteScheduleRegistry,
): ManifestScheduleRegistrar {
  return async (input) => {
    const svc = getHomeScheduleService();
    if (!svc) {
      if (input.target.kind === 'service-route') {
        throw new Error(`Scheduler unavailable for deterministic app schedule: ${input.scheduleId}`);
      }
      return;
    }
    const control = await readManifestControl(svc, input.scheduleId, input.cron);
    if (input.target.kind === 'prompt') {
      const record = await svc.createSchedule({
        taskType: `app:${input.scheduleId}`,
        schedule: control.cron,
        taskData: { prompt: input.target.prompt, targetAgent: input.target.targetAgent },
        ownerSub: null,
        queue: input.queue,
      });
      await applyManifestStatus(svc, record, control.enabled);
      return;
    }

    serviceRouteRegistry.register({
      appName: input.target.appName,
      scheduleId: input.scheduleId,
      packageDir: input.target.packageDir,
      module: input.target.module,
      handler: input.target.handler,
      route: input.target.path,
      body: input.target.body,
    });
    try {
      const record = await svc.createSchedule({
        taskType: manifestServiceRouteTaskType(input.scheduleId),
        schedule: control.cron,
        taskData: { kind: 'manifest-service-route', scheduleKey: input.scheduleId },
        ownerSub: null,
        queue: input.queue,
      });
      await applyManifestStatus(svc, record, control.enabled);
    } catch (error) {
      const localId = input.scheduleId.slice(input.target.appName.length + 1);
      serviceRouteRegistry.unregister(input.target.appName, [localId]);
      throw error;
    }
  };
}

/**
 * @description ADR-085 P0 — the registrar's counterpart: when an app deactivates, delete every
 * schedule it registered. Matches the exact framework-scope taskType (`app:{name}-{sid}`) AND
 * its per-user instances (`app:{name}-{sid}:{sub}`) so a toggled-off app's polls STOP
 * firing/billing. The sid anchor prevents prefix collisions between apps like `eats` and
 * `eats-pro`.
 *
 * @returns Deregistrar passed into SwarmAppService at construction.
 */
export function createManifestScheduleDeregistrar(
  serviceRouteRegistry: ManifestServiceRouteScheduleRegistry,
): ManifestScheduleDeregistrar {
  return async ({ appName, scheduleIds }) => {
    serviceRouteRegistry.unregister(appName, scheduleIds);
    const svc = getHomeScheduleService();
    if (!svc) return;
    const all = await svc.listSchedules({ scope: 'all' } as never);
    let removed = 0;
    for (const rec of all) {
      const t = String(rec.taskType || '');
      const owned = scheduleIds.some((sid) =>
        t === `app:${appName}-${sid}` ||
        t.startsWith(`app:${appName}-${sid}:`) ||
        t === manifestServiceRouteTaskType(`${appName}-${sid}`) ||
        t.startsWith(`${manifestServiceRouteTaskType(`${appName}-${sid}`)}:`),
      );
      if (!owned) continue;
      try {
        if (await svc.deleteSchedule(rec.id)) removed++;
      } catch { /* best-effort per schedule */ }
    }
    logger.info({ appName, removed }, 'App schedules torn down on deactivate (ADR-085 P0)');
  };
}

/**
 * @description Per-user "polls": when a user connects a connector, register any scope:'per-user'
 * manifest schedules whose requiresConnection matches, scoped to that user. Namespaced `app:`
 * (bypasses the per-agent scheduler gate) + ownerSub-scoped so each user gets their own.
 * Idempotent (scheduler replaces by id). Only executes when the scheduler is on.
 *
 * @param swarmAppService - The process-lifetime SwarmAppService (source of active manifests).
 * @param pool - Postgres pool used to check the caller's accessible connections.
 */
export function registerPerUserScheduleReconciler(swarmAppService: SwarmAppService, pool: Pool): void {
  setPerUserScheduleReconciler(async (userSub, provider) => {
    const svc = getHomeScheduleService();
    if (!svc) return;
    const manifests = await swarmAppService.getActiveManifests();
    const subShort = userSub.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
    for (const m of manifests) {
      for (const s of m.schedules ?? []) {
        if (s.scope !== 'per-user' || s.enabled === false) continue;
        if (provider && s.requiresConnection && s.requiresConnection !== provider) continue;
        if (s.requiresConnection) {
          const conns = await accessibleConnections(pool, userSub, s.requiresConnection);
          if (!conns.length) continue;
        }
        try {
          await svc.createSchedule({
            taskType: `app:${m.name}-${s.id}:${subShort}`,
            schedule: s.cron,
            taskData: { prompt: s.prompt, targetAgent: s.targetAgent },
            ownerSub: userSub,
            queue: m.name,
          });
        } catch { /* best-effort per schedule */ }
      }
    }
  });
}

/**
 * @description Nightly docs-quality check (ADR-081). Files a ticketType=oshal-dev ticket every
 * night at 04:00 (process TZ) for the oshal-developer bot: link-check + docs-drift review in its
 * own clone. Registered only when OSHAL_DEV_OWNER_SUB is set — the ticket owner must be a
 * super-admin sub or the privileged-dispatch gate escalates it (fail-closed, visibly).
 * Idempotent (createSchedule replaces by taskType-derived id); executes only when
 * ENABLE_AGENT_SCHEDULER=true (api container).
 */
export function registerNightlyDevDocsSchedule(): void {
  const devDocsOwnerSub = (process.env.OSHAL_DEV_OWNER_SUB ?? '').trim();
  if (!devDocsOwnerSub) return;
  void (async () => {
    const svc = getHomeScheduleService();
    if (!svc) return;
    try {
      await svc.createSchedule({
        taskType: 'workflow:oshal-dev',
        schedule: process.env.OSHAL_DEV_DOCS_CRON || '0 4 * * *',
        taskData: {
          title: 'Nightly docs quality check',
          prompt: [
            'Nightly documentation quality pass over the OSHAL platform repo (your clone at /app/dev-repo).',
            'Run `node scripts/docs-link-check.js` and fix what it flags; verify new docs live in docs/ topic',
            'folders indexed by their README; spot-check that CLAUDE.md/README statements still match the code',
            '(as-built, not aspirational). Commit + push safe fixes; report anything judgment-heavy.',
          ].join(' '),
        },
        ownerSub: devDocsOwnerSub,
        queue: 'oshal-dev',
      });
      logger.info({ ownerSub: devDocsOwnerSub }, 'Nightly oshal-dev docs-quality schedule registered');
    } catch (err) {
      logger.warn({ err }, 'Failed to register the nightly oshal-dev docs-quality schedule (non-fatal)');
    }
  })();
}
