/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from server.ts (1000-line cap decomposition): swarm-app manifest schedule registrar/deregistrar factories, the per-user schedule reconciler, and the nightly oshal-dev docs-quality schedule (ADR-081). Verbatim moves — server.ts calls these at the exact same points in createApp, so wiring order and env handling are unchanged.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SwarmAppService, ManifestScheduleRegistrar, ManifestScheduleDeregistrar } from '@/features/swarm-apps';
import { getHomeScheduleService } from './home-schedule-dispatch';
import { setPerUserScheduleReconciler } from './per-user-schedule-reconcile';
import { accessibleConnections } from './routes/connector-tenancy';

const logger = createChildLogger({ module: 'swarm-app-schedule-wiring' });

/**
 * @description Builds the bridge that registers a manifest's framework-scope schedules onto the
 * shared scheduling service. Lazy lookup: the scheduler is wired earlier in boot
 * (createScheduleController) than the app autoload, so the handle resolves by registration time;
 * if absent, it's a safe no-op. taskType is namespaced `app:` so it bypasses the per-agent
 * user-scheduling tool gate (these are operator/system-declared defaults). ownerSub null =
 * system-wide. Schedules only EXECUTE when ENABLE_AGENT_SCHEDULER=true.
 *
 * @returns Registrar passed into SwarmAppService at construction.
 */
export function createManifestScheduleRegistrar(): ManifestScheduleRegistrar {
  return async (input) => {
    const svc = getHomeScheduleService();
    if (!svc) return;
    await svc.createSchedule({
      taskType: `app:${input.scheduleId}`,
      schedule: input.cron,
      taskData: { prompt: input.prompt, targetAgent: input.targetAgent },
      ownerSub: null,
      queue: input.queue,
    });
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
export function createManifestScheduleDeregistrar(): ManifestScheduleDeregistrar {
  return async ({ appName, scheduleIds }) => {
    const svc = getHomeScheduleService();
    if (!svc) return;
    const all = await svc.listSchedules({ scope: 'all' } as never);
    let removed = 0;
    for (const rec of all) {
      const t = String(rec.taskType || '');
      const owned = scheduleIds.some((sid) => t === `app:${appName}-${sid}` || t.startsWith(`app:${appName}-${sid}:`));
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
