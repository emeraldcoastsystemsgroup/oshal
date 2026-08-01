/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Global search: installed-app adapter. The `app` result kind was missing, so a user who knew an app by name had no way to reach its cockpit shape from search. Isolation lives IN THIS ADAPTER rather than in the injected lister: the lister hands over raw records carrying scope + ownerSub and the adapter applies the visibility rule itself (byte-mirroring isVisibleToCaller in swarm-app-service.ts), so a mis-wired lister cannot leak a person-scoped app and the rule is directly unit-testable with a stub.
 */

import { createChildLogger } from '@/shared/logger';
import type { SearchHit, SearchSource } from './search-source';
import { buildSnippet, ilikeRecencyScore } from './search-ranking';
import { deepLinkFor } from './deep-link';

const logger = createChildLogger({ module: 'global-search-apps' });

/**
 * @description One installed-app record as this adapter needs it — deliberately carrying the
 * visibility inputs (`scope` + `ownerSub`) rather than a pre-filtered list, so the ownership
 * decision is made here where it can be tested.
 */
export interface SearchableApp {
  /** Manifest name — the app's queueId AND its `?app=` deep-link key. */
  name: string;
  /** Display name shown in the catalog. */
  displayName: string;
  /** Manifest description (searched). */
  description: string;
  /** Catalog shelf (ADR-097) — shown in the snippet when the description is empty. */
  suite: string | null;
  /** Visibility scope: public | person | operator | tenant. */
  scope: string;
  /** Owner sub for person-scoped apps; null otherwise. */
  ownerSub: string | null;
  /** ISO timestamp of the last manifest load/update, for recency weighting. */
  updatedAt: string | null;
}

/** Supplies the installed-app records, UNFILTERED. Filtering is this adapter's job. */
export type SearchableAppLister = () => Promise<SearchableApp[]>;

/**
 * @description Is this app visible to the caller? Mirrors `isVisibleToCaller` in
 * swarm-app-service.ts exactly: public → everyone; person → its owner only; operator/tenant →
 * nobody except an operator (tenant filtering is still deferred there). Operators bypass, matching
 * `listApps`. Kept as a local copy on purpose — a features slice cannot import another slice
 * (FSD), and duplicating four lines is better than routing search through the app layer.
 * @param app - The candidate app record.
 * @param userSub - The caller's sub.
 * @param isOperator - Whether the caller is a platform operator.
 * @returns True when the caller may see the app.
 */
function isAppVisibleToCaller(app: SearchableApp, userSub: string, isOperator: boolean): boolean {
  if (isOperator) return true;
  if (app.scope === 'public') return true;
  if (app.scope === 'person') return !!userSub && app.ownerSub === userSub;
  return false;
}

/**
 * @description Searches installed swarm apps by name / display name / description. Apps are a
 * small in-memory catalog (tens of rows), so matching is a plain case-insensitive substring scan
 * rather than SQL — there is nothing to index and no store round-trip to make.
 */
export class AppsSearchSource implements SearchSource {
  public readonly name = 'apps';

  /**
   * @description Create the adapter over a record lister.
   * @param listApps - Returns ALL installed app records (with scope + ownerSub). Must NOT
   * pre-filter — this adapter applies the caller-visibility rule so it stays testable.
   */
  constructor(private readonly listApps: SearchableAppLister) {}

  /**
   * @description Substring search over the caller-visible app catalog.
   * @param userSub - The caller's sub — the person-scope ownership filter.
   * @param query - Raw user query.
   * @param limit - Max hits to return.
   * @param extras - Caller attributes; only `isOperator` is consulted.
   * @returns Visible app hits, best-first.
   */
  async search(
    userSub: string,
    query: string,
    limit: number,
    extras?: { isOperator?: boolean },
  ): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    try {
      const all = await this.listApps();
      const now = Date.now();
      const hits: SearchHit[] = [];
      for (const app of all) {
        if (!isAppVisibleToCaller(app, userSub, extras?.isOperator === true)) continue;
        const label = `${app.displayName || app.name}`;
        const inTitle = label.toLowerCase().includes(q) || app.name.toLowerCase().includes(q);
        const body = app.description || (app.suite ? `${app.suite} app` : '');
        if (!inTitle && !body.toLowerCase().includes(q)) continue;
        hits.push({
          id: app.name,
          title: label,
          snippet: buildSnippet(body || label, query),
          kind: 'app',
          url: deepLinkFor('app', app.name),
          score: ilikeRecencyScore(inTitle, app.updatedAt, now),
          source: this.name,
          ts: app.updatedAt,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (err) {
      logger.error({ err, stack: (err as Error).stack }, 'apps search failed');
      return [];
    }
  }
}
