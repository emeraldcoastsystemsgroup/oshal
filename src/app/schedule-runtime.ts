/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of extracted schedule runtime wiring so server.ts can stay below the governance threshold during engineering-screen retrofit work
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the trading-autopilot dispatch branch (deterministic multi-timeframe loop) alongside the home branch + its scheduling-gate bypass and service injection
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added the trading-lab dispatch branch (ADR-092 Strategy Lab: nightly forward walks + pinned-window regressions) + its gate bypass — a system sim pass, same class as review/optimize
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the schedule dispatch callback + the enablement gate in runWithSystemIdentity so scheduled DB work (ticket/trading/world/series writes, tool-enablement reads) keeps operator visibility once OSHAL_DB_GUC_STRICT denies the identity-less case. Per-user home actions re-scope to the owner sub inside home-schedule-dispatch (nested, mirrors the interactive path).
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Dispatch active manifest service-route schedules through their deterministic loopback worker instead of the generic orchestrator, with the same system-schedule gate bypass as other kernel-owned deterministic branches.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Wire the assistant's reminder path: hand the scheduler service to jarvis-schedule-intent (only when the runner is enabled) and bypass the per-agent scheduler tool gate for the jarvis-reminder taskType — a user scheduling their own prompt through the assistant, re-run with autoApprove:false so the fire-time approval gates own execution. A jarvis-reminder falls through to the generic orchestrator dispatch, which is the intended behaviour (run the prompt as if the user had typed it then).
 */

import type { AppContext } from './composition-root';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import {
  RedisScheduleStore,
  ScheduleController,
  ScheduleRunner,
  ScheduleService,
  type ScheduleDispatchResult,
  type ScheduleRecord,
} from '@/features/scheduling';
import { DEFAULT_CHAT_AGENT_ID } from '@/features/chat-orchestration';
import { createChildLogger } from '@/shared/logger';
import { isHomeSchedule, dispatchHomeSchedule, setHomeScheduleService } from './home-schedule-dispatch';
import { isTradingSchedule, dispatchTradingSchedule, setTradingScheduleService } from './trading-schedule-dispatch';
import { isResearchSchedule, dispatchTradingResearch } from './trading-research-dispatch';
import { isAssessSchedule, dispatchTradingAssess } from './trading-assess-dispatch';
import { isReviewSchedule, dispatchTradingReview } from './trading-review-dispatch';
import { isOptimizeSchedule, dispatchTradingOptimize } from './trading-optimize-dispatch';
import { isLabSchedule, dispatchTradingLab } from './trading-lab-dispatch';
import { isSwingSchedule, dispatchTradingSwing } from './trading-swing-dispatch';
import { isWorldSchedule, dispatchWorldSchedule } from './world-schedule-dispatch';
import { isWorkflowTicketSchedule, dispatchWorkflowTicketSchedule } from './workflow-ticket-schedule-dispatch';
import { JARVIS_REMINDER_TASK_TYPE, setJarvisScheduleService } from './routes/jarvis-schedule-intent';
import {
  isManifestServiceRouteSchedule,
  type ManifestServiceRouteScheduleRuntime,
} from './manifest-service-route-schedule';

const logger = createChildLogger({ module: 'schedule-runtime' });
let schedulerShutdownHookRegistered = false;

/**
 * @description Builds scheduler runtime components and starts polling when enabled.
 * @param ctx - Application context used to dispatch scheduled prompts.
 * @returns Bound schedule controller instance for route registration.
 */
export function createScheduleController(
  ctx: AppContext,
  serviceRouteSchedules: ManifestServiceRouteScheduleRuntime,
): ScheduleController {
  const store = new RedisScheduleStore();
  // Home schedules (smart-home timers) dispatch through the home branch — broker the
  // owner's token, run on the home-bot, log a home-control ticket. Everything else
  // keeps the generic orchestrator path. Keeps the shared scheduler untouched.
  // Every scheduled dispatch is background work (no request in scope). Stamp it as trusted
  // SYSTEM so ticket/trading/world/series/workflow DB writes keep operator visibility once
  // OSHAL_DB_GUC_STRICT denies the identity-less case. The one per-user exception — home
  // actions owned by a specific user — re-scopes to the owner sub INSIDE dispatchHomeSchedule
  // (a nested runWithRequestIdentity wins for that scope), mirroring the interactive path.
  const service = new ScheduleService(store, (schedule) => runWithSystemIdentity(() =>
    isHomeSchedule(schedule.taskType) ? dispatchHomeSchedule(ctx, schedule)
      : isTradingSchedule(schedule.taskType) ? dispatchTradingSchedule(ctx, schedule)
      : isResearchSchedule(schedule.taskType) ? dispatchTradingResearch(ctx, schedule)
      : isAssessSchedule(schedule.taskType) ? dispatchTradingAssess(ctx, schedule)
      : isReviewSchedule(schedule.taskType) ? dispatchTradingReview(ctx, schedule)
      : isOptimizeSchedule(schedule.taskType) ? dispatchTradingOptimize(ctx, schedule)
      : isLabSchedule(schedule.taskType) ? dispatchTradingLab(ctx, schedule)
      : isSwingSchedule(schedule.taskType) ? dispatchTradingSwing(ctx, schedule)
      : isWorldSchedule(schedule.taskType) ? dispatchWorldSchedule(ctx, schedule)
      : isWorkflowTicketSchedule(schedule.taskType) ? dispatchWorkflowTicketSchedule(ctx, schedule)
      : isManifestServiceRouteSchedule(schedule.taskType) ? serviceRouteSchedules.dispatch(schedule)
      : dispatchScheduleToOrchestrator(ctx, schedule)), {
    defaultTargetAgentId: DEFAULT_CHAT_AGENT_ID,
    ensureSchedulingEnabled: (targetAgentId, taskType) => runWithSystemIdentity(async () => {
      // Home schedules dispatch to the home-bot via the home branch (token brokered),
      // not the generic agent-scheduler tool path — skip the per-agent tool gate.
      if (isHomeSchedule(taskType)) return;
      // Trading-autopilot schedules run the deterministic in-controller loop (no target
      // agent), so they likewise bypass the per-agent self-scheduling tool gate.
      if (isTradingSchedule(taskType)) return;
      // Trading research/fast brain schedules run the analyst inline (no user self-scheduling).
      if (isResearchSchedule(taskType)) return;
      // The assessment batch is a system forecast pass — bypass the per-agent tool gate.
      if (isAssessSchedule(taskType)) return;
      // The overnight signal review is a system learning pass — bypass the gate too.
      if (isReviewSchedule(taskType)) return;
      // The nightly parameter optimizer is a system backtest pass (recommend-only) — bypass the gate.
      if (isOptimizeSchedule(taskType)) return;
      // The Strategy Lab leg (forward walks + pinned-window regressions) is a system sim pass — bypass.
      if (isLabSchedule(taskType)) return;
      // The daily swing (trend) sleeve runs the deterministic Donchian loop in-controller — bypass.
      if (isSwingSchedule(taskType)) return;
      // Manifest/framework-declared schedules (taskType `app:<app>-<id>`) are operator/
      // system-declared "default polls", not a user agent self-scheduling — they bypass
      // the per-agent agent-scheduler tool gate (which exists to gate user self-scheduling).
      if (taskType.startsWith('app:')) return;
      // Workflow-ticket schedules (taskType `workflow:<ticketType>`) only create a ticket;
      // the workflow engine owns execution. Operator/system-declared — bypass the per-agent gate.
      if (isWorkflowTicketSchedule(taskType)) return;
      // Installed-package deterministic workers are validated service-auth routes. The active
      // registry, rather than an agent tool grant, is their execution authority.
      if (isManifestServiceRouteSchedule(taskType)) return;
      // A Jarvis personal reminder is a user scheduling their OWN prompt through the assistant. It
      // re-runs that prompt through the general orchestrator with autoApprove:false, so the fire-time
      // approval gates own execution — same class as the workflow-ticket bypass. The reminder is
      // per-user (ownerSub) and creates no outward effect at schedule time, so it is not gated behind
      // the per-agent agent-scheduler tool (which gates a BOT self-scheduling, not a person).
      if (taskType === JARVIS_REMINDER_TASK_TYPE) return;
      if (!targetAgentId) {
        throw new Error(`Schedule ${taskType} is missing a target agent`);
      }

      const schedulerEnabled = await ctx.switchFrameworkService.isToolEnabled(targetAgentId, 'agent-scheduler');
      if (!schedulerEnabled) {
        throw new Error(`Agent Scheduler is off for agent ${targetAgentId}`);
      }
    }),
  });
  const pollIntervalMs = parsePositiveInteger(process.env.SCHEDULER_POLL_INTERVAL_MS, 15000);
  const runner = new ScheduleRunner(service, pollIntervalMs);

  if (process.env.ENABLE_AGENT_SCHEDULER === 'true') {
    runner.start(true);
    logger.info({ pollIntervalMs }, 'Agent scheduler runner started');
  } else {
    logger.info('Agent scheduler runner auto-start disabled');
  }

  // Expose the service to the home schedule layer (routes create/list/delete; the
  // solar replanner updates crons) without a circular import.
  setHomeScheduleService(service);
  // Same handle for the trading autopilot control route (enable/status/stop).
  setTradingScheduleService(service);
  // Give the assistant's /ask path a handle so "remind me on Tuesday" creates a real schedule. Only
  // wired when the runner is actually enabled — a reminder is pointless without a runner to fire it,
  // so jarvisSchedulingAvailable() is false (and the /ask pre-check declines) on a box with the
  // scheduler off, which is the honest posture rather than accepting reminders that never run.
  setJarvisScheduleService(process.env.ENABLE_AGENT_SCHEDULER === 'true' ? service : null);
  registerSchedulerShutdownHook(runner, service);
  return new ScheduleController(service, runner);
}

/**
 * @description Dispatches a schedule prompt into the chat orchestrator.
 * @param ctx - Application context with orchestrator dependency.
 * @param schedule - Due schedule record to execute.
 * @returns Dispatch status for scheduling service accounting.
 */
async function dispatchScheduleToOrchestrator(
  ctx: AppContext,
  schedule: ScheduleRecord,
): Promise<ScheduleDispatchResult> {
  const prompt = readOptionalString(schedule.taskData.prompt);
  if (!prompt) {
    logger.error({ scheduleId: schedule.id }, 'Scheduled task missing prompt');
    return { success: false, scheduleId: schedule.id, error: 'Missing taskData.prompt' };
  }

  const agentId = readOptionalString(schedule.taskData.targetAgent);
  const taskId = buildScheduledTaskId(schedule.id);

  try {
    logger.info({ scheduleId: schedule.id, taskId, agentId }, 'Dispatching scheduled prompt to orchestrator');
    await ctx.orchestrator.processMessage(taskId, prompt, {
      agenticMode: true,
      autoApprove: false,
      source: 'scheduler',
      agentId,
    });
    return { success: true, scheduleId: schedule.id, taskId };
  } catch (error) {
    logger.error({ err: error, scheduleId: schedule.id, taskId }, 'Failed to dispatch scheduled prompt');
    return { success: false, scheduleId: schedule.id, taskId, error: asErrorMessage(error) };
  }
}

/**
 * @description Registers process-level scheduler shutdown cleanup once.
 * @param runner - Polling schedule runner.
 * @param service - Scheduling service with Redis resources.
 * @returns Nothing; mutates process signal handlers once.
 */
function registerSchedulerShutdownHook(runner: ScheduleRunner, service: ScheduleService): void {
  if (schedulerShutdownHookRegistered) {
    return;
  }

  schedulerShutdownHookRegistered = true;
  process.once('SIGINT', () => {
    runner.stop();
    void service.shutdown();
  });
  process.once('SIGTERM', () => {
    runner.stop();
    void service.shutdown();
  });
}

/**
 * @description Generates deterministic task identifiers for scheduled dispatches.
 * @param scheduleId - Schedule identifier that triggered execution.
 * @returns Task identifier for orchestrator processing.
 */
function buildScheduledTaskId(scheduleId: string): string {
  const suffix = Date.now().toString(36);
  return `schedule-${scheduleId}-${suffix}`.replaceAll(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * @description Parses a positive integer environment value with fallback.
 * @param rawValue - Raw environment string value.
 * @param fallback - Default number when raw value is invalid.
 * @returns Parsed positive integer.
 */
function parsePositiveInteger(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @description Reads optional non-empty strings from unknown input values.
 * @param value - Unknown value to normalize.
 * @returns Trimmed string when non-empty.
 */
function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * @description Converts unknown errors into response-safe text.
 * @param error - Unknown error value.
 * @returns Human-readable error text.
 */
function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
