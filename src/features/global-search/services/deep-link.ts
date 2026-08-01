/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: the per-source DEEP-LINK CONTRACT. Adapters previously hand-typed a bare surface path ('/cockpit/', '/chat') that landed on the right screen but never on the right RECORD, and two adapters returned null with no stated reason. This module is the single place a hit's canonical URL is minted: one builder per result kind, each pinned to a URL parameter a surface DEMONSTRABLY reads (named in the builder's doc), plus an explicit NO_SURFACE registry so "no deep link" is a declared decision with a reason instead of an unexplained null. Pure functions — the resolvability guard tests THIS file, not seven adapters.
 */

/**
 * @description The result kinds global search can return. This is the `kind` stamped on every
 * SearchHit, and it is what a caller switches on to render a typed row — deliberately separate
 * from the adapter `source` name: several adapters could in principle emit the same kind (a
 * future archived-ticket adapter still yields `ticket`), and the deep-link builder is chosen by
 * KIND, not by which store the row came from.
 */
export type SearchHitKind = 'ticket' | 'chat' | 'app' | 'connector' | 'bot' | 'doc' | 'entity';

/**
 * @description Kinds that deliberately have NO deep link, each with the reason it has none.
 * A null `url` on a hit MUST be explained here — an adapter returning null for a kind absent
 * from this map is a bug the deep-link guard fails on, which is the whole point: an unexplained
 * null is indistinguishable from a forgotten link.
 */
export const NO_SURFACE_REASON: Readonly<Partial<Record<SearchHitKind, string>>> = Object.freeze({
  doc: 'RAG chunks have no per-document cockpit surface — the Knowledge tab lists collections, '
    + 'not addressable documents, so a per-chunk URL would 404 the record it claims to open.',
  entity: 'The personal-data vault (ADR-057) is owner-key encrypted with no browse surface; its '
    + 'entities are reachable only through the assistant, which takes no record parameter.',
});

/**
 * @description Percent-encode one path/query value. Deep links are consumed by a browser, so an
 * id carrying `&`, `#` or a space must not be able to graft extra parameters onto the URL.
 * @param value - Raw identifier from a store row.
 * @returns The URI-encoded value.
 */
function enc(value: string): string {
  return encodeURIComponent(value);
}

/**
 * @description Canonical link to ONE ticket in the cockpit ticket workbench.
 * Resolves via `?ticket=` in src/pages/cockpit/js/app.js, which seeds
 * CockpitViewController.openTicketWorkbench → TicketView.focusTicket, so the row is selected and
 * its detail pane loaded (not merely the ticket list opened).
 * @param ticketId - The `tickets.ticket_id` value.
 * @returns The cockpit deep link, or null when the id is empty.
 */
export function ticketDeepLink(ticketId: string): string | null {
  const id = (ticketId || '').trim();
  return id ? `/cockpit/?ticket=${enc(id)}` : null;
}

/**
 * @description Canonical link to ONE conversation in the chat surface.
 * Resolves via `?taskId=` in src/pages/chat/ui/chat-config-modal.mjs, which adopts the requested
 * task id instead of minting a new one, so the conversation rehydrates.
 * @param taskId - The `chat_tasks.task_id` value.
 * @returns The chat deep link, or null when the id is empty.
 */
export function chatDeepLink(taskId: string): string | null {
  const id = (taskId || '').trim();
  return id ? `/chat?taskId=${enc(id)}` : null;
}

/**
 * @description Canonical link to ONE installed app's cockpit shape.
 * Resolves via `?app=` in src/pages/cockpit/js/components/RibbonNav.js — the documented cockpit
 * URL contract (CLAUDE.md: "`?app=` is the single source of truth"), which shapes the ribbon and
 * pre-filters the ticket list to the manifest's ticketType.
 * @param appName - The manifest `name` (also the app's queueId).
 * @returns The cockpit deep link, or null when the name is empty.
 */
export function appDeepLink(appName: string): string | null {
  const name = (appName || '').trim();
  return name ? `/cockpit/?app=${enc(name)}` : null;
}

/**
 * @description Canonical link to ONE bot/agent selected in the cockpit.
 * Resolves via `?agentId=` in src/pages/cockpit/js/cockpit-persistence.js
 * (readPreferredSelectedAgentId), which takes the query value in preference to localStorage, so
 * the cockpit opens with that bot selected.
 * @param agentId - The `agents.agent_id` UUID.
 * @returns The cockpit deep link, or null when the id is empty.
 */
export function botDeepLink(agentId: string): string | null {
  const id = (agentId || '').trim();
  return id ? `/cockpit/?agentId=${enc(id)}` : null;
}

/**
 * @description Canonical link to the caller's connections list, focused on one provider.
 * Resolves via `/utilities` (src/app/server.ts) plus `?connector=` which utilities.html reads to
 * scroll the matching connector card into view and highlight it. The provider id is part of the
 * link because "your Gmail connection" must land on that card, not on a page of thirty.
 * @param provider - The `oshal_connections.provider` value.
 * @returns The utilities deep link, or null when the provider is empty.
 */
export function connectorDeepLink(provider: string): string | null {
  const id = (provider || '').trim();
  return id ? `/utilities?connector=${enc(id)}` : null;
}

/**
 * @description The declared deep link for a hit kind + record id, or null when the kind is
 * registered in {@link NO_SURFACE_REASON}. Adapters call THIS rather than formatting their own
 * URL, so adding a surface parameter is a one-line change here instead of a hunt through seven
 * adapters — and so the guard can assert every kind is either linked or explained.
 * @param kind - The hit kind.
 * @param id - The record identifier the link should open.
 * @returns The canonical cockpit URL, or null for a declared no-surface kind.
 */
export function deepLinkFor(kind: SearchHitKind, id: string): string | null {
  switch (kind) {
    case 'ticket': return ticketDeepLink(id);
    case 'chat': return chatDeepLink(id);
    case 'app': return appDeepLink(id);
    case 'bot': return botDeepLink(id);
    case 'connector': return connectorDeepLink(id);
    case 'doc':
    case 'entity':
      return null;
    default: {
      // Exhaustiveness: a new kind added to SearchHitKind without a builder is a compile error
      // here, not a silently unlinked result row.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
