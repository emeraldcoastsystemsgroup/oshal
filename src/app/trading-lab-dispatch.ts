/**
 * Strategy Lab scheduler leg (ADR-092) — the nightly post-close `trading-lab:<sub>` schedule.
 * Two halves, both idempotent per session: (1) FORWARD — advance every non-retired strategy's
 * out-of-sample walk onto the session that just closed; (2) REGRESSION — re-run every baselined
 * strategy over its pinned window and flag drift (engine-behavior change, the resample-bug class).
 * Created alongside the advisor's other legs by the autopilot enable route; also runnable on
 * demand via POST /api/trading/lab/forward-run + /regression-run and scripts/trading-regression-suite.ts.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — isLabSchedule/labTaskType/LAB_CRON + dispatchTradingLab (forward-all then regress-all, drift logged at ERROR for the watchdog).
 *
 * @module trading-lab-dispatch
 */

import type { AppContext } from './composition-root';
import type { ScheduleDispatchResult, ScheduleRecord } from '@/features/scheduling';
import { marketDataConfigured } from '@/features/trading';
import { createChildLogger } from '@/shared/logger';
import { runForwardAll, runRegressionsAll } from './trading-strategy-lab-ops';

const logger = createChildLogger({ module: 'trading-lab-dispatch' });

/** Nightly, after the US close settles (21:45 UTC ≈ 16:45 ET in DST), weekdays. */
export const LAB_CRON = '45 21 * * 1-5';

/** @description True for schedules this module owns. */
export function isLabSchedule(taskType: string): boolean { return taskType.startsWith('trading-lab'); }

/** @description The per-user lab schedule taskType. */
export function labTaskType(sub: string): string { return `trading-lab:${sub}`; }

/**
 * @description Dispatches the nightly lab leg: forward-step all strategies, then regression-run
 * the baselined ones. Never throws — the scheduler gets a structured result either way.
 * @param ctx - App context (pool).
 * @param schedule - The due schedule (taskData carries userSub).
 * @returns Dispatch result for scheduler accounting.
 */
export async function dispatchTradingLab(ctx: AppContext, schedule: ScheduleRecord): Promise<ScheduleDispatchResult> {
  const sub = String((schedule.taskData as Record<string, unknown>).userSub || '');
  if (!sub) return { success: false, scheduleId: schedule.id, error: 'lab schedule missing userSub' };
  if (!marketDataConfigured()) {
    logger.info({ scheduleId: schedule.id }, 'lab leg skipped — market data keys not configured');
    return { success: true, scheduleId: schedule.id };
  }
  try {
    const forward = await runForwardAll(ctx.pool, sub);
    const verdicts = await runRegressionsAll(ctx.pool, sub);
    const drifted = verdicts.filter((v) => v.status === 'drifted');
    const failed = verdicts.filter((v) => v.status === 'failed');
    if (drifted.length) {
      logger.error({ sub, drifted: drifted.map((d) => ({ name: d.strategyName, deltas: d.deltas })) },
        'STRATEGY REGRESSION DRIFT — a pinned-window rerun no longer reproduces its baseline; the engine changed behavior');
    }
    logger.info({
      sub, strategies: forward.length,
      sessionsApplied: forward.reduce((s, f) => s + f.applied, 0),
      regressions: verdicts.length, drifted: drifted.length, failed: failed.length,
    }, 'lab leg complete');
    return { success: true, scheduleId: schedule.id };
  } catch (err) {
    logger.error({ err, scheduleId: schedule.id, sub }, 'lab leg failed');
    return { success: false, scheduleId: schedule.id, error: (err as Error).message };
  }
}
