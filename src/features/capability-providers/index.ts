/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 S1: barrel for the capability-providers feature slice — the Postgres store behind the swarm capability rows (migration 183). The resolution rule itself is shared (@/shared/capability-providers) so the voice and media features read it without importing this slice.
 */

/**
 * @description Capability providers (ADR-173): persistence for the swarm rows.
 * @module features/capability-providers
 */

export * from './services';
