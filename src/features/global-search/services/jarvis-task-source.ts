/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Owner-scoped recall over the caller's Jarvis work items (jarvis_tasks). Until now nothing read that table except the OPEN WORK block, which carries only the latest eight rows, so a work item older than that was invisible to Jarvis however the user asked. Same two-step shape as the conversation read: list returns selection metadata only (never `result` or `error`), fetch returns one named task's result. Rows are scoped by the migration-060/100 owner policy on the identity-stamped connection; the adapter's own user_sub predicate is defense in depth, and the real-database guard proves the policy alone refuses. A work item whose own id, ticket or conversation carries protected execution lineage is left out of the list and withheld by fetch, exactly as the OPEN WORK block drops it.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';
import { escapeIlike } from './search-ranking';
import {
  RECALL_WITHHELD_PROTECTED,
  recallReferencesReadable,
  type RecallFetchResult,
} from './recall-protected-results';

const logger = createChildLogger({ module: 'global-search-jarvis-tasks' });

/**
 * Metadata-only work-item list. `result` is named only inside the match predicate; it is never
 * selected. `$4` is the reserved protected-lineage metadata key: an item whose own id, ticket or
 * conversation carries it is left out, as the OPEN WORK block leaves it out.
 */
export const JARVIS_TASK_LIST_SQL = `SELECT j.id, j.title, j.status, j.kind, j.session_id, j.created_at, j.finished_at
   FROM jarvis_tasks j
  WHERE j.user_sub = $1
    AND (j.title ILIKE $2 ESCAPE '\\' OR j.result ILIKE $2 ESCAPE '\\')
    AND NOT EXISTS (
      SELECT 1 FROM chat_tasks c
       WHERE c.task_id IN (j.id, j.ticket_id, j.session_id)
         AND c.metadata ? $4
    )
  ORDER BY j.created_at DESC
  LIMIT $3`;

/** The exact-id work-item read of a fetch, including the result and the failure note. */
export const JARVIS_TASK_FETCH_SQL = `SELECT id, title, status, kind, session_id, ticket_id, result, error,
        created_at, finished_at
   FROM jarvis_tasks
  WHERE id = $1 AND user_sub = $2
  LIMIT 1`;

/** Selection metadata for one of the caller's Jarvis work items. */
export interface JarvisTaskSummary {
  /** Which record family this is; the query tool returns conversations beside work items. */
  source: 'jarvis-task';
  taskId: string;
  title: string;
  status: string;
  kind: string | null;
  /** The conversation the item was filed from; conversation_fetch reads it. */
  sessionId: string | null;
  createdAt: string | null;
  finishedAt: string | null;
}

/** One caller-owned work item with its recorded outcome. */
export interface JarvisTaskDetail extends JarvisTaskSummary {
  result: string | null;
  error: string | null;
}

interface JarvisTaskRow {
  id: string;
  title: string;
  status: string;
  kind: string | null;
  session_id: string | null;
  ticket_id?: string | null;
  result?: string | null;
  error?: string | null;
  created_at: Date | string | null;
  finished_at: Date | string | null;
}

/**
 * @description Recall over the caller's own Jarvis work items. Read-only; every statement runs on
 * the identity-stamped pool so jarvis_tasks row-level security scopes it to the caller.
 */
export class JarvisTaskRecallSource {
  /**
   * @description Create the adapter over a GUC-wrapped Postgres pool.
   * @param pool - Pool whose queries inherit the caller's identity from request context.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description List the caller's work items whose title or recorded result matches, returning
   * selection metadata only.
   * @param userSub - The caller's verified subject.
   * @param query - Words to match in a title or result.
   * @param limit - Maximum summaries to return.
   * @returns Caller-owned work-item summaries, newest first; empty on a read failure (logged).
   */
  async list(userSub: string, query: string, limit: number): Promise<JarvisTaskSummary[]> {
    const pattern = `%${escapeIlike(query)}%`;
    try {
      const result = await this.pool.query(
        JARVIS_TASK_LIST_SQL,
        [userSub, pattern, limit, PROTECTED_RESULT_EXECUTIONS],
      );
      return (result.rows as JarvisTaskRow[]).map(toSummary);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'jarvis task list failed');
      return [];
    }
  }

  /**
   * @description Fetch one caller-owned work item with its result. A foreign or absent id returns
   * no record; a caller-owned item the protected-result boundary refuses is returned as withheld.
   * @param userSub - The caller's verified subject.
   * @param taskId - The exact work-item id selected from the list.
   * @returns The work item, or no record (with `withheld` when the boundary refused it).
   */
  async fetch(userSub: string, taskId: string): Promise<RecallFetchResult<JarvisTaskDetail>> {
    try {
      const { rows } = await this.pool.query(JARVIS_TASK_FETCH_SQL, [taskId, userSub]);
      const row = rows[0] as JarvisTaskRow | undefined;
      if (!row) return { record: null };
      if (!(await recallReferencesReadable(this.pool, userSub, [row.id, row.ticket_id, row.session_id]))) {
        logger.info({ taskId }, 'jarvis task fetch withheld by the protected-result boundary');
        return { record: null, withheld: RECALL_WITHHELD_PROTECTED };
      }
      return { record: { ...toSummary(row), result: row.result ?? null, error: row.error ?? null } };
    } catch (err) {
      logger.error({ err, taskId, stack: (err as Error).stack }, 'jarvis task fetch failed');
      return { record: null };
    }
  }
}

/**
 * @description Normalize a nullable database timestamp.
 * @param value - Timestamp as the driver returned it.
 * @returns ISO-8601 text, or null.
 */
function isoOrNull(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * @description Map one jarvis_tasks row to its selection metadata (never its result).
 * @param row - Row from the list or the exact-id read.
 * @returns The metadata-only summary.
 */
function toSummary(row: JarvisTaskRow): JarvisTaskSummary {
  return {
    source: 'jarvis-task',
    taskId: row.id,
    title: row.title,
    status: row.status,
    kind: row.kind,
    sessionId: row.session_id,
    createdAt: isoOrNull(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}
