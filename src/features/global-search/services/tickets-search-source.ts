/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: tickets adapter — ILIKE over title/description on the tickets table, HARD-scoped to owner_sub = caller (the same ownership column cockpit-routes scopes by; the GUC/RLS pool is the backstop, not the line). Score = ILIKE+recency fallback (tickets have no native ranking).
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet, escapeIlike, ilikeRecencyScore } from './search-ranking';

const logger = createChildLogger({ module: 'global-search-tickets' });

interface TicketRow {
  ticket_id: string;
  title: string;
  description: string;
  status: string;
  ticket_type: string | null;
  updated_at: Date | string | null;
}

/**
 * @description Searches the caller's OWN tickets (Postgres `tickets` table). Isolation: the WHERE
 * clause pins `owner_sub = $caller` explicitly — mirroring cockpit-routes' owner scoping — so even
 * if the request ran on an unwrapped pool no cross-user row can come back. Results link to the
 * cockpit (tickets is the framework-default view).
 */
export class TicketsSearchSource implements SearchSource {
  public readonly name = 'tickets';

  /**
   * @description Create the adapter over the api's (GUC-wrapped) Postgres pool.
   * @param pool - Postgres pool; queries inherit the caller's RLS GUCs from request identity.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description ILIKE search over ticket title + description, owner-scoped, newest-first
   * candidate window, scored with the shared ILIKE+recency fallback.
   * @param userSub - The caller's sub — the ownership filter.
   * @param query - Raw user query (escaped for ILIKE here).
   * @param limit - Max hits to return.
   * @returns Caller-owned ticket hits.
   */
  async search(userSub: string, query: string, limit: number): Promise<SearchHit[]> {
    const pattern = `%${escapeIlike(query)}%`;
    try {
      const result = await this.pool.query(
        `SELECT ticket_id, title, description, status, ticket_type, updated_at
           FROM tickets
          WHERE owner_sub = $1
            AND (title ILIKE $2 ESCAPE '\\' OR description ILIKE $2 ESCAPE '\\')
          ORDER BY updated_at DESC
          LIMIT $3`,
        [userSub, pattern, limit],
      );
      const now = Date.now();
      return (result.rows as TicketRow[]).map((row) => {
        const ts = row.updated_at ? new Date(row.updated_at).toISOString() : null;
        const inTitle = row.title.toLowerCase().includes(query.toLowerCase());
        return {
          id: row.ticket_id,
          title: row.title,
          snippet: buildSnippet(inTitle ? row.description || row.title : row.description, query),
          url: '/cockpit/',
          score: ilikeRecencyScore(inTitle, ts, now),
          source: this.name,
          ts,
        } satisfies SearchHit;
      });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'tickets search failed');
      return [];
    }
  }
}
