/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial SwarmMetricsCollector — aggregates processing metrics across governance services for cockpit consumption. Stage 6 of the complex-ticket reference gap plan.
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-metrics-collector' });

// ---------------------------------------------------------------------------
// Metric Types
// ---------------------------------------------------------------------------

/**
 * @description Metrics for a single ticket processing run.
 */
export interface TicketProcessingMetrics {
  ticketId: string;
  runId: string;
  agentId: string;
  complexity: string;
  phases: PhaseMetric[];
  totalDurationMs: number;
  outcome: 'completed' | 'failed' | 'escalated';
  regressionCount: number;
  executionAttempts: number;
  verificationAttempts: number;
  artifactComplianceScore: number;
  handoverCount: number;
  staleLoopDetected: boolean;
  approvalRequired: boolean;
  completedAt: string;
}

/**
 * @description Metrics for a single phase within a ticket run.
 */
export interface PhaseMetric {
  phase: string;
  phaseIndex: number;
  durationMs: number;
  agentId: string;
  rounds: number;
  status: 'completed' | 'failed' | 'skipped' | 'regressed';
  artifactsValid: boolean;
  handoverWritten: boolean;
}

/**
 * @description Aggregated metrics across all recent runs.
 */
export interface AggregatedMetrics {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  escalatedRuns: number;
  averageDurationMs: number;
  averageRegressionCount: number;
  averageExecutionAttempts: number;
  averageArtifactCompliance: number;
  staleLoopRate: number;
  approvalRequiredRate: number;
  phaseCompletionRates: Record<string, number>;
  topFailurePhases: Array<{ phase: string; failureCount: number }>;
  agentPerformance: AgentPerformanceMetric[];
  collectedAt: string;
}

/**
 * @description Performance metrics for a specific agent.
 */
export interface AgentPerformanceMetric {
  agentId: string;
  ticketsHandled: number;
  completedCount: number;
  failedCount: number;
  averageDurationMs: number;
  regressionRate: number;
}

// ---------------------------------------------------------------------------
// Collector Configuration
// ---------------------------------------------------------------------------

/**
 * @description Configuration for the metrics collector.
 */
export interface MetricsCollectorConfig {
  /** Maximum number of ticket metrics to retain in memory. Default: 500. */
  maxRetainedMetrics: number;
  /** Whether to log metrics on collection. Default: true. */
  logOnCollect: boolean;
}

const DEFAULT_CONFIG: MetricsCollectorConfig = {
  maxRetainedMetrics: 500,
  logOnCollect: true,
};

// ---------------------------------------------------------------------------
// Swarm Metrics Collector
// ---------------------------------------------------------------------------

/**
 * @description SwarmMetricsCollector — aggregates processing metrics from
 * governance services and provides operator-ready summaries.
 *
 * Responsibilities:
 * - Collect per-ticket processing metrics
 * - Aggregate metrics across runs for dashboards
 * - Track agent performance
 * - Track phase completion rates and failure patterns
 * - Provide cockpit-ready summary data
 */
export class SwarmMetricsCollector {
  private readonly config: MetricsCollectorConfig;
  private readonly ticketMetrics: TicketProcessingMetrics[] = [];

  constructor(config?: Partial<MetricsCollectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * @description Record metrics for a completed ticket processing run.
   * @param metrics - The ticket processing metrics to record.
   */
  recordTicketMetrics(metrics: TicketProcessingMetrics): void {
    this.ticketMetrics.push(metrics);

    if (this.ticketMetrics.length > this.config.maxRetainedMetrics) {
      this.ticketMetrics.shift();
    }

    if (this.config.logOnCollect) {
      logger.info(
        {
          ticketId: metrics.ticketId,
          outcome: metrics.outcome,
          durationMs: metrics.totalDurationMs,
          regressions: metrics.regressionCount,
          phases: metrics.phases.length,
        },
        'Ticket processing metrics recorded',
      );
    }
  }

  /**
   * @description Get aggregated metrics across all retained runs.
   * @returns Aggregated metrics summary for cockpit dashboards.
   */
  getAggregatedMetrics(): AggregatedMetrics {
    const total = this.ticketMetrics.length;
    if (total === 0) {
      return this.emptyAggregatedMetrics();
    }

    const completed = this.ticketMetrics.filter((m) => m.outcome === 'completed');
    const failed = this.ticketMetrics.filter((m) => m.outcome === 'failed');
    const escalated = this.ticketMetrics.filter((m) => m.outcome === 'escalated');

    return {
      totalRuns: total,
      completedRuns: completed.length,
      failedRuns: failed.length,
      escalatedRuns: escalated.length,
      averageDurationMs: this.average(this.ticketMetrics.map((m) => m.totalDurationMs)),
      averageRegressionCount: this.average(this.ticketMetrics.map((m) => m.regressionCount)),
      averageExecutionAttempts: this.average(this.ticketMetrics.map((m) => m.executionAttempts)),
      averageArtifactCompliance: this.average(this.ticketMetrics.map((m) => m.artifactComplianceScore)),
      staleLoopRate: this.ticketMetrics.filter((m) => m.staleLoopDetected).length / total,
      approvalRequiredRate: this.ticketMetrics.filter((m) => m.approvalRequired).length / total,
      phaseCompletionRates: this.computePhaseCompletionRates(),
      topFailurePhases: this.computeTopFailurePhases(),
      agentPerformance: this.computeAgentPerformance(),
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * @description Get metrics for a specific ticket.
   * @param ticketId - The ticket identifier.
   * @returns Metrics for the ticket, or undefined if not found.
   */
  getTicketMetrics(ticketId: string): TicketProcessingMetrics | undefined {
    return this.ticketMetrics.find((m) => m.ticketId === ticketId);
  }

  /**
   * @description Get recent ticket metrics.
   * @param limit - Maximum number of records to return.
   * @returns Recent ticket metrics, most recent first.
   */
  getRecentMetrics(limit = 50): TicketProcessingMetrics[] {
    return this.ticketMetrics.slice(-limit).reverse();
  }

  /**
   * @description Get agent performance metrics.
   * @returns Performance metrics per agent.
   */
  getAgentPerformance(): AgentPerformanceMetric[] {
    return this.computeAgentPerformance();
  }

  /**
   * @description Clear all retained metrics.
   */
  clear(): void {
    this.ticketMetrics.length = 0;
    logger.info('Metrics collector cleared');
  }

  // -----------------------------------------------------------------------
  // Private Helpers
  // -----------------------------------------------------------------------

  /**
   * @description Compute phase completion rates across all runs.
   */
  private computePhaseCompletionRates(): Record<string, number> {
    const phaseCounts: Record<string, { total: number; completed: number }> = {};

    for (const metric of this.ticketMetrics) {
      for (const phase of metric.phases) {
        if (!phaseCounts[phase.phase]) {
          phaseCounts[phase.phase] = { total: 0, completed: 0 };
        }
        phaseCounts[phase.phase].total++;
        if (phase.status === 'completed') {
          phaseCounts[phase.phase].completed++;
        }
      }
    }

    const rates: Record<string, number> = {};
    for (const [phase, counts] of Object.entries(phaseCounts)) {
      rates[phase] = counts.total > 0 ? counts.completed / counts.total : 0;
    }
    return rates;
  }

  /**
   * @description Compute top failure phases across all runs.
   */
  private computeTopFailurePhases(): Array<{ phase: string; failureCount: number }> {
    const failureCounts: Record<string, number> = {};

    for (const metric of this.ticketMetrics) {
      for (const phase of metric.phases) {
        if (phase.status === 'failed' || phase.status === 'regressed') {
          failureCounts[phase.phase] = (failureCounts[phase.phase] || 0) + 1;
        }
      }
    }

    return Object.entries(failureCounts)
      .map(([phase, failureCount]) => ({ phase, failureCount }))
      .sort((a, b) => b.failureCount - a.failureCount)
      .slice(0, 5);
  }

  /**
   * @description Compute per-agent performance metrics.
   */
  private computeAgentPerformance(): AgentPerformanceMetric[] {
    const agentMap: Record<string, TicketProcessingMetrics[]> = {};

    for (const metric of this.ticketMetrics) {
      if (!agentMap[metric.agentId]) {
        agentMap[metric.agentId] = [];
      }
      agentMap[metric.agentId].push(metric);
    }

    return Object.entries(agentMap).map(([agentId, metrics]) => ({
      agentId,
      ticketsHandled: metrics.length,
      completedCount: metrics.filter((m) => m.outcome === 'completed').length,
      failedCount: metrics.filter((m) => m.outcome === 'failed').length,
      averageDurationMs: this.average(metrics.map((m) => m.totalDurationMs)),
      regressionRate: metrics.length > 0
        ? metrics.filter((m) => m.regressionCount > 0).length / metrics.length
        : 0,
    }));
  }

  /**
   * @description Compute average of a number array.
   */
  private average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * @description Return empty aggregated metrics when no data is available.
   */
  private emptyAggregatedMetrics(): AggregatedMetrics {
    return {
      totalRuns: 0, completedRuns: 0, failedRuns: 0, escalatedRuns: 0,
      averageDurationMs: 0, averageRegressionCount: 0, averageExecutionAttempts: 0,
      averageArtifactCompliance: 0, staleLoopRate: 0, approvalRequiredRate: 0,
      phaseCompletionRates: {}, topFailurePhases: [], agentPerformance: [],
      collectedAt: new Date().toISOString(),
    };
  }
}