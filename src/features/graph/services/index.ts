/**
 * Graph services barrel (ADR-045).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 — graph services barrel.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export NODES/EDGES collection names for the data-lifecycle person-graph exporter (dump queries reference them instead of magic strings).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 domain ingestions: export GraphIngestionService + the singleton/subscription helpers and their event types.
 *
 * @module graph/services
 */
export { GraphConnector, createGraphConnector } from './graph-connector';
export { ArangoGraphAdapter, NODES, EDGES } from './arango-graph-adapter';
export { personDbName, tenantDbName, nodeKey } from './graph-keys';
export type { GraphNode, GraphEdge, GraphHandle, GraphConnectorConfig } from './graph-types';
export {
  GraphIngestionService,
  getGraphIngestionService,
  startTicketGraphIngestion,
  SWARM_GRAPH_TENANT,
  type GraphIngestionConnector,
  type CaptureOpportunityGraphEvent,
  type JobGraphRecord,
} from './graph-ingestion';
