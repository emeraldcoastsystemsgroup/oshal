/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: the orchestrator — fans one caller-scoped query out to the registered SearchSource adapters in parallel (each isolated: one failing store logs at ERROR and contributes [], it never sinks the whole search), then rank-merges via mergeRankedHits. Source filtering (sources=) resolves against adapter names; unknown names are reported, not silently dropped.
 */

import { createChildLogger } from '@/shared/logger';
import type { SearchCallerExtras, SearchHit, SearchSource } from './search-source';
import { mergeRankedHits } from './search-ranking';

const logger = createChildLogger({ module: 'global-search-service' });

/** The orchestrator's answer: merged hits + per-source accounting for the UI's group headers. */
export interface GlobalSearchResponse {
  /** Rank-interleaved, capped, deduped hits across the selected sources. */
  hits: SearchHit[];
  /** Per-source hit counts BEFORE the global cap (the UI shows "tickets (3)" style headers). */
  sourceCounts: Record<string, number>;
  /** `sources=` names that matched no registered adapter (surfaced, never silently ignored). */
  unknownSources: string[];
  /** Total wall time of the fan-out + merge, ms. */
  durationMs: number;
}

/**
 * @description Fans a query out to pluggable, caller-scoped search sources and rank-merges the
 * results. Holds NO store logic itself — isolation lives in each adapter (every one is handed the
 * caller's sub), fault tolerance and ranking live here.
 */
export class GlobalSearchService {
  private readonly sources: SearchSource[];

  /**
   * @description Register the adapter set once at composition time.
   * @param sources - The adapters to fan out to (order is irrelevant — the merge interleaves).
   */
  constructor(sources: SearchSource[]) {
    this.sources = sources;
    logger.info({ sources: sources.map((s) => s.name) }, 'GlobalSearchService initialized');
  }

  /** @description The registered adapter names (route input validation + UI source pickers). @returns Adapter names. */
  sourceNames(): string[] {
    return this.sources.map((s) => s.name);
  }

  /**
   * @description Run one caller-scoped search. Every selected adapter receives the SAME
   * (userSub, query, perSourceLimit) so no source can widen its own scope; adapter failures are
   * logged and degrade to empty rather than failing the request.
   * @param userSub - The authenticated caller's sub (session-derived by the route, never body).
   * @param query - Raw user query text.
   * @param limit - Global cap on merged hits (each adapter is asked for up to this many).
   * @param onlySources - Optional adapter-name filter from the route's `sources=` param.
   * @param extras - Caller email/groups/operator for permission-aware sources.
   * @returns Merged hits + per-source accounting.
   */
  async search(
    userSub: string,
    query: string,
    limit: number,
    onlySources?: string[],
    extras?: SearchCallerExtras,
  ): Promise<GlobalSearchResponse> {
    const started = Date.now();
    const wanted = onlySources?.map((s) => s.trim().toLowerCase()).filter(Boolean);
    const selected = wanted?.length ? this.sources.filter((s) => wanted.includes(s.name)) : this.sources;
    const unknownSources = wanted?.length ? wanted.filter((w) => !this.sources.some((s) => s.name === w)) : [];

    const groups = await Promise.all(
      selected.map(async (source) => {
        try {
          return await source.search(userSub, query, limit, extras);
        } catch (err) {
          // Adapters catch internally too; this is the belt for adapters that forget.
          logger.error({ err, stack: (err as Error).stack, source: source.name }, 'search source threw');
          return [] as SearchHit[];
        }
      }),
    );

    const sourceCounts: Record<string, number> = {};
    selected.forEach((source, i) => { sourceCounts[source.name] = groups[i].length; });
    const hits = mergeRankedHits(groups, limit);
    const durationMs = Date.now() - started;
    logger.info(
      { userSub, queryLength: query.length, limit, sources: selected.map((s) => s.name), sourceCounts, merged: hits.length, durationMs },
      'global search complete',
    );
    return { hits, sourceCounts, unknownSources, durationMs };
  }
}
