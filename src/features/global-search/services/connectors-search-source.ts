/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: connector adapter. The `connector` result kind was missing, so "gmail" returned mail CONTENT but never the connection itself — the row an operator actually wants when the question is "is my Gmail still connected". Searches oshal_connections HARD-scoped to user_sub (the per-user token store, ADR-042), matching provider / account email / status. Deliberately selects NO token columns: access_token and refresh_token are never named in the query, so a snippet cannot accidentally carry ciphertext into a browser.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Multi-account (migration 101-connections-multi-account, landed the same day): a provider can now hold several accounts per user, so the hit id moves from provider to connection_id — a provider-keyed id made the merge's source:id dedupe collapse someone's two Gmail accounts into a single row and hide the second. The account `label` joins the searched columns and the hit title. The deep link stays provider-keyed because /utilities focuses a PROVIDER card, which is the right landing place for any of its accounts.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet, escapeIlike, ilikeRecencyScore } from './search-ranking';
import { deepLinkFor } from './deep-link';

const logger = createChildLogger({ module: 'global-search-connectors' });

interface ConnectionRow {
  connection_id: string;
  provider: string;
  account_email: string | null;
  label: string | null;
  status: string;
  updated_at: Date | string | null;
}

/**
 * @description Searches the caller's OWN connector connections (`oshal_connections`). Isolation:
 * `user_sub = $1` is the first predicate and every uniqueness index on the table is user_sub-first,
 * so there is no shape in which a foreign row can match; the GUC/RLS pool is the backstop, not the
 * line. The SELECT list is an allowlist of six non-secret columns — the encrypted token columns are
 * never read here at all.
 */
export class ConnectorsSearchSource implements SearchSource {
  public readonly name = 'connectors';

  /**
   * @description Create the adapter over the api's (GUC-wrapped) Postgres pool.
   * @param pool - Postgres pool; queries inherit the caller's RLS GUCs from request identity.
   */
  constructor(private readonly pool: Pool) {}

  /**
   * @description ILIKE search over provider name, connected account email and status, scoped to
   * the caller's connections.
   * @param userSub - The caller's sub — the ownership filter.
   * @param query - Raw user query (escaped for ILIKE here).
   * @param limit - Max hits to return.
   * @returns The caller's matching connection hits.
   */
  async search(userSub: string, query: string, limit: number): Promise<SearchHit[]> {
    if (!userSub) return [];
    const pattern = `%${escapeIlike(query)}%`;
    try {
      const result = await this.pool.query(
        `SELECT connection_id, provider, account_email, label, status, updated_at
           FROM oshal_connections
          WHERE user_sub = $1
            AND (provider ILIKE $2 ESCAPE '\\'
                 OR account_email ILIKE $2 ESCAPE '\\'
                 OR label ILIKE $2 ESCAPE '\\'
                 OR status ILIKE $2 ESCAPE '\\')
          ORDER BY updated_at DESC
          LIMIT $3`,
        [userSub, pattern, limit],
      );
      const now = Date.now();
      return (result.rows as ConnectionRow[]).map((row) => {
        const ts = row.updated_at ? new Date(row.updated_at).toISOString() : null;
        const q = query.toLowerCase();
        const label = (row.label || '').trim();
        const inTitle = row.provider.toLowerCase().includes(q) || label.toLowerCase().includes(q);
        const body = [row.account_email || '(no account email recorded)', row.status].join(' · ');
        return {
          // Keyed on connection_id, NOT provider: migration 101-connections-multi-account made a
          // provider multi-account per user, and a provider-keyed id would make the merge's
          // source:id dedupe collapse someone's two Gmail accounts into one row — hiding the second
          // rather than showing it.
          id: row.connection_id,
          title: label ? `${label} (${row.provider})` : `${row.provider} connection`,
          snippet: buildSnippet(body, query),
          kind: 'connector',
          url: deepLinkFor('connector', row.provider),
          score: ilikeRecencyScore(inTitle, ts, now),
          source: this.name,
          ts,
        } satisfies SearchHit;
      });
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'connectors search failed');
      return [];
    }
  }
}
