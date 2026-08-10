/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added schedule orchestration service with Redis persistence and cron-based next-run computation
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persisted ownerSub on create + filtered listSchedules by app queue (taskType) and caller (ownerSub, own-or-unowned)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scope new user-owned schedule ids by exact taskType and owner so create-or-replace cannot overwrite another tenant; preserve exact-owner legacy ids in place.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Honour the record's `timezone` when computing next-run (cron-parser `tz` option) so "9am" fires at the user's 9am, not the container's; and treat `once` as a real state — a one-shot pauses itself the moment it fires instead of relying on the stale-misfire heuristic (which let a no-year cron recur annually). Both changes are inert for records that set neither field, so existing schedules are byte-for-byte unaffected.
 */

import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { createChildLogger } from '@/shared/logger';
import {
  CreateScheduleInputSchema,
  ScheduleTaskDataSchema,
  UpdateScheduleInputSchema,
  type CreateScheduleInput,
  type ListSchedulesFilter,
  type ScheduleDispatchResult,
  type ScheduleRecord,
  type ScheduleTaskData,
  type UpdateScheduleTaskData,
  type UpdateScheduleInput,
} from '../types';
import { RedisScheduleStore } from './redis-schedule-store';
import { deriveQueueIdFromTaskType } from '@/entities/ticket';

const logger = createChildLogger({ module: 'schedule-service' });
const DUE_BATCH_LIMIT = 20;
const SCHEDULE_INDEX_RECONCILE_INTERVAL_MS = 60000;
const SCHEDULE_MISFIRE_GRACE_MS = 60 * 60 * 1000;
// Hard ceiling on a single schedule's dispatch. A handler that hangs (a stalled feed fetch, a wedged
// LLM call) must NOT freeze the single-flight runner — without this, one hung dispatch blocks every
// schedule (the autopilot) indefinitely. On timeout the schedule is marked skipped and re-fires next
// interval. Overridable via SCHEDULE_DISPATCH_TIMEOUT_MS. 4 min > any healthy task, catches true hangs.
const DISPATCH_TIMEOUT_MS = Math.max(60000, Number(process.env.SCHEDULE_DISPATCH_TIMEOUT_MS) || 240000);
// Cap on fire-and-forget dispatches running at once — backpressure so slow jobs can't pile up unbounded.
const MAX_INFLIGHT_DISPATCHES = Math.max(8, Number(process.env.SCHEDULE_MAX_INFLIGHT) || 48);

/**
 * @description Dispatch callback used by the scheduling service to execute due jobs.
 */
export type ScheduleDispatchHandler = (schedule: ScheduleRecord) => Promise<ScheduleDispatchResult>;

/**
 * @description Optional runtime guard that blocks scheduling when the target agent
 * does not currently have scheduling enabled in the switch framework.
 */
export type ScheduleEnablementGuard = (targetAgentId: string | undefined, taskType: string) => Promise<void>;

/**
 * @description Optional runtime scheduling behavior overrides.
 */
export interface ScheduleServiceOptions {
  defaultTargetAgentId?: string;
  ensureSchedulingEnabled?: ScheduleEnablementGuard;
}

/**
 * @description Service layer for schedule CRUD operations and due-job dispatch orchestration.
 */
export class ScheduleService {
  private lastIndexReconcileAtMs = 0;
  /** Count of dispatches running in the background (fire-and-forget) — bounds pile-up. */
  private inFlightDispatches = 0;

  constructor(
    private readonly store: RedisScheduleStore,
    private readonly dispatchHandler: ScheduleDispatchHandler,
    private readonly options: ScheduleServiceOptions = {},
  ) {}

  /**
   * @description Validates schedule service connectivity to Redis.
   *
   * @returns True when Redis is reachable.
   */
  async healthCheck(): Promise<boolean> {
    return this.store.ping();
  }

  /**
   * @description Creates or replaces a schedule using a legacy-compatible payload.
   *
   * @param input - Legacy schedule payload (`taskType`, `schedule`, `taskData`).
   * @returns Newly persisted schedule record.
   */
  async createSchedule(input: CreateScheduleInput): Promise<ScheduleRecord> {
    const parsed = CreateScheduleInputSchema.parse(input);
    await this.assertSchedulingEnabled(parsed.taskData.targetAgent, parsed.taskType);
    const { scheduleId, existing } = await this.resolveCreateTarget(parsed);
    const now = new Date();
    const schedule = this.buildCreateRecord(scheduleId, parsed, existing, now);
    await this.store.saveSchedule(schedule);
    logger.info({ scheduleId, cron: schedule.cron }, 'Created or replaced schedule');
    return schedule;
  }

  /**
   * @description Resolves the persistence key for create-or-replace without allowing two owners
   * to share a lossy taskType-derived id. Existing records keep their legacy id only when both the
   * exact taskType and exact owner match. New user records include a non-reversible digest of both;
   * unowned internal/system schedules retain the stable historical id used by boot reconcilers.
   */
  private async resolveCreateTarget(input: CreateScheduleInput): Promise<{
    scheduleId: string;
    existing: ScheduleRecord | null;
  }> {
    const legacyId = this.normalizeScheduleId(input.taskType);
    const legacy = await this.store.getSchedule(legacyId);
    if (!input.ownerSub) {
      return { scheduleId: legacyId, existing: legacy };
    }
    if (legacy?.ownerSub === input.ownerSub && legacy.taskType === input.taskType.trim()) {
      return { scheduleId: legacyId, existing: legacy };
    }

    const ownerScope = createHash('sha256')
      .update(input.ownerSub, 'utf8')
      .update('\0', 'utf8')
      .update(input.taskType.trim(), 'utf8')
      .digest('hex')
      .slice(0, 24);
    const scheduleId = `${legacyId}--${ownerScope}`;
    return { scheduleId, existing: await this.store.getSchedule(scheduleId) };
  }

  /**
   * @description Returns schedules visible to a surface/view, sorted by identifier.
   *
   * Applies the view's app-queue filter (`taskType`) and caller scoping
   * (`ownerSub`). Owner scoping is inclusive of unowned (system/legacy)
   * schedules so background-created jobs never vanish; pass `scope: 'all'`
   * (operator/admin dashboards) to disable owner scoping entirely.
   *
   * @param filter - Optional app-queue + caller scoping. Omit for all schedules.
   * @returns Matching schedules.
   */
  async listSchedules(filter?: ListSchedulesFilter): Promise<ScheduleRecord[]> {
    const schedules = await this.store.listSchedules();
    const scoped = schedules.filter((schedule) => this.matchesListFilter(schedule, filter));
    return scoped
      // Always surface the owning queue (derive for legacy/un-tagged records) so
      // calendar/queue surfaces can scope to loaded apps without a separate backfill.
      .map((schedule) => ({ ...schedule, queue: schedule.queue ?? deriveQueueIdFromTaskType(schedule.taskType) }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * @description Decides whether a schedule is visible under a list filter.
   */
  private matchesListFilter(schedule: ScheduleRecord, filter?: ListSchedulesFilter): boolean {
    if (!filter) return true;
    if (filter.taskType && schedule.taskType !== filter.taskType) return false;
    if (filter.queue) {
      // Derive on the fly for un-tagged (legacy) schedules so the queue filter
      // works before every record is re-saved with its queue.
      const scheduleQueue = schedule.queue ?? deriveQueueIdFromTaskType(schedule.taskType);
      if (scheduleQueue !== filter.queue) return false;
    }
    if (filter.scope !== 'all' && filter.ownerSub) {
      const owner = schedule.ownerSub;
      // Caller sees their own schedules plus unowned (system/legacy) ones,
      // never another user's owned schedule.
      if (owner && owner !== filter.ownerSub) return false;
    }
    return true;
  }

  /**
   * @description Returns a single schedule by identifier.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns Schedule record when found.
   */
  async getSchedule(scheduleId: string): Promise<ScheduleRecord | null> {
    return this.store.getSchedule(scheduleId);
  }

  /**
   * @description Updates an existing schedule pattern (cron expression).
   *
   * @param scheduleId - Stable schedule identifier.
   * @param input - Partial schedule update payload.
   * @returns Updated schedule record.
   */
  async updateSchedule(scheduleId: string, input: UpdateScheduleInput): Promise<ScheduleRecord> {
    const parsed = UpdateScheduleInputSchema.parse(input);
    const existing = await this.requireSchedule(scheduleId);
    const nextCron = parsed.pattern?.trim() || parsed.schedule?.trim() || existing.cron;
    const nextTaskData = parsed.taskData ? this.mergeTaskData(existing.taskData, parsed.taskData) : existing.taskData;
    await this.assertSchedulingEnabled(nextTaskData.targetAgent, existing.taskType);
    const updated = this.withUpdatedSchedule(existing, nextCron, nextTaskData);
    await this.store.saveSchedule(updated);
    logger.info({ scheduleId, cron: updated.cron }, 'Updated schedule');
    return updated;
  }

  /**
   * @description Pauses an active schedule.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns Updated paused schedule record.
   */
  async pauseSchedule(scheduleId: string): Promise<ScheduleRecord> {
    const existing = await this.requireSchedule(scheduleId);
    const updated = this.withStatus(existing, 'paused');
    await this.store.saveSchedule(updated);
    logger.info({ scheduleId }, 'Paused schedule');
    return updated;
  }

  /**
   * @description Resumes a paused schedule and recomputes next run.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns Updated active schedule record.
   */
  async resumeSchedule(scheduleId: string): Promise<ScheduleRecord> {
    const existing = await this.requireSchedule(scheduleId);
    const updated = this.withStatus(existing, 'active');
    await this.store.saveSchedule(updated);
    logger.info({ scheduleId, nextRunAt: updated.nextRunAt }, 'Resumed schedule');
    return updated;
  }

  /**
   * @description Deletes a schedule by identifier.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns True when a schedule existed and was deleted.
   */
  async deleteSchedule(scheduleId: string): Promise<boolean> {
    const deleted = await this.store.deleteSchedule(scheduleId);
    logger.info({ scheduleId, deleted }, 'Deleted schedule');
    return deleted;
  }

  /**
   * @description Executes a schedule immediately by identifier.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns Dispatch result for the triggered execution.
   */
  async triggerSchedule(scheduleId: string): Promise<ScheduleDispatchResult> {
    const schedule = await this.requireSchedule(scheduleId);
    await this.assertSchedulingEnabled(schedule.taskData.targetAgent, schedule.taskType);
    return this.dispatchAndPersist(schedule);
  }

  /**
   * @description Executes a worker callback payload from external scheduler workers.
   *
   * @param payload - Callback payload from worker or API caller.
   * @returns Dispatch result.
   */
  async executeScheduledTask(payload: Record<string, unknown>): Promise<ScheduleDispatchResult> {
    const scheduleId = this.readOptionalString(payload.scheduleId) || this.readOptionalString(payload.id);
    if (scheduleId) {
      return this.triggerSchedule(scheduleId);
    }

    const taskType = this.readOptionalString(payload.taskType) || 'adhoc-scheduled-task';
    const taskData = ScheduleTaskDataSchema.parse(payload.taskData || {});
    await this.assertSchedulingEnabled(taskData.targetAgent, taskType);
    const synthetic = this.buildSyntheticSchedule(taskType, taskData);
    return this.dispatchHandler(synthetic);
  }

  /**
   * @description Dispatches all due schedules in a bounded batch.
   *
   * @returns Number of schedules dispatched in this cycle.
   */
  async dispatchDueSchedules(): Promise<number> {
    await this.reconcileScheduleIndexIfDue();
    // Backpressure: if too many dispatches are still running in the background, don't pop more this
    // cycle — let them drain. Bounds pile-up without ever blocking the runner.
    if (this.inFlightDispatches >= MAX_INFLIGHT_DISPATCHES) {
      logger.warn({ inFlight: this.inFlightDispatches }, 'Schedule dispatch backpressure — skipping pop this cycle');
      return 0;
    }
    const dueIds = await this.store.popDueScheduleIds(Date.now(), DUE_BATCH_LIMIT);
    if (dueIds.length === 0) {
      return 0;
    }

    // FIRE-AND-FORGET: kick off each due dispatch but do NOT await them — the runner cycle must return
    // immediately. The CORE bug was the cycle blocking on job COMPLETION: a 70s LLM bot dispatch or a
    // minutes-long world news refresh held the single-flight runner, starving the every-5-min trading
    // autopilot. Decoupling cadence from job duration fixes it at the root. Each job self-guards
    // (dispatchOneDue try/catch) and is time-boxed (withDispatchTimeout); the counter bounds pile-up.
    for (const scheduleId of dueIds) {
      this.inFlightDispatches += 1;
      void this.dispatchOneDue(scheduleId).finally(() => { this.inFlightDispatches -= 1; });
    }

    return dueIds.length;
  }

  /** Dispatch one popped due schedule, guarded + time-boxed so it never throws into — or hangs — the
   *  concurrent batch. A timeout marks it skipped (advances next run) so the runner cycle can complete. */
  private async dispatchOneDue(scheduleId: string): Promise<void> {
    try {
      const schedule = await this.store.getSchedule(scheduleId);
      if (!schedule || schedule.status !== 'active') return;
      await this.assertSchedulingEnabled(schedule.taskData.targetAgent, schedule.taskType);
      await this.withDispatchTimeout(this.dispatchAndPersist(schedule), schedule.taskType, scheduleId);
    } catch (error) {
      const schedule = await this.store.getSchedule(scheduleId);
      if (schedule) {
        await this.store.saveSchedule(this.withSkippedDispatch(schedule));
      }
      logger.error({ err: error, scheduleId }, 'Failed to dispatch due schedule');
    }
  }

  /** Reject after DISPATCH_TIMEOUT_MS so a hung handler can't freeze the single-flight runner. The
   *  underlying promise is left to settle on its own; the cycle moves on and the schedule re-fires. */
  private withDispatchTimeout<T>(p: Promise<T>, taskType: string, scheduleId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        logger.error({ scheduleId, taskType, timeoutMs: DISPATCH_TIMEOUT_MS }, 'Schedule dispatch timed out — abandoning to unblock the runner');
        reject(new Error(`dispatch timeout after ${DISPATCH_TIMEOUT_MS}ms (${taskType})`));
      }, DISPATCH_TIMEOUT_MS);
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e as Error); });
    });
  }

  /**
   * @description Closes owned Redis resources.
   */
  async shutdown(): Promise<void> {
    await this.store.close();
  }

  /**
   * @description Repairs the Redis due index periodically before dispatch pops.
   */
  private async reconcileScheduleIndexIfDue(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastIndexReconcileAtMs < SCHEDULE_INDEX_RECONCILE_INTERVAL_MS) {
      return;
    }
    this.lastIndexReconcileAtMs = nowMs;

    await this.advanceStaleScheduleNextRuns(new Date(nowMs));

    const reconcile = (this.store as RedisScheduleStore & {
      reconcileScheduleIndex?: () => Promise<{ scanned: number; indexed: number; removed: number }>;
    }).reconcileScheduleIndex;
    if (!reconcile) {
      return;
    }

    try {
      const result = await reconcile.call(this.store);
      logger.info(result, 'Schedule index reconciliation complete');
    } catch (error) {
      logger.error({ err: error }, 'Schedule index reconciliation failed');
    }
  }

  /**
   * @description Advances active schedules whose recorded next run is too stale
   * to execute safely as a late catch-up action.
   */
  private async advanceStaleScheduleNextRuns(now: Date): Promise<void> {
    let repaired = 0;
    let pausedOneTime = 0;
    const nowMs = now.getTime();
    const schedules = await this.store.listSchedules();
    for (const schedule of schedules) {
      if (schedule.status !== 'active') {
        continue;
      }

      const nextRunMs = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Number.NaN;
      const shouldRepair = !Number.isFinite(nextRunMs)
        || nextRunMs < nowMs - SCHEDULE_MISFIRE_GRACE_MS;
      if (!shouldRepair) {
        continue;
      }

      if (this.isOneTimeSchedule(schedule)) {
        await this.store.saveSchedule({
          ...schedule,
          status: 'paused',
          updatedAt: now.toISOString(),
          nextRunAt: null,
        });
        pausedOneTime++;
        continue;
      }

      await this.store.saveSchedule({
        ...schedule,
        updatedAt: now.toISOString(),
        nextRunAt: this.computeNextRunOrNull(schedule.cron, schedule.status, now, schedule.timezone),
      });
      repaired++;
    }

    if (repaired > 0 || pausedOneTime > 0) {
      logger.warn(
        { repaired, pausedOneTime, misfireGraceMs: SCHEDULE_MISFIRE_GRACE_MS },
        'Repaired stale schedule next-run state before reconciliation',
      );
    }
  }

  /**
   * @description Detects legacy one-time schedules encoded as cron records.
   */
  private isOneTimeSchedule(schedule: ScheduleRecord): boolean {
    // The first-class flag is authoritative; the heuristic below is only for legacy records that
    // encoded one-shot intent in their taskData/text before `once` existed.
    if (schedule.once === true) return true;
    const taskData = schedule.taskData as Record<string, unknown>;
    const typedFields = [
      taskData.kind,
      taskData.scheduleKind,
      taskData.recurrence,
      taskData.repeat,
    ].filter((value): value is string => typeof value === 'string');
    if (typedFields.some((value) => /^(once|one[-_ ]?time|single[-_ ]?run|none)$/i.test(value.trim()))) {
      return true;
    }

    const text = [
      schedule.id,
      schedule.taskType,
      taskData.prompt,
      taskData.action,
      taskData.label,
    ].filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();

    return /\b(one[- ]time|single[- ]run|run once|once only|not recurring|not a recurring|do not create another schedule)\b/.test(text);
  }

  /**
   * @description Dispatches a schedule, then persists run metadata and next run.
   */
  private async dispatchAndPersist(schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
    const dispatchResult = await this.dispatchHandler(schedule);
    const updated = this.withDispatchResult(schedule, dispatchResult.success);
    await this.store.saveSchedule(updated);
    logger.info(
      { scheduleId: schedule.id, success: dispatchResult.success, nextRunAt: updated.nextRunAt },
      'Dispatched scheduled task',
    );
    return dispatchResult;
  }

  /**
   * @description Ensures a schedule exists before performing mutable actions.
   */
  private async requireSchedule(scheduleId: string): Promise<ScheduleRecord> {
    const schedule = await this.store.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    return schedule;
  }

  /**
   * @description Builds a normalized schedule record for create/replace operations.
   */
  private buildCreateRecord(
    scheduleId: string,
    input: CreateScheduleInput,
    existing: ScheduleRecord | null,
    now: Date,
  ): ScheduleRecord {
    const cron = input.schedule.trim();
    const nowIso = now.toISOString();
    this.assertValidCron(cron);
    return {
      id: scheduleId,
      taskType: input.taskType.trim(),
      cron,
      taskData: input.taskData,
      status: existing?.status || 'active',
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
      nextRunAt: this.computeNextRunOrNull(cron, existing?.status || 'active', now, input.timezone ?? existing?.timezone),
      lastRunAt: existing?.lastRunAt || null,
      executionCount: existing?.executionCount || 0,
      ownerSub: input.ownerSub ?? existing?.ownerSub ?? null,
      // Tag the schedule with its owning app queue so the cockpit calendar can
      // filter to loaded apps. Explicit queue wins; otherwise derive from taskType.
      queue: input.queue ?? existing?.queue ?? deriveQueueIdFromTaskType(input.taskType),
      timezone: input.timezone ?? existing?.timezone ?? null,
      once: input.once ?? existing?.once ?? false,
    };
  }

  /**
   * @description Returns a schedule clone with updated cron expression.
   */
  private withUpdatedSchedule(schedule: ScheduleRecord, cron: string, taskData: ScheduleTaskData): ScheduleRecord {
    this.assertValidCron(cron);
    return {
      ...schedule,
      cron,
      taskData,
      updatedAt: new Date().toISOString(),
      nextRunAt: this.computeNextRunOrNull(cron, schedule.status, new Date(), schedule.timezone),
    };
  }

  /**
   * @description Merges partial task-data edits into the persisted schedule payload.
   */
  private mergeTaskData(existing: ScheduleTaskData, input: UpdateScheduleTaskData): ScheduleTaskData {
    const merged = {
      ...existing,
      ...input,
    };
    return ScheduleTaskDataSchema.parse(merged);
  }

  /**
   * @description Returns a schedule clone with updated status and next-run values.
   */
  private withStatus(schedule: ScheduleRecord, status: 'active' | 'paused'): ScheduleRecord {
    const now = new Date();
    return {
      ...schedule,
      status,
      updatedAt: now.toISOString(),
      nextRunAt: this.computeNextRunOrNull(schedule.cron, status, now, schedule.timezone),
    };
  }

  /**
   * @description Returns a schedule clone with dispatch metadata updates.
   */
  private withDispatchResult(schedule: ScheduleRecord, success: boolean): ScheduleRecord {
    const now = new Date();
    // A one-shot is done the moment it fires: pause it and clear the next run so it never repeats.
    // This is the first-class replacement for the "cron with no year" encoding, which recurred
    // annually until the misfire-grace heuristic happened to catch it.
    const oneShotDone = schedule.once === true;
    return {
      ...schedule,
      lastRunAt: now.toISOString(),
      updatedAt: now.toISOString(),
      executionCount: success ? schedule.executionCount + 1 : schedule.executionCount,
      status: oneShotDone ? 'paused' : schedule.status,
      nextRunAt: oneShotDone ? null : this.computeNextRunOrNull(schedule.cron, schedule.status, now, schedule.timezone),
    };
  }

  /**
   * @description Returns a schedule clone for skipped dispatches where execution should
   * not count as a run, but the next occurrence still needs to be indexed.
   */
  private withSkippedDispatch(schedule: ScheduleRecord): ScheduleRecord {
    const now = new Date();
    return {
      ...schedule,
      updatedAt: now.toISOString(),
      nextRunAt: this.computeNextRunOrNull(schedule.cron, schedule.status, now, schedule.timezone),
    };
  }

  /**
   * @description Creates a synthetic schedule context for ad-hoc execute callbacks.
   */
  private buildSyntheticSchedule(taskType: string, taskData: ScheduleTaskData): ScheduleRecord {
    const nowIso = new Date().toISOString();
    return {
      id: this.normalizeScheduleId(taskType),
      taskType,
      cron: '* * * * *',
      taskData,
      status: 'active',
      createdAt: nowIso,
      updatedAt: nowIso,
      nextRunAt: null,
      lastRunAt: null,
      executionCount: 0,
    };
  }

  /**
   * @description Computes next-run timestamp or null when schedule is paused.
   */
  private computeNextRunOrNull(cron: string, status: 'active' | 'paused', now: Date, timezone?: string | null): string | null {
    if (status !== 'active') {
      return null;
    }
    return this.computeNextRunIso(cron, now, timezone);
  }

  /**
   * @description Validates cron expression format by requesting next occurrence.
   */
  private assertValidCron(cron: string): void {
    try {
      CronExpressionParser.parse(cron, { currentDate: new Date() }).next();
    } catch (error) {
      logger.error({ err: error, cron }, 'Invalid cron expression');
      throw new Error(`Invalid cron expression: ${cron}`);
    }
  }

  /**
   * @description Computes the next occurrence for a cron expression, in the schedule's timezone
   * when one is set. Without a timezone the expression resolves in the process clock, which is the
   * historical behaviour — so legacy records that carry no timezone are unaffected.
   */
  private computeNextRunIso(cron: string, now: Date, timezone?: string | null): string {
    const options = timezone ? { currentDate: now, tz: timezone } : { currentDate: now };
    const expression = CronExpressionParser.parse(cron, options);
    const iso = expression.next().toISOString();
    if (!iso) {
      throw new Error(`Could not compute next run for cron expression: ${cron}`);
    }
    return iso;
  }

  /**
   * @description Produces stable Redis-safe schedule identifiers from taskType values.
   */
  private normalizeScheduleId(taskType: string): string {
    return taskType.trim().replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  }

  /**
   * @description Enforces switch-framework schedule enablement when a guard is configured.
   */
  private async assertSchedulingEnabled(targetAgentId: string | undefined, taskType: string): Promise<void> {
    if (!this.options.ensureSchedulingEnabled) {
      return;
    }

    await this.options.ensureSchedulingEnabled(this.resolveTargetAgentId(targetAgentId), taskType);
  }

  /**
   * @description Resolves the target agent for schedule ownership and enablement checks.
   */
  private resolveTargetAgentId(targetAgentId: string | undefined): string | undefined {
    return this.readOptionalString(targetAgentId) || this.options.defaultTargetAgentId;
  }

  /**
   * @description Reads optional non-empty string values from untyped payloads.
   */
  private readOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}
