/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: chat-history adapter — ILIKE over chat_tasks titles AND chat_messages text. chat_messages carries no owner column, so message hits are scoped by an INNER JOIN to the caller's OWN chat_tasks rows (owner_sub = caller) — never queried bare. Deduped per task (best hit wins), ILIKE+recency scored.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Emit kind:'chat' and the CANONICAL deep link (deepLinkFor -> /chat?taskId=<id>) instead of the bare '/chat' path, which started a BRAND-NEW conversation and lost the one the user searched for.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Add the owner-scoped conversation list/fetch read model: list returns selection metadata only, while fetch returns one named conversation's messages. Both rely on the identity-stamped pool and the database owner policy.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet, escapeIlike, ilikeRecencyScore } from './search-ranking';
import { deepLinkFor } from './deep-link';

const logger = createChildLogger({ module: 'global-search-chat' });

/** Maximum messages one explicit conversation fetch may place in a model turn. */
export const MAX_CONVERSATION_MESSAGES = 100;

interface ChatHitRow {
  task_id: string;
  title: string;
  body: string;
  matched_title: boolean;
  ts: Date | string | null;
}

/** Selection metadata returned before the caller chooses a conversation to fetch. */
export interface ConversationSummary {
  taskId: string;
  title: string;
  status: string;
  kind: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string | null;
}

/** One caller-owned conversation and its bounded message history. */
export interface ConversationDetail extends ConversationSummary {
  messages: Array<{
    role: string;
    text: string;
    createdAt: string | null;
  }>;
}

/**
 * @description Searches the caller's chat history (chat_tasks + chat_messages). Isolation:
 * chat_tasks is filtered on its owner_sub column; chat_messages has NO owner column of its own,
 * so message text is only ever reached through an inner join to the caller's own tasks — the
 * ownership model for conversations lives on the task row (see conversation-schema.ts).
 */
export class ChatSearchSource implements SearchSource {
  public readonly name = 'chat';

  /**
   * @description Create the adapter over the api's (GUC-wrapped) Postgres pool.
   * @param pool - Postgres pool; queries inherit the caller's RLS GUCs from request identity.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description One UNION query: title matches on the caller's tasks + text matches on messages
   * joined to the caller's tasks, then deduped per task keeping the strongest hit.
   * @param userSub - The caller's sub — the ownership filter on chat_tasks.
   * @param query - Raw user query (escaped for ILIKE here).
   * @param limit - Max hits to return.
   * @returns Caller-owned chat task hits (one per task).
   */
  async search(userSub: string, query: string, limit: number): Promise<SearchHit[]> {
    const pattern = `%${escapeIlike(query)}%`;
    try {
      // Fetch a wider candidate window than `limit` because per-task dedupe collapses rows.
      const result = await this.pool.query(
        `SELECT t.task_id, t.title, t.title AS body, TRUE AS matched_title, t.updated_at AS ts
           FROM chat_tasks t
          WHERE t.owner_sub = $1 AND t.title ILIKE $2 ESCAPE '\\'
          UNION ALL
         SELECT t.task_id, t.title, m.text AS body, FALSE AS matched_title, m.created_at AS ts
           FROM chat_messages m
           JOIN chat_tasks t ON t.task_id = m.task_id AND t.owner_sub = $1
          WHERE m.text ILIKE $2 ESCAPE '\\'
          ORDER BY ts DESC
          LIMIT $3`,
        [userSub, pattern, limit * 4],
      );
      const now = Date.now();
      const byTask = new Map<string, SearchHit>();
      for (const row of result.rows as ChatHitRow[]) {
        const ts = row.ts ? new Date(row.ts).toISOString() : null;
        const hit: SearchHit = {
          id: row.task_id,
          title: row.title || '(untitled conversation)',
          snippet: buildSnippet(row.body, query),
          kind: 'chat',
          url: deepLinkFor('chat', row.task_id),
          score: ilikeRecencyScore(row.matched_title, ts, now),
          source: this.name,
          ts,
        };
        const prev = byTask.get(row.task_id);
        if (!prev || hit.score > prev.score) byTask.set(row.task_id, hit);
      }
      return [...byTask.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'chat search failed');
      return [];
    }
  }

  /**
   * @description List caller-owned conversations matching a title or message query without
   * returning message bodies. The EXISTS predicate uses message text only to select candidate
   * task ids; the result shape is deliberately metadata-only so a broad question cannot inject
   * old answers into the model context before it chooses a record.
   * @param userSub - The caller's verified subject.
   * @param query - Words to match in a title or message.
   * @param limit - Maximum summaries to return.
   * @returns Caller-owned conversation summaries, newest first.
   */
  async list(userSub: string, query: string, limit: number): Promise<ConversationSummary[]> {
    const pattern = `%${escapeIlike(query)}%`;
    try {
      const result = await this.pool.query(
        `SELECT t.task_id, t.title, t.status, t.processing_mode,
                t.metadata->>'kind' AS metadata_kind, t.created_at, t.updated_at
           FROM chat_tasks t
          WHERE t.owner_sub = $1
            AND (t.title ILIKE $2 ESCAPE '\\'
                 OR EXISTS (
                   SELECT 1 FROM chat_messages m
                    WHERE m.task_id = t.task_id AND m.text ILIKE $2 ESCAPE '\\'
                 ))
          ORDER BY t.updated_at DESC
          LIMIT $3`,
        [userSub, pattern, limit],
      );
      return result.rows.map((row: {
        task_id: string;
        title: string;
        status: string;
        processing_mode: string;
        metadata_kind: string | null;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      }) => ({
        taskId: row.task_id,
        title: row.title || '(untitled conversation)',
        status: row.status,
        kind: row.metadata_kind || row.processing_mode,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        url: deepLinkFor('chat', row.task_id),
      }));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'conversation list failed');
      return [];
    }
  }

  /**
   * @description Fetch one caller-owned conversation and its messages. Ownership is part of the
   * task lookup and the message policy is independently enforced by `oshal_owns_task` on the
   * identity-stamped connection; a foreign or absent id returns null without an existence leak.
   * @param userSub - The caller's verified subject.
   * @param taskId - The exact conversation identifier selected by the caller.
   * @returns One caller-owned conversation, or null when it is not visible to this caller.
   */
  async fetch(userSub: string, taskId: string): Promise<ConversationDetail | null> {
    try {
      const taskResult = await this.pool.query(
        `SELECT task_id, title, status, processing_mode, metadata->>'kind' AS metadata_kind,
                created_at, updated_at
           FROM chat_tasks
          WHERE task_id = $1 AND owner_sub = $2
          LIMIT 1`,
        [taskId, userSub],
      );
      const row = taskResult.rows[0] as {
        task_id: string;
        title: string;
        status: string;
        processing_mode: string;
        metadata_kind: string | null;
        created_at: Date | string | null;
        updated_at: Date | string | null;
      } | undefined;
      if (!row) return null;

      const messagesResult = await this.pool.query(
        `SELECT role, text, created_at
           FROM chat_messages
          WHERE task_id = $1
          ORDER BY created_at ASC
          LIMIT $2`,
        [taskId, MAX_CONVERSATION_MESSAGES],
      );
      return {
        taskId: row.task_id,
        title: row.title || '(untitled conversation)',
        status: row.status,
        kind: row.metadata_kind || row.processing_mode,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        url: deepLinkFor('chat', row.task_id),
        messages: messagesResult.rows.map((message: {
          role: string;
          text: string;
          created_at: Date | string | null;
        }) => ({
          role: message.role,
          text: message.text,
          createdAt: message.created_at ? new Date(message.created_at).toISOString() : null,
        })),
      };
    } catch (err) {
      logger.error({ err, taskId, stack: (err as Error).stack }, 'conversation fetch failed');
      return null;
    }
  }
}
