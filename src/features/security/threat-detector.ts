/**
 * Runtime threat detector — Security Center (ADR-055).
 *
 * Watches live bot/tool activity (chat_tasks — the per-bot cost/run ledger) for anomalies that
 * suggest abuse, a runaway loop, or an attack: a spike of failed tasks, a single unusually
 * expensive run (possible prompt-injection-driven runaway or scraping), and a burst of tasks
 * from one agent in a short window. These are HEURISTICS — the security-analyst bot triages
 * each into a real/false-positive verdict. Thresholds are env-overridable.
 *
 * @module features/security/threat-detector
 */

import { createChildLogger } from '@/shared/logger';
import type { Pool } from 'pg';
import type { RawFinding, ScannerReport, Severity } from './types';
import { tableExists } from './db-utils';

const logger = createChildLogger({ module: 'security:threat-detector' });

const num = (env: string, def: number) => Number(process.env[env] || def);

export async function detectThreats(pool: Pool): Promise<ScannerReport> {
  if (!(await tableExists(pool, 'chat_tasks'))) {
    return { kind: 'runtime', available: false, findings: [], note: 'chat_tasks not present (no bot activity yet)' };
  }
  const findings: RawFinding[] = [];
  const failThreshold = num('SECURITY_FAILED_TASK_THRESHOLD', 10);
  const costThreshold = num('SECURITY_TASK_COST_USD', 5);
  const burstThreshold = num('SECURITY_AGENT_BURST_THRESHOLD', 50);

  try {
    // 1) Failed-task spike in the last 24h.
    const fails = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM chat_tasks
        WHERE status = 'failed' AND updated_at > now() - interval '24 hours'`)).rows[0]?.n ?? 0;
    if (fails >= failThreshold) {
      findings.push({
        category: 'threat',
        severity: fails >= failThreshold * 3 ? 'high' : 'medium',
        title: `${fails} failed bot tasks in the last 24h`,
        detail: `${fails} chat_tasks ended in status='failed' over the last 24 hours (threshold ${failThreshold}). `
          + `A failure spike can mean a broken integration, a credential problem, or repeated abusive/malformed input. Inspect the recent failures.`,
        source: 'chat_tasks',
        evidence: { failedCount: fails, windowHours: 24, threshold: failThreshold },
        fingerprint: 'threat:failed-task-spike-24h',
      });
    }

    // 2) Unusually expensive single runs in the last 7 days (possible runaway / abuse).
    const pricey = (await pool.query(
      `SELECT task_id, agent_id, total_cost, total_output_tokens, updated_at
         FROM chat_tasks
        WHERE total_cost > $1 AND updated_at > now() - interval '7 days'
        ORDER BY total_cost DESC LIMIT 10`, [costThreshold])).rows;
    for (const t of pricey) {
      const sev: Severity = t.total_cost > costThreshold * 4 ? 'high' : 'medium';
      findings.push({
        category: 'threat',
        severity: sev,
        title: `Expensive bot run: $${Number(t.total_cost).toFixed(2)} (${t.agent_id || 'unknown agent'})`,
        detail: `Task ${t.task_id} cost $${Number(t.total_cost).toFixed(2)} (~${t.total_output_tokens} output tokens), above the $${costThreshold} watch threshold. `
          + `A single very expensive run can indicate a runaway loop or a prompt-injection-driven scrape. Confirm it was legitimate.`,
        source: `chat_tasks:${t.task_id}`,
        evidence: { taskId: t.task_id, agentId: t.agent_id, costUsd: Number(t.total_cost), outputTokens: Number(t.total_output_tokens), at: t.updated_at },
        fingerprint: `threat:expensive-task:${t.task_id}`,
      });
    }

    // 3) Per-agent burst: many tasks created in the last hour.
    const bursts = (await pool.query(
      `SELECT agent_id, COUNT(*)::int AS n
         FROM chat_tasks
        WHERE created_at > now() - interval '1 hour' AND agent_id IS NOT NULL
        GROUP BY agent_id HAVING COUNT(*) >= $1
        ORDER BY n DESC LIMIT 10`, [burstThreshold])).rows;
    for (const b of bursts) {
      findings.push({
        category: 'threat',
        severity: b.n >= burstThreshold * 2 ? 'high' : 'medium',
        title: `Activity burst: ${b.n} tasks/hour from ${b.agent_id}`,
        detail: `Agent ${b.agent_id} created ${b.n} tasks in the last hour (threshold ${burstThreshold}). `
          + `A sustained burst can be a loop, a flood of inbound requests, or automated abuse. Verify the source is expected.`,
        source: `chat_tasks:agent:${b.agent_id}`,
        evidence: { agentId: b.agent_id, tasksLastHour: b.n, threshold: burstThreshold },
        fingerprint: `threat:agent-burst:${b.agent_id}`,
      });
    }
  } catch (err) {
    logger.error({ err }, 'threat detection failed');
    return { kind: 'runtime', available: false, findings, note: `runtime detection error: ${(err as Error).message}` };
  }

  return { kind: 'runtime', available: true, findings, note: `runtime heuristics over chat_tasks (${findings.length} hit(s))` };
}
