/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added polling runner for Redis-backed schedule dispatch
 */

import { createChildLogger } from '@/shared/logger';
import { ScheduleService } from './schedule-service';

const logger = createChildLogger({ module: 'schedule-runner' });
const DEFAULT_POLL_INTERVAL_MS = 15000;

/**
 * @description Polling runtime that periodically dispatches due schedules.
 */
export class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cycleActive = false;

  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  /**
   * @description Starts the polling runner and optional immediate first cycle.
   *
   * @param runImmediately - When true, executes one cycle before interval scheduling.
   */
  start(runImmediately: boolean = true): void {
    if (this.timer) {
      logger.warn('Schedule runner already started');
      return;
    }

    logger.info({ pollIntervalMs: this.pollIntervalMs }, 'Starting schedule runner');
    if (runImmediately) {
      void this.runCycle();
    }

    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.pollIntervalMs);
  }

  /**
   * @description Stops the polling runner.
   */
  stop(): void {
    if (!this.timer) {
      logger.warn('Schedule runner is not running');
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Stopped schedule runner');
  }

  /**
   * @description Returns runner state used by diagnostics endpoints.
   */
  getStatus(): { isRunning: boolean; pollIntervalMs: number } {
    return {
      isRunning: this.timer !== null,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  /**
   * @description Executes a single dispatch cycle unless another cycle is running.
   */
  private async runCycle(): Promise<void> {
    if (this.cycleActive) {
      logger.warn('Skipped overlapping schedule dispatch cycle');
      return;
    }

    this.cycleActive = true;
    try {
      const dispatched = await this.scheduleService.dispatchDueSchedules();
      logger.info({ dispatched }, 'Completed schedule dispatch cycle');
    } catch (error) {
      logger.error({ err: error }, 'Schedule dispatch cycle failed');
    } finally {
      this.cycleActive = false;
    }
  }
}
