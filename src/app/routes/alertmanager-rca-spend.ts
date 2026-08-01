/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Alert triage P3 (ADR-119 FR-E2): the app-layer RcaSpendReader over the per-event cost ledger. Spend is summed from oshal_cost_events joined through ticket_task_links -> tickets on ticket_type — the SAME attribution cost-governance's spendSqlFor('app') uses, and deliberately NOT a chat_tasks updated_at window: chat_tasks rows accumulate a task's LIFETIME total_cost and recordCost bumps updated_at on every event, so a windowed read there attributes a long-lived task's whole history to "this hour" (the exact defect budget-service seq 2 fixed). chat_tasks remains the canonical per-call ledger; the events table is its per-event projection and the only honest windowed read. Both reads return null on failure so the gate fails OPEN
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { RcaSpendReader } from '@/features/alert-triage';

const logger = createChildLogger({ module: 'alertmanager-rca-spend' });

/**
 * @description Builds the FR-E2 actuals reader over the Postgres cost ledger. Attribution:
 * an RCA run's cost rows link to their ticket via ticket_task_links, and the alert queue's
 * tickets share one ticket_type — so "RCA spend for this queue" is the app-scope join.
 * Fail-open by contract: every infra gap returns null (logged WARN) and the budget gate
 * lets the dispatch proceed — a DB hiccup must never park the swarm's own outage tickets.
 * @param pool - The api's Postgres pool.
 * @returns The reader the alert intake wires into its budget gate.
 */
export function createPoolRcaSpendReader(pool: Pool): RcaSpendReader {
  return {
    async hourlyRcaSpendUsd(ticketType: string): Promise<number | null> {
      try {
        const result = await pool.query(
          `SELECT COALESCE(SUM(e.cost_usd), 0) AS spend
             FROM tickets t
             JOIN ticket_task_links ttl ON ttl.ticket_id = t.ticket_id
             JOIN oshal_cost_events e ON e.task_id = ttl.task_id
            WHERE t.ticket_type = $1
              AND e.ts >= NOW() - interval '1 hour'`,
          [ticketType],
        );
        return Number.parseFloat(String(result.rows[0]?.spend ?? 0)) || 0;
      } catch (err) {
        logger.warn({ err, ticketType }, 'RCA hourly spend query failed — returning null (budget gate fails open)');
        return null;
      }
    },

    async recentRcaTicketCostsUsd(ticketType: string, limit: number): Promise<number[] | null> {
      const capped = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 20)));
      try {
        const result = await pool.query(
          `SELECT SUM(e.cost_usd) AS cost
             FROM tickets t
             JOIN ticket_task_links ttl ON ttl.ticket_id = t.ticket_id
             JOIN oshal_cost_events e ON e.task_id = ttl.task_id
            WHERE t.ticket_type = $1
            GROUP BY t.ticket_id
            ORDER BY MAX(e.ts) DESC
            LIMIT $2`,
          [ticketType, capped],
        );
        return result.rows.map((row) => Number.parseFloat(String(row.cost ?? 0)) || 0);
      } catch (err) {
        logger.warn({ err, ticketType }, 'Recent per-RCA cost query failed — returning null (fallback reserve estimate applies)');
        return null;
      }
    },
  };
}
