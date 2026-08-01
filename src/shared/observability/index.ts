/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Barrel for the observability slice — the Prometheus exposition both runtimes serve at GET /metrics, so the ADR-119 self-healing rules key on series the swarm itself guarantees rather than on a host collector that cannot see Docker Desktop containers.
 */

/**
 * Observability surfaces shared by both runtimes (swarm controller + bot node).
 *
 * @module shared/observability
 */
export {
  PROMETHEUS_CONTENT_TYPE,
  _resetMemoryLimitCache,
  containerMemoryLimitBytes,
  renderRuntimeMetrics,
  type FileReader,
  type OshalRuntimeKind,
  type RuntimeMetricsIdentity,
} from './runtime-metrics';
