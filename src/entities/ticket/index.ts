/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added ticket entity barrel export for canonical OSHAL ticket workflow contracts
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added internal ticket types, store interface, and link schemas
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical ticket-project metadata helpers for default-project assignment and root-ticket project moves
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported trusted provider-to-internal-ticket projection contracts
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | FSD deep-import burn-down: surfaced TicketTypeSchema/TicketType, buildTicketRowStatusMetadataPatch, and the ticket-store status-record contracts consumers were deep-importing
 */

export {
  ExternalTicketHierarchySchema,
  ExternalTicketProjectionSchema,
  ExternalTicketWorkflowSchema,
  ExternalWorkActorSchema,
  ExternalWorkItemSchema,
  ExternalWorkTimestampsSchema,
  OshalTicketExecutionPhaseSchema,
  OshalTicketStateGroupSchema,
  OshalTicketStateSchema,
  TicketHierarchyVisibilitySchema,
  TicketInteractionModeSchema,
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  normalizeOshalTicketState,
  shouldDisplayTicketAtRoot,
  toTicketStateEnvSuffix,
  type ExternalTicketHierarchy,
  type ExternalTicketProjection,
  type ExternalTicketWorkflow,
  type ExternalWorkItem,
  type OshalTicketExecutionPhase,
  type OshalTicketState,
  type OshalTicketStateGroup,
  type TicketHierarchyVisibility,
  type TicketInteractionMode,
} from './types';

export {
  InternalTicketSchema,
  CreateInternalTicketSchema,
  TicketPrioritySchema,
  TicketTaskLinkRoleSchema,
  TicketTaskLinkSchema,
  TicketWorkspaceLinkSchema,
  type InternalTicket,
  type CreateInternalTicketInput,
  type TicketPriority,
  type TicketTaskLinkRole,
  type TicketTaskLink,
  type TicketWorkspaceLink,
} from './internal-ticket';

export {
  // Canonical queue concept (project was repurposed into a queue long ago).
  DEFAULT_QUEUE_ID,
  DEFAULT_QUEUE_NAME,
  TicketQueueAssignmentInputSchema,
  readCanonicalTicketQueue,
  mergeTicketQueueMetadata,
  resolveCanonicalTicketQueue,
  type CanonicalTicketQueue,
  type TicketQueueAssignmentInput,
  // Deprecated project-named aliases — kept until all call sites migrate.
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_NAME,
  TicketProjectAssignmentInputSchema,
  readCanonicalTicketProject,
  mergeTicketProjectMetadata,
  resolveCanonicalTicketProject,
  type CanonicalTicketProject,
  type TicketProjectAssignmentInput,
} from './project-metadata';

export {
  CHAT_QUEUE_ID,
  DEFAULT_DERIVED_QUEUE_ID,
  TICKET_TYPE_TO_QUEUE_ID,
  deriveTicketQueue,
  deriveQueueIdFromTaskType,
  applyDerivedQueueMetadata,
  type QueueClassificationContext,
  type DerivedTicketQueue,
} from './queue-classification';

export {
  type ITicketStore,
  type TicketStatusHistoryRecord,
  type TicketStatusMetadata,
  type TicketStatusUpdateContext,
} from './ticket-store';

// FSD deep-import burn-down (2026-07-24): members consumers were reaching via deep paths.
export { TicketTypeSchema, type TicketType } from './types';
export { buildTicketRowStatusMetadataPatch } from './ticket-status-row-metadata';
