/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search barrel — the slice's ONLY public surface (FSD: no deep imports). Exposes the adapter contract, the pure ranking helpers (unit-tested), the four caller-scoped adapters, and the fan-out orchestrator.
 */

/**
 * @description Global search across the caller's OWN swarm data — a pluggable SearchSource
 * adapter set (tickets, chat history, personal-data vault, RAG) fan-out + rank-merge. Every
 * adapter is caller-scoped by user_sub; the route (app layer) composes the service and gates it
 * behind requiresAuth.
 * @module features/global-search
 */

export type { SearchHit, SearchSource, SearchCallerExtras } from './services/search-source';
export {
  escapeIlike,
  buildSnippet,
  ilikeRecencyScore,
  normalizeScores,
  mergeRankedHits,
} from './services/search-ranking';
export { GlobalSearchService, type GlobalSearchResponse } from './services/global-search-service';
export { TicketsSearchSource } from './services/tickets-search-source';
export { ChatSearchSource } from './services/chat-search-source';
export { PersonalDataSearchSource } from './services/personal-data-search-source';
export { RagSearchSource } from './services/rag-search-source';
