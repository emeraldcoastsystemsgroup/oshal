/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-057 scaffold: personal-data ontology (entities, relationships, provenance, IDs)
 */

/**
 * Personal-data ontology (ADR-057). The per-user model the reasoner relates over and the broker
 * (ADR-056) gates access to. Small + extensible: ~12 core entity types spanning home/money/career/
 * comms. This file is the SHAPE only — storage/ingestion live elsewhere (deferred per the ADR).
 *
 * IDs are user-namespaced (`user:<ownerSub>:<type>:<localId>`) so the broker can scope every query
 * to one user and never cross tenants. World data is REFERENCED (`world:<type>:<id>`), never copied.
 */
import { z } from 'zod';

/** Core personal entity types (ADR-057 §1). Grow this only when a connector needs a new type. */
export const PersonalEntityTypeSchema = z.enum([
  'person',        // the user (:self) + contacts
  'account',       // a connected account = a connector instance (email, brokerage, bank, device-cloud, job board)
  'organization',  // employer, stock issuer, merchant, prospective employer (carries world_ref)
  'security',      // a tradable instrument (carries world_ref)
  'holding',       // a position: person -> account -> security
  'transaction',   // a money movement
  'opportunity',   // a job lead / application
  'device',        // an IoT device
  'message',       // a comm (email, etc.) — unstructured anchor
  'event',         // a calendar item
  'document',      // resume / file / note — unstructured anchor
  'skill',         // a career skill
  'place',         // home / work location
]);
export type PersonalEntityType = z.infer<typeof PersonalEntityTypeSchema>;

/** Core relationship types (ADR-057 §2). `in_sector` is the seam that joins personal -> world. */
export const PersonalEdgeTypeSchema = z.enum([
  'owns',           // person -> account | device
  'holds',          // person -> holding
  'of',             // holding -> security
  'issued_by',      // security -> organization
  'applied_to',     // person -> opportunity
  'at',             // opportunity -> organization
  'has_skill',      // person -> skill
  'sent',           // person -> message
  'received',       // person -> message
  'mentions',       // message -> (organization | person | security | ...)
  'attended',       // person -> event
  'with',           // event -> person
  'transaction_from', // transaction -> account
  'transaction_to',   // transaction -> organization
  'located_at',     // device -> place
  'in_sector',      // (organization | security) -> world:sector:* (JOIN to world data)
]);
export type PersonalEdgeType = z.infer<typeof PersonalEdgeTypeSchema>;

/**
 * Provenance carried by every node + edge — what makes a reasoned answer citable and the access
 * audit (ADR-056) end-to-end. `source` is the connector or the data-access ticket id that produced it.
 */
export const ProvenanceSchema = z.object({
  source: z.string(),                 // connector id, bot id, or data-access ticket id
  ingestedAt: z.string(),             // ISO timestamp
  confidence: z.number().min(0).max(1).default(1),
  derivedBy: z.string().optional(),   // bot/agent that REVERBERATED this out of raw data (schema-builder)
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** A personal graph node. `id` MUST be user-namespaced (see makeEntityId). */
export const PersonalEntitySchema = z.object({
  id: z.string(),                     // user:<ownerSub>:<type>:<localId>
  type: PersonalEntityTypeSchema,
  ownerSub: z.string(),               // the user this belongs to — the broker's scope handle
  label: z.string().default(''),      // human label
  attrs: z.record(z.string(), z.unknown()).default({}),
  worldRef: z.string().nullable().default(null),   // world:<type>:<id> — referenced, never copied
  provenance: ProvenanceSchema,
});
export type PersonalEntity = z.infer<typeof PersonalEntitySchema>;

/** A personal graph edge. `from`/`to` are entity ids (or a world:* ref for `in_sector`). */
export const PersonalEdgeSchema = z.object({
  id: z.string(),
  type: PersonalEdgeTypeSchema,
  ownerSub: z.string(),
  from: z.string(),
  to: z.string(),
  attrs: z.record(z.string(), z.unknown()).default({}),
  provenance: ProvenanceSchema,
});
export type PersonalEdge = z.infer<typeof PersonalEdgeSchema>;

// ── ID conventions (the broker's tenancy guard depends on these) ─────────────────────────────────

/** Build a user-namespaced entity id: `user:<ownerSub>:<type>:<localId>`. */
export function makeEntityId(ownerSub: string, type: PersonalEntityType, localId: string | number): string {
  return `user:${ownerSub}:${type}:${localId}`;
}

/** Build a shared-world reference id: `world:<type>:<id>` (e.g. world:company:apple). Never copied into a vault. */
export function makeWorldRef(type: string, id: string): string {
  return `world:${type}:${id}`;
}

/** The id prefix the broker scopes a user's queries to (their own data only). */
export function userScopePrefix(ownerSub: string): string {
  return `user:${ownerSub}:`;
}

/** True if `id` is in this user's scope (their namespace) or is a shared-world ref. The broker uses
 *  this to reject anything that would cross tenants — the confused-deputy guard (ADR-056 §2). */
export function isInUserScope(id: string, ownerSub: string): boolean {
  return id.startsWith(userScopePrefix(ownerSub)) || id.startsWith('world:');
}
