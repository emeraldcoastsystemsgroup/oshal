/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Layer B: query-driven RSS feed registry (news/social/legal/regulatory/medical/web)
 */

/**
 * Feed registry. Every entry is a FREE, KEYLESS, query-driven RSS feed — drop in a search term, get a
 * feed back. The point (the operator's): feeds carry CLASSIFICATIONS. A regulatory hit (Federal Register) and
 * a news sentiment and a litigation signal (Blawg) and a clinical trial mean very different things —
 * so each source has a `category` the world layer keeps, and the reasoner weighs them differently.
 *
 * `outletField` tells the parser where the per-item publisher lives (news feeds) — for non-news feeds
 * the FEED itself is the authoritative source (Federal Register, ClinicalTrials), so there's no outlet.
 */

import { CROSS_SPECTRUM_OUTLETS } from './outlet-ratings';

export type FeedCategory = 'news' | 'social' | 'legal' | 'regulatory' | 'medical' | 'web' | 'finance';

/** One concrete RSS request: a labelled URL. A subject expands into several of these (the query plan). */
export interface QueryVariant { label: string; url: string; }

export interface FeedSource {
  id: string;
  name: string;
  category: FeedCategory;
  /** Build the base feed URL for a query. */
  url: (q: string) => string;
  /**
   * Optional query PLAN: expand one subject into several targeted RSS requests (recency windows,
   * cross-spectrum `site:` filters, angle terms). When absent the source gets a single `base` variant.
   * The point (the operator's): how you search Google decides how much — and how balanced — you get back.
   */
  plan?: (q: string) => QueryVariant[];
  /** Optional SYMBOL-scoped URL for per-ticker feeds (Yahoo Finance). Used by the finance ticker plan
   *  in place of the free-text `url(q)` when a stock symbol is the natural key. */
  symbolUrl?: (sym: string) => string;
  /** Per-item field holding the publisher (news). 'none' = the feed itself is the source. */
  outletField: 'Source' | 'source' | 'author' | 'none';
  /** Optional UA override — Reddit 403s anything that looks like a default scraper. */
  userAgent?: string;
}

const e = encodeURIComponent;

/** Generic cross-spectrum expansion: for an engine whose `q=` honors the `site:` operator (Google News,
 *  Bing News), pull the SAME subject filtered to one outlet per lean bucket — so the bias-aware read gets
 *  balanced material by construction, not whatever the default ranking surfaces. `buildUrl` takes the
 *  full query string (subject + operators) and returns the feed URL. */
function siteVariants(buildUrl: (qq: string) => string, q: string): QueryVariant[] {
  return CROSS_SPECTRUM_OUTLETS
    .filter((o) => o.domain)
    .map((o) => ({ label: `site:${o.domain}`, url: buildUrl(`${q} site:${o.domain}`) }));
}

// Google News honors a real query language inside `q=`: recency (`when:`), `site:` filters, phrases.
const googleNewsUrl = (q: string): string => `https://news.google.com/rss/search?q=${e(q)}&hl=en-US&gl=US&ceid=US:en`;
function googleNewsPlan(q: string): QueryVariant[] {
  return [
    { label: 'base', url: googleNewsUrl(q) },
    { label: 'recent-7d', url: googleNewsUrl(`${q} when:7d`) },
    ...siteVariants(googleNewsUrl, q),
  ];
}

// Bing News also honors `site:` in its query; recency is a URL param (qft interval) rather than an operator.
const bingNewsUrl = (q: string): string => `https://www.bing.com/news/search?format=RSS&q=${e(q)}`;
function bingNewsPlan(q: string): QueryVariant[] {
  return [
    { label: 'base', url: bingNewsUrl(q) },
    { label: 'recent', url: `${bingNewsUrl(q)}&qft=interval%3d%227%22` },
    ...siteVariants(bingNewsUrl, q),
  ];
}

// Reddit (one community, not a spectrum): broaden by SORT + window instead of cross-spectrum site filters.
const redditUrl = (q: string, sort: string, t?: string): string =>
  `https://www.reddit.com/search.rss?sort=${sort}${t ? `&t=${t}` : ''}&q=${e(q)}`;
function redditPlan(q: string): QueryVariant[] {
  return [
    { label: 'new', url: redditUrl(q, 'new') },
    { label: 'relevance', url: redditUrl(q, 'relevance') },
    { label: 'top-week', url: redditUrl(q, 'top', 'week') },
  ];
}

// Hacker News full-text search (Algolia-backed) — used for the bare-query base + a ticker plan below.
const hnUrl = (q: string): string => `https://hnrss.org/newest?q=${e(q)}`;

// Yahoo Finance per-symbol headline RSS — keyless, ticker-scoped, finance-dense. The single best free
// per-name finance feed for the trading universe; it keys on the SYMBOL, not free text.
const yahooFinanceUrl = (sym: string): string =>
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${e(String(sym).toUpperCase())}&region=US&lang=en-US`;

export const FEED_SOURCES: ReadonlyArray<FeedSource> = [
  { id: 'google-news',      name: 'Google News',         category: 'news',       outletField: 'source', url: googleNewsUrl, plan: googleNewsPlan },
  { id: 'bing-news',        name: 'Bing News',           category: 'news',       outletField: 'Source', url: bingNewsUrl, plan: bingNewsPlan },
  { id: 'yahoo-finance',    name: 'Yahoo Finance',       category: 'finance',    outletField: 'source', url: (q) => yahooFinanceUrl(q), symbolUrl: yahooFinanceUrl },
  { id: 'reddit',           name: 'Reddit',              category: 'social',     outletField: 'author', userAgent: 'web:oshal-feeds:1.0 (by /u/oshal-swarm)', url: (q) => redditUrl(q, 'new'), plan: redditPlan },
  { id: 'hackernews',       name: 'Hacker News',         category: 'social',     outletField: 'none',   url: hnUrl },
  { id: 'federal-register', name: 'US Federal Register', category: 'regulatory', outletField: 'none',   url: (q) => `https://www.federalregister.gov/api/v1/documents.rss?conditions%5Bterm%5D=${e(q)}` },
  { id: 'epa',              name: 'EPA',                 category: 'regulatory', outletField: 'none',   url: (q) => `https://www.epa.gov/newsreleases/search/rss?search_api_views_fulltext=${e(q)}` },
  { id: 'clinicaltrials',   name: 'ClinicalTrials.gov',  category: 'medical',    outletField: 'none',   url: (q) => `https://clinicaltrials.gov/ct2/results/rss.xml?term=${e(q)}&count=50` },
  { id: 'blawg',            name: 'Blawg Search',        category: 'legal',      outletField: 'none',   url: (q) => `https://blawgsearch.justia.com/rss/search?mode=rss&l=20&s=0&query=${e(q)}` },
  { id: 'bing-web',         name: 'Bing Web',            category: 'web',        outletField: 'none',   url: (q) => `https://www.bing.com/search?format=RSS&q=${e(q)}` },
  { id: 'wordpress',        name: 'WordPress',           category: 'web',        outletField: 'none',   url: (q) => `https://en.search.wordpress.com/?f=feed&q=${e(q)}` },
  { id: 'archive',          name: 'Internet Archive',    category: 'web',        outletField: 'none',   url: (q) => `https://archive.org/services/collection-rss.php?query=description:${e(q)}` },
];

const BY_ID = new Map(FEED_SOURCES.map((f) => [f.id, f]));
export function feedSource(id: string): FeedSource | undefined { return BY_ID.get(id); }

/** The query plan for a source: its `plan()` if defined, else a single `base` variant. */
export function feedPlan(src: FeedSource, q: string): QueryVariant[] {
  return src.plan ? src.plan(q) : [{ label: 'base', url: src.url(q) }];
}

/** Default sources used when none are specified (the news pair — where the bias read applies). */
export const DEFAULT_FEED_IDS = ['google-news', 'bing-news'];

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE (per-ticker) coverage — for the trading universe. The generic news plan balances POLITICAL
// bias (left/center/right `site:` filters); a STOCK doesn't need that — it needs topical breadth. So the
// finance plan fans a ticker out across the angles that actually move a name (earnings, analyst actions,
// corporate actions, catalysts) searched by COMPANY NAME, not "<SYM> stock". This is the "expand the
// search criteria" lever: ~7 variants/engine × the finance feed set = hundreds of items per name per run.
// ─────────────────────────────────────────────────────────────────────────────

/** The finance angles a name is searched across — keyed on the company NAME (high recall), plus the bare
 *  ticker (catches symbol-tagged chatter the name misses). `name` is the press name; `sym` the ticker. */
function financeAngles(name: string, sym: string): Array<{ label: string; q: string }> {
  const n = `"${name}"`;
  return [
    { label: 'headline', q: `${n} stock` },
    { label: 'earnings', q: `${n} (earnings OR revenue OR guidance OR outlook OR forecast)` },
    { label: 'analyst', q: `${n} (analyst OR "price target" OR upgrade OR downgrade OR rating OR initiated)` },
    { label: 'corporate', q: `${n} (SEC OR lawsuit OR investigation OR merger OR acquisition OR CEO OR layoffs)` },
    { label: 'catalyst', q: `${n} (product OR launch OR contract OR deal OR partnership OR recall OR approval)` },
    { label: 'ticker', q: `${sym} stock` },
  ];
}

/** Google News finance plan: every angle + a tight recency window (`when:2d`). */
function googleFinancePlan(name: string, sym: string): QueryVariant[] {
  return [
    ...financeAngles(name, sym).map((a) => ({ label: a.label, url: googleNewsUrl(a.q) })),
    { label: 'recent-2d', url: googleNewsUrl(`"${name}" when:2d`) },
  ];
}

/** Bing News finance plan: every angle + a 7-day recency interval. */
function bingFinancePlan(name: string, sym: string): QueryVariant[] {
  return [
    ...financeAngles(name, sym).map((a) => ({ label: a.label, url: bingNewsUrl(a.q) })),
    { label: 'recent', url: `${bingNewsUrl(`"${name}" stock`)}&qft=interval%3d%227%22` },
  ];
}

/** Reddit finance plan: ticker + name across new + top-of-week (where retail chatter lives). */
function redditFinancePlan(name: string, sym: string): QueryVariant[] {
  const q = `${sym} OR "${name}"`;
  return [
    { label: 'new', url: redditUrl(q, 'new') },
    { label: 'top-week', url: redditUrl(q, 'top', 'week') },
  ];
}

/** The LEAN per-ticker plan — one freshest, highest-signal request per source. Used by the every-5-min
 *  market-hours pulse so 100 names complete well inside the 5-min window; the full plan (below) runs on
 *  the slower 6h depth refresh. Yahoo symbol headline + Google 2-day recency + Reddit-new. */
function leanTickerPlan(src: FeedSource, sym: string, name: string): QueryVariant[] | null {
  if (src.symbolUrl) return [{ label: 'symbol', url: src.symbolUrl(sym) }];
  switch (src.id) {
    case 'google-news': return [{ label: 'recent-2d', url: googleNewsUrl(`"${name}" when:2d`) }];
    case 'bing-news':  return [{ label: 'recent', url: `${bingNewsUrl(`"${name}" stock`)}&qft=interval%3d%227%22` }];
    case 'reddit':     return [{ label: 'new', url: redditUrl(`${sym} OR "${name}"`, 'new') }];
    case 'hackernews': return [{ label: 'ticker', url: hnUrl(sym) }];
    default:           return null;
  }
}

/**
 * @description The per-ticker query plan for a source: Yahoo keys on the symbol; news/social engines fan
 * out across the finance angles (by company name); anything else gets its bare base query. This is what
 * a ticker subject pulls in place of the political-bias news plan.
 * @param src - The feed source.
 * @param sym - Ticker symbol.
 * @param name - Company press name (used to search; falls back to the symbol).
 * @param fallbackQuery - The subject's free-text query, used for sources without finance handling.
 * @param lean - Pull only the freshest high-signal variants (the market-hours pulse) vs the full fan-out.
 * @returns The list of concrete RSS requests to pull for this name from this source.
 */
export function tickerFeedPlan(src: FeedSource, sym: string, name: string, fallbackQuery: string, lean = false): QueryVariant[] {
  if (lean) { const p = leanTickerPlan(src, sym, name); if (p) return p; }
  if (src.symbolUrl) return [{ label: 'symbol', url: src.symbolUrl(sym) }];
  switch (src.id) {
    case 'google-news': return googleFinancePlan(name, sym);
    case 'bing-news':   return bingFinancePlan(name, sym);
    case 'reddit':      return redditFinancePlan(name, sym);
    case 'hackernews':  return [{ label: 'name', url: hnUrl(name) }, { label: 'ticker', url: hnUrl(sym) }];
    default:            return [{ label: 'base', url: src.url(fallbackQuery) }];
  }
}

/** Feed set a ticker subject pulls on the DEPTH refresh: Yahoo per-symbol headlines + the finance-angle
 *  news engines + social. Far broader than DEFAULT_FEED_IDS (the news pair) so the 100 monitored names
 *  get real coverage. */
export const FINANCE_FEED_IDS = ['yahoo-finance', 'google-news', 'bing-news', 'reddit', 'hackernews'];

/** Feed set the every-5-min PULSE pulls — the three freshest, fastest finance sources (with the lean
 *  one-request plan), so the whole universe refreshes inside the 5-min window. Bing/HN stay on the
 *  6h depth refresh. */
export const PULSE_FEED_IDS = ['yahoo-finance', 'google-news'];
