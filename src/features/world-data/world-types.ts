/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-058 Layer B: world-data contribution types (shared world graph + series)
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
  metric: z.string(),                              // sentiment | price | mention_count | impact_score
  value: z.number(),
  at: z.string(),                                  // ISO timestamp (the series axis — kept historically)
});
export type WorldFact = z.infer<typeof WorldFactSchema>;

/** What a world-feeder bot (e.g. the beefed-up news-aggregator) reverberates into the world layer. */
export const WorldContributionSchema = z.object({
  source: z.string(),                              // feed/bot/ticket that produced this (provenance)
  ingestedAt: z.string(),
  entities: z.array(WorldEntitySchema).default([]),
  edges: z.array(WorldEdgeSchema).default([]),
  facts: z.array(WorldFactSchema).default([]),
});
export type WorldContribution = z.infer<typeof WorldContributionSchema>;
