/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Shared deterministic-id + node builders for ingest mappers (ADR-066)
 */

/**
 * @module features/personal-graph/ingest/ingest-helpers
 * @description Pure helpers shared by the per-provider ingest mappers (ADR-066): deterministic id
 * construction and a Person-node builder. Centralizing id construction is what makes the same person
 * resolve to the same node id across providers (the prerequisite for cross-source dedup/merge).
 */

import { normalizeEmail } from '../graph-types';
import type { PersonNode, SourceRef } from '../graph-types';

/** Deterministic person id. Email is the strong key; fall back to a provider-scoped handle/id. */
export function personId(opts: { email?: string; provider?: string; handle?: string }): string {
  const email = normalizeEmail(opts.email);
  if (email) return `person:${email}`;
  if (opts.provider && opts.handle) return `person:${opts.provider}:${opts.handle.toLowerCase()}`;
  throw new Error('personId requires an email, or a provider+handle');
}

/** Deterministic id for a provider-scoped entity, e.g. event:google-calendar:abc123. */
export function scopedId(type: string, provider: string, externalId: string): string {
  return `${type.toLowerCase()}:${provider}:${externalId}`;
}

/** Build a Person node from whatever identity bits a source carries. */
export function buildPerson(opts: {
  email?: string;
  name?: string;
  handle?: string;
  source: SourceRef;
}): PersonNode {
  const email = normalizeEmail(opts.email);
  const id = personId({ email, provider: opts.source.provider, handle: opts.handle });
  const label = opts.name?.trim() || email || opts.handle || id;
  const props: PersonNode['props'] = {};
  if (email) props.email = email;
  if (opts.name) props.name = opts.name;
  if (opts.handle) props.handle = opts.handle;
  return { id, type: 'Person', label, sources: [opts.source], props };
}
