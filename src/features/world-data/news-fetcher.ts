/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Layer B: news fetcher — Bing RSS -> outlet -> sentiment -> world
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Multi-source feed registry + REAL sentiment via swarm Claude creds (CLI provider, batched)
 */

/**
 * Feed fetcher (the beefed-up news-aggregator's engine). Pulls any query-driven RSS feed from the
 * registry (Google/Bing News, Reddit, HN, Federal Register, ClinicalTrials, Blawg, …), maps each item
 * to its source + CLASSIFICATION, scores sentiment for news/social via the SWARM's Claude creds
 * (ClaudeCodeCliProvider → host OAuth, the same creds every bot runs on — NOT a one-shot key), and
 * ingests per-item world contributions. News items carry outlet bias; non-news carry their category
 * as an authoritative signal (a Federal Register hit is policy, not sentiment).
 */
import { XMLParser } from 'fast-xml-parser';
import { createChildLogger } from '@/shared/logger';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { ClaudeCodeCliProvider } from '@/features/llm-provider/services/claude-code-cli-provider';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import { CodexHarnessProvider } from '@/features/llm-provider/services/codex-cli-provider';
import { ratingByName, slugifyOutlet, leanBucket } from './outlet-ratings';
import { feedSource, feedPlan, tickerFeedPlan, DEFAULT_FEED_IDS, type FeedSource } from './feed-sources';
import { type FirehoseFeed } from './firehose-feeds';
import { meterFeeds } from './firehose-meter';
import { symbolForName, TICKER_COMPANY_NAMES } from './ticker-names';
import { itemHash, slugifyEntity, pubIso, lexicon } from './feed-util';
import { isRealNewsHeadline } from '@/shared/utils/headline-noise';
import type { WorldContribution } from './world-types';
import type { WorldIntelligenceService } from './world-intelligence-service';

const logger = createChildLogger({ module: 'news-fetcher' });
const CLASSIFIER_MODEL = process.env.WORLD_SENTIMENT_MODEL || 'claude-haiku-4-5-20251001';
// Bump when the analyze prompt/schema changes — backtests compare against the version that produced the record.
const CLASSIFIER_VERSION = 'world-analyze-v2';
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });

/** A classify backend — both the Claude CLI and the Codex CLI expose this same shape. */
interface ClassifyProvider { name: string; complete(prompt: string, systemPrompt?: string): Promise<{ text: string }>; }

const claudeProvider = new ClaudeCodeCliProvider({ model: CLASSIFIER_MODEL });
const codexProvider = new CodexHarnessProvider({
  model: process.env.WORLD_CLASSIFY_CODEX_MODEL || undefined,
  timeoutMs: Math.max(30_000, Number(process.env.WORLD_CLASSIFY_CODEX_TIMEOUT_MS) || 120_000),
});

/** Classify backends to SPREAD the deep-dive load over (default both Claude + Codex → ~2× throughput and
 *  no single-provider bottleneck). Chunks round-robin across these; a provider that errors degrades only
 *  its chunk (lexicon fallback). Configure with WORLD_CLASSIFY_PROVIDERS (e.g. "claude" or "codex,claude"). */
const CLASSIFY_PROVIDERS: ClassifyProvider[] = (() => {
  const byName: Record<string, ClassifyProvider> = {
    claude: { name: 'claude', complete: (p, s) => claudeProvider.complete(p, s) },
    codex: { name: 'codex', complete: (p, s) => codexProvider.complete(p, s) },
  };
  const want = (process.env.WORLD_CLASSIFY_PROVIDERS || 'claude,codex').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = want.map((w) => byName[w]).filter(Boolean);
  return out.length ? out : [byName.claude];
})();

export interface FeedItem { title: string; description: string; outlet: string; link: string; pubDate: string; }
// Pure helpers (itemHash, slugifyEntity, pubIso, lexicon) live in ./feed-util so they unit-test without
// importing this module (which instantiates the Claude provider at load). Re-export the ones callers use.
export { slugifyEntity } from './feed-util';

const txt = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') { const o = v as Record<string, unknown>; return String(o['#text'] ?? o.name ?? ''); }
  return String(v);
};
const asArr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Per-request feed fetch timeout (ms). A hanging feed endpoint must NOT block the refresh loop —
 *  without this a single stuck URL stalls the whole run (it has no other timeout). */
const FEED_FETCH_TIMEOUT_MS = 12_000;

/** Circuit-breaker: when a source rate-limits us (429/503), stop hitting it for a cooldown instead of
 *  hammering it every pulse. Reddit hard-limits its .rss endpoint and was returning a 429 STORM (dozens/
 *  min × 3 variants × every subject) — wasted work that also amplified the scheduler stall. One open
 *  circuit per source id; healthy sources are unaffected. Override the cooldown via FEED_COOLDOWN_MS. */
const FEED_COOLDOWN_MS = Math.max(60_000, Number(process.env.FEED_COOLDOWN_MS) || 15 * 60_000);
const circuitOpenUntil = new Map<string, number>();

/** Default feed-fetch User-Agent — identifies the puller to publishers (site + contact, per SEC EDGAR's
 *  fair-access policy which wants a contact, not just a URL). Override via WORLD_FEED_UA. Reddit overrides
 *  this with its own required format (per-source userAgent). */
const DEFAULT_FEED_UA = process.env.WORLD_FEED_UA
  || 'Mozilla/5.0 (compatible; OSHAL-feeds/1.0; +https://agenticfederal.us; maintainer@emeraldcoastsystemsgroup.com)';

/** How many query-variant requests to fetch concurrently within one source. The finance ticker plan
 *  fans a name out across ~7 variants per engine; fetching them in parallel (bounded) is what turns the
 *  broadened search criteria into real throughput instead of a slow sequential crawl. */
const FETCH_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `n` in flight at once, preserving input order in the result. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Fetch + parse a specific feed URL (one query variant). Handles both RSS 2.0 and Atom. */
async function fetchFeedUrl(src: FeedSource, url: string, limit = 15): Promise<FeedItem[]> {
  // Circuit open (recently rate-limited)? Skip the network entirely until the cooldown elapses.
  const openUntil = circuitOpenUntil.get(src.id) || 0;
  if (Date.now() < openUntil) throw new Error(`${src.id} rate-limited — circuit open ${Math.ceil((openUntil - Date.now()) / 60_000)}m`);
  // Reddit (and a few others) 403 a generic/Mozilla UA; they want a descriptive one. Per-source override.
  const ua = src.userAgent ?? DEFAULT_FEED_UA;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);
  let body: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: controller.signal,
    });
    // Rate-limited / overloaded → open the circuit so we stop hammering this source for a while.
    if (res.status === 429 || res.status === 503) {
      circuitOpenUntil.set(src.id, Date.now() + FEED_COOLDOWN_MS);
      throw new Error(`${src.id} ${res.status} — circuit opened ${Math.round(FEED_COOLDOWN_MS / 60_000)}m`);
    }
    if (!res.ok) throw new Error(`${src.id} ${res.status}`);
    body = await res.text();
    circuitOpenUntil.delete(src.id); // success → ensure the circuit is closed
  } finally {
    clearTimeout(timer);
  }
  const doc = parser.parse(body) as Record<string, unknown>;
  const channel = (doc?.rss as { channel?: { item?: unknown } } | undefined)?.channel;
  const feed = doc?.feed as { entry?: unknown } | undefined;
  const raw = asArr<Record<string, unknown>>((channel?.item ?? feed?.entry) as Record<string, unknown> | Record<string, unknown>[] | undefined);
  return raw.slice(0, limit).map((it) => {
    const outlet = src.outletField === 'none'
      ? src.name
      : txt(it[src.outletField] ?? it.Source ?? it.source ?? it.author) || src.name;
    return {
      title: txt(it.title),
      description: txt(it.description ?? it.summary ?? it.content),
      outlet,
      link: txt(it.link),
      pubDate: txt(it.pubDate ?? it.updated ?? it.published),
    };
  });
}

/** Fetch + parse a registry feed for a query (single base query — back-compat). */
export async function fetchFeed(src: FeedSource, query: string, limit = 15): Promise<FeedItem[]> {
  return fetchFeedUrl(src, src.url(query), limit);
}

/** Entity types we keep — anything else Claude returns is dropped (keeps the graph typed + clean). */
const ENTITY_TYPES = new Set(['person', 'org', 'team', 'place', 'ticker', 'product']);

/** Catalyst event types (trading signal dataset §2 `event_*`). The KIND of news that moves a name —
 *  far stronger signal than a raw sentiment number ("earnings + positive shift + high novelty"). */
const EVENT_TYPES = new Set(['earnings', 'guidance', 'ma', 'rating', 'legal_reg', 'product', 'exec', 'macro', 'supply']);

export interface ItemAnalysis {
  s: number | null;
  entities: Array<{ name: string; type: string }>;
  /** Dominant catalyst type + intensity 0..1 (null = not a concrete catalyst). */
  event: { type: string; intensity: number } | null;
}

/** Sub-batch size for one Claude classify call + how many sub-batches run concurrently. Small chunks =
 *  each call is fast (won't hit the 120s timeout) and a slow/failed chunk only loses ITS items (failure
 *  isolation), not the whole feed. Concurrency kept low to bound memory (concurrent CLI spawns). */
const CLASSIFY_CHUNK = Math.max(4, Number(process.env.WORLD_CLASSIFY_CHUNK) || 10);
const CLASSIFY_CONCURRENCY = Math.max(1, Number(process.env.WORLD_CLASSIFY_CONCURRENCY) || 2);
/** Cost kill-switch: WORLD_CLASSIFY_DISABLED=true → skip the LLM entirely; classification falls back to
 *  the free lexicon (sentiment only, no entities/events). All non-LLM signals (mentions, novelty, congress,
 *  insider, short, gov, calendar) keep working. The instant "stop the token burn" lever. */
const CLASSIFY_DISABLED = ['1', 'true', 'on', 'yes'].includes((process.env.WORLD_CLASSIFY_DISABLED || '').trim().toLowerCase());

/**
 * Classify items (sentiment + entities + catalyst) in CHUNKED, bounded-concurrency sub-batches. A failed
 * or timed-out chunk degrades only its own items (empty → lexicon fallback) — the rest still classify.
 */
/** GLOBAL round-robin cursor — advances per chunk across ALL analyzeBatch calls (every feed, every pulse),
 *  so small single-chunk feeds still alternate Codex/Claude instead of all landing on provider[0]. */
let providerCursor = 0;

async function analyzeBatch(items: FeedItem[], subject: string): Promise<ItemAnalysis[]> {
  const providers = CLASSIFY_PROVIDERS;
  if (!items.length) return [];
  // Cost kill-switch / no providers → lexicon-only (no LLM spend).
  if (CLASSIFY_DISABLED || providers.length === 0) return items.map(() => ({ s: null, entities: [], event: null }));
  if (items.length <= CLASSIFY_CHUNK && providers.length === 1) return analyzeChunk(items, subject, providers[0]);
  const chunks: FeedItem[][] = [];
  for (let i = 0; i < items.length; i += CLASSIFY_CHUNK) chunks.push(items.slice(i, i + CLASSIFY_CHUNK));
  // Round-robin chunks across providers (Codex + Claude) via the GLOBAL cursor; run enough in parallel to
  // keep both busy.
  const conc = Math.max(CLASSIFY_CONCURRENCY, providers.length);
  const results = await mapPool(chunks, conc, (c) => analyzeChunk(c, subject, providers[(providerCursor++) % providers.length]));
  return results.flat();
}

/**
 * ONE Claude call (swarm host-OAuth creds) that does THREE jobs: sentiment toward the subject, the notable
 * named entities, AND the dominant CATALYST type (the §2 event_* signal). Folding all into one call = no
 * extra LLM cost over the sentiment pass. Returns per-item {s, entities[], event}.
 */
async function analyzeChunk(items: FeedItem[], subject: string, provider: ClassifyProvider): Promise<ItemAnalysis[]> {
  const empty = (): ItemAnalysis => ({ s: null, entities: [], event: null });
  if (!items.length) return [];
  const list = items.map((it, i) => `${i}. ${`${it.title}. ${it.description}`.slice(0, 240)}`).join('\n');
  const sys =
    'For each item return (a) sentiment toward the subject from -1.0 (very negative) to +1.0 (very positive), '
    + '(b) the notable named entities it mentions — real people, organizations, teams, places, stock tickers, products '
    + '(type one of: person, org, team, place, ticker, product; skip generic terms; max 6 per item), '
    + 'and (c) the dominant CATALYST the item reports + its intensity 0..1 (1 = major hard event, e.g. an actual '
    + 'earnings beat/miss or signed deal; lower = passing mention). Catalyst types: earnings, guidance, ma (M&A), '
    + 'rating (analyst upgrade/downgrade/price target), legal_reg (lawsuit/regulatory/investigation), product '
    + '(launch/recall/approval), exec (leadership change), macro (rates/inflation/jobs/Fed), supply (disaster/supply shock). '
    + 'Use null for "ev" when the item is not about a concrete catalyst. '
    + 'Return ONLY a JSON array of {"i":<index>,"s":<number>,"e":[{"n":"<name>","t":"<type>"}],"ev":{"t":"<catalyst>","i":<0..1>}}, no prose.';
  try {
    const r = await provider.complete(`Subject: ${subject}\nItems:\n${list}`, sys);
    const m = r.text.match(/\[[\s\S]*\]/);
    if (!m) return items.map(empty);
    const rows = JSON.parse(m[0]) as Array<{ i: number; s: number; e?: Array<{ n: string; t: string }>; ev?: { t?: string; i?: number } | null }>;
    const out: ItemAnalysis[] = items.map(empty);
    for (const row of rows) {
      const i = row.i;
      if (i < 0 || i >= out.length) continue;
      if (Number.isFinite(row.s)) out[i].s = Math.max(-1, Math.min(1, row.s));
      for (const ent of row.e ?? []) {
        const type = String(ent?.t || '').toLowerCase().trim();
        const name = String(ent?.n || '').trim();
        if (name && ENTITY_TYPES.has(type) && slugifyEntity(name)) out[i].entities.push({ name, type });
      }
      const evType = String(row.ev?.t || '').toLowerCase().trim();
      const evInten = Number(row.ev?.i);
      if (EVENT_TYPES.has(evType) && Number.isFinite(evInten) && evInten > 0) {
        out[i].event = { type: evType, intensity: Math.max(0, Math.min(1, evInten)) };
      }
    }
    return out;
  } catch (err) {
    logger.warn({ err, provider: provider.name }, 'batch analyze failed — sentiment falls back to lexicon, no entities/events');
    return items.map(empty);
  }
}

export interface FeedIngestResult {
  perSource: Array<{
    source: string; category?: string; error?: string;
    variants?: number; fetched?: number; unique?: number; newItems?: number; ingested: number;
  }>;
  usedLlm: boolean;
}

/**
 * Pull each requested feed for `query`, classify, score (news/social), and ingest per-item world
 * contributions tagged with the source + category. News → outlet bias; non-news → category signal.
 */
export async function ingestFeeds(
  svc: WorldIntelligenceService,
  query: string,
  entityId: string,
  entityLabel: string,
  sourceIds: string[] = DEFAULT_FEED_IDS,
  opts: { limit?: number; light?: boolean; ticker?: { symbol: string; name: string; lean?: boolean } } = {},
): Promise<FeedIngestResult> {
  const sources = sourceIds.map(feedSource).filter((s): s is FeedSource => Boolean(s));
  const now = new Date().toISOString();
  const perSource: FeedIngestResult['perSource'] = [];
  let usedLlm = false;

  const subjectSlug = slugifyEntity(entityLabel);

  for (const src of sources) {
    // 1) Run the query PLAN — every variant is its own RSS request; track per-variant fetched counts.
    //    - `ticker` mode (trading universe): fan the name out across the finance-angle plan / Yahoo symbol
    //      feed (feed-sources.tickerFeedPlan) — broad finance coverage per monitored name.
    //    - `light` mode: one base request per source so a BROAD topic set completes inside the window.
    //    - otherwise: the source's full plan (deep cross-spectrum bias-balanced read for curated topics).
    const plan = opts.ticker
      ? tickerFeedPlan(src, opts.ticker.symbol, opts.ticker.name, query, opts.ticker.lean)
      : opts.light ? [{ label: 'base', url: src.url(query) }] : feedPlan(src, query);
    // Fetch the plan's variants concurrently (bounded) — turns the wider search criteria into throughput.
    const fetchedVariants = await mapPool(plan, FETCH_CONCURRENCY, async (v) => {
      try {
        const got = await fetchFeedUrl(src, v.url, opts.limit ?? 15);
        return { label: v.label, items: got };
      } catch (err) {
        // A "circuit open" skip is the rate-limit breaker working as designed (Reddit 429 storm),
        // not a real fetch failure — log it at debug so it doesn't flood the journal every pulse.
        const msg = (err as Error)?.message ?? '';
        if (msg.includes('circuit open')) {
          logger.debug({ err, src: src.id, variant: v.label }, 'feed variant skipped — circuit open (rate-limited)');
        } else {
          logger.warn({ err, src: src.id, variant: v.label }, 'feed variant fetch failed');
        }
        return { label: v.label, items: [] as FeedItem[] };
      }
    });
    const variantStats: Array<{ label: string; fetched: number }> = fetchedVariants.map((v) => ({ label: v.label, fetched: v.items.length }));
    const pulled: Array<{ item: FeedItem; variant: string }> = [];
    for (const v of fetchedVariants) for (const item of v.items) pulled.push({ item, variant: v.label });
    const fetched = pulled.length;
    if (!fetched) {
      perSource.push({ source: src.id, category: src.category, variants: plan.length, fetched: 0, ingested: 0, error: 'no items (all variants empty/failed)' });
      continue;
    }

    // 2) Dedup within this source's pull by content hash (keep the first variant that surfaced it).
    const uniq = new Map<string, { item: FeedItem; variant: string }>();
    for (const p of pulled) { const h = itemHash(entityId, p.item); if (!uniq.has(h)) uniq.set(h, p); }
    const unique = [...uniq.entries()]; // [hash, {item, variant}]

    // 3) Skip items we've already archived — only NEW items get classified (no wasted LLM on re-pulls).
    const seen = await svc.existingHashes(unique.map(([h]) => h));
    const fresh = unique.filter(([h]) => !seen.has(h));
    const reSeen = unique.filter(([h]) => seen.has(h)).map(([h]) => h);
    if (reSeen.length) await svc.touchItems(reSeen);

    // 4) Classify the FRESH set once (sentiment + entities). News/social/finance carry sentiment;
    //    regulatory/legal/medical/web are authoritative category signals, not sentiment.
    const scored = src.category === 'news' || src.category === 'social' || src.category === 'finance';
    const freshItems = fresh.map(([, p]) => p.item);
    const analysis: ItemAnalysis[] = scored ? await analyzeBatch(freshItems, entityLabel) : freshItems.map(() => ({ s: null, entities: [], event: null }));

    let ingested = 0, newItems = 0, classified = 0, srcUsedLlm = false;
    for (let i = 0; i < fresh.length; i += 1) {
      const [hash, { item: it, variant }] = fresh[i];
      let sourceId: string;
      let sourceType: string;
      let sourceProps: Record<string, unknown>;
      const rating = src.category === 'news' ? ratingByName(it.outlet) : undefined;
      if (src.category === 'news') {
        sourceId = rating?.id ?? `world:outlet:${slugifyOutlet(it.outlet)}`;
        sourceType = 'outlet';
        sourceProps = rating
          ? { lean: rating.lean, reliability: rating.reliability, biasBucket: leanBucket(rating.lean), category: src.category }
          : { unrated: true, category: src.category };
      } else {
        sourceId = `world:source:${src.id}`;
        sourceType = 'source';
        sourceProps = { category: src.category, authority: true, name: src.name };
      }

      const llmScore = analysis[i].s;
      const score = llmScore ?? (scored ? lexicon(`${it.title}. ${it.description}`) : 1);
      if (llmScore != null) { usedLlm = true; srcUsedLlm = true; }
      if (scored) classified += 1;
      const pub = pubIso(it.pubDate);
      const at = pub ?? now;

      // Extracted entities → real world nodes, co-mentioned with the subject, mentioned-in the source,
      // plus a per-entity `mentions` series. Dedup within the item; never re-add the subject itself.
      const extra = new Map<string, { name: string; type: string }>();
      for (const ent of analysis[i].entities) {
        const slug = slugifyEntity(ent.name);
        if (!slug || slug === subjectSlug) continue;
        extra.set(`world:${ent.type}:${slug}`, ent);
      }
      const headline = it.title.slice(0, 200);

      const contribution: WorldContribution = {
        source: sourceId,
        ingestedAt: now,
        entities: [
          { id: entityId, type: 'company', label: entityLabel, props: {} },
          { id: sourceId, type: sourceType, label: it.outlet, props: sourceProps },
          ...[...extra].map(([id, ent]) => ({ id, type: ent.type, label: ent.name, props: {} })),
        ],
        edges: [
          {
            type: src.category === 'news' ? 'covered_by' : 'mentioned_in',
            from: entityId, to: sourceId, props: { headline, category: src.category, variant },
          },
          ...[...extra.keys()].flatMap((id) => [
            { type: 'co_mentioned_with', from: entityId, to: id, props: { headline, source: sourceId, category: src.category } },
            { type: 'mentioned_in', from: id, to: sourceId, props: { headline, category: src.category } },
          ]),
        ],
        facts: [
          { entity: entityId, metric: scored ? 'sentiment' : `${src.category}_mention`, value: scored ? score : 1, at },
          // ADR-096 / 2026-07-14: the STRAINED sentiment series. `sentiment` above counts EVERY headline —
          // including the reactive commentary the 07-14 wire-ceiling study proved is journalism ABOUT a move
          // ("What's Going On With Intel Stock Friday?", "…And Other Big Movers"), not information. Those
          // items were ~2/3 of the apparent pre-surge "signal". `sentiment_clean` counts only headlines that
          // pass the proven noise prefilter, so the trading sentiment gate can consume real news instead of
          // reaction sentiment. Written in PARALLEL — the baseline series is untouched, so the two are A/B'd.
          ...(scored && isRealNewsHeadline(it.title) ? [{ entity: entityId, metric: 'sentiment_clean', value: score, at }] : []),
          ...[...extra.keys()].map((id) => ({ entity: id, metric: 'mentions', value: 1, at })),
        ],
      };
      // 4) Archive FIRST (dedup by content hash). Only write to the graph + series for genuinely NEW
      //    items — re-pulls must not double-count the append-only sentiment series.
      const { inserted } = await svc.archiveItem({
        itemHash: hash, entityId, entityLabel,
        feedId: src.id, category: src.category, queryVariant: variant,
        outlet: it.outlet, outletId: sourceType === 'outlet' ? sourceId : null,
        lean: rating?.lean ?? null, reliability: rating?.reliability ?? null,
        title: it.title, description: it.description, link: it.link, pubDate: pub,
        sentiment: scored ? score : null, entities: analysis[i].entities,
        eventType: analysis[i].event?.type ?? null, eventIntensity: analysis[i].event?.intensity ?? null,
        classifierModel: CLASSIFIER_MODEL, classifierVersion: CLASSIFIER_VERSION, usedLlm: llmScore != null,
      });
      if (inserted) { await svc.ingest(contribution); newItems += 1; ingested += 1; }
    }

    // 5) Record the pull so pull-rate (fetched vs unique vs new) is measurable over time.
    await svc.logPull({
      entityId, feedId: src.id, category: src.category,
      fetched, uniqueItems: unique.length, newItems, classified, usedLlm: srcUsedLlm, variants: variantStats,
    });
    perSource.push({ source: src.id, category: src.category, variants: plan.length, fetched, unique: unique.length, newItems, ingested });
  }

  return { perSource, usedLlm };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIREHOSE ingestion — the "fluent" path. Pull each publisher feed ONCE (not per name), classify +
// entity-extract each NEW item, and fan it out to every world entity it mentions (+ a market bucket).
// O(feeds) requests feed ALL names; dedup means steady-state only classifies genuinely-new articles.
// ─────────────────────────────────────────────────────────────────────────────

/** The catch-all entity every firehose item attaches to (general market sentiment + the dedup key). */
const MARKET_BUCKET = { id: 'world:market:us', type: 'market', label: 'US Market' };

/** Resolve an item's extracted entities to the world entities it should attach to. Tickers map directly;
 *  orgs/products map to a universe ticker when their name matches, else a generic org node. Bounded per item. */
function resolveFirehoseTargets(entities: Array<{ name: string; type: string }>): Array<{ id: string; type: string; label: string }> {
  const out = new Map<string, { id: string; type: string; label: string }>();
  for (const e of entities) {
    const name = String(e.name || '').trim();
    if (!name) continue;
    if (e.type === 'ticker') {
      const sym = name.toUpperCase().replace(/[^A-Z.]/g, '');
      if (sym.length >= 1 && sym.length <= 5) out.set(`world:ticker:${sym.toLowerCase()}`, { id: `world:ticker:${sym.toLowerCase()}`, type: 'company', label: sym });
    } else if (e.type === 'org' || e.type === 'product') {
      const sym = symbolForName(name);
      if (sym) out.set(`world:ticker:${sym.toLowerCase()}`, { id: `world:ticker:${sym.toLowerCase()}`, type: 'company', label: sym });
      else { const slug = slugifyEntity(name); if (slug) out.set(`world:org:${slug}`, { id: `world:org:${slug}`, type: 'org', label: name }); }
    }
    if (out.size >= 8) break;
  }
  return [...out.values()];
}

export interface FirehoseResult {
  perFeed: Array<{ feed: string; fetched: number; fresh: number; attached: number; error?: string }>;
  usedLlm: boolean;
}

/** Reject after `ms` so one slow/hanging feed can't eat the whole pass — the feed is abandoned and the
 *  rest continue (long-run isolation). The detached work settles on its own. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e as Error); });
  });
}

/** CHEAP entity match (no LLM) for the speed read: universe company-name mentions + $TICKER cashtags. */
function quickEntities(it: FeedItem): Array<{ name: string; type: string }> {
  const hay = `${it.title} ${it.description}`;
  const lower = hay.toLowerCase();
  const out = new Map<string, { name: string; type: string }>();
  for (const [sym, name] of Object.entries(TICKER_COMPANY_NAMES)) {
    if (name.length >= 3 && lower.includes(name.toLowerCase())) out.set(sym, { name: sym, type: 'ticker' });
  }
  for (const m of hay.match(/\$[A-Za-z]{1,5}\b/g) || []) { const s = m.slice(1).toUpperCase(); out.set(s, { name: s, type: 'ticker' }); }
  return [...out.values()].slice(0, 8);
}

/**
 * SPEED READ — tier 1. Pull every publisher feed ONCE (per-feed isolated + time-boxed), and for each NEW
 * article: lexicon sentiment + a CHEAP entity match (no LLM), archived against the market bucket + matched
 * tickers. Fast + free → captures volume, attention (mention_count/novelty), and breaking news instantly.
 * Items land `used_llm=false` (classifierVersion `speed-read`) = the deep-dive work queue. No series facts
 * here — the deep dive writes the authoritative sentiment once (no double-counting).
 * @param svc - World-intelligence service.
 * @param feeds - Operator-configurable firehose feeds.
 * @param opts - limit (items/feed), feedBudgetMs (per-feed wall-clock isolation).
 */
export async function speedReadFirehose(
  svc: WorldIntelligenceService,
  feeds: FirehoseFeed[],
  opts: { limit?: number; feedBudgetMs?: number } = {},
): Promise<FirehoseResult> {
  const now = new Date().toISOString();
  const perFeed: FirehoseResult['perFeed'] = [];
  const budgetMs = opts.feedBudgetMs ?? 45_000;

  for (const feed of feeds) {
    const src: FeedSource = { id: feed.id, name: feed.name, category: 'finance', outletField: 'none', url: () => feed.url };
    try {
      const result = await withTimeout((async () => {
        const items = await fetchFeedUrl(src, feed.url, opts.limit ?? 30);
        if (!items.length) return { fetched: 0, fresh: 0, attached: 0 };
        const withHash = items.map((it) => ({ it, h: itemHash(MARKET_BUCKET.id, it) }));
        const seen = await svc.existingHashes(withHash.map((x) => x.h));
        const fresh = withHash.filter((x) => !seen.has(x.h));
        const reseen = withHash.filter((x) => seen.has(x.h)).map((x) => x.h);
        if (reseen.length) await svc.touchItems(reseen);
        const rating = ratingByName(feed.name);
        let attached = 0;
        for (const { it } of fresh) {
          const score = lexicon(`${it.title}. ${it.description}`);
          const pub = pubIso(it.pubDate);
          const targets = [MARKET_BUCKET, ...resolveFirehoseTargets(quickEntities(it))];
          const done = new Set<string>();
          for (const tgt of targets) {
            if (done.has(tgt.id)) continue;
            done.add(tgt.id);
            await svc.archiveItem({
              itemHash: itemHash(tgt.id, it), entityId: tgt.id, entityLabel: tgt.label,
              feedId: feed.id, category: 'finance', queryVariant: 'firehose',
              outlet: feed.name, outletId: rating?.id ?? null, lean: rating?.lean ?? null, reliability: rating?.reliability ?? null,
              title: it.title, description: it.description, link: it.link, pubDate: pub,
              sentiment: score, entities: [],
              eventType: null, eventIntensity: null,
              classifierModel: 'lexicon', classifierVersion: 'speed-read', usedLlm: false,
            });
            attached += 1;
          }
        }
        await svc.logPull({ entityId: MARKET_BUCKET.id, feedId: feed.id, category: 'finance', fetched: items.length, uniqueItems: withHash.length, newItems: fresh.length, classified: 0, usedLlm: false, variants: [{ label: 'speed-read', fetched: items.length }] });
        return { fetched: items.length, fresh: fresh.length, attached };
      })(), budgetMs, `speed-read ${feed.id}`);
      perFeed.push({ feed: feed.id, ...result });
    } catch (err) {
      logger.warn({ err, feed: feed.id }, 'speed-read feed failed');
      perFeed.push({ feed: feed.id, fetched: 0, fresh: 0, attached: 0, error: (err as Error).message });
    }
  }
  return { perFeed, usedLlm: false };
}

export interface DeepDiveResult {
  perFeed: Array<{ feed: string; budget: number; deepened: number }>;
  deepened: number;
}

/**
 * DEEP DIVE — tier 2. Spend the (expensive, finite) LLM classify budget on the freshest un-deepened
 * speed-read items, the budget allocated across feeds by a learned novelty signal (firehose-meter). For each
 * item: real sentiment + entities + catalyst → upgrade the market row (markDeepened) and write the
 * AUTHORITATIVE sentiment fact for the market bucket + every entity it names (one series write per item).
 * @param svc - World-intelligence service.
 * @param feeds - The firehose feeds (defines the meter's feed set).
 * @param opts - budget (total items/pulse), metered, noveltyHours.
 */
export async function deepDiveFirehose(
  svc: WorldIntelligenceService,
  feeds: FirehoseFeed[],
  opts: { budget?: number; metered?: boolean; noveltyHours?: number } = {},
): Promise<DeepDiveResult> {
  const now = new Date().toISOString();
  const budget = opts.budget ?? 60;
  const novelty = await svc.pullNoveltyByFeed(MARKET_BUCKET.id, opts.noveltyHours ?? 24).catch(() => new Map());
  const limits = meterFeeds(feeds.map((f) => f.id), novelty, { budget, metered: opts.metered });
  const perFeed: DeepDiveResult['perFeed'] = [];
  let deepened = 0;

  for (const feed of feeds) {
    const slot = limits.get(feed.id) ?? 0;
    try {
      const queue = await svc.recentUndeepened(MARKET_BUCKET.id, feed.id, slot);
      if (!queue.length) { perFeed.push({ feed: feed.id, budget: slot, deepened: 0 }); continue; }
      const feedItems: FeedItem[] = queue.map((q) => ({ title: q.title, description: q.description, outlet: q.outlet, link: q.link, pubDate: q.pubDate || '' }));
      const analysis = await analyzeBatch(feedItems, 'the U.S. stock market and the companies and tickers mentioned');
      const rating = ratingByName(feed.name);
      const sourceId = rating?.id ?? `world:outlet:${slugifyOutlet(feed.name)}`;
      const sourceProps = rating
        ? { lean: rating.lean, reliability: rating.reliability, biasBucket: leanBucket(rating.lean), category: 'finance' }
        : { unrated: true, category: 'finance', name: feed.name };

      for (let i = 0; i < queue.length; i += 1) {
        const q = queue[i];
        const a = analysis[i];
        const score = a.s ?? lexicon(`${q.title}. ${q.description}`);
        const at = q.pubDate ?? now;
        // Upgrade the market row out of the work queue, recording the deep classification.
        await svc.markDeepened(q.itemHash, {
          sentiment: score, eventType: a.event?.type ?? null, eventIntensity: a.event?.intensity ?? null,
          entities: a.entities, classifierModel: CLASSIFIER_MODEL, classifierVersion: CLASSIFIER_VERSION,
        });
        const targets = [MARKET_BUCKET, ...resolveFirehoseTargets(a.entities)];
        const headline = q.title.slice(0, 200);
        // Archive deep per-entity rows (so mention_count reflects the names the deep read found).
        for (const tgt of targets) {
          if (tgt.id === MARKET_BUCKET.id) continue;
          await svc.archiveItem({
            itemHash: itemHash(tgt.id, feedItems[i]), entityId: tgt.id, entityLabel: tgt.label,
            feedId: feed.id, category: 'finance', queryVariant: 'firehose-deep',
            outlet: q.outlet, outletId: rating?.id ?? null, lean: rating?.lean ?? null, reliability: rating?.reliability ?? null,
            title: q.title, description: q.description, link: q.link, pubDate: q.pubDate,
            sentiment: score, entities: a.entities,
            eventType: a.event?.type ?? null, eventIntensity: a.event?.intensity ?? null,
            classifierModel: CLASSIFIER_MODEL, classifierVersion: CLASSIFIER_VERSION, usedLlm: a.s != null,
          });
        }
        // One contribution: the authoritative sentiment fact for every target + the co-mention graph.
        await svc.ingest({
          source: sourceId, ingestedAt: now,
          entities: [
            ...targets.map((t) => ({ id: t.id, type: t.type, label: t.label, props: {} })),
            { id: sourceId, type: 'outlet', label: q.outlet, props: sourceProps },
          ],
          edges: targets.map((t) => ({ type: 'covered_by', from: t.id, to: sourceId, props: { headline, category: 'finance', variant: 'firehose' } })),
          facts: targets.map((t) => ({ entity: t.id, metric: 'sentiment', value: score, at })),
        });
        deepened += 1;
      }
      perFeed.push({ feed: feed.id, budget: slot, deepened: queue.length });
    } catch (err) {
      logger.warn({ err, feed: feed.id }, 'deep-dive feed failed');
      perFeed.push({ feed: feed.id, budget: slot, deepened: 0 });
    }
  }
  return { perFeed, deepened };
}

/**
 * BACKTEST: replay archived items for an entity through the CURRENT classifier and compare to what we
 * originally recorded. Answers "are our classifications any good / have they drifted?" — read-only, it
 * scores nothing into the graph. Reports mean absolute sentiment drift, directional agreement (did the
 * sign hold?), and entity-extraction stability (are we still tagging the same entities?).
 */
export interface BacktestResult {
  entity: string; days: number; sampled: number; rescored: number;
  meanAbsDrift: number | null; directionalAgreement: number | null; entityStability: number | null;
  driftedModel: boolean; examples: Array<{ title: string; was: number | null; now: number | null; drift: number | null }>;
}

export async function backtest(
  svc: WorldIntelligenceService,
  entity: string,
  days = 30,
  opts: { limit?: number } = {},
): Promise<BacktestResult> {
  const items = await svc.archivedItems(entity, days, opts.limit ?? 40);
  if (!items.length) {
    return { entity, days, sampled: 0, rescored: 0, meanAbsDrift: null, directionalAgreement: null, entityStability: null, driftedModel: false, examples: [] };
  }
  const label = items[0].entityLabel || entity;
  const feedItems: FeedItem[] = items.map((it) => ({ title: it.title, description: it.description, outlet: it.outlet, link: '', pubDate: it.pubDate || '' }));
  const fresh = await analyzeBatch(feedItems, label);

  let driftSum = 0, driftN = 0, agree = 0, agreeN = 0, stabSum = 0, stabN = 0;
  const examples: BacktestResult['examples'] = [];
  for (let i = 0; i < items.length; i += 1) {
    const was = items[i].sentiment;
    const now = fresh[i].s;
    if (was != null && now != null) {
      const drift = Math.abs(now - was);
      driftSum += drift; driftN += 1;
      agreeN += 1; if (Math.sign(now) === Math.sign(was)) agree += 1;
      if (examples.length < 8) examples.push({ title: items[i].title.slice(0, 90), was, now, drift: Number(drift.toFixed(3)) });
    }
    // Entity stability: fraction of originally-tagged entities the current model still extracts.
    const oldSet = new Set(items[i].entities.map((e) => slugifyEntity(e.name)).filter(Boolean));
    if (oldSet.size) {
      const newSet = new Set(fresh[i].entities.map((e) => slugifyEntity(e.name)).filter(Boolean));
      let hit = 0; for (const s of oldSet) if (newSet.has(s)) hit += 1;
      stabSum += hit / oldSet.size; stabN += 1;
    }
  }
  const driftedModel = items.some((it) => it.classifierVersion !== CLASSIFIER_VERSION || it.classifierModel !== CLASSIFIER_MODEL);
  return {
    entity, days, sampled: items.length, rescored: driftN,
    meanAbsDrift: driftN ? Number((driftSum / driftN).toFixed(3)) : null,
    directionalAgreement: agreeN ? Number((agree / agreeN).toFixed(3)) : null,
    entityStability: stabN ? Number((stabSum / stabN).toFixed(3)) : null,
    driftedModel, examples,
  };
}
