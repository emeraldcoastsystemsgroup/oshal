/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation of VerificationScheduler
 */

import { logger } from '@/shared/logger';
import { ToolVerificationService } from './tool-verification-service';
import { VerificationSummary } from '@/shared/types/tool';

/**
 * @description Scheduler for periodic tool verification checks.
 * Runs verification at configurable intervals and logs results.
 */
export class VerificationScheduler {
  private readonly logger = logger.child({ service: 'VerificationScheduler' });
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly verificationService: ToolVerificationService,
    private readonly intervalMs: number = 3600000 // Default: 1 hour
  ) {}

  /**
   * @description Start the verification scheduler
   * 
   * @param runImmediately - Whether to run verification immediately on start
   */
  start(runImmediately: boolean = false): void {
    if (this.isRunning) {
      this.logger.warn('Scheduler already running, ignoring start request');
      return;
    }

    this.logger.info(
      { intervalMs: this.intervalMs, runImmediately },
      'Starting verification scheduler'
    );

    this.isRunning = true;

    if (runImmediately) {
      this.runVerification();
    }

    this.intervalId = setInterval(() => {
      this.runVerification();
    }, this.intervalMs);
  }

  /**
   * @description Stop the verification scheduler
   */
  stop(): void {
    if (!this.isRunning) {
      this.logger.warn('Scheduler not running, ignoring stop request');
      return;
    }

    this.logger.info('Stopping verification scheduler');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
  }

  /**
   * @description Check if scheduler is currently running
   * 
   * @returns True if scheduler is active
   */
  getStatus(): boolean {
    return this.isRunning;
  }

  /**
   * @description Run verification immediately (manual trigger)
   * 
   * @returns VerificationSummary of the verification run
   */
  async runNow(): Promise<VerificationSummary> {
    this.logger.info('Manual verification trigger');
    return await this.runVerification();
  }

  /**
   * @description Execute verification and log results
   */
  private async runVerification(): Promise<VerificationSummary> {
    this.logger.info('Starting scheduled tool verification');
    const startTime = Date.now();

    try {
      const summary = await this.verificationService.verifyAllTools('system');
      const durationSec = (Date.now() - startTime) / 1000;

      this.logger.info(
        {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          errors: summary.errors,
          skipped: summary.skipped,
          durationSec,
        },
        'Scheduled verification completed'
      );

      return summary;
    } catch (error) {
      this.logger.error({ err: error }, 'Scheduled verification failed');
      throw error;
    }
  }
}