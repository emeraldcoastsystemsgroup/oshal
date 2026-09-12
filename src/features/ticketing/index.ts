/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Expose queued-principal authority storage through the feature boundary.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for ticketing feature
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added PlaneSyncService export
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket project assignment service export for root-ticket project moves
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Re-exported resilient localhost fallback stores through the ticketing feature barrel for composition-root compliance
 */

export {
  InMemoryTicketStore,
  InMemoryWorkspaceStore,
  PlaneSyncService,
  PostgresTicketStore,
  PostgresWorkspaceStore,
  ResilientTicketStore,
  ResilientWorkspaceStore,
  TicketProjectAssignmentService,
  TicketService,
  PostgresQueuedApplicationPrincipalStore,
  ensureQueuedApplicationPrincipalSchema,
  QUEUED_APPLICATION_PRINCIPAL_SCHEMA,
  WorkspaceService,
} from './services';
