/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | CKR-13 / D6: a graph ticket parked at a gate said nothing about WHERE it was parked. A graph ticket is dispatched from `approved` and no code writes an in_process_* status, so the only signals were a resume node id buried in metadata and a workflow_run_steps row nobody joined. An operator looking at the ticket saw "Approval Required" and a status history, with no way to tell which node of which workflow was waiting, or what had just finished. This reads both and hands the ticket route one object. The read is owner-scoped by the GUC pool exactly as every other ticket read is - workflow_run_steps carries owner_sub under RLS - so a caller cannot learn the position of a run they cannot see.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'ticket-workflow-position' });

/** Where a graph ticket is parked, as far as the ticket itself can say. */
export interface TicketWorkflowPosition {
  /** The run this position belongs to (`metadata.workflowRunId`). */
  runId: string;
  /** The node the engine will continue from when the ticket is approved. */
  resumeNodeId: string | null;
  /** True when resumeNodeId came from the pre-2026-07-05 `graphResumeNode` key. */
  resumeNodeIdIsLegacy: boolean;
  /** The most recent recorded step: what the run last did before parking. */
  lastStep: {
    seq: number;
    nodeId: string;
    nodeType: string;
    nodeTitle: string;
    status: string;
    finishedAt: string | null;
  } | null;
}

interface TicketMetadataShape {
  workflowRunId?: unknown;
  workflowCheckpoint?: { resumeNodeId?: unknown } | null;
  graphResumeNode?: unknown;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * @description Reads the resume point out of a ticket's metadata, preferring the checkpoint.
 * @param metadata - The ticket's metadata object.
 * @returns The resume node id and whether it came from the legacy key.
 *
 * `metadata.workflowCheckpoint.resumeNodeId` is what the dispatcher writes. `graphResumeNode` is
 * the pre-2026-07-05 spelling, still READ so tickets parked before the checkpoint existed can
 * resume — and as of 2026-09-19 that is not hypothetical: five tickets on the operator box carry
 * it, three of them still parked at `approval_required`. Retiring the fallback would strand them.
 */
export function readResumePoint(
  metadata: Record<string, unknown> | null | undefined,
): { resumeNodeId: string | null; isLegacy: boolean } {
  const meta = (metadata ?? {}) as TicketMetadataShape;
  const fromCheckpoint = readString(meta.workflowCheckpoint?.resumeNodeId);
  if (fromCheckpoint) return { resumeNodeId: fromCheckpoint, isLegacy: false };
  const legacy = readString(meta.graphResumeNode);
  return { resumeNodeId: legacy, isLegacy: Boolean(legacy) };
}

/**
 * @description Resolves where a graph ticket is parked, for the ticket detail route.
 * @param pool - The GUC-stamped pool, so the step read is owner-scoped like every other read.
 * @param metadata - The ticket's metadata.
 * @returns The position, or null when this ticket is not a graph run.
 *
 * Never throws: position is a read-only enrichment on a route that must keep answering. A failed
 * lookup logs and returns null rather than turning a ticket fetch into a 500.
 */
export async function readTicketWorkflowPosition(
  pool: Pool | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): Promise<TicketWorkflowPosition | null> {
  const meta = (metadata ?? {}) as TicketMetadataShape;
  const runId = readString(meta.workflowRunId);
  if (!runId) return null;

  const { resumeNodeId, isLegacy } = readResumePoint(metadata);
  const position: TicketWorkflowPosition = {
    runId,
    resumeNodeId,
    resumeNodeIdIsLegacy: isLegacy,
    lastStep: null,
  };
  if (!pool) return position;

  try {
    const result = await pool.query(
      `SELECT seq, node_id, node_type, node_title, status, finished_at
         FROM workflow_run_steps
        WHERE run_id = $1
        ORDER BY seq DESC
        LIMIT 1`,
      [runId],
    );
    const row = result.rows[0];
    if (row) {
      position.lastStep = {
        seq: Number(row.seq ?? 0),
        nodeId: String(row.node_id ?? ''),
        nodeType: String(row.node_type ?? ''),
        nodeTitle: String(row.node_title ?? ''),
        status: String(row.status ?? ''),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      };
    }
  } catch (error) {
    // The run-history tables are optional on an older schema, and a ticket fetch must not fail
    // because its position could not be read.
    logger.warn({ err: error, runId }, 'Could not read workflow position for ticket');
  }
  return position;
}
