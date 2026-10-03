/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The plan an in-process planning round returned is read from memory and recorded, never read back from disk. The shared workspace is writable by every bot and work_items rows by the bot role, so a planted IMPLEMENTATION-PLAN.md or deliverable could otherwise choose child tickets and their target bots once children run as the operator. A failed round becomes a PlanningDecompositionError, which the queue manager escalates as planning_decomposition_failed.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | A reply without the decomposition section no longer ends as one child when the planning node wrote IMPLEMENTATION-PLAN.md during the round (live run 5: a 919-character reply beside a full plan file). readFreshPlanFile reads that one file, in the root ticket's own folder by UUID, only when its mtime is after the round started, only when it carries the marker, bounded in size; anything older stays unread, as before.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createChildLogger } from '@/shared/logger';
import { PlanningDecompositionError } from './ticket-decomposition-service';

const logger = createChildLogger({ module: 'planning-output-source' });

/** The file the root's plan is recorded in, in the root ticket's workspace folder. */
export const IMPLEMENTATION_PLAN_FILE = 'IMPLEMENTATION-PLAN.md';

const TICKET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The marker the decomposition parser looks for, exactly as it looks for it. */
export const SUBTASK_DECOMPOSITION_MARKER = '## SUBTASK DECOMPOSITION';

/** The largest plan file the fallback reads; a plan is a few kilobytes. */
const MAX_PLAN_FILE_BYTES = 512 * 1024;

/**
 * @description Whether a plan text carries the decomposition section the parser reads.
 * @param text - The plan text.
 * @returns True when the marker is present.
 */
export function hasSubtaskDecomposition(text: string): boolean {
  return text.includes(SUBTASK_DECOMPOSITION_MARKER);
}

/**
 * @description The plan the planning node wrote to IMPLEMENTATION-PLAN.md during the round, for a
 * reply that carries no decomposition section: a command-line engine tends to write the file and
 * reply briefly. Only the root ticket's own folder, named by its ticket UUID; only a file modified
 * after the round started, so a file planted before it is ignored as before; bounded in size; used
 * only when it carries the decomposition section.
 * @param workspaceRoot - The shared workspace root.
 * @param workspaceTaskId - The root ticket's workspace folder id; must be a ticket UUID.
 * @param roundStartedAtMs - When the planning round was dispatched (epoch ms).
 * @returns The file's text, or undefined when no plan was written during the round.
 */
export function readFreshPlanFile(workspaceRoot: string, workspaceTaskId: string, roundStartedAtMs: number): string | undefined {
  if (!TICKET_UUID.test(workspaceTaskId)) return undefined;
  const planPath = join(workspaceRoot, workspaceTaskId, IMPLEMENTATION_PLAN_FILE);
  try {
    const stat = statSync(planPath);
    if (!stat.isFile() || stat.mtimeMs <= roundStartedAtMs) {
      logger.info({ workspaceTaskId, mtimeMs: stat.mtimeMs, roundStartedAtMs }, 'IMPLEMENTATION-PLAN.md predates the planning round; not read');
      return undefined;
    }
    if (stat.size > MAX_PLAN_FILE_BYTES) {
      logger.warn({ workspaceTaskId, size: stat.size }, 'IMPLEMENTATION-PLAN.md is larger than a plan; not read');
      return undefined;
    }
    const text = readFileSync(planPath, 'utf8');
    if (!hasSubtaskDecomposition(text)) {
      logger.info({ workspaceTaskId }, 'IMPLEMENTATION-PLAN.md written during the round carries no decomposition section; not used');
      return undefined;
    }
    logger.info({ workspaceTaskId, chars: text.length }, 'Decomposing the plan file the planning node wrote during the round');
    return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.error({ err, workspaceTaskId }, 'Failed to read IMPLEMENTATION-PLAN.md written during the round');
    return undefined;
  }
}

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
