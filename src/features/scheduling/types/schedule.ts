/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added schedule domain schemas and types for Redis-backed self-scheduling
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added ownerSub (per-user scoping) + ListSchedulesFilter so calendar surfaces filter on their app queue and the caller's own schedules
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add the internal manifest-service-route task-data shape while retaining legacy prompt payloads. Exactly one mode is valid, so deterministic package jobs no longer need a fake prompt merely to enter the scheduler.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | First-class `timezone` and `once` on the schedule record + create input. Both are optional and default to prior behaviour (no tz = process clock, once=false = recurring), so every existing schedule is untouched. `timezone` fixes cron firing in the container clock instead of the user's; `once` makes a one-shot a real state the runner pauses after firing, replacing the fragile "cron with no year" encoding that recurred annually.
 */

import { z } from 'zod';

/**
 * @description Lifecycle state of a scheduled task entry.
 */
export const ScheduleStatusSchema = z.enum(['active', 'paused']);

/**
 * @description Lifecycle state of a scheduled task entry.
 */
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

/**
 * @description Payload attached to a schedule. Matches legacy schedule payload
 * contract where `prompt` and `targetAgent` are supplied under `taskData`.
 */
export const MANIFEST_SERVICE_ROUTE_TASK_KIND = 'manifest-service-route' as const;

export const ScheduleTaskDataSchema = z.object({
  prompt: z.string().min(1).optional(),
  targetAgent: z.string().optional(),
  kind: z.string().optional(),
  /** Stable manifest schedule key only; the privileged route/body remain in the active registry. */
  scheduleKey: z.string().min(1).optional(),
}).catchall(z.unknown()).superRefine((value, ctx) => {
  const isServiceRoute = value.kind === MANIFEST_SERVICE_ROUTE_TASK_KIND;
  if (isServiceRoute) {
    if (!value.scheduleKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleKey'], message: 'service-route task data requires scheduleKey' });
    }
    if (value.prompt !== undefined || value.targetAgent !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'service-route task data cannot contain prompt or targetAgent' });
    }
    return;
  }
  if (!value.prompt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: 'prompt task data requires prompt' });
  }
  if (value.scheduleKey !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleKey'], message: 'prompt task data cannot contain scheduleKey' });
  }
});

/**
 * @description Payload attached to a schedule.
 */
export type ScheduleTaskData = z.infer<typeof ScheduleTaskDataSchema>;

/**
 * @description Persisted schedule record stored in Redis.
 */
export const ScheduleRecordSchema = z.object({
  id: z.string().min(1),
  taskType: z.string().min(1),
  cron: z.string().min(1),
  taskData: ScheduleTaskDataSchema,
  status: ScheduleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
  executionCount: z.number().int().nonnegative(),
  // OIDC `sub` of the user who created the schedule. Null for system/legacy
  // schedules with no session context — those remain visible to every caller.
  ownerSub: z.string().min(1).nullable().optional(),
  // Queue (application id) this schedule belongs to, so the cockpit calendar/queue
  // can filter schedules to the loaded apps. Derived from the ticket queue the
  // schedule's taskType maps to; null for legacy/system schedules.
  queue: z.string().nullable().optional(),
  // IANA timezone the cron clock time is interpreted in (e.g. "America/Chicago").
  // Absent = the process clock, which is the historical behaviour every existing
  // record relies on, so this stays optional.
  timezone: z.string().min(1).nullable().optional(),
  // One-shot intent: fire the next matching occurrence, then pause. Absent/false =
  // recurring, the historical default. This is what makes "on Tuesday" fire once
  // instead of once a year.
  once: z.boolean().optional(),
});

/**
 * @description Persisted schedule record stored in Redis.
 */
export type ScheduleRecord = z.infer<typeof ScheduleRecordSchema>;

/**
 * @description Input payload for creating or replacing a schedule.
 */
export const CreateScheduleInputSchema = z.object({
  taskType: z.string().min(1),
  schedule: z.string().min(1),
  taskData: ScheduleTaskDataSchema,
  // Caller identity injected by the controller from the OIDC session. Optional so
  // background/system callers without a session can still create schedules.
  ownerSub: z.string().nullable().optional(),
  // Explicit queue (app id) this schedule belongs to. When omitted it is derived
  // from the taskType's ticket queue mapping.
  queue: z.string().min(1).optional(),
  // IANA timezone the cron is interpreted in. Optional; absent = process clock.
  timezone: z.string().min(1).nullable().optional(),
  // One-shot intent — fire the next occurrence then pause. Optional; absent = recurring.
  once: z.boolean().optional(),
});

/**
 * @description Input payload for creating or replacing a schedule.
 */
export type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;

/**
 * @description Filter applied when listing schedules for a surface/view.
 *
 * `taskType` scopes to a single app queue (e.g. `home-control`). `ownerSub`
 * scopes to a caller's own schedules — records with no owner (system/legacy)
 * stay visible. `scope: 'all'` is the operator override that disables owner
 * scoping for admin/ops dashboards.
 */
export const ListSchedulesFilterSchema = z.object({
  taskType: z.string().min(1).optional(),
  // Queue (app id) scope — the cockpit calendar passes the loaded apps' queues so
  // schedules show only for loaded tools. Matches ScheduleRecord.queue.
  queue: z.string().min(1).optional(),
  ownerSub: z.string().min(1).optional(),
  scope: z.enum(['mine', 'all']).optional(),
});

/**
 * @description Filter applied when listing schedules for a surface/view.
 */
export type ListSchedulesFilter = z.infer<typeof ListSchedulesFilterSchema>;

/**
 * @description Partial task payload accepted when editing an existing schedule.
 */
export const UpdateScheduleTaskDataSchema = z.object({
  prompt: z.string().min(1).optional(),
  targetAgent: z.string().optional(),
}).catchall(z.unknown());

/**
 * @description Partial task payload accepted when editing an existing schedule.
 */
export type UpdateScheduleTaskData = z.infer<typeof UpdateScheduleTaskDataSchema>;

/**
 * @description Input payload for updating an existing schedule.
 */
export const UpdateScheduleInputSchema = z.object({
  pattern: z.string().min(1).optional(),
  schedule: z.string().min(1).optional(),
  taskData: UpdateScheduleTaskDataSchema.optional(),
});

/**
 * @description Input payload for updating an existing schedule.
 */
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInputSchema>;

/**
 * @description Result payload returned when a schedule is dispatched.
 */
export interface ScheduleDispatchResult {
  success: boolean;
  scheduleId: string;
  taskId?: string;
  error?: string;
}
