/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from queue-manager-service.ts (1000-line cap decomposition): module-level dispatch helpers — planning-role normalization/inference, work-item→capability routing maps, dispatch entry-state resolution, ExternalWorkItem conversion, failed-work-item summarization, non-retryable-error detection, and child-ticket creation from PM planning output. Pure logic + the child-ticket factory; no queue state lives here. queue-manager-service re-exports the previously-public symbols so every existing call site and test is unchanged.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import {
  type InternalTicket,
  type ExternalWorkItem,
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
} from '@/entities/ticket';
import type { TicketService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import type { TaskFolderService } from './task-folder-service';

const logger = createChildLogger({ module: 'queue-manager-dispatch-helpers' });

/** @description Maximum times a ticket can be dispatched before escalation. Prevents infinite re-dispatch loops. */
export const MAX_DISPATCH_ATTEMPTS = 3;

/** @description Error signatures that are unsafe to retry via approved rollback because they indicate stalled or invalid orchestration flow. */
const NON_RETRYABLE_DISPATCH_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /Pipeline timeout after \d+ms/i,
  /Cannot start phase .* before .* is completed or skipped/i,
  /No active orchestration for ticket .* phase \d+/i,
];

/**
 * @description Finds the PM assignment matching a decomposed planning unit title.
 * @param unitTitle - Child-ticket title from PM planning output.
 * @param assignments - Optional PM assignment hints.
 * @returns Matching assignment when present.
 */
function findAssignmentForPlanningUnit(
  unitTitle: string,
  assignments?: Array<{ subtaskTitle: string; suggestedRole: string; suggestedAgentId?: string }>,
): { subtaskTitle: string; suggestedRole: string; suggestedAgentId?: string } | undefined {
  if (!assignments || assignments.length === 0) {
    return undefined;
  }

  const normalizedUnitTitle = normalizePlanningTitle(unitTitle);
  return assignments.find((assignment) => normalizePlanningTitle(assignment.subtaskTitle) === normalizedUnitTitle);
}

/**
 * @description Infers a specialist role from PM planning-unit content when the
 * structured AGENT_ASSIGNMENTS block is missing or does not match the title.
 * @param unit - PM planning unit with title, labels, work type, and criteria.
 * @returns Specialist role suitable for child-ticket routing.
 */
export function inferPlanningUnitSuggestedRole(unit: {
  title: string;
  workType?: string;
  labels?: string[];
  acceptanceCriteria?: string[];
}): string {
  const explicitRole = readSuggestedAgentRole([
    unit.title,
    unit.workType ?? '',
    ...(unit.labels ?? []),
    ...(unit.acceptanceCriteria ?? []),
  ]);
  if (explicitRole) {
    return normalizePlanningRole(explicitRole) ?? explicitRole;
  }

  const title = unit.title.toLowerCase();
  const haystack = [
    unit.workType,
    unit.title,
    ...(unit.labels ?? []),
    ...(unit.acceptanceCriteria ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (/\b(implement|implementation|code|coding|function|class|module|bugfix|fix)\b/.test(title)) {
    return 'code-developer';
  }
  if (/\b(test|tests|testing|pytest|unit test|qa|quality assurance|verify|verification)\b/.test(haystack)) {
    return 'test-engineer';
  }
  if (/\b(doc|docs|documentation|readme|guide|runbook)\b/.test(haystack)) {
    return 'documentation-writer';
  }
  if (/\b(deploy|deployment|docker|ci|pipeline|kubernetes|helm|devops)\b/.test(haystack)) {
    return 'devops-bot';
  }
  if (/\b(architect|architecture|design|planning|plan)\b/.test(haystack)) {
    return 'system-architect';
  }
  if (/\b(review|audit|security|compliance)\b/.test(haystack)) {
    return 'code-reviewer';
  }

  return 'code-developer';
}

/**
 * @description Reads explicit PM role hints from markdown or prose.
 * @param values - Candidate text values.
 * @returns Lowercase role identifier when present.
 */
function readSuggestedAgentRole(values: string[]): string | undefined {
  for (const value of values) {
    const match = value.match(/suggested\s+agent\s+role[\s:*`_-]+([a-z][a-z0-9_-]+)/i);
    if (match?.[1]) {
      return match[1].toLowerCase();
    }
  }

  return undefined;
}

/**
 * @description Normalizes PM role labels to canonical local swarm bot names.
 * @param role - Raw role string from PM output or metadata.
 * @returns Canonical role name when a known alias is found.
 */
export function normalizePlanningRole(role: string | undefined): string | undefined {
  const normalized = role
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized) {
    return undefined;
  }

  const aliases: Record<string, string> = {
    developer: 'code-developer',
    engineer: 'code-developer',
    executor: 'code-developer',
    coder: 'code-developer',
    'software-engineer': 'code-developer',
    'code-engineer': 'code-developer',
    tester: 'test-engineer',
    test: 'test-engineer',
    qa: 'test-engineer',
    'qa-engineer': 'test-engineer',
    'quality-engineer': 'test-engineer',
    'quality-assurance': 'test-engineer',
    reviewer: 'code-reviewer',
    review: 'code-reviewer',
    'security-reviewer': 'code-reviewer',
    writer: 'documentation-writer',
    documenter: 'documentation-writer',
    docs: 'documentation-writer',
    documentation: 'documentation-writer',
    'technical-writer': 'documentation-writer',
    devops: 'devops-bot',
    sre: 'devops-bot',
    infrastructure: 'devops-bot',
    'infrastructure-engineer': 'devops-bot',
    architect: 'system-architect',
    architecture: 'system-architect',
    planner: 'system-architect',
    researcher: 'research-bot',
    analyst: 'research-bot',
    security: 'security-auditor-bot',
    auditor: 'security-auditor-bot',
    'security-auditor': 'security-auditor-bot',
  };

  return aliases[normalized] ?? normalized;
}

/**
 * @description Normalizes a planning title for fuzzy assignment matching.
 * @param title - Raw planning title.
 * @returns Normalized title.
 */
function normalizePlanningTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * @description Converts an InternalTicket to the ExternalWorkItem format expected by the swarm pipeline.
 * @param ticket - The internal ticket to convert
 * @returns ExternalWorkItem for swarm pipeline consumption
 */
export function buildWorkItem(ticket: InternalTicket): ExternalWorkItem & { metadata?: Record<string, unknown> } {
  return {
    externalId: ticket.ticketId,
    provider: 'direct',
    title: ticket.title,
    body: ticket.description ?? '',
    status: 'approved',
    priority: (ticket.metadata?.priority as string | undefined) ?? 'medium',
    labels: ticket.labels?.length ? ticket.labels : ((ticket.metadata?.labels as string[] | undefined) ?? []),
    workflow: buildExternalTicketWorkflow('approved', 'ticket'),
    hierarchy: buildExternalTicketHierarchy(ticket.ticketId),
    rawPayload: ticket,
    metadata: ticket.metadata as Record<string, unknown> | undefined,
  };
}

/**
 * @description Resolves the truthful lifecycle state used when the queue claims a ticket.
 * Structured root tickets enter Phase 0 discovery/planning. Child tickets and direct
 * execution work enter build immediately because they bypass PM planning.
 * @param ticket - The ticket being claimed for dispatch.
 * @param hasChildren - Whether the root ticket was already planned (children exist).
 * @returns The dispatch entry state.
 */
export function resolveDispatchEntryState(ticket: InternalTicket, hasChildren = false): 'in_process_discovery' | 'in_process_build' {
  if (ticket.parentTicketId) {
    return 'in_process_build';
  }

  // If this root ticket was already planned and has children, skip re-planning.
  // This prevents the approval_required → approved → re-plan infinite loop.
  if (hasChildren) {
    return 'in_process_build';
  }

  const metadata = ticket.metadata ?? {};
  const recommendedPath = typeof metadata.recommendedPath === 'string' ? metadata.recommendedPath : undefined;
  const planningMode = typeof metadata.planningMode === 'string' ? metadata.planningMode : undefined;
  const bypassesPlanning = recommendedPath === 'instant-answer'
    || recommendedPath === 'direct-execution'
    || planningMode === 'none'
    || planningMode === 'lightweight';

  return bypassesPlanning ? 'in_process_build' : 'in_process_discovery';
}

/**
 * @description Maps root-ticket intake metadata into routing capabilities.
 * Structured-project work keeps the existing broad ticket-label behavior and flows
 * into PM planning. Instant-answer and direct-execution root tickets use narrower
 * capabilities so they can bypass heavyweight planning and route straight to the
 * best available responder or specialist.
 * @param metadata - Root ticket intake metadata.
 * @param ticketLabels - The ticket's own labels.
 * @returns Routing capabilities, or undefined to leave routing unconstrained.
 */
export function resolveRootTicketCapabilities(
  metadata: Record<string, unknown>,
  ticketLabels: string[],
): string[] | undefined {
  const recommendedPath = typeof metadata.recommendedPath === 'string' ? metadata.recommendedPath : undefined;
  const outcomeType = typeof metadata.outcomeType === 'string' ? metadata.outcomeType : undefined;
  const metadataCapabilities = Array.isArray(metadata.requiredCapabilities)
    ? metadata.requiredCapabilities.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  if (metadataCapabilities.length > 0) {
    return [...new Set(metadataCapabilities)];
  }

  if (recommendedPath === 'instant-answer') {
    return ['conversation', 'analysis'];
  }

  if (recommendedPath === 'direct-execution') {
    const mapped: Record<string, string[]> = {
      'question-answer': ['conversation', 'analysis'],
      'small-change': ['code', 'implementation'],
      'proof-of-concept': ['implementation', 'analysis'],
      'integration': ['integration', 'implementation'],
      'investigation': ['research', 'analysis'],
      'product-delivery': ['implementation'],
    };
    const outcomeMapped = outcomeType ? mapped[outcomeType] : undefined;
    if (outcomeMapped?.length) {
      return outcomeMapped;
    }
    if (ticketLabels.length > 0) {
      return ticketLabels;
    }
    return ['implementation'];
  }

  return ticketLabels.length > 0 ? ticketLabels : undefined;
}

/**
 * @description Maps workType and PM-assigned role to specialist agent capabilities.
 * Used to route child tickets directly to the right specialist instead of PM.
 * Matches the legacy pattern: depth 1+ tickets bypass PM and go to specialists.
 *
 * @param workType - Work type from ticket metadata (implementation, testing, etc.)
 * @param pmAssignedRole - Role assigned by PM in AGENT_ASSIGNMENTS
 * @returns Array of required capabilities for agent routing
 */
export function resolveSpecialistCapabilities(
  workType: string | undefined,
  pmAssignedRole: string | undefined,
): string[] {
  // PM-assigned role takes priority
  const normalizedPmRole = normalizePlanningRole(pmAssignedRole);
  if (normalizedPmRole) {
    const roleMap: Record<string, string[]> = {
      'code-developer': ['code', 'implementation'],
      'test-engineer': ['testing', 'validation'],
      'documentation-writer': ['documentation', 'technical-writing'],
      'code-reviewer': ['code-review', 'security'],
      'system-architect': ['architecture', 'design'],
      'devops-bot': ['infrastructure', 'cicd'],
      'research-bot': ['research', 'analysis'],
      'security-auditor-bot': ['security', 'compliance'],
    };
    const mapped = roleMap[normalizedPmRole];
    if (mapped) return mapped;
  }

  // Fall back to workType mapping
  const workTypeMap: Record<string, string[]> = {
    implementation: ['code', 'implementation'],
    testing: ['testing', 'validation'],
    documentation: ['documentation', 'technical-writing'],
    review: ['code-review', 'quality'],
    integration: ['code', 'implementation', 'integration'],
    analysis: ['research', 'analysis'],
  };

  return workTypeMap[workType ?? ''] ?? ['code', 'implementation'];
}

/**
 * @description Returns a readable error message regardless of error shape.
 * @param error - Unknown dispatch error
 * @returns Normalized message text
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '';
}

/** A failed work item's debuggable summary, as embedded in escalation metadata. */
export interface FailedWorkItemSummary {
  unitId?: string;
  title?: string;
  assignedAgentId?: string;
  /** Best-effort human error pulled from executionOutput/metadata, bounded + secret-free. */
  error?: string;
}

/**
 * @description Pulls a bounded, human-readable failure reason out of a failed work item's
 * `executionOutput` or `metadata`. The eval-wall's complaint was that a build escalation records
 * WHICH escalation but not WHY — this recovers the "why" (the agent/CLI error that failed the
 * item) so a `pipeline_work_items_failed` escalation is actually debuggable. Never surfaces raw
 * objects wholesale (could carry prompts/secrets) — only known string error fields, capped.
 * @param item - A work item (only the fields we read are required).
 * @returns A short error string, or '' when none can be found.
 */
export function extractWorkItemError(item: {
  executionOutput?: unknown;
  metadata?: Record<string, unknown> | null;
}): string {
  const cap = (s: string): string => (s.length > 300 ? `${s.slice(0, 300)}…` : s).trim();
  const fromValue = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>;
      for (const key of ['error', 'errorMessage', 'message', 'stderr', 'failureReason']) {
        const v = rec[key];
        if (typeof v === 'string' && v.trim().length > 0) return v;
      }
    }
    return '';
  };
  const found = fromValue(item.executionOutput) || fromValue(item.metadata ?? undefined);
  return found ? cap(found) : '';
}

/**
 * @description Summarizes the failed work items behind a `pipeline_work_items_failed` escalation
 * into debuggable-but-bounded metadata (the FIRST few, not the whole set — an escalation row must
 * stay small). Turns "N items failed" into "here are the items and why each failed", which is what
 * the 2026-06-22 eval-wall diagnosis asked for.
 * @param items - The work items linked to the escalating ticket.
 * @param max - Cap on how many failed items to embed (default 5).
 * @returns Per-item summaries for the failed items (empty when none failed).
 */
export function summarizeFailedWorkItems(
  items: Array<{
    status?: string;
    unitId?: string;
    title?: string;
    assignedAgentId?: string;
    executionOutput?: unknown;
    metadata?: Record<string, unknown> | null;
  }>,
  max = 5,
): FailedWorkItemSummary[] {
  return items
    .filter((item) => item.status === 'failed')
    .slice(0, Math.max(0, max))
    .map((item) => {
      const error = extractWorkItemError(item);
      const summary: FailedWorkItemSummary = {};
      if (item.unitId) summary.unitId = item.unitId;
      if (item.title) summary.title = item.title;
      if (item.assignedAgentId) summary.assignedAgentId = item.assignedAgentId;
      if (error) summary.error = error;
      return summary;
    });
}

/**
 * @description Detects failures that should escalate immediately instead of rollback+retry.
 * @param error - Unknown dispatch error
 * @returns True when the failure signature is known to be non-retryable in queue-manager flow
 */
export function isNonRetryableDispatchError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (message.length === 0) {
    return false;
  }

  return NON_RETRYABLE_DISPATCH_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * @description Dependencies for creating child tickets from PM planning output.
 * Mirrors the slices of QueueManagerPipelineDeps that the factory actually uses,
 * so the QueueManagerService doesn't expose its private state to a free function.
 */
export interface ChildTicketPlanningDeps {
  /** Persistent ticket store used to create the child tickets. */
  ticketService: TicketService;
  /** @description Resolves a persona name (e.g. "code-developer") to agent UUID from the live registry. */
  resolveAgentIdByName?: (name: string) => Promise<string | undefined>;
  /** Present only when the queue manager has pipeline deps injected — gates the routing-decision log line. */
  taskFolderService?: TaskFolderService;
}

/**
 * @description Resolves a PM-assigned role name (e.g. "code-developer") to a canonical agent UUID
 * by querying the persisted agents table. Returns undefined when no match is found.
 * @param role - Raw PM-assigned role string.
 * @param resolver - Persona-name → agentId resolver from the live registry.
 * @returns Matching agent UUID, or undefined when unresolved.
 */
async function resolveRoleToAgentId(
  role: string | undefined,
  resolver?: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (!role) return undefined;
  if (!resolver) return undefined;
  const lookupRoles = [
    normalizePlanningRole(role),
    role.trim().toLowerCase(),
  ].filter((entry, index, entries): entry is string => Boolean(entry) && entries.indexOf(entry) === index);
  try {
    for (const lookupRole of lookupRoles) {
      const agentId = await resolver(lookupRole);
      if (agentId) {
        logger.info({ role, lookupRole, agentId }, 'Resolved PM-assigned role to agent ID from registry');
        return agentId;
      }
    }
    logger.warn({ role, lookupRoles }, 'PM-assigned role not found in agent registry');
  } catch (err) {
    logger.warn({ err, role, lookupRoles }, 'Failed to resolve PM-assigned role; routing will use fallback');
  }
  return undefined;
}

/**
 * @description Creates child tickets from PM-generated planning decomposition.
 * Uses LLM-generated titles and descriptions rather than the deterministic "Step N" fallback.
 * Called by the queue manager's dispatchTicket() after processTickets() returns planningDecomposition data.
 * @param parentTicket - The parent ticket being decomposed
 * @param planningUnits - PM-decomposed work units with LLM-generated titles
 * @param agentAssignments - Optional PM assignment hints (AGENT_ASSIGNMENTS block)
 * @param deps - Ticket store + registry resolver + optional task-folder logger
 * @returns Object with created child ticket IDs
 */
export async function createChildTicketsFromPlanningOutput(
  parentTicket: InternalTicket,
  planningUnits: Array<{ title: string; description: string; acceptanceCriteria: string[]; workType: string; labels: string[] }>,
  agentAssignments: Array<{ subtaskTitle: string; suggestedRole: string; suggestedAgentId?: string }> | undefined,
  deps: ChildTicketPlanningDeps,
): Promise<{ childTicketIds: string[] }> {
  const { ticketId } = parentTicket;
  const parentMetadata = parentTicket.metadata ?? {};
  const childTicketIds: string[] = [];

  logger.info(
    { ticketId, unitCount: planningUnits.length },
    'Creating child tickets from PM planning decomposition',
  );

  for (let i = 0; i < planningUnits.length; i++) {
    const unit = planningUnits[i]!;
    const assignment = findAssignmentForPlanningUnit(unit.title, agentAssignments);
    const pmAssignedRole = assignment?.suggestedRole ?? inferPlanningUnitSuggestedRole(unit);
    const pmAssignedAgentId = assignment?.suggestedAgentId
      || await resolveRoleToAgentId(pmAssignedRole, deps.resolveAgentIdByName);
    try {
      const childTicket = await deps.ticketService.createTicket({
        title: unit.title,
        ticketType: 'build',
        description: unit.description,
        status: 'approved',
        priority: 'none',
        labels: unit.labels ?? [],
        parentTicketId: ticketId,
        workspaceId: null,
        assignedAgentId: pmAssignedAgentId ?? null,
        externalProvider: null,
        externalId: null,
        externalUrl: null,
        metadata: {
          ...parentMetadata,
          workType: unit.workType,
          depth: 1,
          acceptanceCriteria: unit.acceptanceCriteria,
          subtaskTitle: unit.title,
          pmAssignedRole,
          pmAssignedAgentId,
        },
      });

      childTicketIds.push(childTicket.ticketId);
      logger.info(
        {
          parentTicketId: ticketId,
          childTicketId: childTicket.ticketId,
          workType: unit.workType,
          pmAssignedRole,
          pmAssignedAgentId,
          title: unit.title,
        },
        'Created child ticket from PM planning output',
      );
    } catch (err) {
      logger.error(
        { err, ticketId, unitIndex: i, title: unit.title },
        'Failed to create child ticket from planning output — continuing with remaining units',
      );
    }
  }

  if (deps.taskFolderService) {
    deps.taskFolderService.appendRoutingDecision(
      ticketId,
      `PM planning decomposed into ${planningUnits.length} units, created ${childTicketIds.length} child tickets`,
      'queue-manager',
    );
  }

  logger.info(
    { ticketId, childTicketIds, unitCount: planningUnits.length },
    'Child ticket creation from PM planning complete',
  );

  return { childTicketIds };
}
