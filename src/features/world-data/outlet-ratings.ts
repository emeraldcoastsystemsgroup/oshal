/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Layer B: rated news outlets — bias + reliability so sentiment means something
 */

/**
 * Rated news outlets. The whole point: sentiment from a feed is meaningless without the feed's BIAS.
 * "Fox negative + CNN positive" tells you nothing — both are being themselves. So every outlet carries
 * a political lean (-1 left .. +1 right) and a reliability score, and the reader reads sentiment
 * THROUGH these (bias-balanced aggregate, cross-spectrum consensus, outlet deviation).
 *
 * IMPORTANT (ADR-057 provenance/bias guardrail): these seed numbers are ILLUSTRATIVE placeholders in
 * the AllSides / Ad Fontes Media shape. Before this is used for anything load-bearing, replace them
 * with the real, licensed/cited datasets and keep `provenance`. Wrong-but-confident bias ratings are a
 * liability, not a moat.
 */

import type { WorldContribution } from './world-types';

export type LeanBucket = 'left' | 'center' | 'right';
export type EconBucket = 'pro-labor' | 'neutral' | 'pro-market';
/** What KIND of outlet — so the reader can weigh "the financial press vs the wires vs partisan media". */
export type OutletKind = 'wire' | 'mainstream' | 'broadcast' | 'financial' | 'tech' | 'partisan';

export interface OutletRating {
  id: string;          // world:outlet:<slug>
  name: string;
  kind: OutletKind;    // classification axis: what type of outlet this is
  lean: number;        // POLITICAL axis: -1 (left) .. 0 (center) .. +1 (right)
  econLean: number;    // ECONOMIC axis: -1 (pro-labor / regulation / market-skeptic) .. +1 (pro-business / pro-market)
  reliability: number; // 0 (unreliable) .. 1 (high factual reliability)
  provenance: string;  // source of the rating (replace seed with AllSides/Ad Fontes)
  domain?: string;     // canonical domain — used for Google News `site:` cross-spectrum queries
}

const P = 'AllSides/Ad Fontes shape — SEED placeholder, verify before use';

/** Seed set — a spread across BOTH axes (political lean + econ framing) and kinds so the aggregates are
 *  meaningful. econLean: -1 pro-labor/regulation/market-skeptic .. +1 pro-business/pro-market. */
export const OUTLET_RATINGS: ReadonlyArray<OutletRating> = [
  // Wires — the neutral spine on both axes.
  { id: 'world:outlet:ap',         name: 'Associated Press', kind: 'wire',       lean:  0.00, econLean:  0.00, reliability: 0.95, provenance: P, domain: 'apnews.com' },
  { id: 'world:outlet:reuters',    name: 'Reuters',          kind: 'wire',       lean:  0.00, econLean:  0.05, reliability: 0.95, provenance: P, domain: 'reuters.com' },
  // Mainstream / broadcast.
  { id: 'world:outlet:bbc',        name: 'BBC',              kind: 'mainstream', lean: -0.15, econLean: -0.10, reliability: 0.90, provenance: P, domain: 'bbc.com' },
  { id: 'world:outlet:npr',        name: 'NPR',              kind: 'mainstream', lean: -0.25, econLean: -0.20, reliability: 0.85, provenance: P, domain: 'npr.org' },
  { id: 'world:outlet:nyt',        name: 'New York Times',   kind: 'mainstream', lean: -0.40, econLean: -0.20, reliability: 0.82, provenance: P, domain: 'nytimes.com' },
  { id: 'world:outlet:wapo',       name: 'Washington Post',  kind: 'mainstream', lean: -0.40, econLean: -0.20, reliability: 0.82, provenance: P, domain: 'washingtonpost.com' },
  { id: 'world:outlet:guardian',   name: 'The Guardian',     kind: 'mainstream', lean: -0.45, econLean: -0.50, reliability: 0.80, provenance: P, domain: 'theguardian.com' },
  { id: 'world:outlet:cnn',        name: 'CNN',              kind: 'broadcast',  lean: -0.55, econLean: -0.20, reliability: 0.72, provenance: P, domain: 'cnn.com' },
  { id: 'world:outlet:abc',        name: 'ABC News',         kind: 'broadcast',  lean: -0.35, econLean: -0.15, reliability: 0.80, provenance: P, domain: 'abcnews.go.com' },
  { id: 'world:outlet:cbs',        name: 'CBS News',         kind: 'broadcast',  lean: -0.35, econLean: -0.15, reliability: 0.80, provenance: P, domain: 'cbsnews.com' },
  { id: 'world:outlet:nbc',        name: 'NBC News',         kind: 'broadcast',  lean: -0.45, econLean: -0.20, reliability: 0.78, provenance: P, domain: 'nbcnews.com' },
  { id: 'world:outlet:pbs',        name: 'PBS',              kind: 'broadcast',  lean: -0.30, econLean: -0.15, reliability: 0.85, provenance: P, domain: 'pbs.org' },
  { id: 'world:outlet:politico',   name: 'Politico',         kind: 'mainstream', lean: -0.30, econLean: -0.10, reliability: 0.80, provenance: P, domain: 'politico.com' },
  { id: 'world:outlet:thehill',    name: 'The Hill',         kind: 'mainstream', lean: -0.05, econLean:  0.00, reliability: 0.78, provenance: P, domain: 'thehill.com' },
  { id: 'world:outlet:axios',      name: 'Axios',            kind: 'mainstream', lean: -0.15, econLean:  0.00, reliability: 0.82, provenance: P, domain: 'axios.com' },
  // Partisan.
  { id: 'world:outlet:msnbc',      name: 'MSNBC',            kind: 'partisan',   lean: -0.70, econLean: -0.40, reliability: 0.62, provenance: P, domain: 'msnbc.com' },
  { id: 'world:outlet:foxnews',    name: 'Fox News',         kind: 'partisan',   lean:  0.65, econLean:  0.40, reliability: 0.60, provenance: P, domain: 'foxnews.com' },
  { id: 'world:outlet:nypost',     name: 'New York Post',    kind: 'partisan',   lean:  0.55, econLean:  0.30, reliability: 0.62, provenance: P, domain: 'nypost.com' },
  { id: 'world:outlet:newsmax',    name: 'Newsmax',          kind: 'partisan',   lean:  0.85, econLean:  0.40, reliability: 0.40, provenance: P, domain: 'newsmax.com' },
  { id: 'world:outlet:breitbart',  name: 'Breitbart',        kind: 'partisan',   lean:  0.90, econLean:  0.35, reliability: 0.35, provenance: P, domain: 'breitbart.com' },
  // Financial press — politically near-center but a real ECON-axis spread (the gap this axis fills).
  { id: 'world:outlet:wsj',        name: 'Wall St Journal',  kind: 'financial',  lean:  0.20, econLean:  0.50, reliability: 0.88, provenance: P, domain: 'wsj.com' },
  { id: 'world:outlet:bloomberg',  name: 'Bloomberg',        kind: 'financial',  lean:  0.00, econLean:  0.25, reliability: 0.88, provenance: P, domain: 'bloomberg.com' },
  { id: 'world:outlet:cnbc',       name: 'CNBC',             kind: 'financial',  lean:  0.05, econLean:  0.35, reliability: 0.80, provenance: P, domain: 'cnbc.com' },
  { id: 'world:outlet:ft',         name: 'Financial Times',  kind: 'financial',  lean:  0.00, econLean:  0.15, reliability: 0.90, provenance: P, domain: 'ft.com' },
  { id: 'world:outlet:economist',  name: 'The Economist',    kind: 'financial',  lean:  0.05, econLean:  0.30, reliability: 0.88, provenance: P, domain: 'economist.com' },
  { id: 'world:outlet:barrons',    name: "Barron's",         kind: 'financial',  lean:  0.10, econLean:  0.45, reliability: 0.85, provenance: P, domain: 'barrons.com' },
  { id: 'world:outlet:marketwatch',name: 'MarketWatch',      kind: 'financial',  lean:  0.00, econLean:  0.25, reliability: 0.80, provenance: P, domain: 'marketwatch.com' },
  { id: 'world:outlet:morningstar',name: 'Morningstar',      kind: 'financial',  lean:  0.00, econLean:  0.15, reliability: 0.85, provenance: P, domain: 'morningstar.com' },
  { id: 'world:outlet:ibd',        name: "Investor's Business Daily", kind: 'financial', lean: 0.40, econLean: 0.60, reliability: 0.78, provenance: P, domain: 'investors.com' },
  { id: 'world:outlet:forbes',     name: 'Forbes',           kind: 'financial',  lean:  0.10, econLean:  0.40, reliability: 0.75, provenance: P, domain: 'forbes.com' },
  { id: 'world:outlet:yahoo-finance', name: 'Yahoo Finance', kind: 'financial',  lean:  0.00, econLean:  0.15, reliability: 0.75, provenance: P, domain: 'finance.yahoo.com' },
  { id: 'world:outlet:business-insider', name: 'Business Insider', kind: 'financial', lean: -0.20, econLean: 0.05, reliability: 0.72, provenance: P, domain: 'businessinsider.com' },
  { id: 'world:outlet:seeking-alpha', name: 'Seeking Alpha', kind: 'financial',  lean:  0.10, econLean:  0.25, reliability: 0.68, provenance: P, domain: 'seekingalpha.com' },
  // Tech press.
  { id: 'world:outlet:techcrunch', name: 'TechCrunch',       kind: 'tech',       lean: -0.05, econLean:  0.10, reliability: 0.75, provenance: P, domain: 'techcrunch.com' },
  { id: 'world:outlet:verge',      name: 'The Verge',        kind: 'tech',       lean: -0.25, econLean: -0.10, reliability: 0.78, provenance: P, domain: 'theverge.com' },
  { id: 'world:outlet:arstechnica',name: 'Ars Technica',     kind: 'tech',       lean: -0.10, econLean:  0.00, reliability: 0.85, provenance: P, domain: 'arstechnica.com' },
  { id: 'world:outlet:wired',      name: 'Wired',            kind: 'tech',       lean: -0.20, econLean: -0.10, reliability: 0.80, provenance: P, domain: 'wired.com' },
];

/** Name aliases → canonical outlet id, for source strings that don't substring-match the formal name
 *  (e.g. Google News emits "AP News" / "WSJ", not "Associated Press" / "Wall St Journal"). */
const ALIASES: Record<string, string> = {
  'ap news': 'world:outlet:ap', 'ap': 'world:outlet:ap', 'the associated press': 'world:outlet:ap',
  'wsj': 'world:outlet:wsj', 'the wall street journal': 'world:outlet:wsj', 'wall street journal': 'world:outlet:wsj',
  'the new york times': 'world:outlet:nyt', 'ny times': 'world:outlet:nyt',
  'the washington post': 'world:outlet:wapo', 'washington post': 'world:outlet:wapo',
  'fox': 'world:outlet:foxnews', 'fox business': 'world:outlet:foxnews',
  'the guardian': 'world:outlet:guardian', 'guardian': 'world:outlet:guardian',
  'nbc': 'world:outlet:nbc', 'cbs': 'world:outlet:cbs', 'abc': 'world:outlet:abc',
  // Financial press short names Google News emits.
  'ft': 'world:outlet:ft', 'financial times': 'world:outlet:ft',
  'barron\'s': 'world:outlet:barrons', 'barrons': 'world:outlet:barrons',
  'ibd': 'world:outlet:ibd', "investor's business daily": 'world:outlet:ibd',
  'the economist': 'world:outlet:economist',
  'yahoo': 'world:outlet:yahoo-finance', 'yahoo! finance': 'world:outlet:yahoo-finance',
  'insider': 'world:outlet:business-insider',
};

/**
 * A representative spread for cross-spectrum query expansion: pull the SAME subject filtered to one or
 * two outlets per lean bucket, so the bias-aware read gets balanced input by construction instead of
 * whatever the default ranking happens to surface. Reliable + recognizable domains, both poles covered.
 */
export const CROSS_SPECTRUM_OUTLETS: ReadonlyArray<OutletRating> = OUTLET_RATINGS.filter((o) =>
  ['world:outlet:cnn', 'world:outlet:nyt', 'world:outlet:reuters', 'world:outlet:ap', 'world:outlet:wsj', 'world:outlet:foxnews'].includes(o.id),
);

const BY_ID = new Map(OUTLET_RATINGS.map((o) => [o.id, o]));

/** Lookup an outlet's rating by its world id (e.g. world:outlet:foxnews). */
export function ratingOf(outletId: string): OutletRating | undefined {
  return BY_ID.get(outletId);
}

/** Map a Bing <News:Source> name (e.g. "Fox News", "CNBC", "MUO on MSN") to a rating, if it's one we
 *  rate. Tolerant: exact, then substring either way (Bing appends "… on MSN" etc.). undefined = unrated. */
export function ratingByName(name: string): OutletRating | undefined {
  const n = (name || '').toLowerCase().trim();
  if (!n) return undefined;
  const head = n.split(' on ')[0].trim();
  // 1) Exact alias hit (handles Google News short names like "AP News", "WSJ").
  const aliased = ALIASES[n] ?? ALIASES[head];
  if (aliased) return BY_ID.get(aliased);
  // 2) Formal-name match: exact, then substring either way (Bing appends "… on MSN" etc.).
  return OUTLET_RATINGS.find((o) => {
    const m = o.name.toLowerCase();
    return m === n || m === head || n.includes(m) || m.includes(head);
  });
}

/** Stable world:outlet slug for an unrated source name. */
export function slugifyOutlet(name: string): string {
  return ((name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) || 'unknown';
}

/** Bucket a lean number into left / center / right for the spread aggregate. */
export function leanBucket(lean: number): LeanBucket {
  if (lean <= -0.3) return 'left';
  if (lean >= 0.3) return 'right';
  return 'center';
}

/** Bucket an econLean into pro-labor / neutral / pro-market (the second classification axis). */
export function econBucket(econLean: number): EconBucket {
  if (econLean <= -0.2) return 'pro-labor';
  if (econLean >= 0.2) return 'pro-market';
  return 'neutral';
}

/**
 * A finance-tilted cross-spectrum set for query expansion on BUSINESS/MARKET subjects: spans the econ
 * axis (skeptic → pro-market) and the major financial press, so a finance read gets balanced econ input
 * the way the political set balances the political read. Use for finance topics; political set otherwise.
 */
export const CROSS_SPECTRUM_FINANCE: ReadonlyArray<OutletRating> = OUTLET_RATINGS.filter((o) =>
  ['world:outlet:reuters', 'world:outlet:bloomberg', 'world:outlet:wsj', 'world:outlet:ft', 'world:outlet:cnbc', 'world:outlet:marketwatch'].includes(o.id),
);

/**
 * Build the WorldContribution that seeds the outlets into the world graph: an outlet node per rating,
 * a `leans` edge to its bias bucket node, with reliability carried on the node. Idempotent (canonical
 * ids). This is what makes the bias available to the reasoner and the bias-aware sentiment read.
 */
export function buildOutletSeedContribution(now: string): WorldContribution {
  const buckets: LeanBucket[] = ['left', 'center', 'right'];
  const kinds: OutletKind[] = ['wire', 'mainstream', 'broadcast', 'financial', 'tech', 'partisan'];
  return {
    source: 'outlet-ratings-seed',
    ingestedAt: now,
    entities: [
      ...buckets.map((b) => ({ id: `world:bias:${b}`, type: 'bias', label: b, props: {} })),
      ...kinds.map((k) => ({ id: `world:outlet-kind:${k}`, type: 'outlet-kind', label: k, props: {} })),
      ...OUTLET_RATINGS.map((o) => ({
        id: o.id, type: 'outlet', label: o.name,
        props: {
          kind: o.kind, lean: o.lean, econLean: o.econLean, reliability: o.reliability,
          biasBucket: leanBucket(o.lean), econBucket: econBucket(o.econLean), provenance: o.provenance,
        },
      })),
    ],
    edges: [
      ...OUTLET_RATINGS.map((o) => ({ type: 'leans', from: o.id, to: `world:bias:${leanBucket(o.lean)}`, props: { lean: o.lean } })),
      ...OUTLET_RATINGS.map((o) => ({ type: 'is_kind', from: o.id, to: `world:outlet-kind:${o.kind}`, props: {} })),
    ],
    facts: [],
  };
}
