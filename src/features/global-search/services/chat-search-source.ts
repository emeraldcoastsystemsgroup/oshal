/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: chat-history adapter — ILIKE over chat_tasks titles AND chat_messages text. chat_messages carries no owner column, so message hits are scoped by an INNER JOIN to the caller's OWN chat_tasks rows (owner_sub = caller) — never queried bare. Deduped per task (best hit wins), ILIKE+recency scored.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Emit kind:'chat' and the CANONICAL deep link (deepLinkFor -> /chat?taskId=<id>) instead of the bare '/chat' path, which started a BRAND-NEW conversation and lost the one the user searched for.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet, escapeIlike, ilikeRecencyScore } from './search-ranking';
import { deepLinkFor } from './deep-link';

const logger = createChildLogger({ module: 'global-search-chat' });

interface ChatHitRow {
  task_id: string;
  title: string;
  body: string;
  matched_title: boolean;
  ts: Date | string | null;
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
}
