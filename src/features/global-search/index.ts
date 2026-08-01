/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search barrel — the slice's ONLY public surface (FSD: no deep imports). Exposes the adapter contract, the pure ranking helpers (unit-tested), the four caller-scoped adapters, and the fan-out orchestrator.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export the deep-link contract (deepLinkFor + the per-kind builders + NO_SURFACE_REASON + SearchHitKind) and the three new typed adapters (apps/bots/connectors) with their injected-lister record types. The deep-link builders are exported because the resolvability guard and the surface both need the SAME source of truth for what a hit's URL is.
 */

/**
 * @description Global search across the caller's OWN swarm data — a pluggable SearchSource
 * adapter set (tickets, chat, apps, bots, connectors, personal-data vault, RAG) fan-out +
 * rank-merge, each hit carrying a `kind` and a canonical cockpit deep link. Every
 * adapter is caller-scoped by user_sub; the route (app layer) composes the service and gates it
 * behind requiresAuth.
 * @module features/global-search
 */

export type { SearchHit, SearchSource, SearchCallerExtras } from './services/search-source';
export type { SearchHitKind } from './services/deep-link';
export {
  NO_SURFACE_REASON,
  deepLinkFor,
  ticketDeepLink,
  chatDeepLink,
  appDeepLink,
  botDeepLink,
  connectorDeepLink,
} from './services/deep-link';
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
export { AppsSearchSource, type SearchableApp, type SearchableAppLister } from './services/apps-search-source';
export { BotsSearchSource, type SearchableBot, type SearchableBotLister } from './services/bots-search-source';
export { ConnectorsSearchSource } from './services/connectors-search-source';
