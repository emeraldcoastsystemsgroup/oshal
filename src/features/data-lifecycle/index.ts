/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the data-lifecycle slice (per-user export + two-step delete): exporter registry contract + aggregation, the real default exporters, and the signed delete-confirmation token.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Review fix: export the information_schema-driven discovered exporters (full sub-keyed table coverage for export + delete).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Re-export the two engine exporters (Chroma vector store + Arango person-graph) and their injection-option types through the barrel, so the /api/me guard spec imports the builders FSD-clean (no deep import) to pin their caller-scoping + absent-engine-degrades-empty behavior.
 */

/**
 * @description Data-lifecycle feature — per-user data export ("give me everything you hold
 * on me") and two-step account-data deletion, driven by a single exporter registry so every
 * per-user store participates uniformly. Consumed by the /api/me routes.
 *
 * @module features/data-lifecycle
 */

export * from './services/exporter-registry';
export * from './services/default-exporters';
export * from './services/discovered-exporters';
export * from './services/delete-token';
export * from './services/chroma-exporter';
export * from './services/arango-person-graph-exporter';
