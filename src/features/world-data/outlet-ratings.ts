/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Layer B: rated news outlets — bias + reliability so sentiment means something
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Deleted the hand-typed seed table and its "replace with AllSides/Ad Fontes" wording (operator decision 2026-09-22: no external license, ever; oshal ranks outlets from its own observations). Ratings are now OBSERVED: rateOutlets turns per-source divergence statistics read from the stored sentiment series into a lean (the sustained divergence of a source from the other sources on the same subjects and days) and a reliability (how closely it tracks them), each carrying its comparison, observation and subject counts and its date range, and "insufficient" below the stated minimums instead of a number. What stays here is outlet IDENTITY (canonical id, name, domain, aliases), so a publisher name keeps resolving to the id its history is stored under, plus the fixed cross-spectrum query lists. buildOutletSeedContribution now seeds identity only and nulls the rating props the old seed wrote into the shared graph.
 */

/**
 * Outlet identity and oshal's OWN outlet ratings.
 *
 * A sentiment number means little without knowing how its source usually reads, so every source is
 * rated, but only from what oshal itself observed. For each source, on every subject and day where
 * at least one other source also scored the same subject, the divergence is the source's mean
 * sentiment minus the mean of the other sources' means. Over the rating window:
 *  - lean        = the mean divergence (sentiment units; above 0 = persistently more favourable than
 *                  the other sources, below 0 = persistently more critical);
 *  - reliability = 1 - mean |divergence| / 2, in [0, 1] (sentiment spans [-1, 1], so |divergence|
 *                  cannot exceed 2): how closely the source tracks the cross-source consensus.
 * Every rating carries the counts and dates it was computed from. Below the minimum comparisons or
 * subjects the source is "insufficient" and carries no number. The statistics are read from the
 * stored series (outlet-observations.ts), so a rating is reproducible from the stored rows alone.
 */

import type { WorldContribution } from './world-types';

/** Where a rated source sits against the other sources on the same subjects and days. */
export type LeanBucket = 'below' | 'near' | 'above';
/** A source is rated only above the stated minimums; below them it is insufficient data. */
export type RatingStatus = 'rated' | 'insufficient';

/** One publisher's identity. No rating lives here; ratings are observed (see rateOutlets). */
export interface OutletIdentity {
  /** Canonical world id (world:outlet:<slug>) its sentiment history is stored under. */
  id: string;
  /** Display name. */
  name: string;
  /** Canonical domain, used for the `site:` cross-spectrum query variants. */
  domain?: string;
}

/** Known publishers. Identity only: id, display name and domain, so a publisher's items keep landing
 *  under one id whatever spelling a feed uses. */
export const OUTLET_IDENTITIES: ReadonlyArray<OutletIdentity> = [
  { id: 'world:outlet:ap', name: 'Associated Press', domain: 'apnews.com' },
  { id: 'world:outlet:reuters', name: 'Reuters', domain: 'reuters.com' },
  { id: 'world:outlet:bbc', name: 'BBC', domain: 'bbc.com' },
  { id: 'world:outlet:npr', name: 'NPR', domain: 'npr.org' },
  { id: 'world:outlet:nyt', name: 'New York Times', domain: 'nytimes.com' },
  { id: 'world:outlet:wapo', name: 'Washington Post', domain: 'washingtonpost.com' },
  { id: 'world:outlet:guardian', name: 'The Guardian', domain: 'theguardian.com' },
  { id: 'world:outlet:cnn', name: 'CNN', domain: 'cnn.com' },
  { id: 'world:outlet:abc', name: 'ABC News', domain: 'abcnews.go.com' },
  { id: 'world:outlet:cbs', name: 'CBS News', domain: 'cbsnews.com' },
  { id: 'world:outlet:nbc', name: 'NBC News', domain: 'nbcnews.com' },
  { id: 'world:outlet:pbs', name: 'PBS', domain: 'pbs.org' },
  { id: 'world:outlet:politico', name: 'Politico', domain: 'politico.com' },
  { id: 'world:outlet:thehill', name: 'The Hill', domain: 'thehill.com' },
  { id: 'world:outlet:axios', name: 'Axios', domain: 'axios.com' },
  { id: 'world:outlet:msnbc', name: 'MSNBC', domain: 'msnbc.com' },
  { id: 'world:outlet:foxnews', name: 'Fox News', domain: 'foxnews.com' },
  { id: 'world:outlet:nypost', name: 'New York Post', domain: 'nypost.com' },
  { id: 'world:outlet:newsmax', name: 'Newsmax', domain: 'newsmax.com' },
  { id: 'world:outlet:breitbart', name: 'Breitbart', domain: 'breitbart.com' },
  { id: 'world:outlet:wsj', name: 'Wall St Journal', domain: 'wsj.com' },
  { id: 'world:outlet:bloomberg', name: 'Bloomberg', domain: 'bloomberg.com' },
  { id: 'world:outlet:cnbc', name: 'CNBC', domain: 'cnbc.com' },
  { id: 'world:outlet:ft', name: 'Financial Times', domain: 'ft.com' },
  { id: 'world:outlet:economist', name: 'The Economist', domain: 'economist.com' },
  { id: 'world:outlet:barrons', name: "Barron's", domain: 'barrons.com' },
  { id: 'world:outlet:marketwatch', name: 'MarketWatch', domain: 'marketwatch.com' },
  { id: 'world:outlet:morningstar', name: 'Morningstar', domain: 'morningstar.com' },
  { id: 'world:outlet:ibd', name: "Investor's Business Daily", domain: 'investors.com' },
  { id: 'world:outlet:forbes', name: 'Forbes', domain: 'forbes.com' },
  { id: 'world:outlet:yahoo-finance', name: 'Yahoo Finance', domain: 'finance.yahoo.com' },
  { id: 'world:outlet:business-insider', name: 'Business Insider', domain: 'businessinsider.com' },
  { id: 'world:outlet:seeking-alpha', name: 'Seeking Alpha', domain: 'seekingalpha.com' },
  { id: 'world:outlet:techcrunch', name: 'TechCrunch', domain: 'techcrunch.com' },
  { id: 'world:outlet:verge', name: 'The Verge', domain: 'theverge.com' },
  { id: 'world:outlet:arstechnica', name: 'Ars Technica', domain: 'arstechnica.com' },
  { id: 'world:outlet:wired', name: 'Wired', domain: 'wired.com' },
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
  'ft': 'world:outlet:ft', 'financial times': 'world:outlet:ft',
  'barron\'s': 'world:outlet:barrons', 'barrons': 'world:outlet:barrons',
  'ibd': 'world:outlet:ibd', "investor's business daily": 'world:outlet:ibd',
  'the economist': 'world:outlet:economist',
  'yahoo': 'world:outlet:yahoo-finance', 'yahoo! finance': 'world:outlet:yahoo-finance',
  'insider': 'world:outlet:business-insider',
};

const BY_ID = new Map(OUTLET_IDENTITIES.map((o) => [o.id, o]));
const pick = (ids: string[]): ReadonlyArray<OutletIdentity> => OUTLET_IDENTITIES.filter((o) => ids.includes(o.id));

/** The fixed set of publishers queried directly with `site:` for every subject, so coverage does not
 *  depend only on a search engine's default ranking. A query-plan configuration, not a rating. */
export const CROSS_SPECTRUM_OUTLETS = pick(['world:outlet:cnn', 'world:outlet:nyt', 'world:outlet:reuters', 'world:outlet:ap', 'world:outlet:wsj', 'world:outlet:foxnews']);

/** The finance-press counterpart of {@link CROSS_SPECTRUM_OUTLETS} for business and market subjects. */
export const CROSS_SPECTRUM_FINANCE = pick(['world:outlet:reuters', 'world:outlet:bloomberg', 'world:outlet:wsj', 'world:outlet:ft', 'world:outlet:cnbc', 'world:outlet:marketwatch']);

/**
 * @description Look up a known publisher by its canonical world id.
 * @param outletId - e.g. world:outlet:foxnews.
 * @returns The identity, or undefined for a source with no canonical entry.
 */
export function outletById(outletId: string): OutletIdentity | undefined {
  return BY_ID.get(outletId);
}

/**
 * @description Resolve a feed's publisher string ("Fox News", "AP News", "MUO on MSN") to a known
 * identity: alias first, then the formal name exactly or by substring either way (Bing appends
 * "… on MSN"). Resolution keeps one publisher's items under one id; it says nothing about a rating.
 * @param name - The publisher name a feed item carried.
 * @returns The identity, or undefined when the publisher is not a known one.
 */
export function outletByName(name: string): OutletIdentity | undefined {
  const n = (name || '').toLowerCase().trim();
  if (!n) return undefined;
  const head = n.split(' on ')[0].trim();
  const aliased = ALIASES[n] ?? ALIASES[head];
  if (aliased) return BY_ID.get(aliased);
  return OUTLET_IDENTITIES.find((o) => {
    const m = o.name.toLowerCase();
    return m === n || m === head || n.includes(m) || m.includes(head);
  });
}

/**
 * @description Stable world:outlet slug for a publisher with no canonical identity.
 * @param name - Publisher name.
 * @returns A lowercase slug of at most 40 characters ('unknown' when empty).
 */
export function slugifyOutlet(name: string): string {
  return ((name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)) || 'unknown';
}

/**
 * @description The world id a publisher's sentiment is stored under: its canonical id when known,
 * else world:outlet:<slug>. The one place ingest decides it, so history never splits.
 * @param name - Publisher name from the feed item.
 * @returns The world source id.
 */
export function outletSourceId(name: string): string {
  return outletByName(name)?.id ?? `world:outlet:${slugifyOutlet(name)}`;
}

/** Graph props the retired seed table wrote onto outlet nodes. Writing them as null on every outlet
 *  upsert clears them from the shared graph (an UPDATE merges props), so no seeded number survives
 *  there as if it were a rating. Ratings are computed on read from the stored series instead. */
export const RETIRED_RATING_PROPS: Readonly<Record<string, null>> = Object.freeze({
  kind: null, lean: null, econLean: null, reliability: null,
  biasBucket: null, econBucket: null, provenance: null, unrated: null,
});

/** Per-source divergence statistics read from the stored sentiment series (outlet-observations.ts). */
export interface OutletDivergenceStats {
  source: string;
  /** Subject-days on which this source and at least one other source scored the same subject. */
  comparisons: number;
  /** Distinct subjects among those comparisons. */
  subjects: number;
  /** This source's sentiment points behind those comparisons. */
  observations: number;
  /** Earliest and latest compared day, YYYY-MM-DD. */
  firstDay: string | null;
  lastDay: string | null;
  /** Mean of (this source's mean − the other sources' mean) over the comparisons. */
  meanDivergence: number | null;
  /** Sample standard deviation of that divergence. */
  sdDivergence: number | null;
  /** Mean absolute divergence. */
  meanAbsDivergence: number | null;
}

/** The stated method parameters. Every rating set carries them, so a reader can reproduce it. */
export interface OutletRatingParams {
  /** Trailing whole days of the stored series a rating is computed over. */
  windowDays: number;
  /** Fewest compared subject-days a source needs before it is rated. */
  minComparisons: number;
  /** Fewest distinct compared subjects a source needs before it is rated. */
  minSubjects: number;
}

/** One source's observed rating. lean and reliability are null whenever status is insufficient. */
export interface ObservedOutletRating {
  source: string;
  status: RatingStatus;
  lean: number | null;
  leanBucket: LeanBucket | null;
  reliability: number | null;
  comparisons: number;
  subjects: number;
  observations: number;
  firstObserved: string | null;
  lastObserved: string | null;
}

/** All observed ratings for one window plus the method that produced them. */
export interface OutletRatingSet extends OutletRatingParams {
  method: typeof OUTLET_RATING_METHOD;
  /** Standard errors a mean divergence must clear before the lean is called below or above. */
  leanZ: number;
  computedAt: string;
  ratings: ReadonlyMap<string, ObservedOutletRating>;
}

/** Method identifier recorded on every rating set; bump it when the arithmetic changes. */
export const OUTLET_RATING_METHOD = 'consensus-divergence-v1';
/** A lean is called below/above only when its mean divergence is more than two standard errors from 0. */
export const OUTLET_LEAN_Z = 2;
const DEFAULT_PARAMS: OutletRatingParams = { windowDays: 90, minComparisons: 20, minSubjects: 3 };

/** Whole-number env override; an unset, malformed or non-positive value keeps the default. */
function envWhole(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const n = Number((env[name] || '').trim());
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

/**
 * @description The rating method parameters, overridable per deployment.
 * @param env - Process environment (WORLD_OUTLET_RATING_WINDOW_DAYS, _MIN_COMPARISONS, _MIN_SUBJECTS).
 * @returns The parameters every rating in a set is computed with.
 */
export function outletRatingParams(env: NodeJS.ProcessEnv = process.env): OutletRatingParams {
  return {
    windowDays: envWhole(env, 'WORLD_OUTLET_RATING_WINDOW_DAYS', DEFAULT_PARAMS.windowDays),
    minComparisons: envWhole(env, 'WORLD_OUTLET_RATING_MIN_COMPARISONS', DEFAULT_PARAMS.minComparisons),
    minSubjects: envWhole(env, 'WORLD_OUTLET_RATING_MIN_SUBJECTS', DEFAULT_PARAMS.minSubjects),
  };
}

const round3 = (x: number): number => Number(x.toFixed(3));

/** Call a lean below/above only when its mean divergence clears LEAN_Z standard errors. */
function leanBucketOf(mean: number, sd: number | null, comparisons: number): LeanBucket {
  const se = (sd ?? 0) / Math.sqrt(comparisons);
  if (mean - OUTLET_LEAN_Z * se > 0) return 'above';
  if (mean + OUTLET_LEAN_Z * se < 0) return 'below';
  return 'near';
}

/**
 * @description Rate one source from its divergence statistics. Below either minimum, or with no
 * divergence to average, it is insufficient and carries no lean or reliability.
 * @param s - The source's divergence statistics.
 * @param params - The stated minimums.
 * @returns The observed rating with its counts and dates.
 */
export function rateOutlet(s: OutletDivergenceStats, params: OutletRatingParams): ObservedOutletRating {
  const base = {
    source: s.source, comparisons: s.comparisons, subjects: s.subjects, observations: s.observations,
    firstObserved: s.firstDay, lastObserved: s.lastDay,
  };
  const enough = s.comparisons >= params.minComparisons && s.subjects >= params.minSubjects;
  if (!enough || s.meanDivergence == null || s.meanAbsDivergence == null) {
    return { ...base, status: 'insufficient', lean: null, leanBucket: null, reliability: null };
  }
  return {
    ...base,
    status: 'rated',
    lean: round3(s.meanDivergence),
    leanBucket: leanBucketOf(s.meanDivergence, s.sdDivergence, s.comparisons),
    reliability: round3(Math.max(0, Math.min(1, 1 - s.meanAbsDivergence / 2))),
  };
}

/**
 * @description Rate every source the statistics cover.
 * @param stats - Divergence statistics, one per source.
 * @param params - The stated method parameters.
 * @param computedAt - When the statistics were read (ISO).
 * @returns The rating set, keyed by source id.
 */
export function rateOutlets(stats: OutletDivergenceStats[], params: OutletRatingParams, computedAt: string): OutletRatingSet {
  return {
    ...params, method: OUTLET_RATING_METHOD, leanZ: OUTLET_LEAN_Z, computedAt,
    ratings: new Map(stats.map((s) => [s.source, rateOutlet(s, params)])),
  };
}

/**
 * @description A source's rating from a set, or an insufficient rating with zero counts for a source
 * that was never compared in the window. Never guesses a number.
 * @param set - The rating set.
 * @param source - The world source id.
 * @returns The observed rating.
 */
export function ratingFor(set: OutletRatingSet, source: string): ObservedOutletRating {
  return set.ratings.get(source) ?? {
    source, status: 'insufficient', lean: null, leanBucket: null, reliability: null,
    comparisons: 0, subjects: 0, observations: 0, firstObserved: null, lastObserved: null,
  };
}

/**
 * @description Seed the known publishers' identity nodes into the world graph. Identity only: id,
 * name and domain, plus nulls over the rating props the retired seed table wrote, so running it
 * clears those numbers from every known outlet node. Idempotent (canonical ids).
 * @param now - Ingest timestamp (ISO).
 * @returns The contribution to ingest.
 */
export function buildOutletSeedContribution(now: string): WorldContribution {
  return {
    source: 'outlet-identity-seed',
    ingestedAt: now,
    entities: OUTLET_IDENTITIES.map((o) => ({
      id: o.id, type: 'outlet', label: o.name,
      props: { ...RETIRED_RATING_PROPS, domain: o.domain ?? null },
    })),
    edges: [],
    facts: [],
  };
}
