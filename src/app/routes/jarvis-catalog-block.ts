/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The ASSISTANT CATALOG text, moved out of jarvis-orchestrator.ts and no longer capped at 40 routes. On 2026-10-01 the live box had 66 effective routes and the model saw the first 40, so calendar, finance, rides, spotify, intelligent-sales and 21 more were invisible to routing and to the multi-app planner (whose compiler resolves any route key, listed or not). Every route is now listed: the routes the ask names (by key or name words, then distinctive blurb words) come first with their description, the rest as a compact key/name/reach line, all inside CATALOG_LINES_BUDGET_CHARS - what the 40 full lines cost - so the plan guidance after the catalog stays where it was. If even the compact lines overflow the budget, the remainder is counted in one line rather than silently cut.
 *
 * @module jarvis-catalog-block
 */

import type { AppRoute } from './jarvis-orchestrator';

/** Characters the entry lines may spend: what the 40 full lines cost when the list was capped at 40. */
export const CATALOG_LINES_BUDGET_CHARS = 9_000;
const BLURB_CHARS = 180;
/** Words too common in route blurbs to say what an ask is about. */
const COMMON_WORDS = new Set(['about', 'anything', 'apps', 'bots', 'every', 'from', 'into', 'only', 'other', 'select',
  'task', 'tasks', 'that', 'their', 'them', 'this', 'user', 'users', 'what', 'when', 'which', 'with', 'your']);

const CATALOG_HEADER = [
  'ASSISTANT CATALOG - the specialists and apps ON THIS DEPLOYMENT. This list is authoritative',
  'and supersedes any baked-in specialist list in your instructions: installations differ, and',
  'what is listed here is what exists for this user. Entries this request names come first with a',
  'description; every other app is listed by key and name. When a question belongs to one of these',
  'domains and you do not hold its data in this turn, never answer with a bare "I do not know" -',
  'hand the work off, or name the owning app and point the user to it (with its link). These',
  'are also the "catalog keys" the multi-app plan directive refers to. FRESHNESS: a result',
  'in OPEN WORK is a record of that past task - it answers questions about that task only.',
  'For a question about the CURRENT state of a catalog domain (counts, totals, what is in a',
  'stage or list right now), FILE THE FRESH HANDOFF YOURSELF in this same reply - a data',
  'read is not outward, so never ask permission first and never lead with the old number;',
  'say the pull is under way. Point the user at the owning app only when its screen is',
  'genuinely the better answer - never present an old task result as today\'s numbers.',
];

/** How the model reaches a route: hand it work, or point the user to its screen. */
const reach = (r: AppRoute): string => (r.mode === 'delegate' ? 'you can hand work to it' : `point the user to it: ${r.deepLink}`);
const fullLine = (r: AppRoute): string => `- ${r.key}: ${r.name} - ${r.blurb.slice(0, BLURB_CHARS)} (${reach(r)})`;
const compactLine = (r: AppRoute): string => `- ${r.key}: ${r.name} (${reach(r)})`;

/** Distinct lowercase words of a text, three letters or longer, common blurb words removed. */
function wordsOf(text: string): Set<string> {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !COMMON_WORDS.has(w)));
}

/** Does the ask use this word, as a word or its singular ("calendars" asks about "calendar")? */
function asksAbout(ask: string, word: string): boolean {
  const stem = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
  return new RegExp(`(?:^|[^a-z0-9])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(ask);
}

/**
 * @description How strongly an ask points at one route: its key and name words count double, and up
 * to three distinctive blurb words (five letters or longer) count once each.
 * @param ask - The lowercased request.
 * @param r - The route.
 * @returns 0 when the ask names nothing of this route.
 */
export function catalogRelevance(ask: string, r: AppRoute): number {
  if (!ask) return 0;
  const named = [...wordsOf(`${r.key} ${r.name}`)].filter((w) => asksAbout(ask, w)).length;
  const blurb = [...wordsOf(r.blurb.slice(0, BLURB_CHARS))].filter((w) => w.length >= 5 && asksAbout(ask, w)).length;
  return named * 2 + Math.min(3, blurb);
}

/**
 * @description The catalog entry lines inside the budget: every route gets a compact line first, in
 * priority order (routes the ask names, most relevant first, then the deployment's order), and then
 * routes are given their full description in the same order while the budget allows.
 * @param routes - The effective routes, in deployment order.
 * @param ask - The user's words this turn ('' for none).
 * @param budget - Characters the lines may spend.
 * @returns The lines, plus a count line when some routes did not fit at all.
 */
export function catalogLines(routes: AppRoute[], ask: string, budget: number = CATALOG_LINES_BUDGET_CHARS): string[] {
  const lowered = String(ask || '').toLowerCase();
  const scored = routes.map((route, index) => ({ route, index, score: catalogRelevance(lowered, route) }));
  const priority = [...scored].sort((a, b) => b.score - a.score || a.index - b.index).map(({ route }) => route);
  const listed: Array<{ route: AppRoute; full: boolean }> = [];
  let used = 0;
  for (const route of priority) {
    const cost = compactLine(route).length + 1;
    if (used + cost > budget) continue;
    listed.push({ route, full: false });
    used += cost;
  }
  for (const entry of listed) {
    const extra = fullLine(entry.route).length - compactLine(entry.route).length;
    if (used + extra > budget) continue;
    entry.full = true;
    used += extra;
  }
  const lines = listed.map(({ route, full }) => (full ? fullLine(route) : compactLine(route)));
  const omitted = routes.length - listed.length;
  return omitted > 0 ? [...lines, `- (${omitted} more apps on this deployment are not listed here; they appear when a request names them)`] : lines;
}

/**
 * @description The ASSISTANT CATALOG block for one turn over the effective routes.
 * @param routes - The effective routes, in deployment order.
 * @param ask - The user's words this turn ('' for none).
 * @returns The block, or '' when there are no routes.
 */
export function renderCatalogBlock(routes: AppRoute[], ask = ''): string {
  if (!routes.length) return '';
  return [...CATALOG_HEADER, ...catalogLines(routes, ask)].join('\n');
}
