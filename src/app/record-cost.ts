/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the Argo `onExit` cost-ledger hook (ADR-078 §1). Writes ONE workflow-level chat_tasks row summarising the run. Deliberately does NOT re-count per-call cost: the execution handler already wrote a chat_tasks row per LLM call, so this row is a zero-cost run marker linked to the ticket. Double-counting the run's spend here would silently inflate every cost report.
 */

/**
 * Record Cost — the Argo onExit handler, one workflow-level ledger row.
 *
 *   record-cost.sh --ticket-id=T --workflow-status=Succeeded
 *
 * IMPORTANT — why this row carries zero cost:
 *   Each `bot-node-phase` pod already records its own `chat_tasks` row through the shared
 *   execution handler (`recordCost` → CostTrackingService). Summing those costs again here
 *   would double-count every Argo run in every cost report. This row exists so a Workflow
 *   run is *visible* in the ledger and linked to its ticket — a run marker, not a second bill.
 *
 * Exit codes: 0 = row written (or DB absent, which is non-fatal for an exit handler).
 * An exit handler that fails the Workflow after the real work succeeded would be worse
 * than a missing marker row, so this only returns 1 on an unexpected crash.
 *
 * @module record-cost
 */

import { createChildLogger } from '@/shared/logger';
import { CostTrackingService } from '@/features/operational-intelligence';
import { TicketService, PostgresTicketStore } from '@/features/ticketing';
import { connectPool } from './bot-node-runtime';

const logger = createChildLogger({ module: 'record-cost' });

/** The exit-handler arguments the WorkflowTemplate passes. */
export interface RecordCostArgs {
  ticketId: string;
  workflowStatus: string;
  agentId: string;
}

/**
 * @description Parses `--ticket-id` / `--workflow-status`, falling back to the DAG's env vars.
 * @param argv - Raw process arguments (excluding node + script path).
 * @returns The resolved arguments.
 * @throws Error when the ticket id is missing — an unattributable ledger row is worthless.
 */
export function parseRecordCostArgs(argv: string[]): RecordCostArgs {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }
  const ticketId = flags.get('ticket-id') || process.env.TICKET_ID || '';
  const workflowStatus = flags.get('workflow-status') || process.env.WORKFLOW_STATUS || 'Unknown';
  const agentId = flags.get('agent-id') || process.env.AGENT_ID || 'argo-workflow';
  if (!ticketId) throw new Error('record-cost: missing required argument: --ticket-id');
  return { ticketId, workflowStatus, agentId };
}

/**
 * @description Builds the zero-cost run-marker cost event for a finished Workflow.
 * @param args - The finished run's identifiers and terminal status.
 * @returns A CostEvent carrying no spend — the phase pods already billed their own calls.
 */
export function buildRunMarkerEvent(args: RecordCostArgs): Parameters<CostTrackingService['recordCost']>[0] {
  return {
    taskId: `argo-${args.ticketId}`,
    agentId: args.agentId,
    providerId: 'argo-workflow',
    modelId: 'n/a',
    inputTokens: 0,
    outputTokens: 0,
    inputCost: 0,
    outputCost: 0,
    // Zero on purpose: per-call cost was already recorded by each phase pod's execution handler.
    totalCost: 0,
    currency: 'USD',
    ticketExternalId: args.ticketId,
    requestCount: 0,
    estimated: false,
  };
}

/**
 * @description Maps Argo's terminal workflow phase to the marker's chat_tasks status. Anything
 * other than Succeeded is 'failed' — a marker that stays 'processing' forever counts as an
 * in-progress task in every active-task surface, drifting the counts upward with each run
 * (double-check finding 2026-07-08).
 * @param workflowStatus - Argo's {{workflow.status}} (Succeeded / Failed / Error / Unknown).
 * @returns The terminal status to stamp on the marker row.
 */
export function markerStatusFor(workflowStatus: string): 'completed' | 'failed' {
  return workflowStatus.trim().toLowerCase() === 'succeeded' ? 'completed' : 'failed';
}

/**
 * @description Writes the run marker and exits.
 * @returns Process exit code — 0 on success or when no DB is configured; 1 only on a crash.
 */
async function record(): Promise<number> {
  const args = parseRecordCostArgs(process.argv.slice(2));
  logger.info({ ...args }, 'record-cost writing workflow run marker');

  const pool = await connectPool();
  if (!pool) {
    // An exit handler must not fail a Workflow whose real work already succeeded.
    logger.warn({ ticketId: args.ticketId }, 'record-cost: no DATABASE_URL / DB unreachable — skipping run marker');
    return 0;
  }

  try {
    const event = buildRunMarkerEvent(args);
    await new CostTrackingService(pool).recordCost(event);

    // persistCostEvent hard-codes status 'processing' and nothing ever closes an unlinked
    // task — the marker would count as an in-progress task forever. Stamp the terminal
    // status + the workflow outcome, then link the run to its ticket so it shows up in
    // per-ticket cost rollups (queryCostByTicket joins ticket_task_links).
    const status = markerStatusFor(args.workflowStatus);
    try {
      await pool.query(
        `UPDATE chat_tasks
            SET status = $2,
                metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                updated_at = NOW()
          WHERE task_id = $1`,
        [event.taskId, status, JSON.stringify({ workflowStatus: args.workflowStatus, source: 'argo-onexit' })],
      );
    } catch (err) {
      logger.warn({ err, taskId: event.taskId }, 'record-cost: marker status stamp failed — non-fatal');
    }
    try {
      const ticketService = new TicketService(new PostgresTicketStore(pool));
      if (await ticketService.getTicket(args.ticketId)) {
        await ticketService.linkTask(args.ticketId, event.taskId, 'swarm-execution');
      }
    } catch (err) {
      logger.warn({ err, ticketId: args.ticketId }, 'record-cost: ticket link failed — non-fatal');
    }

    logger.info({ ticketId: args.ticketId, workflowStatus: args.workflowStatus, status }, 'record-cost done');
    return 0;
  } finally {
    try { await pool.end(); } catch { /* pool already closed — nothing to release */ }
  }
}

// Entrypoint guard: importable by tests without touching a database.
if (require.main === module) {
  record()
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error({ err }, 'record-cost crashed');
      // eslint-disable-next-line no-console -- CLI entrypoint: synchronous stderr crash line before process.exit (pino may not flush)
      console.error('record-cost failed:', err);
      process.exit(1);
    });
}
