/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added AgentMetricsService — per-agent success rate, duration, retry rate (WS-7 #2)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed depth=0 filter from queryFromDB — agent assignments are on depth-1 items; depth-0 had only 1 assigned row
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'agent-metrics-service' });

/**
 * @description A single execution event recorded for an agent.
 */
export interface AgentExecutionEvent {
  agentId: string;
  ticketExternalId: string;
  swarmRunId: string;
  durationMs: number;
  outcome: 'completed' | 'failed' | 'escalated';
  retryCount: number;
  verificationAttempts: number;
  complexity?: string;
}

/**
 * @description Aggregated metrics for one agent.
 */
export interface AgentMetrics {
  agentId: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  escalationCount: number;
  successRate: number;
  avgDurationMs: number;
  avgRetryCount: number;
  avgVerificationAttempts: number;
  lastExecutionAt?: string;
}

/**
 * @description AgentMetricsService — collects and aggregates per-agent performance metrics.
 *
 * Fed by swarm execution completion events. Provides the data that the CompetencyRanker
 * consumes for routing tie-breaking. Also queryable by operators for agent health visibility.
 */
export class AgentMetricsService {
  private readonly pool: Pool | null;
  private readonly events: AgentExecutionEvent[] = [];

  constructor(pool: Pool | null = null) {
    this.pool = pool;
  }

  /**
   * @description Record an agent execution event.
   */
  recordExecution(event: AgentExecutionEvent): void {
    this.events.push(event);
    logger.info(
      { agentId: event.agentId, outcome: event.outcome, durationMs: event.durationMs },
      'Agent execution recorded',
    );
  }

  /**
   * @description Get metrics for a specific agent from in-memory events.
   */
  getMetrics(agentId: string): AgentMetrics {
    const agentEvents = this.events.filter((e) => e.agentId === agentId);
    return computeMetrics(agentId, agentEvents);
  }

  /**
   * @description Get metrics for all agents from in-memory events.
   */
  getAllMetrics(): AgentMetrics[] {
    const byAgent = new Map<string, AgentExecutionEvent[]>();
    for (const event of this.events) {
      if (!byAgent.has(event.agentId)) byAgent.set(event.agentId, []);
      byAgent.get(event.agentId)!.push(event);
    }

    return [...byAgent.entries()].map(([agentId, events]) => computeMetrics(agentId, events));
  }

  /**
   * @description Get metrics ranked by success rate descending.
   */
  getRankedMetrics(): AgentMetrics[] {
    return this.getAllMetrics().sort((a, b) => b.successRate - a.successRate);
  }

  /**
   * @description Query agent metrics from work_items table.
   */
  async queryFromDB(agentId?: string): Promise<AgentMetrics[]> {
    if (!this.pool) return agentId ? [this.getMetrics(agentId)] : this.getAllMetrics();

    try {
      const query = `
        SELECT
          assigned_agent_id as agent_id,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'failed') as failed,
          COUNT(*) FILTER (WHERE status = 'escalated') as escalated,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) as avg_duration_ms,
          MAX(updated_at) as last_execution
        FROM work_items
        WHERE assigned_agent_id IS NOT NULL
          AND ($1::text IS NULL OR assigned_agent_id = $1)
        GROUP BY assigned_agent_id
        ORDER BY COUNT(*) FILTER (WHERE status = 'completed')::float / GREATEST(COUNT(*), 1) DESC`;

      const result = await this.pool.query(query, [agentId ?? null]);

      return result.rows.map((row) => {
        const total = parseInt(row.total, 10);
        const completed = parseInt(row.completed, 10);
        const failed = parseInt(row.failed, 10);
        const escalated = parseInt(row.escalated, 10);
        return {
          agentId: row.agent_id,
          totalExecutions: total,
          successCount: completed,
          failureCount: failed,
          escalationCount: escalated,
          successRate: total > 0 ? completed / total : 0,
          avgDurationMs: parseFloat(row.avg_duration_ms) || 0,
          avgRetryCount: 0,
          avgVerificationAttempts: 0,
          lastExecutionAt: row.last_execution?.toISOString(),
        };
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to query agent metrics from database');
      return agentId ? [this.getMetrics(agentId)] : this.getAllMetrics();
    }
  }
}

function computeMetrics(agentId: string, events: AgentExecutionEvent[]): AgentMetrics {
  if (events.length === 0) {
    return {
      agentId, totalExecutions: 0, successCount: 0, failureCount: 0, escalationCount: 0,
      successRate: 0, avgDurationMs: 0, avgRetryCount: 0, avgVerificationAttempts: 0,
    };
  }

  const successCount = events.filter((e) => e.outcome === 'completed').length;
  const failureCount = events.filter((e) => e.outcome === 'failed').length;
  const escalationCount = events.filter((e) => e.outcome === 'escalated').length;
  const avgDurationMs = events.reduce((sum, e) => sum + e.durationMs, 0) / events.length;
  const avgRetryCount = events.reduce((sum, e) => sum + e.retryCount, 0) / events.length;
  const avgVerificationAttempts = events.reduce((sum, e) => sum + e.verificationAttempts, 0) / events.length;

  return {
    agentId,
    totalExecutions: events.length,
    successCount,
    failureCount,
    escalationCount,
    successRate: successCount / events.length,
    avgDurationMs,
    avgRetryCount,
    avgVerificationAttempts,
  };
}
