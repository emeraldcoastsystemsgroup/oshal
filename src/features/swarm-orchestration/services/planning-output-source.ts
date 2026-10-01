/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The plan an in-process planning round returned is read from memory and recorded, never read back from disk. The shared workspace is writable by every bot and work_items rows by the bot role, so a planted IMPLEMENTATION-PLAN.md or deliverable could otherwise choose child tickets and their target bots once children run as the operator. A failed round becomes a PlanningDecompositionError, which the queue manager escalates as planning_decomposition_failed.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from '@/shared/logger';
import { PlanningDecompositionError } from './ticket-decomposition-service';

const logger = createChildLogger({ module: 'planning-output-source' });

/** The file the root's plan is recorded in, in the root ticket's workspace folder. */
export const IMPLEMENTATION_PLAN_FILE = 'IMPLEMENTATION-PLAN.md';

const TICKET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @description The plan text an in-process planning round returned: the reply content itself, not
 * the JSON wrapper around it (the assignment parser reads roles from the text).
 * @param ticketId - The root ticket, for the error.
 * @param output - The round output: `{ content }`, a string, or `{ status: 'failed', error }`.
 * @returns The plan text.
 * @throws PlanningDecompositionError when the round failed or returned no text.
 */
export function readInProcessPlanText(ticketId: string, output: unknown): string {
  const record = output !== null && typeof output === 'object' ? output as Record<string, unknown> : null;
  if (record?.status === 'failed') {
    throw new PlanningDecompositionError(
      ticketId,
      `project-manager planning round failed: ${String(record.error ?? 'unknown error')}`,
    );
  }
  const content = typeof output === 'string' ? output : record?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new PlanningDecompositionError(ticketId, 'project-manager planning round returned no plan text');
  }
  return content;
}

/**
 * @description Records the plan as IMPLEMENTATION-PLAN.md in the root ticket's workspace folder,
 * only when no such file exists (flag 'wx'). An existing file is left untouched and is never read.
 * @param workspaceRoot - The shared workspace root.
 * @param workspaceTaskId - The root ticket's workspace folder id; must be a ticket UUID.
 * @param text - The plan text.
 * @returns The path written, or undefined when nothing was written.
 */
export function recordImplementationPlan(workspaceRoot: string, workspaceTaskId: string, text: string): string | undefined {
  if (!TICKET_UUID.test(workspaceTaskId)) {
    logger.warn({ workspaceTaskId }, 'Not recording IMPLEMENTATION-PLAN.md: the workspace folder id is not a ticket UUID');
    return undefined;
  }
  const directory = join(workspaceRoot, workspaceTaskId);
  const planPath = join(directory, IMPLEMENTATION_PLAN_FILE);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(planPath, text, { encoding: 'utf8', flag: 'wx' });
    logger.info({ workspaceTaskId, chars: text.length }, 'Recorded the in-process plan as IMPLEMENTATION-PLAN.md');
    return planPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      logger.warn({ workspaceTaskId }, 'IMPLEMENTATION-PLAN.md already exists in the root folder; left untouched and not read');
      return undefined;
    }
    logger.error({ err, workspaceTaskId }, 'Failed to record IMPLEMENTATION-PLAN.md; decomposition continues from memory');
    return undefined;
  }
}
