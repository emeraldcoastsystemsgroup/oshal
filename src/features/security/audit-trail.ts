/**
 * Access / audit-trail detector — Security Center (ADR-055).
 *
 * Reads the platform's routing audit log (routing_audit_log — who/which agent won each task and
 * why) and surfaces dispatch anomalies that can signal a misroute or an unauthorized handler: a
 * task that routed with NO candidate agents, or with a winner that scored ~0 (it ran by default,
 * not by fit). This is the access-trail we currently persist; richer per-resource access-control
 * logging (e.g. cross-tenant reads) needs the owning apps to emit audit rows — noted honestly so
 * coverage is not overstated.
 *
 * @module features/security/audit-trail
 */

import { createChildLogger } from '@/shared/logger';
import type { Pool } from 'pg';
import type { RawFinding, ScannerReport } from './types';
import { tableExists } from './db-utils';

const logger = createChildLogger({ module: 'security:audit-trail' });

export async function auditAccess(pool: Pool): Promise<ScannerReport> {
  if (!(await tableExists(pool, 'routing_audit_log'))) {
    return {
      kind: 'audit',
      available: false,
      findings: [],
      note: 'routing_audit_log not present — no dispatch trail to audit yet. Per-resource access-control auditing requires owning apps to emit audit rows.',
    };
  }
  const findings: RawFinding[] = [];
  try {
    // Tasks dispatched with no candidate agents (routed by fallback, not by fit).
    const noCand = (await pool.query(
      `SELECT task_id, winner_agent_id, strategy, winner_score, created_at
         FROM routing_audit_log
        WHERE candidate_count = 0 AND created_at > now() - interval '7 days'
        ORDER BY created_at DESC LIMIT 15`)).rows;
    for (const r of noCand) {
      findings.push({
        category: 'audit',
        severity: 'medium',
        title: `Task routed with no candidate agents -> ${r.winner_agent_id}`,
        detail: `Task ${r.task_id} was dispatched to ${r.winner_agent_id} (strategy '${r.strategy}') with zero candidate agents evaluated. A task handled by a fallback agent rather than a fit-scored one can mean a missing capability mapping or an unexpected handler — verify the right bot handled it.`,
        source: `routing_audit_log:${r.task_id}`,
        evidence: { taskId: r.task_id, winner: r.winner_agent_id, strategy: r.strategy, winnerScore: r.winner_score, at: r.created_at },
        fingerprint: `audit:no-candidates:${r.task_id}`,
      });
    }

    // Winner scored ~0 despite having candidates (low-fit dispatch).
    const lowFit = (await pool.query(
      `SELECT task_id, winner_agent_id, strategy, winner_score, candidate_count, created_at
         FROM routing_audit_log
        WHERE candidate_count > 0 AND winner_score <= 0 AND created_at > now() - interval '7 days'
        ORDER BY created_at DESC LIMIT 15`)).rows;
    for (const r of lowFit) {
      findings.push({
        category: 'audit',
        severity: 'low',
        title: `Low-fit dispatch -> ${r.winner_agent_id} (score ${r.winner_score})`,
        detail: `Task ${r.task_id} routed to ${r.winner_agent_id} with a winning score of ${r.winner_score} across ${r.candidate_count} candidate(s). A near-zero winning score means no agent was a good fit; confirm the chosen handler was appropriate for the request.`,
        source: `routing_audit_log:${r.task_id}`,
        evidence: { taskId: r.task_id, winner: r.winner_agent_id, score: r.winner_score, candidates: r.candidate_count, at: r.created_at },
        fingerprint: `audit:low-fit:${r.task_id}`,
      });
    }
  } catch (err) {
    logger.error({ err }, 'access audit failed');
    return { kind: 'audit', available: false, findings, note: `access audit error: ${(err as Error).message}` };
  }

  return {
    kind: 'audit',
    available: true,
    findings,
    note: `dispatch-trail audit over routing_audit_log (${findings.length} hit(s)). Note: per-resource access-control auditing needs owning-app instrumentation.`,
  };
}
