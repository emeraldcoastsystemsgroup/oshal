/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added FeedbackLoopService — human verdict capture feeding into agent quality tuning (WS-7 #6)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wrapped the constructor-kicked ensureSchema DDL in runWithSystemIdentity — the detached boot CREATE TABLE/INDEX ran with no request in scope; must stamp operator under OSHAL_DB_GUC_STRICT=deny (guc warn-audit site).
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runWithSystemIdentity } from '@/shared/services/database/request-identity';
import type { AgentMetricsService } from './agent-metrics-service';

const logger = createChildLogger({ module: 'feedback-loop-service' });

/**
 * @description Human verdict on a completed work item.
 */
export type HumanVerdict = 'accept' | 'reject' | 'revise';

/**
 * @description A feedback record submitted by a human reviewer.
 */
export interface FeedbackRecord {
  feedbackId: string;
  ticketExternalId: string;
  agentId: string;
  swarmRunId?: string;
  verdict: HumanVerdict;
  comment?: string;
  reviewerName?: string;
  createdAt: string;
}

/**
 * @description Aggregated feedback stats for one agent.
 */
export interface AgentFeedbackStats {
  agentId: string;
  totalFeedback: number;
  acceptCount: number;
  rejectCount: number;
  reviseCount: number;
  acceptRate: number;
  recentFeedback: FeedbackRecord[];
}

/**
 * @description FeedbackLoopService — captures human verdicts on completed work and
 * feeds them back into agent metrics and competency ranking.
 *
 * Flow:
 * 1. Operator reviews completed ticket output
 * 2. Submits verdict: accept / reject / revise
 * 3. Service records feedback and updates agent metrics
 * 4. CompetencyRanker picks up updated metrics for routing
 *
 * This closes the human-in-the-loop feedback cycle.
 */
export class FeedbackLoopService {
  private readonly pool: Pool | null;
  private readonly metricsService: AgentMetricsService | null;
  private readonly records: FeedbackRecord[] = [];

  constructor(pool: Pool | null = null, metricsService: AgentMetricsService | null = null) {
    this.pool = pool;
    this.metricsService = metricsService;
    this.ensureSchema().catch((err) => {
      logger.debug({ err }, 'Feedback schema setup deferred');
    });
  }

  /**
   * @description Submit a human verdict on a completed work item.
   * @param feedback - Feedback record with verdict and context
   */
  async submitFeedback(feedback: FeedbackRecord): Promise<void> {
    this.records.push(feedback);
    logger.info(
      { ticketId: feedback.ticketExternalId, agentId: feedback.agentId, verdict: feedback.verdict },
      'Human feedback submitted',
    );

    await this.persistFeedback(feedback);
    this.updateAgentMetrics(feedback);
  }

  /**
   * @description Get feedback stats for a specific agent.
   * @param agentId - Agent identifier
   * @returns Aggregated feedback stats
   */
  getAgentStats(agentId: string): AgentFeedbackStats {
    const agentRecords = this.records.filter((r) => r.agentId === agentId);
    return buildStats(agentId, agentRecords);
  }

  /**
   * @description Get feedback stats for all agents.
   * @returns Array of agent feedback stats sorted by accept rate
   */
  getAllStats(): AgentFeedbackStats[] {
    const byAgent = new Map<string, FeedbackRecord[]>();
    for (const r of this.records) {
      if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []);
      byAgent.get(r.agentId)!.push(r);
    }
    return [...byAgent.entries()]
      .map(([agentId, recs]) => buildStats(agentId, recs))
      .sort((a, b) => b.acceptRate - a.acceptRate);
  }

  /**
   * @description Get recent feedback records.
   * @param limit - Max records to return
   * @returns Recent feedback records
   */
  getRecentFeedback(limit = 20): FeedbackRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * @description Query feedback from database for an agent.
   * @param agentId - Agent identifier
   * @param limit - Max records
   * @returns Feedback records from DB
   */
  async queryFromDB(agentId?: string, limit = 50): Promise<FeedbackRecord[]> {
    if (!this.pool) return this.getRecentFeedback(limit);
    try {
      const result = await this.pool.query(
        `SELECT * FROM human_feedback
         WHERE ($1::text IS NULL OR agent_id = $1)
         ORDER BY created_at DESC LIMIT $2`,
        [agentId ?? null, limit],
      );
      return result.rows.map(mapDbRow);
    } catch (err) {
      logger.warn({ err }, 'Failed to query feedback from DB');
      return this.getRecentFeedback(limit);
    }
  }

  /**
   * @description Persist feedback record to database.
   */
  private async persistFeedback(feedback: FeedbackRecord): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO human_feedback (
          feedback_id, ticket_external_id, agent_id, swarm_run_id,
          verdict, comment, reviewer_name, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          feedback.feedbackId, feedback.ticketExternalId,
          feedback.agentId, feedback.swarmRunId ?? null,
          feedback.verdict, feedback.comment ?? null,
          feedback.reviewerName ?? null, feedback.createdAt,
        ],
      );
    } catch (err) {
      logger.warn({ err, feedbackId: feedback.feedbackId }, 'Failed to persist feedback');
    }
  }

  /**
   * @description Feed verdict back into agent metrics as an execution event.
   */
  private updateAgentMetrics(feedback: FeedbackRecord): void {
    if (!this.metricsService) return;
    const outcome = feedback.verdict === 'accept' ? 'completed'
      : feedback.verdict === 'reject' ? 'failed'
      : 'completed'; // 'revise' counts as completed but with retries
    this.metricsService.recordExecution({
      agentId: feedback.agentId,
      ticketExternalId: feedback.ticketExternalId,
      swarmRunId: feedback.swarmRunId ?? 'feedback',
      durationMs: 0,
      outcome,
      retryCount: feedback.verdict === 'revise' ? 1 : 0,
      verificationAttempts: 1,
    });
    logger.info(
      { agentId: feedback.agentId, verdict: feedback.verdict, metricsOutcome: outcome },
      'Agent metrics updated from human feedback',
    );
  }

  /**
   * @description Ensure feedback table exists.
   */
  private async ensureSchema(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    // Detached boot DDL (the constructor kicks this off) with no request in scope — run it as
    // trusted SYSTEM so the CREATE TABLE/INDEX stamp operator under OSHAL_DB_GUC_STRICT=deny.
    await runWithSystemIdentity(async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS human_feedback (
            feedback_id TEXT PRIMARY KEY,
            ticket_external_id TEXT NOT NULL,
            agent_id TEXT NOT NULL,
            swarm_run_id TEXT,
            verdict TEXT NOT NULL CHECK (verdict IN ('accept', 'reject', 'revise')),
            comment TEXT,
            reviewer_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`);
        await pool.query(
          `CREATE INDEX IF NOT EXISTS idx_human_feedback_agent
           ON human_feedback (agent_id, created_at DESC)`,
        );
      } catch (err) {
        logger.debug({ err }, 'Feedback table creation deferred');
      }
    });
  }
}

/**
 * @description Build aggregated stats from feedback records.
 */
function buildStats(agentId: string, records: FeedbackRecord[]): AgentFeedbackStats {
  const acceptCount = records.filter((r) => r.verdict === 'accept').length;
  const rejectCount = records.filter((r) => r.verdict === 'reject').length;
  const reviseCount = records.filter((r) => r.verdict === 'revise').length;
  return {
    agentId,
    totalFeedback: records.length,
    acceptCount,
    rejectCount,
    reviseCount,
    acceptRate: records.length > 0 ? acceptCount / records.length : 0,
    recentFeedback: records.slice(-5),
  };
}

/**
 * @description Map a database row to a FeedbackRecord.
 */
function mapDbRow(row: Record<string, unknown>): FeedbackRecord {
  return {
    feedbackId: String(row.feedback_id),
    ticketExternalId: String(row.ticket_external_id),
    agentId: String(row.agent_id),
    swarmRunId: row.swarm_run_id ? String(row.swarm_run_id) : undefined,
    verdict: String(row.verdict) as HumanVerdict,
    comment: row.comment ? String(row.comment) : undefined,
    reviewerName: row.reviewer_name ? String(row.reviewer_name) : undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
