/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The protected-result read boundary for the owner-scoped recall reads (conversation_fetch and the jarvis_tasks fetch). The two HTTP read paths for the same records already apply it - message history through callerCanReadTaskResult -> canReadProtectedResult, and the OPEN WORK block through filterJarvisResultRows/hasProtectedJarvisSource - while the recall fetch applied owner RLS only. The recall tools run on a bot-node that holds the caller's subject and nothing else: no verified actor to re-check current application rights with. So the SAME shared decision (canReadProtectedResult) is evaluated with an actor resolver that refuses, which makes every record that would need an actor fail closed and leaves ordinary records readable.
 */

import type { Pool } from 'pg';
import { canReadProtectedResult, PROTECTED_RESULT_EXECUTIONS } from '@/shared/protected-results';

/** Reason a recall fetch names when a caller-owned record exists but this boundary withheld it. */
export const RECALL_WITHHELD_PROTECTED = 'protected_result' as const;

/** Outcome of one exact-id recall fetch. */
export interface RecallFetchResult<T> {
  /** The caller-owned record, or null when it is absent, foreign, or withheld. */
  record: T | null;
  /**
   * Set only when the caller's OWN record was found and the protected-result boundary refused it
   * here. A foreign id never reaches this check (row-level security hides it first), so the marker
   * discloses nothing about another owner's records.
   */
  withheld?: typeof RECALL_WITHHELD_PROTECTED;
}

/**
 * Lineage of the chat tasks a recalled record depends on. `$2` is the reserved metadata key, passed
 * as a parameter so the key has one definition (PROTECTED_RESULT_EXECUTIONS).
 */
export const RECALL_LINEAGE_SQL = `SELECT task_id, agent_id, owner_sub,
        metadata ? $2 AS has_lineage, metadata -> $2 AS lineage
   FROM chat_tasks
  WHERE task_id = ANY($1::text[])`;

interface LineageRow {
  task_id: string;
  agent_id: string | null;
  owner_sub: string | null;
  has_lineage: boolean;
  lineage: unknown;
}

/**
 * The recall tools carry no verified actor. Any record whose read would need one (protected
 * lineage, a durable protected execution, a protected agent) therefore refuses instead of reading.
 * @returns Never resolves; always rejects.
 */
async function noVerifiedActor(): Promise<never> {
  throw new Error('recall_has_no_verified_actor');
}

/**
 * @description Decide whether every chat task a recalled record depends on passes the shared
 * protected-result boundary in this process. Each referenced id is evaluated exactly as the
 * existing read paths evaluate it: a visible task with its own stored lineage, agent and owner; an
 * id with no visible task as `{ taskId, ownerSub: caller }` (the filterJarvisResultRows fallback).
 * Errors propagate so the caller's catch logs them and fails closed.
 * @param pool - Identity-stamped pool; the lineage read is itself owner-scoped by row-level security.
 * @param callerSub - The caller's verified subject, used for ids with no visible task row.
 * @param taskIds - The record's own id and every conversation/ticket id it references.
 * @returns True only when no referenced task is refused by the protected-result boundary.
 */
export async function recallReferencesReadable(
  pool: Pool,
  callerSub: string,
  taskIds: ReadonlyArray<string | null | undefined>,
): Promise<boolean> {
  const ids = [...new Set(taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!ids.length) return true;
  const { rows } = await pool.query(RECALL_LINEAGE_SQL, [ids, PROTECTED_RESULT_EXECUTIONS]);
  const byId = new Map((rows as LineageRow[]).map((row) => [row.task_id, row]));
  for (const taskId of ids) {
    const row = byId.get(taskId);
    const task = row
      ? {
        taskId,
        ownerSub: row.owner_sub,
        agentId: row.agent_id ?? undefined,
        metadata: row.has_lineage ? { [PROTECTED_RESULT_EXECUTIONS]: row.lineage } : {},
      }
      : { taskId, ownerSub: callerSub };
    if (!(await canReadProtectedResult(task, noVerifiedActor))) return false;
  }
  return true;
}
