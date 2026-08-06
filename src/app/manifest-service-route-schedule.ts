/**
 * Deterministic schedule handlers contributed by active app packages.
 *
 * A declaration is bound to an exact auth:`service` route at manifest validation, but execution
 * calls a named export from that route's compiled module in-process. This is deliberate: a
 * loopback HTTP call could fall through to an unrelated kernel route when dynamic package routes
 * are disabled. Loading the already-declared module under realpath confinement preserves the
 * package boundary and makes active-registry ownership the only dispatch authority.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1   | maintainer@emeraldcoastsystemsgroup.com     | Add confined, lifecycle-scoped deterministic service-route handler registration and dispatch.
 *
 * @module manifest-service-route-schedule
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import type { AppContext } from '@/app/composition/app-context';
import { registerPackageFrameworkAliases } from '@/app/composition/manifest-route-mounter';
import {
  MANIFEST_SERVICE_ROUTE_TASK_KIND,
  type ScheduleDispatchResult,
  type ScheduleRecord,
} from '@/features/scheduling';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'manifest-service-route-schedule' });
const nodeRequire = createRequire(__filename);
const TASK_PREFIX = 'app-route:';
const MAX_SUMMARY_CHARS = 512;

/** Static input exposed to a package's named schedule handler. */
export interface ManifestServiceRouteHandlerInput {
  scheduleId: string;
  scheduledAtIso: string;
  body: Readonly<Record<string, unknown>>;
}

/** Deliberately bounded result contract; package internals never enter scheduler metadata. */
export interface ManifestServiceRouteHandlerResult {
  summary?: string;
}

type ManifestServiceRouteHandler = (
  ctx: AppContext,
  input: ManifestServiceRouteHandlerInput,
) => ManifestServiceRouteHandlerResult | Promise<ManifestServiceRouteHandlerResult>;

/** Activation-time target after loader validation has bound it to one service route. */
export interface ManifestServiceRouteScheduleTarget {
  appName: string;
  scheduleId: string;
  packageDir: string;
  module: string;
  handler: string;
  route: string;
  body: Record<string, unknown>;
}

interface RegisteredTarget {
  appName: string;
  scheduleId: string;
  route: string;
  body: Readonly<Record<string, unknown>>;
  handler: ManifestServiceRouteHandler;
  packageContext: AppContext;
}

/** Read/dispatch contract injected into the scheduler runtime. */
export interface ManifestServiceRouteScheduleRuntime {
  dispatch(schedule: ScheduleRecord): Promise<ScheduleDispatchResult>;
}

/** @description Stable task type stored by the shared scheduler. */
export function manifestServiceRouteTaskType(scheduleId: string): string {
  return `${TASK_PREFIX}${scheduleId}`;
}

/** @description Identify the dedicated deterministic package-worker dispatch class. */
export function isManifestServiceRouteSchedule(taskType: string): boolean {
  return taskType.startsWith(TASK_PREFIX);
}

/** Whether `candidate` resolves inside `root`, including the root itself. */
function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * @description Process-lifetime active target registry. Registration validates the compiled
 * export before swapping the entry; a failed reload cannot replace a working target.
 */
export class ManifestServiceRouteScheduleRegistry implements ManifestServiceRouteScheduleRuntime {
  private readonly targets = new Map<string, RegisteredTarget>();

  constructor(private readonly ctx: AppContext) {
    if (!process.env.VITEST) {
      try {
        registerPackageFrameworkAliases(path.resolve(__dirname, '..'));
      } catch (error) {
        logger.error({ err: error }, 'Failed to register framework aliases for manifest schedule handlers');
      }
    }
  }

  /** Register or replace one target owned by an active app. */
  register(target: ManifestServiceRouteScheduleTarget): void {
    const taskType = manifestServiceRouteTaskType(target.scheduleId);
    const existing = this.targets.get(taskType);
    if (existing && existing.appName !== target.appName) {
      throw new Error(`Manifest service schedule ${target.scheduleId} is already owned by ${existing.appName}`);
    }

    const realPackageDir = fs.realpathSync(target.packageDir);
    const declaredModule = path.resolve(realPackageDir, target.module);
    if (!isWithin(realPackageDir, declaredModule) || !fs.existsSync(declaredModule)) {
      throw new Error(`Manifest schedule module is missing or outside package: ${target.module}`);
    }
    const realModule = fs.realpathSync(declaredModule);
    if (!isWithin(realPackageDir, realModule) || path.extname(realModule).toLowerCase() !== '.js') {
      throw new Error(`Manifest schedule module must resolve to compiled JavaScript inside the package: ${target.module}`);
    }

    const modulePath = nodeRequire.resolve(realModule);
    delete nodeRequire.cache[modulePath];
    process.env.OSHAL_APP_PACKAGE_DIR = realPackageDir;
    const loaded = nodeRequire(modulePath) as Record<string, unknown>;
    const exported = loaded[target.handler];
    if (typeof exported !== 'function') {
      throw new Error(`Manifest schedule handler export is missing: ${target.module}#${target.handler}`);
    }

    const body = deepFreeze(JSON.parse(JSON.stringify(target.body)) as Record<string, unknown>);
    this.targets.set(taskType, {
      appName: target.appName,
      scheduleId: target.scheduleId,
      route: target.route,
      body,
      handler: exported as ManifestServiceRouteHandler,
      packageContext: { ...this.ctx, appPackageDir: realPackageDir },
    });
    logger.info({ app: target.appName, scheduleId: target.scheduleId }, 'Registered manifest service-route schedule handler');
  }

  /** Retract exact targets before their persisted schedules are deleted. Idempotent. */
  unregister(appName: string, scheduleIds: readonly string[]): void {
    for (const localId of scheduleIds) {
      const taskType = manifestServiceRouteTaskType(`${appName}-${localId}`);
      if (this.targets.get(taskType)?.appName === appName) this.targets.delete(taskType);
    }
  }

  /** Dispatch one due job to the exact active compiled handler. */
  async dispatch(schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
    const target = this.targets.get(schedule.taskType);
    if (!target) return failure(schedule, 'No active manifest service-route target');
    if (
      schedule.taskData.kind !== MANIFEST_SERVICE_ROUTE_TASK_KIND ||
      schedule.taskData.scheduleKey !== target.scheduleId
    ) {
      return failure(schedule, 'Persisted service-route metadata does not match the active manifest');
    }

    try {
      const result = await target.handler(target.packageContext, {
        scheduleId: target.scheduleId,
        scheduledAtIso: new Date().toISOString(),
        body: target.body,
      });
      const normalized = validateResult(result, target);
      logger.info(
        { app: target.appName, scheduleId: schedule.id, route: target.route, reportedSummary: Boolean(normalized.summary) },
        'Manifest service-route schedule completed',
      );
      return { success: true, scheduleId: schedule.id, taskId: schedule.id };
    } catch (error) {
      logger.error({ err: error, app: target.appName, scheduleId: schedule.id }, 'Manifest service-route schedule failed');
      return failure(schedule, 'Package service-route handler failed');
    }
  }
}

/** @description Recursively freeze the validated static body handed to package code. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** @description Enforce the small, log-safe package result contract. */
function validateResult(result: unknown, target: RegisteredTarget): ManifestServiceRouteHandlerResult {
  if (result === undefined) return {};
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`Manifest schedule handler ${target.appName}/${target.scheduleId} returned a non-object result`);
  }
  const value = result as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => key !== 'summary');
  if (unknown.length > 0) throw new Error(`Manifest schedule handler returned unknown result fields: ${unknown.join(', ')}`);
  if (value.summary !== undefined && typeof value.summary !== 'string') {
    throw new Error('Manifest schedule handler summary must be a string');
  }
  const summary = typeof value.summary === 'string'
    ? value.summary.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS)
    : undefined;
  return { summary };
}

/** @description Build a non-throwing scheduler failure result. */
function failure(schedule: ScheduleRecord, error: string): ScheduleDispatchResult {
  return { success: false, scheduleId: schedule.id, error };
}
