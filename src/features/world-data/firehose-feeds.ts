/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — configurable publisher FIREHOSE feeds. Pulled ONCE per pulse (not per-name); each item is entity-tagged and fanned to the names it mentions. O(feeds) requests feed all 100 names = the "fluent" path that doesn't rate-limit. Fully env-configurable.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Update docs/ paths after docs directory consolidation
 */

/**
 * Publisher FIREHOSE feeds for the trading signal layer.
 *
 * Two complementary ingestion shapes:
 *  - PER-NAME SEARCH (feed-sources.ts): one query per ticker per source — precise, but O(names × terms ×
 *    feeds) requests, which is request-heavy and brushes rate limits.
 *  - FIREHOSE (this file): pull each publisher's latest-articles RSS ONCE, classify + entity-extract every
 *    item, and attach it to whatever `world:ticker:*` / `world:org:*` entities it mentions (+ a market
 *    bucket). O(feeds) requests — ~12 pulls feed ALL names at once. No per-name hammering = "fluent".
 *
 * EVERYTHING here is configurable via env so the operator curates without a code change:
 *   WORLD_FIREHOSE_ENABLED        on/off              (default on)
 *   WORLD_FIREHOSE_FEEDS          replace the list    ("id|Name|url ; id2|Name2|url2"  OR  "url,url,url")
 *   WORLD_FIREHOSE_LIMIT          items per feed      (default 30)
 *   WORLD_FIREHOSE_EVERY_N_PULSES run every Nth pulse (default 1 = every 5-min pulse)
 *
 * Dead/blocked feeds are self-healing: the per-source circuit-breaker (news-fetcher) trips a feed that
 * 429s/503s and skips it for a cooldown, so a bad URL never stalls the run.
 */

export interface FirehoseFeed {
  /** Stable id (also the circuit-breaker key). */
  id: string;
  /** Publisher name (the outlet; matched against outlet-ratings for bias when known). */
  name: string;
  /** The fixed latest-articles RSS/Atom URL (no query). */
  url: string;
}

/** Curated default finance/macro firehoses — free, keyless RSS, pulled wide to COLLECT AS MUCH AS POSSIBLE.
 *  Dead/blocked endpoints self-heal (per-source circuit-breaker), so over-including costs nothing. Override
 *  the whole set via WORLD_FIREHOSE_FEEDS. */
const DEFAULT_FIREHOSE: ReadonlyArray<FirehoseFeed> = [
  // ── Aggregators / wires ──────────────────────────────────────────────────
  { id: 'fh-yahoo-finance', name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { id: 'fh-investing', name: 'Investing.com', url: 'https://www.investing.com/rss/news_25.rss' },
  { id: 'fh-investing-econ', name: 'Investing.com', url: 'https://www.investing.com/rss/news_95.rss' },
  { id: 'fh-investing-stocks', name: 'Investing.com', url: 'https://www.investing.com/rss/news_285.rss' },
  // ── CNBC sections ────────────────────────────────────────────────────────
  { id: 'fh-cnbc-top', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { id: 'fh-cnbc-markets', name: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { id: 'fh-cnbc-finance', name: 'CNBC', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { id: 'fh-cnbc-economy', name: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { id: 'fh-cnbc-earnings', name: 'CNBC', url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html' },
  { id: 'fh-cnbc-tech', name: 'CNBC', url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html' },
  // ── WSJ sections ─────────────────────────────────────────────────────────
  { id: 'fh-wsj-markets', name: 'The Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml' },
  { id: 'fh-wsj-business', name: 'The Wall Street Journal', url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml' },
  { id: 'fh-wsj-tech', name: 'The Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSWSJD.xml' },
  { id: 'fh-wsj-world', name: 'The Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' },
  // ── MarketWatch sections ─────────────────────────────────────────────────
  { id: 'fh-marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { id: 'fh-marketwatch-rt', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { id: 'fh-marketwatch-pulse', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse' },
  // ── Other publishers ─────────────────────────────────────────────────────
  { id: 'fh-foxbusiness', name: 'Fox Business', url: 'https://moxie.foxbusiness.com/google-publisher/markets.xml' },
  { id: 'fh-seekingalpha', name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml' },
  { id: 'fh-businessinsider', name: 'Business Insider', url: 'https://markets.businessinsider.com/rss/news' },
  { id: 'fh-zerohedge', name: 'ZeroHedge', url: 'https://feeds.feedburner.com/zerohedge/feed' },
  { id: 'fh-nyt-business', name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
  { id: 'fh-nyt-economy', name: 'The New York Times', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml' },
  { id: 'fh-guardian-business', name: 'The Guardian', url: 'https://www.theguardian.com/uk/business/rss' },
  { id: 'fh-bbc-business', name: 'BBC', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { id: 'fh-thestreet', name: 'TheStreet', url: 'https://www.thestreet.com/.rss/full/' },
  // ── Catalyst + macro firehoses (authoritative non-news signals) ───────────
  { id: 'fh-sec-8k', name: 'SEC EDGAR', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom' },
  { id: 'fh-sec-all', name: 'SEC EDGAR', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=&output=atom' },
  { id: 'fh-fed-press', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { id: 'fh-bls', name: 'Bureau of Labor Statistics', url: 'https://www.bls.gov/feed/bls_latest.rss' },
];

const offish = (v: string | undefined): boolean => {
  const s = (v ?? '').trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off' || s === 'no';
};

/** @description Whether the firehose pass runs at all (default on). */
export function firehoseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !offish(env.WORLD_FIREHOSE_ENABLED);
}

/** @description Items pulled per firehose feed (default 40 — speed read is free, so collect wide). */
export function firehoseLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORLD_FIREHOSE_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : 40;
}

/** @description Run the firehose every Nth pulse (default 1 = every pulse). Lets the operator throttle. */
export function firehoseEveryNPulses(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORLD_FIREHOSE_EVERY_N_PULSES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** SPEED READ vs DEEP DIVE — two tiers (docs/apps/trading/signal-dataset.md):
 *  - speed read: cheap, every pulse, ALL feeds. Fetch + lexicon-classify + quick entity match (no LLM).
 *    Catches volume + breaking news + the attention/novelty features instantly.
 *  - deep dive: the expensive Claude classify (real sentiment + entities + event tags), run on a METERED
 *    budget of the freshest un-deepened items, allocated across feeds by a learned novelty signal. */

/** Whether the deep-dive (LLM) tier runs at all (default on). Off → speed-read-only (free, no LLM). */
export function deepDiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !offish(env.WORLD_DEEPDIVE_ENABLED);
}

/** Total items the deep dive may LLM-classify per pulse (the metered budget). Default 60. */
export function deepDiveBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORLD_DEEPDIVE_BUDGET);
  return Number.isFinite(n) && n > 0 ? Math.min(400, Math.floor(n)) : 60;
}

/** Whether the deep-dive budget is metered dynamically by feed novelty (default on) vs split evenly. */
export function deepDiveMetered(env: NodeJS.ProcessEnv = process.env): boolean {
  return !offish(env.WORLD_DEEPDIVE_METER);
}

/** Per-feed wall-clock budget (ms) for the speed read — ISOLATES a slow/hanging feed so it can't eat the
 *  whole pass; the feed is abandoned and the rest continue. Default 45s. Override WORLD_FEED_BUDGET_MS. */
export function feedBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORLD_FEED_BUDGET_MS);
  return Number.isFinite(n) && n >= 5000 ? Math.floor(n) : 45_000;
}

const slugFromUrl = (u: string): string => {
  try { return new URL(u).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40); }
  catch { return 'fh-custom'; }
};
const hostFromUrl = (u: string): string => {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
};

/**
 * @description The active firehose feed list. Defaults to the curated set; WORLD_FIREHOSE_FEEDS REPLACES it.
 * Accepts either pipe triples ("id|Name|url") separated by ; or newlines, or a bare comma/space list of URLs
 * (id + name derived from the host). This is how the operator drops in their own researched feed list.
 */
export function firehoseFeeds(env: NodeJS.ProcessEnv = process.env): FirehoseFeed[] {
  const raw = (env.WORLD_FIREHOSE_FEEDS ?? '').trim();
  if (!raw) return [...DEFAULT_FIREHOSE];
  const parts = raw.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  const out: FirehoseFeed[] = [];
  for (const part of parts) {
    if (part.includes('|')) {
      const [id, name, url] = part.split('|').map((s) => s.trim());
      if (url && /^https?:/i.test(url)) out.push({ id: id || slugFromUrl(url), name: name || hostFromUrl(url), url });
    } else {
      // bare URL(s) — may be comma/space separated within this segment
      for (const u of part.split(/[, ]+/).map((s) => s.trim()).filter(Boolean)) {
        if (/^https?:/i.test(u)) out.push({ id: slugFromUrl(u), name: hostFromUrl(u), url: u });
      }
    }
  }
  return out.length ? out : [...DEFAULT_FIREHOSE];
}
