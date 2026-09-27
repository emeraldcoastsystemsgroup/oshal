/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-058 Layer B: world-data contribution types (shared world graph + series)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Reserve the congressional disclosure namespace: a contribution may not carry a `congress_*` fact or claim the `quiver-congress` source, so POST /api/world/contribute and the model-callable `contribute` verb cannot author a congressional holding. The STOCK Act feed collector (political-trades.ts) is the only writer.
 */

/**
 * World-data contribution types (Layer B). The SHARED, read-mostly world knowledge — companies,
 * sectors, outlets, people, events, policies — plus their sentiment/market TIME-SERIES. This is the
 * other side of the relate-join: a personal `Security.worldRef = world:company:apple` points HERE.
 *
 * Unlike personal entities (user-namespaced, resolved by match keys), world entities carry a CANONICAL
 * id (`world:<type>:<key>`), so upsert-by-id is idempotent — resolution is free.
 */
import { z } from 'zod';

/** Metric namespace owned by the congressional (STOCK Act) disclosure feed collector. */
export const CONGRESS_METRIC_PREFIX = 'congress_';
/** The only provenance a congressional disclosure point may carry. */
export const CONGRESS_FEED_SOURCE = 'quiver-congress';

/**
 * @description Whether a metric name falls in the congressional disclosure namespace. Compared
 * trimmed and case-insensitively, so `Congress_Buys` cannot slip past the reservation.
 * @param metric - A world metric name.
 * @returns True when only the disclosure feed collector may write it.
 */
export function isReservedCongressMetric(metric: string): boolean {
  return String(metric).trim().toLowerCase().startsWith(CONGRESS_METRIC_PREFIX);
}

/**
 * @description Whether a provenance label claims the congressional disclosure feed, compared the
 * same way as the metric namespace.
 * @param source - A contribution or metric source label.
 * @returns True when the label names the disclosure feed.
 */
export function isReservedCongressSource(source: string): boolean {
  return String(source).trim().toLowerCase() === CONGRESS_FEED_SOURCE;
}

const RESERVED_METRIC_MESSAGE = 'congress_* metrics are written only by the congressional disclosure feed collector';
const RESERVED_SOURCE_MESSAGE = 'the quiver-congress source is reserved for the congressional disclosure feed collector';

/** A world graph node — canonical id is the dedup key. */
export const WorldEntitySchema = z.object({
  id: z.string(),                                  // world:<type>:<key> e.g. world:company:apple
  type: z.string(),                                // company | sector | outlet | person | event | policy | product
  label: z.string().default(''),
  props: z.record(z.string(), z.unknown()).default({}),
});
export type WorldEntity = z.infer<typeof WorldEntitySchema>;

/** A world graph edge (the DERIVED intelligence: leans, moves_with, in_sector, correlates_with…). */
export const WorldEdgeSchema = z.object({
  type: z.string(),
  from: z.string(),                                // world id
  to: z.string(),                                  // world id
  props: z.record(z.string(), z.unknown()).default({}),
});
export type WorldEdge = z.infer<typeof WorldEdgeSchema>;

/** A world time-series point (sentiment over time, price, mention_count…) — lands in TimescaleDB. */
export const WorldFactSchema = z.object({
  entity: z.string(),                              // world id
  metric: z.string()                               // sentiment | price | mention_count | impact_score
    .refine((metric) => !isReservedCongressMetric(metric), { message: RESERVED_METRIC_MESSAGE }),
  value: z.number(),
  at: z.string(),                                  // ISO timestamp (the series axis — kept historically)
});
export type WorldFact = z.infer<typeof WorldFactSchema>;

/** What a world-feeder bot (e.g. the beefed-up news-aggregator) reverberates into the world layer. */
export const WorldContributionSchema = z.object({
  source: z.string()                               // feed/bot/ticket that produced this (provenance)
    .refine((source) => !isReservedCongressSource(source), { message: RESERVED_SOURCE_MESSAGE }),
  ingestedAt: z.string(),
  entities: z.array(WorldEntitySchema).default([]),
  edges: z.array(WorldEdgeSchema).default([]),
  facts: z.array(WorldFactSchema).default([]),
});
export type WorldContribution = z.infer<typeof WorldContributionSchema>;
