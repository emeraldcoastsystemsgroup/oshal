/**
 * Graph feature barrel — the two-tier graph DB + engine-agnostic connector (ADR-045).
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 — graph feature barrel.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Export NODES/EDGES collection names for the data-lifecycle person-graph exporter.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 domain ingestions: export the ingestion service, singleton, ticket-bus subscription helper, and event types.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | ADR-045 closure: re-export GraphReadOnlyError + GRAPH_READ_ONLY_CODE (the read-only query refusal) so the route layer maps it by code.
 *
 * @module graph
 */
export {
  GraphConnector,
  createGraphConnector,
  ArangoGraphAdapter,
  NODES,
  EDGES,
  personDbName,
  tenantDbName,
  nodeKey,
  GraphIngestionService,
  getGraphIngestionService,
  startTicketGraphIngestion,
  SWARM_GRAPH_TENANT,
  GraphReadOnlyError,
  GRAPH_READ_ONLY_CODE,
  type GraphNode,
  type GraphEdge,
  type GraphHandle,
  type GraphConnectorConfig,
  type GraphIngestionConnector,
  type CaptureOpportunityGraphEvent,
  type JobGraphRecord,
} from './services';
