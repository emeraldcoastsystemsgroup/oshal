/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial barrel export for shared database service helpers
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported swarm run schema bootstrap helper for durable orchestration persistence
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported swarm escalation schema bootstrap helper for durable escalation routing
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported work item schema bootstrap helper for internal swarm work unit persistence
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Exported subtask lifecycle schema bootstrap helper for durable subtask tracking
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported ticket and workspace schema bootstrap helpers for internal ticketing system
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Exported buildOwnerRlsPolicyStatements so lazy app-store DDL sites outside this directory (finance/payments/youtube/trading/tv-pairing) can apply tier-1 RLS at their chokepoints (A1.2 follow-up)
 */

export { createOptionalPostgresPool, hasPostgresConfiguration } from './optional-postgres-pool';
export {
  assertSchemaReady,
  isRuntimeDdlStatement,
  runRuntimeSchemaBootstrap,
  runtimeSchemaBootstrapEnabled,
  wrapPoolWithRuntimeDdlGuard,
  type SchemaRequirement,
} from './schema-bootstrap-policy';
export { buildOwnerRlsPolicyStatements } from './owner-rls-policy';
export { ensureConversationStoreSchema } from './conversation-schema';
export { ensureSwarmRunStoreSchema } from './swarm-run-schema';
export { ensureSwarmEscalationStoreSchema } from './swarm-escalation-schema';
export { ensureWorkItemSchema } from './work-item-schema';
export { ensureSubtaskLifecycleSchema } from './subtask-lifecycle-schema';
export { ensurePersonaLayerSchema } from './persona-layer-schema';
export { ensureTicketSchema } from './ticket-schema';
export { ensureWorkspaceSchema } from './workspace-schema';
export {
  acquireAmbientOwnerLock,
  AmbientOwnerLockBusyError,
  withAmbientOwnerLock,
} from './ambient-owner-lock';
export type { AmbientOwnerLockLease } from './ambient-owner-lock';
