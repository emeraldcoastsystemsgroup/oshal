/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the observability slice — the Prometheus exposition both runtimes serve at GET /metrics, so the ADR-119 self-healing rules key on series the swarm itself guarantees rather than on a host collector that cannot see Docker Desktop containers.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the catalog-load registry + the retrying catalog-directory read: a subsystem that reads a directory of definitions at boot now records what it actually loaded, so /api/readiness can refuse to call a box ready when a capability loaded NOTHING (the 2026-08-01 ENOMEM connector-catalog incident).
 */

/**
 * Observability surfaces shared by both runtimes (swarm controller + bot node).
 *
 * @module shared/observability
 */
export {
  degradedCatalogs,
  listCatalogLoads,
  recordCatalogLoad,
  resetCatalogLoads,
  type CatalogLoadRecord,
  type CatalogSourceState,
} from './catalog-load-registry';
export {
  TRANSIENT_DIR_READ_CODES,
  readCatalogDir,
  type CatalogDirRead,
  type ReadCatalogDirOptions,
} from './read-catalog-dir';
export {
  PROMETHEUS_CONTENT_TYPE,
  _resetMemoryLimitCache,
  containerMemoryLimitBytes,
  renderRuntimeMetrics,
  type FileReader,
  type OshalRuntimeKind,
  type RuntimeMetricsIdentity,
} from './runtime-metrics';
