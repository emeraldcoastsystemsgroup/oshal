/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-057 scaffold: SchemaContribution — bots reverberate over data to build the user's schema
 */

/**
 * SchemaContribution (the "bots reverberate over data to build out the user schema" principle).
 *
 * A bot doesn't write to the vault directly. As a side-effect of its work it REASONS over the data it
 * touched ("what can I tell about my user from this?") and emits a SchemaContribution — proposed
 * entities, edges, and facts, each with provenance + confidence. The framework then "sorts the junk":
 * entity-resolves, dedups, confidence-gates, and (via the broker, ADR-056) writes survivors into the
 * vault. So the personal schema is SELF-BUILDING — emergent from every bot's work, not a separate ETL.
 *
 * This keeps developers out of the storage layer entirely (see the change-impact doc): a bot returns
 * contributions; it never touches the graph/vector/metric stores.
 */
import { z } from 'zod';
import { PersonalEntityTypeSchema, PersonalEdgeTypeSchema, ProvenanceSchema } from './ontology';

/** A proposed entity — not yet resolved. The framework matches it to an existing node or mints one. */
export const EntityContributionSchema = z.object({
  /** Local handle a bot assigns (e.g. "aapl") so its edges can reference this entity before it has a
   *  real id. The service maps ref → resolved/minted id during ingest. */
  ref: z.string().optional(),
  type: PersonalEntityTypeSchema,
  /** Natural keys the resolver uses to dedup ("is this the same Apple?"): symbol, domain, email, etc. */
  match: z.record(z.string(), z.string()).default({}),
  label: z.string().default(''),
  attrs: z.record(z.string(), z.unknown()).default({}),
  worldRef: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.6),
});
export type EntityContribution = z.infer<typeof EntityContributionSchema>;

/** A proposed edge between two contributed/resolved entities (by their `match` ref or an existing id). */
export const EdgeContributionSchema = z.object({
  type: PersonalEdgeTypeSchema,
  from: z.string(),   // a local ref into this contribution's entities, or an existing entity id
  to: z.string(),
  attrs: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(0.6),
});
export type EdgeContribution = z.infer<typeof EdgeContributionSchema>;

/** A proposed metric/fact (number or time-series point) keyed to an entity — math lives here, never in a prompt. */
export const FactContributionSchema = z.object({
  entity: z.string(),     // local ref or existing entity id
  metric: z.string(),     // e.g. sector_exposure_pct, sentiment_felt
  value: z.number(),
  at: z.string(),         // ISO timestamp (time-series point)
  confidence: z.number().min(0).max(1).default(0.8),
});
export type FactContribution = z.infer<typeof FactContributionSchema>;

/**
 * The envelope a bot returns alongside its normal output. The framework ingests it through the broker:
 * resolve → dedup → confidence-gate ("sort the junk") → write survivors to the owner's vault.
 */
export const SchemaContributionSchema = z.object({
  ownerSub: z.string(),                  // whose vault this enriches — enforced by the broker
  provenance: ProvenanceSchema,          // which bot/ticket reverberated this out
  entities: z.array(EntityContributionSchema).default([]),
  edges: z.array(EdgeContributionSchema).default([]),
  facts: z.array(FactContributionSchema).default([]),
});
export type SchemaContribution = z.infer<typeof SchemaContributionSchema>;

/** Below this confidence the framework drops a contribution as junk by default (tunable per type). */
export const DEFAULT_CONTRIBUTION_FLOOR = 0.4;
