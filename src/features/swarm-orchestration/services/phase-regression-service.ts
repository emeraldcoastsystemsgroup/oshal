/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial PhaseRegressionService — regression loop detection, feedback injection, and escalation when regression limit is exceeded. Stage 3 of the complex-ticket reference gap plan.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | TD-1: Hybrid persistence — reads from QueueGovernanceService Postgres counts when available, falls back to in-memory. Eliminates infinite regression on PM bot restart.
 */

import { createChildLogger } from '@/shared/logger';
import type { QueueGovernanceService } from './queue-governance-service';

const logger = createChildLogger({ module: 'phase-regression-service' });

// ---------------------------------------------------------------------------
// Regression Configuration
// ---------------------------------------------------------------------------

/**
 * @description Configuration for phase regression behavior.
 */
export interface PhaseRegressionConfig {
  /** Maximum number of regressions before escalating the ticket. Default: 3. */
  maxRegressions: number;
  /** Whether to inject feedback from the failed phase into the regression target. Default: true. */
  injectFeedback: boolean;
}

const DEFAULT_CONFIG: PhaseRegressionConfig = {
  maxRegressions: 3,
  injectFeedback: true,
};

// ---------------------------------------------------------------------------
// Regression Decision
// ---------------------------------------------------------------------------

/**
 * @description Result of a regression evaluation.
 */
export interface RegressionDecision {
  shouldRegress: boolean;
  shouldEscalate: boolean;
  regressionTarget: 'execution' | 'planning';
  regressionCount: number;
  feedback: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * @description Evaluates whether a failed phase should trigger a regression to a prior phase
 * or escalate to human review. Uses Postgres-persisted counts via QueueGovernanceService
 * when available, falls back to in-memory tracking for tests and non-Postgres environments.
 */
export class PhaseRegressionService {
  private readonly config: PhaseRegressionConfig;
  private readonly regressionCounts = new Map<string, number>();
  private governanceService?: QueueGovernanceService;

  constructor(config?: Partial<PhaseRegressionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * @description Injects the QueueGovernanceService for Postgres-backed regression count persistence.
   * When set, regression counts are read from and written to the tickets.metadata.governance column.
   * @param service - QueueGovernanceService instance from composition root.
   */
  setGovernanceService(service: QueueGovernanceService): void {
    this.governanceService = service;
    logger.info('QueueGovernanceService wired into PhaseRegressionService — regression counts will persist to Postgres');
  }

  /**
   * @description Evaluates whether a failed phase should regress or escalate.
   * Increments the regression count (Postgres-backed when governance is wired, in-memory otherwise)
   * and checks against the configured maximum.
   * @param ticketId - External ticket identifier
   * @param failedPhase - The phase that failed ('testing' | 'review')
   * @param failureReason - Explanation of why the phase failed
   * @param findings - Detailed verification findings
   * @param executorAgentId - Agent that performed the original execution
   * @returns Decision on whether to regress, escalate, or neither
   */
  async evaluateRegression(
    ticketId: string,
    failedPhase: 'testing' | 'review',
    failureReason: string,
    findings: string[],
    executorAgentId?: string,
  ): Promise<RegressionDecision> {
    const count = await this.incrementAndGetCount(ticketId);

    if (count > this.config.maxRegressions) {
      logger.warn(
        { ticketId, failedPhase, count, max: this.config.maxRegressions },
        'Regression limit exceeded — escalating',
      );
      return {
        shouldRegress: false,
        shouldEscalate: true,
        regressionTarget: failedPhase === 'testing' ? 'execution' : 'planning',
        regressionCount: count,
        feedback: null,
      };
    }

    const feedback = this.config.injectFeedback
      ? this.buildFeedback(failedPhase, failureReason, findings, executorAgentId)
      : null;

    logger.info(
      { ticketId, failedPhase, count, target: failedPhase === 'testing' ? 'execution' : 'planning' },
      'Regression triggered',
    );

    return {
      shouldRegress: true,
      shouldEscalate: false,
      regressionTarget: failedPhase === 'testing' ? 'execution' : 'planning',
      regressionCount: count,
      feedback,
    };
  }

  /**
   * @description Increments and returns the regression count for a ticket.
   * Uses Postgres via QueueGovernanceService when available, falls back to in-memory Map.
   * @param ticketId - External ticket identifier.
   * @returns Current regression count after increment.
   */
  private async incrementAndGetCount(ticketId: string): Promise<number> {
    if (this.governanceService) {
      try {
        const pgCount = await this.governanceService.incrementRegression(ticketId);
        // Keep in-memory in sync as a read cache
        this.regressionCounts.set(ticketId, pgCount);
        return pgCount;
      } catch (error) {
        logger.warn({ err: error, ticketId }, 'Postgres regression increment failed — falling back to in-memory');
      }
    }

    // In-memory fallback
    const count = (this.regressionCounts.get(ticketId) ?? 0) + 1;
    this.regressionCounts.set(ticketId, count);
    return count;
  }

  /** @description Builds feedback string for injection into the regression target phase. */
  private buildFeedback(phase: string, reason: string, findings: string[], agentId?: string): string {
    const parts = [`[Regression from ${phase}] ${reason}`];
    if (findings.length > 0) parts.push(`Findings: ${findings.join('; ')}`);
    if (agentId) parts.push(`Original executor: ${agentId}`);
    return parts.join(' | ');
  }
}