/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added RoutingAuditLog — persist every routing decision for traceability (WS-7 #5)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Removed inline CREATE TABLE — schema now in migration 012-routing-audit-log.sql (#5 fix)
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'routing-audit-log' });

/**
 * @description One routing decision record for the audit trail.
 */
export interface RoutingAuditEntry {
  taskId: string;
  ticketExternalId?: string;
  swarmRunId?: string;
  winnerAgentId: string;
  strategy: string;
  winnerScore: number;
  winnerConfidence?: number;
  candidateCount: number;
  candidates: Array<{ agentId: string; score: number; reason: string }>;
  tiersAttempted: string[];
  requiredCapabilities?: string[];
  ticketTitle?: string;
  durationMs: number;
  createdAt: string;
}

/**
 * @description Routing audit query filters.
 */
export interface RoutingAuditQuery {
  agentId?: string;
  strategy?: string;
  since?: Date;
  limit?: number;
}

/**
 * @description RoutingAuditLog — persists every routing decision with full context.
 *
 * Captures: which tiers were tried, which agents bid, scores, final selection, rationale.
 * Enables operators to understand WHY a ticket was routed to a specific agent.
 * Dual-write: in-memory for fast access, Postgres for durable history.
 */
export class RoutingAuditLog {
  private readonly pool: Pool | null;
  private readonly entries: RoutingAuditEntry[] = [];

  constructor(pool: Pool | null = null) {
    this.pool = pool;
    // Schema managed by migration 012-routing-audit-log.sql — no inline CREATE TABLE
  }

  /**
   * @description Record a routing decision.
   */
  async record(entry: RoutingAuditEntry): Promise<void> {
    this.entries.push(entry);

    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO routing_audit_log (
            task_id, ticket_external_id, swarm_run_id,
            winner_agent_id, strategy, winner_score, winner_confidence,
            candidate_count, candidates, tiers_attempted,
            required_capabilities, ticket_title, duration_ms, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
          [
            entry.taskId, entry.ticketExternalId ?? null, entry.swarmRunId ?? null,
            entry.winnerAgentId, entry.strategy, entry.winnerScore, entry.winnerConfidence ?? null,
            entry.candidateCount, JSON.stringify(entry.candidates), entry.tiersAttempted,
            entry.requiredCapabilities ?? null, entry.ticketTitle ?? null,
            entry.durationMs, entry.createdAt,
          ],
        );
      } catch (err) {
        logger.warn({ err, taskId: entry.taskId }, 'Failed to persist routing audit — in-memory only');
      }
    }

    logger.info(
      { taskId: entry.taskId, winner: entry.winnerAgentId, strategy: entry.strategy, candidates: entry.candidateCount },
      'Routing decision recorded',
    );
  }

  /**
   * @description Query routing audit entries.
   */
  query(filter: RoutingAuditQuery = {}): RoutingAuditEntry[] {
    let filtered = this.entries;
    if (filter.agentId) filtered = filtered.filter((e) => e.winnerAgentId === filter.agentId);
    if (filter.strategy) filtered = filtered.filter((e) => e.strategy === filter.strategy);
    if (filter.since) filtered = filtered.filter((e) => new Date(e.createdAt) >= filter.since!);
    const limit = filter.limit ?? 50;
    return filtered.slice(-limit);
  }

  /**
   * @description Get routing strategy distribution.
   */
  getStrategyDistribution(): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const e of this.entries) {
      dist[e.strategy] = (dist[e.strategy] || 0) + 1;
    }
    return dist;
  }

}
