/**
 * Headline noise gate — the shared, deterministic predicate that separates REAL NEWS from
 * REACTION SENTIMENT (journalism *about* a price move).
 *
 * Lives in `shared/` because two feature slices need the same rule and FSD forbids cross-slice
 * imports: `features/world-data` uses it at INGEST (so the sentiment series counts real news, not
 * commentary), and `features/trading` uses it in the news-materiality reader + the event studies.
 *
 * The exclusion classes are EVIDENCE, not taste — every one was measured:
 *  - sweep #5 (2026-07-11): listicles / "big dollar figure" stories were 55% of volume and negative
 *    in all 7 runs; the keyword-regex materiality scorer died on them.
 *  - wire-ceiling study (2026-07-14): of the surges with a headline in the 60 minutes before the
 *    move, MOST were reactive coverage published INTO the move — `"…And Other Big Movers"` 2 min in,
 *    `"What's Going On With Intel Stock Friday?"` 9 min in, `"Micron … Are Tanking On Korea Selloff"`
 *    3 min in. Counting those as sentiment is counting the thermometer as the weather.
 *
 * Pure: string → boolean. No I/O. Same headline, same verdict, forever.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — hoisted from features/trading/services/analyst-actions.ts (isNoiseHeadline) + news-materiality.ts (PREFILTER_DROP) into shared/ so the world-data ingest can strain the sentiment series without an FSD cross-slice import. Same regexes, same behavior; the trading modules now re-export from here.
 *
 * @module headline-noise
 */

/** Structural noise: aggregations, reactive explainers, question headlines. */
const STRUCTURAL_NOISE = [
  /\b(top|best|worst)\s+\d+\b/i,
  /\b\d+\s+(stocks?|names?|companies)\b/i,
  /\band other\b/i,
  /\bmovers?\b/i,
  /\bto watch\b/i,
  /\bwhat'?s going on\b/i,
  /\bwhy (is|are|did)\b/i,
  /\b(preview|recap|midday|premarket|pre-market|after hours|week ahead|earnings scheduled)\b/i,
  /\?\s*$/,
];

/** Classes MEASURED worthless: price-action commentary, estimate chatter, flow/valuation filler. */
const MEASURED_NOISE = [
  /\banalyst estimates?\b/i,
  /\bconsensus estimate\b/i,
  /\b(stock|shares?) (rise|rises|fall|falls|jump|jumps|slip|slips|climb|climbs|dip|dips|surge|surges|gain|gains|drop|drops)\b/i,
  /\btrading (higher|lower)\b/i,
  /\b52-week (high|low)\b/i,
  /\bhere'?s how much\b/i,
  /\bif you (had )?invested\b/i,
  /\bmarket cap\b/i,
  /\bdividend announcement calendar\b/i,
  /\boptions? (activity|alert|volume)\b/i,
  /\bunusual options\b/i,
  /\bshort interest\b/i,
  /\bbenzinga bulls?\b/i,
  /\bcheat sheet\b/i,
];

/**
 * @description True when a headline is STRUCTURAL noise — aggregation, reactive explainer, or a
 * question. The narrow gate: what no classifier should ever try to interpret.
 * @param headline - Raw headline.
 * @returns True when the headline is structural noise.
 */
export function isNoiseHeadline(headline: string): boolean {
  const h = String(headline || '').trim();
  if (h.length < 12) return true;
  for (const rx of STRUCTURAL_NOISE) if (rx.test(h)) return true;
  return false;
}

/**
 * @description KEEP/DROP for any consumer that wants REAL NEWS ONLY: drops structural noise AND
 * the measured-worthless classes (price-action commentary, estimate chatter, flow filler). This is
 * the predicate the world ingest uses to build the strained `sentiment_clean` series and the
 * materiality reader uses to decide what is worth a token.
 * @param headline - Raw headline.
 * @returns True to KEEP (real-news candidate), false to DROP (noise / reaction sentiment).
 */
export function isRealNewsHeadline(headline: string): boolean {
  if (isNoiseHeadline(headline)) return false;
  for (const rx of MEASURED_NOISE) if (rx.test(headline)) return false;
  return true;
}
