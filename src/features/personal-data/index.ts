/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-085/ADR-090 D8: add the missing barrel. personal-data backs the `memory` kernel skill, which promises packages a stable import path (@/features/personal-data) — it had none, and core deep-imported its files (also an FSD violation). This barrel IS the skill's public surface.
 */

/**
 * @description Personal data vault — the per-user encrypted store behind the `memory` kernel skill.
 *
 * Exposes the vault layout/resolution, the SQLite-backed store, the personal-intelligence ingest
 * service, the ontology + schema-contribution zod schemas, and the field-level crypto helpers.
 * Field encryption is owner-keyed (`ownerSub`) — never hand a vault handle across users.
 *
 * @module features/personal-data
 */

export * from './vault';
export * from './vault-crypto';
export * from './sqlite-vault-store';
export * from './personal-intelligence-service';
export * from './schema-contribution';
export * from './ontology';
