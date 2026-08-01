/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: bot adapter. The `bot` result kind was missing, so "which bot handles invoices" had no answer from the search box. Bots are platform config, not user rows, so the isolation question here is REACH, not ownership: the adapter applies ADR-087 accessRoles via the shared roleCanAccess helper against the caller's effective role ('operator' for operators, otherwise 'jarvis' — the same user-facing delegation role bot-node-execute-entitlement.ts uses), so operator-only internal machinery (project-manager, queue-bot, oshal-developer, security-analyst…) never appears in a basic user's results.
 */

import { createChildLogger } from '@/shared/logger';
import { roleCanAccess, type SwarmAccessRole } from '@/shared/types';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet, ilikeRecencyScore } from './search-ranking';
import { deepLinkFor } from './deep-link';

const logger = createChildLogger({ module: 'global-search-bots' });

/**
 * @description One bot as this adapter needs it. `accessRoles` is carried through rather than
 * pre-applied so the reach decision is made — and tested — here.
 */
export interface SearchableBot {
  /** The bot's agentId UUID — the `?agentId=` deep-link key. */
  agentId: string;
  /** Registry name (searched). */
  name: string;
  /** Registry role string, e.g. 'swarm/qa-gatekeeper' (searched). */
  role: string;
  /** Capability tags (searched — this is how "invoices" finds the finance bot). */
  capabilities: string[];
  /** Declared harness, when the registry pins one. Shown in the snippet. */
  harnessType: string | null;
  /** ADR-087 caller-role scoping. Absent/empty = open to every caller. */
  accessRoles?: readonly SwarmAccessRole[];
  /**
   * Liveness label the lister resolved: 'online' | 'offline' | 'unknown'. 'unknown' is a real
   * value, not a placeholder — when the Redis runtime registry is unreachable the honest answer is
   * that liveness could not be determined, and rendering that as "offline" would invent an outage.
   */
  status: 'online' | 'offline' | 'unknown';
}

/** Supplies the bot records, UNFILTERED by role. Role scoping is this adapter's job. */
export type SearchableBotLister = () => Promise<SearchableBot[]>;

/**
 * @description Searches the active bot registry by name / role / capability tag. Deliberately
 * shows offline bots too (with the liveness label in the snippet): "which bot does X" is a question
 * about the fleet's shape, and hiding a stopped container turns a stopped bot into a missing one.
 */
export class BotsSearchSource implements SearchSource {
  public readonly name = 'bots';

  /**
   * @description Create the adapter over a bot lister.
   * @param listBots - Returns ALL active-registry bots including their accessRoles. Must NOT
   * pre-filter by role — this adapter applies roleCanAccess so the rule stays testable.
   */
  constructor(private readonly listBots: SearchableBotLister) {}

  /**
   * @description Substring search over the bots the caller may reach.
   * @param userSub - The caller's sub. Bots are not user-owned, so it is used only to refuse an
   * unauthenticated call (the route already 401s; this is the belt).
   * @param query - Raw user query.
   * @param limit - Max hits to return.
   * @param extras - Caller attributes; only `isOperator` is consulted (it selects the role).
   * @returns Reachable bot hits, best-first.
   */
  async search(
    userSub: string,
    query: string,
    limit: number,
    extras?: { isOperator?: boolean },
  ): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q || !userSub) return [];
    // ADR-087: a signed-in person browsing search has the reach of the user-facing delegation
    // role, not of the swarm's own internal dispatch. Operators see the whole fleet.
    const callerRole: SwarmAccessRole = extras?.isOperator === true ? 'operator' : 'jarvis';
    try {
      const all = await this.listBots();
      const now = Date.now();
      const hits: SearchHit[] = [];
      for (const bot of all) {
        if (!roleCanAccess(bot.accessRoles, callerRole)) continue;
        const inTitle = bot.name.toLowerCase().includes(q);
        const body = [bot.role, ...(bot.capabilities || [])].join(', ');
        if (!inTitle && !body.toLowerCase().includes(q)) continue;
        const harness = bot.harnessType ? ` · ${bot.harnessType}` : '';
        hits.push({
          id: bot.agentId,
          title: bot.name,
          snippet: buildSnippet(`${bot.status}${harness} · ${body}`, query),
          kind: 'bot',
          url: deepLinkFor('bot', bot.agentId),
          // Registry rows have no timestamp; ts stays null so recency never demotes a bot
          // below a chat message. ilikeRecencyScore's null branch applies the same floor to all.
          score: ilikeRecencyScore(inTitle, null, now),
          source: this.name,
          ts: null,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'bots search failed');
      return [];
    }
  }
}
