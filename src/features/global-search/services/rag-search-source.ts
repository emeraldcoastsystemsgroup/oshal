/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: RAG adapter — searchAllCollections through RagService's OWN hybrid ranking, ALWAYS under a caller RagPermissionContext (owner_sub/allowed_users/allowed_groups/tenant filtering happens inside the permission filter; shared corpus stays readable via allowPublic). The context is built by the route from the session — this adapter refuses to run without one.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Emit kind:'doc'. The url stays null, but now BY DECLARATION: deepLinkFor('doc') resolves against NO_SURFACE_REASON, which states why (no addressable per-document cockpit surface) — so the null is a documented decision the guard checks, not an unexplained gap.
 */

import { createChildLogger } from '@/shared/logger';
import type { RagService, RagSearchResult, RagPermissionContext } from '@/features/rag';
import type { SearchCallerExtras, SearchHit, SearchSource } from './search-source';
import { buildSnippet } from './search-ranking';
import { deepLinkFor } from './deep-link';

const logger = createChildLogger({ module: 'global-search-rag' });

/**
 * @description Searches every RAG collection via RagService.searchAllCollections — the store's
 * native hybrid (vector + BM25) ranking is used as-is, which is exactly what the merge layer's
 * per-source normalization expects. Isolation: every call carries a RagPermissionContext built
 * from the caller (sub + email + groups + operator flag); owner-tagged private chunks are
 * filtered inside the permission filter and the unowned shared corpus stays visible
 * (allowPublic) — same contract as /api/rag/search.
 */
export class RagSearchSource implements SearchSource {
  public readonly name = 'rag';

  /**
   * @description Create the adapter over an existing RagService instance.
   * @param ragService - The api's RagService (Chroma or pgvector engine — adapter is agnostic).
   */
  constructor(private readonly ragService: RagService) {}

  /**
   * @description Permission-aware search across all collections. The caller context is derived
   * ONLY from `userSub` + `extras` (session-sourced by the route) — never from query params.
   * @param userSub - The caller's sub (owner_sub match in the permission filter).
   * @param query - Raw user query (RagService handles its own tokenization).
   * @param limit - Max hits to return across collections.
   * @param extras - Caller email/groups/operator for group- and tenant-granted chunks.
   * @returns Permission-filtered RAG hits.
   */
  async search(userSub: string, query: string, limit: number, extras?: SearchCallerExtras): Promise<SearchHit[]> {
    const context: RagPermissionContext = {
      userSub,
      emails: extras?.email ? [extras.email] : [],
      groups: extras?.groups ?? [],
      isOperator: extras?.isOperator === true,
      allowPublic: true,
    };
    try {
      const results = await this.ragService.searchAllCollections(query, limit, context);
      return results.map((r: RagSearchResult) => ({
        id: r.id,
        title: r.metadata?.title || r.metadata?.doc_id || `${r.collection} document`,
        snippet: buildSnippet(r.text, query),
        kind: 'doc',
        url: deepLinkFor('doc', r.id),
        score: r.score,
        source: this.name,
        ts: r.metadata?.ingested_at || null,
      } satisfies SearchHit));
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'rag search failed');
      return [];
    }
  }
}
