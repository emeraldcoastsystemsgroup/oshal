/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added AgentHealthMonitor — periodic health checks for all registered agents (WS-8 #4)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added resetAgent() for self-healing default restart (#7 fix)
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentMetricsService } from './agent-metrics-service';

const logger = createChildLogger({ module: 'agent-health-monitor' });

/**
 * @description Health status for one agent.
 */
export type AgentHealthStatus = 'healthy' | 'degraded' | 'unresponsive' | 'error_looping';

/**
 * @description Health check result for one agent.
 */
export interface AgentHealthCheck {
  agentId: string;
  status: AgentHealthStatus;
  checks: HealthCheckItem[];
  checkedAt: string;
  details?: string;
}

/**
 * @description One individual health check within an agent's health assessment.
 */
export interface HealthCheckItem {
  name: string;
  passed: boolean;
  detail?: string;
}

/**
 * @description Configuration for health monitoring thresholds.
 */
export interface HealthMonitorConfig {
  pollIntervalMs: number;
  errorRateThreshold: number;
  maxAvgDurationMs: number;
  minExecutions: number;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  pollIntervalMs: 120000,
  errorRateThreshold: 0.5,
  maxAvgDurationMs: 300000,
  minExecutions: 3,
};

/**
 * @description AgentHealthMonitor — periodic health assessment for all registered agents.
 *
 * Checks:
 * 1. Error rate — is the agent failing more than threshold?
 * 2. Duration — is the agent taking too long on average?
 * 3. Activity — has the agent had recent executions?
 * 4. Escalation rate — is the agent causing too many escalations?
 *
 * Results feed into the SelfHealingPipeline for remediation.
 */
export class AgentHealthMonitor {
  private readonly metricsService: AgentMetricsService;
  private readonly config: HealthMonitorConfig;
  private readonly history: AgentHealthCheck[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(metricsService: AgentMetricsService, config?: Partial<HealthMonitorConfig>) {
    this.metricsService = metricsService;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * @description Run health checks for all agents with recorded metrics.
   * @returns Array of health check results
   */
  checkAll(): AgentHealthCheck[] {
    const allMetrics = this.metricsService.getAllMetrics();
    const results = allMetrics.map((m) => this.assessAgent(m.agentId));
    this.history.push(...results);
    logger.info(
      { agentCount: results.length, degraded: results.filter((r) => r.status !== 'healthy').length },
      'Health check cycle completed',
    );
    return results;
  }

  /**
   * @description Assess one agent's health from its metrics.
   * @param agentId - Agent identifier
   * @returns Health check result
   */
  assessAgent(agentId: string): AgentHealthCheck {
    const metrics = this.metricsService.getMetrics(agentId);
    const checks: HealthCheckItem[] = [];

    checks.push({
      name: 'error-rate',
      passed: metrics.totalExecutions < this.config.minExecutions || (1 - metrics.successRate) < this.config.errorRateThreshold,
      detail: `${((1 - metrics.successRate) * 100).toFixed(1)}% error rate`,
    });

    checks.push({
      name: 'avg-duration',
      passed: metrics.avgDurationMs < this.config.maxAvgDurationMs,
      detail: `${Math.round(metrics.avgDurationMs)}ms avg`,
    });

    checks.push({
      name: 'escalation-rate',
      passed: metrics.totalExecutions === 0 || (metrics.escalationCount / metrics.totalExecutions) < 0.3,
      detail: `${metrics.escalationCount}/${metrics.totalExecutions} escalated`,
    });

    checks.push({
      name: 'has-activity',
      passed: metrics.totalExecutions > 0,
      detail: `${metrics.totalExecutions} executions`,
    });

    const failedChecks = checks.filter((c) => !c.passed);
    let status: AgentHealthStatus = 'healthy';
    if (failedChecks.length >= 3) status = 'unresponsive';
    else if (failedChecks.some((c) => c.name === 'error-rate')) status = 'error_looping';
    else if (failedChecks.length > 0) status = 'degraded';

    return { agentId, status, checks, checkedAt: new Date().toISOString() };
  }

  /**
   * @description Get recent health check history.
   * @param limit - Max results
   * @returns Recent health checks
   */
  getHistory(limit = 50): AgentHealthCheck[] {
    return this.history.slice(-limit);
  }

  /**
   * @description Get all unhealthy agents from the most recent check cycle.
   * @returns Agents that are not healthy
   */
  getUnhealthyAgents(): AgentHealthCheck[] {
    const latest = new Map<string, AgentHealthCheck>();
    for (const check of this.history) {
      latest.set(check.agentId, check);
    }
    return [...latest.values()].filter((c) => c.status !== 'healthy');
  }

  /**
   * @description Reset an agent's health history. Used by the self-healing pipeline
   * after a restart attempt to give the agent a clean slate for re-assessment.
   * @param agentId - Agent to reset
   */
  resetAgent(agentId: string): void {
    const beforeCount = this.history.length;
    const filtered = this.history.filter((h) => h.agentId !== agentId);
    this.history.length = 0;
    this.history.push(...filtered);
    logger.info({ agentId, removedChecks: beforeCount - filtered.length }, 'Agent health history reset');
  }

  /**
   * @description Start periodic health monitoring.
   */
  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.checkAll(), this.config.pollIntervalMs);
    logger.info({ intervalMs: this.config.pollIntervalMs }, 'Agent health monitor started');
  }

  /**
   * @description Stop periodic health monitoring.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info('Agent health monitor stopped');
    }
  }
}
