/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — the finalize hook the Argo DAG calls after the approval gate (ADR-078 §1). Maps the classified MODE to a ticket disposition using the SAME exported INCIDENT_MODE_DISPOSITION table the in-process incident-rca pipeline uses (rca-mode.ts), so the batch path and the in-process path can never disagree. Unknown/absent mode falls back to 'complete', mirroring dispatchIncidentTicket.
 */

/**
 * Finalize Incident — map the DAG's MODE output to a ticket disposition, then exit.
 *
 *   finalize-incident.sh --ticket-id=T --mode=B
 *
 * Mirrors `INCIDENT_MODE_DISPOSITION` (ADR-069 §2b): A/B rest in `customer_action`
 * (the operator applies the fix or supplies more data); C escalates. A phase that
 * produced no classification completes the ticket rather than stranding it.
 *
 * Exit codes: 0 = ticket updated. 1 = failed (Argo fails the DAG task).
 *
 * @module finalize-incident
 */

import { createChildLogger } from '@/shared/logger';
import { TicketService, PostgresTicketStore } from '@/features/ticketing';
import { INCIDENT_MODE_DISPOSITION } from '@/features/swarm-orchestration';
import type { OshalTicketState } from '@/entities/ticket';
import { connectPool } from './bot-node-runtime';

const logger = createChildLogger({ module: 'finalize-incident' });

/** The finalize arguments the WorkflowTemplate passes. */
export interface FinalizeArgs {
  ticketId: string;
  mode: string;
}

/**
 * @description Parses `--ticket-id` / `--mode`, falling back to the env vars the DAG also sets.
 * @param argv - Raw process arguments (excluding node + script path).
 * @returns The resolved arguments.
 * @throws Error when the ticket id is missing — finalizing "nothing" must fail loudly.
 */
export function parseFinalizeArgs(argv: string[]): FinalizeArgs {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) flags.set(match[1], match[2]);
  }
  const ticketId = flags.get('ticket-id') || process.env.TICKET_ID || '';
  // NO `process.env.MODE` fallback: MODE is a widely-used generic env var (vitest sets MODE=test,
  // bundlers set MODE=production), so reading it here would silently hijack the ticket disposition.
  // The DAG always passes --mode; an absent flag legitimately means "no classification".
  const mode = (flags.get('mode') || 'unknown').trim();
  if (!ticketId) throw new Error('finalize-incident: missing required argument: --ticket-id');
  return { ticketId, mode };
}

/**
 * @description Resolves the ticket status + disposition for a classified mode.
 * An unrecognised or absent mode ('unknown', empty, 'D', …) completes the ticket rather than
 * stranding it in a non-terminal state — the same fallback dispatchIncidentTicket applies.
 * @param mode - The mode letter from the DAG's output parameter.
 * @returns The status to set and the disposition tag to record.
 */
export function dispositionFor(mode: string): { status: OshalTicketState; disposition: string } {
  const key = mode.trim().toUpperCase();
  if (key === 'A' || key === 'B' || key === 'C') return INCIDENT_MODE_DISPOSITION[key];
  return { status: 'complete' as OshalTicketState, disposition: 'completed_no_mode' };
}

/**
 * @description Applies the disposition to the ticket and exits.
 * @returns Process exit code — 0 on success, 1 when the DB is unreachable or the update fails.
 */
async function finalize(): Promise<number> {
  const args = parseFinalizeArgs(process.argv.slice(2));
  const { status, disposition } = dispositionFor(args.mode);
  logger.info({ ...args, status, disposition }, 'finalize-incident applying disposition');

  const pool = await connectPool();
  if (!pool) {
    logger.error({ ticketId: args.ticketId }, 'finalize-incident: no DATABASE_URL / DB unreachable');
    return 1;
  }

  try {
    const ticketService = new TicketService(new PostgresTicketStore(pool));
    await ticketService.updateStatus(args.ticketId, status, {
      mode: args.mode, disposition, source: 'incident-rca-argo',
    });
    logger.info({ ticketId: args.ticketId, status, disposition }, 'finalize-incident done');
    return 0;
  } catch (err) {
    logger.error({ err, ticketId: args.ticketId }, 'finalize-incident failed to update the ticket');
    return 1;
  } finally {
    try { await pool.end(); } catch { /* pool already closed — nothing to release */ }
  }
}

// Entrypoint guard: importable by tests without touching a database.
if (require.main === module) {
  finalize()
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error({ err }, 'finalize-incident crashed');
      // eslint-disable-next-line no-console -- CLI entrypoint: synchronous stderr crash line before process.exit (pino may not flush)
      console.error('finalize-incident failed:', err);
      process.exit(1);
    });
}
