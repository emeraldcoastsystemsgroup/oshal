/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical OSHAL ticket workflow, mode, and hierarchy model for swarm and Plane integration
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Added paused and cancelled ticket states for operator stop/pause control
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added terminal 'dead_letter' state (queue DLQ / poison-ticket quarantine, migration 081). Groups under 'escalated' so existing group-based boards/filters keep working; terminal + requires human review. Reached only via the DeadLetterService after QM_MAX_ATTEMPTS failed dispatch/escalation cycles; leaves only via operator requeue.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added trusted internal-ticket projection fields to normalized provider work items
 */

import { z } from 'zod';
import { IntakeProviderSchema } from '@/shared/types';

/**
 * @description Canonical OSHAL interaction modes that keep chat flows separate from ticket flows.
 */
export const TicketInteractionModeSchema = z.enum(['chat', 'ticket']);

/**
 * @description Ticket type determines which workflow processes the ticket.
 * - build: Software development (7-phase swarm pipeline — embedded framework)
 * - incident: Infrastructure incident investigation (direct specialist — embedded framework)
 * - education: Little Monsters education pipeline (manifest-declared worker bot)
 * - intelligent-processing: Prometheus self-healing alert queue (manifest-contributed,
 *     routed through the incident-rca pipeline). The streamlined alert→ticket→RCA→fix
 *     queue; kept distinct from generic `incident` so it filters cleanly.
 * - security-audit: Multi-harness security audit (3-bot, 3-agent, 3-API pipeline; phase0).
 * - task: Jarvis/assistant delegated task routed through the manifest-worker
 *     pipeline and optionally pinned to a specialist via metadata.targetAgentId.
 *
 * Adding a new ticket type requires:
 *   1. Adding the value here
 *   2. Updating the mapRow cast in ticket-store-postgres.ts (now `as TicketType`)
 *   3. A matching workflow entry (embedded in WorkflowPipelineRegistry, or
 *      contributed by a swarm-app manifest's `workflow:` block)
 *   4. A dispatch path in queue-manager-service.ts (registry-driven — no change
 *      needed for incident-rca-routed types)
 */
// 'chat' = a workflow-less conversation ticket: it wraps a direct bot-chat thread so it shows on
// the queue board and stays in_process until the user closes it. It is NEVER dispatched — the
// QueueManager only pulls 'approved' tickets, and no workflow is registered for 'chat'
// (dispatch-routing → 'defer'). See ensureChatTicket / TicketService.openChatTicket.
export const TicketTypeSchema = z.string().trim().min(1);
/**
 * @description Canonical ticket type key used to select the processing workflow for a ticket.
 */
export type TicketType = z.infer<typeof TicketTypeSchema>;

/**
 * @description Canonical interaction mode key.
 */
export type TicketInteractionMode = z.infer<typeof TicketInteractionModeSchema>;

/**
 * @description Canonical OSHAL ticket states used across processing, UI, and provider projection.
 */
export const OshalTicketStateSchema = z.enum([
  'backlog',
  'approved',
  // Generic "open and in progress, not queued" — used by chat-tickets (groups to 'in_process',
  // never picked up by the QueueManager, which only pulls 'approved'). Distinct from the
  // phase-specific in_process_* states below, which imply an active swarm execution phase.
  'in_process',
  'in_process_discovery',
  'in_process_design',
  'in_process_build',
  'in_process_deploy',
  'in_process_test',
  'in_process_release',
  'approval_required',
  'customer_action',
  'complete',
  'escalated',
  // Terminal poison-ticket quarantine (queue DLQ): the ticket exhausted QM_MAX_ATTEMPTS
  // dispatch/escalation cycles and is parked until an operator requeues or cancels it.
  // Groups under 'escalated' (see TICKET_STATE_DEFINITIONS) so group-based surfaces
  // need no new bucket.
  'dead_letter',
  'paused',
  'cancelled',
]);

/**
 * @description Canonical ticket state key.
 */
export type OshalTicketState = z.infer<typeof OshalTicketStateSchema>;

/**
 * @description High-level state group used for filtering and reporting.
 */
export const OshalTicketStateGroupSchema = z.enum([
  'backlog',
  'approved',
  'in_process',
  'approval_required',
  'customer_action',
  'complete',
  'escalated',
  'paused',
  'cancelled',
]);

/**
 * @description Ticket state group key.
 */
export type OshalTicketStateGroup = z.infer<typeof OshalTicketStateGroupSchema>;

/**
 * @description Optional in-process phase for operational work sequencing.
 */
export const OshalTicketExecutionPhaseSchema = z.enum([
  'discovery',
  'design',
  'build',
  'deploy',
  'test',
  'release',
]);

/**
 * @description Execution phase key used when a ticket is actively in process.
 */
export type OshalTicketExecutionPhase = z.infer<typeof OshalTicketExecutionPhaseSchema>;

/**
 * @description Hierarchy visibility rule used by OSHAL ticket surfaces.
 */
export const TicketHierarchyVisibilitySchema = z.enum([
  'root_only',
  'tree_only',
]);

/**
 * @description Ticket visibility key for root/tree rendering.
 */
export type TicketHierarchyVisibility = z.infer<typeof TicketHierarchyVisibilitySchema>;

/**
 * @description Derived canonical workflow metadata carried with each normalized ticket.
 */
export const ExternalTicketWorkflowSchema = z.object({
  stateKey: OshalTicketStateSchema,
  stateGroup: OshalTicketStateGroupSchema,
  stateLabel: z.string().min(1),
  executionPhase: OshalTicketExecutionPhaseSchema.optional(),
  mode: TicketInteractionModeSchema.default('ticket'),
  isTerminal: z.boolean(),
  requiresCustomerAction: z.boolean(),
  requiresHumanReview: z.boolean(),
});

/**
 * @description Canonical workflow metadata for one normalized external ticket.
 */
export type ExternalTicketWorkflow = z.infer<typeof ExternalTicketWorkflowSchema>;

/**
 * @description Canonical hierarchy metadata used to hide subtickets from root views.
 */
export const ExternalTicketHierarchySchema = z.object({
  parentExternalId: z.string().optional(),
  rootExternalId: z.string().min(1),
  isSubticket: z.boolean(),
  visibility: TicketHierarchyVisibilitySchema,
  childExternalIds: z.array(z.string()).default([]),
  childCount: z.number().int().nonnegative().default(0),
});

/**
 * @description Canonical hierarchy metadata for one normalized external ticket.
 */
export type ExternalTicketHierarchy = z.infer<typeof ExternalTicketHierarchySchema>;

/**
 * @description Normalized actor shape for provider-originated tickets.
 */
export const ExternalWorkActorSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});

/**
 * @description Normalized ticket timestamp metadata.
 */
export const ExternalWorkTimestampsSchema = z.object({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/**
 * @description Trusted provider projection used when materializing a normalized item as an internal ticket.
 */
export const ExternalTicketProjectionSchema = z.object({
  ticketType: TicketTypeSchema,
  externalUrl: z.string().url().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

/**
 * @description Provider-authoritative fields for internal ticket creation and reconciliation.
 */
export type ExternalTicketProjection = z.infer<typeof ExternalTicketProjectionSchema>;

/**
 * @description Canonical normalized ticket contract consumed by swarm orchestration.
 */
export const ExternalWorkItemSchema = z.object({
  provider: IntakeProviderSchema,
  externalId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional().default(''),
  labels: z.array(z.string()).optional().default([]),
  priority: z.string().optional(),
  status: z.string().optional(),
  actor: ExternalWorkActorSchema.optional(),
  timestamps: ExternalWorkTimestampsSchema.optional(),
  ticketProjection: ExternalTicketProjectionSchema.optional(),
  workflow: ExternalTicketWorkflowSchema,
  hierarchy: ExternalTicketHierarchySchema,
  rawPayload: z.unknown(),
});

/**
 * @description Canonical normalized external ticket.
 */
export type ExternalWorkItem = z.infer<typeof ExternalWorkItemSchema>;

const TICKET_STATE_DEFINITIONS: Record<OshalTicketState, Omit<ExternalTicketWorkflow, 'mode'>> = {
  backlog: buildStateDefinition('backlog', 'backlog', 'Backlog'),
  approved: buildStateDefinition('approved', 'approved', 'Approved'),
  in_process: buildStateDefinition('in_process', 'in_process', 'In Process'),
  in_process_discovery: buildStateDefinition('in_process', 'in_process_discovery', 'Phase 0 - Discovery & Planning', 'discovery'),
  in_process_design: buildStateDefinition('in_process', 'in_process_design', 'In Process - Design', 'design'),
  in_process_build: buildStateDefinition('in_process', 'in_process_build', 'In Process - Build', 'build'),
  in_process_deploy: buildStateDefinition('in_process', 'in_process_deploy', 'In Process - Deploy', 'deploy'),
  in_process_test: buildStateDefinition('in_process', 'in_process_test', 'In Process - Test', 'test'),
  in_process_release: buildStateDefinition('in_process', 'in_process_release', 'In Process - Release', 'release'),
  approval_required: buildStateDefinition('approval_required', 'approval_required', 'Approval Required', undefined, true, false, true),
  customer_action: buildStateDefinition('customer_action', 'customer_action', 'Customer Action', undefined, true),
  complete: buildStateDefinition('complete', 'complete', 'Complete', undefined, false, true),
  escalated: buildStateDefinition('escalated', 'escalated', 'Escalated', undefined, false, false, true),
  // DLQ quarantine: TERMINAL (unlike escalated) — the queue never retries it; only an
  // operator requeue (dead_letter → approved) or cancel releases it. Grouped under
  // 'escalated' so state_group surfaces and CHECK constraints stay unchanged.
  dead_letter: buildStateDefinition('escalated', 'dead_letter', 'Dead Letter', undefined, false, true, true),
  paused: buildStateDefinition('paused', 'paused', 'Paused'),
  cancelled: buildStateDefinition('cancelled', 'cancelled', 'Cancelled', undefined, false, true),
};

/**
 * @description Resolves one canonical ticket state into its workflow metadata.
 * @param state - Canonical OSHAL ticket state
 * @param mode - Interaction mode to attach to the workflow metadata
 * @returns Workflow metadata for the requested canonical state
 */
export function buildExternalTicketWorkflow(
  state: OshalTicketState,
  mode: TicketInteractionMode = 'ticket',
): ExternalTicketWorkflow {
  const definition = TICKET_STATE_DEFINITIONS[state];
  return ExternalTicketWorkflowSchema.parse({
    ...definition,
    mode,
  });
}

/**
 * @description Builds canonical hierarchy metadata for one normalized ticket.
 * @param externalId - Ticket identifier
 * @param hierarchy - Optional hierarchy inputs from a provider payload
 * @returns Canonical hierarchy metadata
 */
export function buildExternalTicketHierarchy(
  externalId: string,
  hierarchy?: Partial<ExternalTicketHierarchy>,
): ExternalTicketHierarchy {
  const isSubticket = Boolean(hierarchy?.parentExternalId);
  return ExternalTicketHierarchySchema.parse({
    parentExternalId: hierarchy?.parentExternalId,
    rootExternalId: hierarchy?.rootExternalId || hierarchy?.parentExternalId || externalId,
    isSubticket,
    visibility: isSubticket ? 'tree_only' : 'root_only',
    childExternalIds: hierarchy?.childExternalIds || [],
    childCount: hierarchy?.childCount ?? hierarchy?.childExternalIds?.length ?? 0,
  });
}

/**
 * @description Maps provider-native state text into the canonical OSHAL ticket state model.
 * @param value - Provider-native state text
 * @returns Canonical OSHAL ticket state
 */
export function normalizeOshalTicketState(value: string | null | undefined): OshalTicketState {
  const normalized = value?.trim().toLowerCase() || '';
  if (!normalized) {
    return 'backlog';
  }

  const exactMatch = TICKET_STATE_ALIASES[normalized];
  if (exactMatch) {
    return exactMatch;
  }

  if (normalized.includes('customer')) {
    return 'customer_action';
  }

  if (normalized.includes('approval')) {
    return 'approval_required';
  }

  if (normalized.includes('discovery') || normalized.includes('phase 0') || normalized === 'phase0') {
    return 'in_process_discovery';
  }

  if (normalized.includes('design')) {
    return 'in_process_design';
  }

  if (normalized.includes('build') || normalized.includes('develop') || normalized.includes('implement')) {
    return 'in_process_build';
  }

  if (normalized.includes('deploy')) {
    return 'in_process_deploy';
  }

  if (normalized.includes('test') || normalized.includes('qa') || normalized.includes('verify')) {
    return 'in_process_test';
  }

  if (normalized.includes('release')) {
    return 'in_process_release';
  }

  if (normalized.includes('progress') || normalized.includes('doing')) {
    return 'in_process_build';
  }

  return 'backlog';
}

/**
 * @description Returns whether a ticket should appear at the root level of OSHAL ticket views.
 * @param item - Normalized external ticket
 * @returns True for lead/root tickets, otherwise false
 */
export function shouldDisplayTicketAtRoot(item: Pick<ExternalWorkItem, 'hierarchy'>): boolean {
  return item.hierarchy.visibility === 'root_only';
}

/**
 * @description Converts a canonical ticket state into an environment variable suffix for provider mappings.
 * @param state - Canonical ticket state
 * @returns Environment-variable-safe suffix
 */
export function toTicketStateEnvSuffix(state: OshalTicketState): string {
  return state.toUpperCase();
}

/**
 * @description Builds one canonical ticket-state definition.
 * @param group - High-level state group
 * @param stateKey - Canonical ticket state key
 * @param label - Human-readable label
 * @param executionPhase - Optional in-process execution phase
 * @param requiresCustomerAction - Whether the state depends on customer input
 * @param isTerminal - Whether the state is terminal
 * @param requiresHumanReview - Whether the state implies human review
 * @returns Canonical state definition
 */
function buildStateDefinition(
  group: OshalTicketStateGroup,
  stateKey: OshalTicketState,
  label: string,
  executionPhase?: OshalTicketExecutionPhase,
  requiresCustomerAction = false,
  isTerminal = false,
  requiresHumanReview = false,
): Omit<ExternalTicketWorkflow, 'mode'> {
  return {
    stateKey,
    stateGroup: group,
    stateLabel: label,
    executionPhase,
    isTerminal,
    requiresCustomerAction,
    requiresHumanReview,
  };
}

const TICKET_STATE_ALIASES: Record<string, OshalTicketState> = {
  backlog: 'backlog',
  intake: 'backlog',
  triage: 'backlog',
  approved: 'approved',
  todo: 'approved',
  'to do': 'approved',
  ready: 'approved',
  open: 'approved',
  'phase 0': 'in_process_discovery',
  phase0: 'in_process_discovery',
  discovery: 'in_process_discovery',
  'discovery planning': 'in_process_discovery',
  planning: 'in_process_discovery',
  'customer action': 'customer_action',
  customer_action: 'customer_action',
  'waiting on customer': 'customer_action',
  'approval required': 'approval_required',
  approval_required: 'approval_required',
  'human interaction': 'approval_required',
  'ready for build approval': 'approval_required',
  complete: 'complete',
  completed: 'complete',
  done: 'complete',
  closed: 'complete',
  resolved: 'complete',
  escalated: 'escalated',
  'human review': 'escalated',
  human_review: 'escalated',
  dead_letter: 'dead_letter',
  'dead letter': 'dead_letter',
  'dead-letter': 'dead_letter',
  dlq: 'dead_letter',
  poison: 'dead_letter',
  paused: 'paused',
  pause: 'paused',
  hold: 'paused',
  'on hold': 'paused',
  cancelled: 'cancelled',
  cancel: 'cancelled',
  aborted: 'cancelled',
  design: 'in_process_design',
  build: 'in_process_build',
  deploy: 'in_process_deploy',
  test: 'in_process_test',
  release: 'in_process_release',
};
