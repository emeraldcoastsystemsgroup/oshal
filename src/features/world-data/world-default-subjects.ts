/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — canonical default coverage set (general/world-news topics) the 6-hourly refresh always pulls, so coverage isn't limited to whatever was ad-hoc seeded.
 */

/**
 * Canonical default coverage for the shared world-intelligence layer.
 *
 * The 6-hourly refresh used to re-pull only the subjects that happened to be tracked already (a narrow
 * build-time seed of a few AI/Fed subjects). This is the intended, broad baseline coverage the refresh
 * ALWAYS ensures: general + world-news + macro topics. The stock universe is added at refresh time
 * (app layer) from the shared trading universe. Edit here to change topic coverage.
 *
 * `deep: true` → pull with the full cross-spectrum bias-balanced plan (left/center/right outlet variants);
 * everything else uses the light base pull so the whole broad set completes inside the 6h window.
 */

import { tickerName } from './ticker-names';

export interface WorldSubject {
  /** Canonical world entity id (`world:<type>:<key>`). */
  entity: string;
  /** Display label. */
  label: string;
  /** Search query driven into the registered feeds. */
  query: string;
  /** Pull with the full cross-spectrum bias-balanced plan (vs the light base pull). */
  deep?: boolean;
  /** Stock symbol — set for ticker subjects; triggers the finance feed set + per-ticker query plan. */
  symbol?: string;
  /** Company press name (ticker subjects) — what the finance plan actually searches on. */
  name?: string;
}

/** General + world-news + macro topics — the always-on baseline. A handful are `deep` (bias-balanced). */
export const DEFAULT_WORLD_TOPICS: ReadonlyArray<WorldSubject> = [
  { entity: 'world:topic:world-news', label: 'World News', query: 'world news', deep: true },
  { entity: 'world:topic:us-economy', label: 'US Economy', query: 'US economy', deep: true },
  { entity: 'world:topic:stock-market', label: 'Stock Market', query: 'stock market', deep: true },
  { entity: 'world:topic:federal-reserve', label: 'Federal Reserve', query: 'Federal Reserve interest rates', deep: true },
  { entity: 'world:topic:artificial-intelligence', label: 'Artificial Intelligence', query: 'artificial intelligence', deep: true },
  { entity: 'world:topic:geopolitics', label: 'Geopolitics', query: 'geopolitics international relations' },
  { entity: 'world:topic:technology', label: 'Technology', query: 'technology industry' },
  { entity: 'world:topic:energy-oil', label: 'Energy & Oil', query: 'energy oil prices' },
  { entity: 'world:topic:inflation', label: 'Inflation', query: 'inflation consumer prices' },
  { entity: 'world:topic:labor-market', label: 'Jobs & Labor', query: 'labor market jobs unemployment' },
  { entity: 'world:topic:housing', label: 'Housing Market', query: 'housing market real estate' },
  { entity: 'world:topic:crypto', label: 'Cryptocurrency', query: 'cryptocurrency bitcoin' },
  { entity: 'world:topic:healthcare', label: 'Healthcare', query: 'healthcare industry' },
  { entity: 'world:topic:policy-regulation', label: 'Policy & Regulation', query: 'US policy regulation' },
  { entity: 'world:topic:earnings', label: 'Corporate Earnings', query: 'company earnings results' },
];

/** Build a per-ticker stock subject. Carries the symbol + company press name so the refresh pulls the
 *  finance feed set (Yahoo per-symbol + finance-angle news/social) keyed on the NAME, not "<SYM> stock". */
export function tickerSubject(symbol: string): WorldSubject {
  const sym = String(symbol || '').trim().toUpperCase();
  const name = tickerName(sym);
  return {
    entity: `world:ticker:${sym.toLowerCase()}`,
    label: sym,
    query: `"${name}" stock`,
    symbol: sym,
    name,
  };
}
