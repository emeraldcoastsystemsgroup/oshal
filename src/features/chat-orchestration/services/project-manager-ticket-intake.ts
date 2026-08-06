/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added project-manager ticket intake resolution so direct PM chat creates canonical internal tickets and dedicated linked tasks before orchestration
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched PM intake onto shared ticket-project metadata helpers so direct PM tickets inherit the platform-wide Default-project contract
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Changed ticket creation default status from backlog to approved so queue manager processes tickets immediately
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Carry the authenticated message owner onto both the canonical ticket and chat task so their row ownership matches the narrowed request identity under RLS.
 */

import { DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_ID, mergeTicketProjectMetadata } from '@/entities/ticket';
import type { ITaskStore } from '@/entities/task';
import type { TicketService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'project-manager-ticket-intake' });

const PROJECT_MANAGER_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';
const PROJECT_MANAGER_NAME = 'project-manager';

const CREATE_TICKET_PATTERNS = [
  /\bcreate\b[\w\s-]{0,32}\bticket\b/i,
  /\bnew\b[\w\s-]{0,16}\bticket\b/i,
  /\bopen\b[\w\s-]{0,32}\bticket\b/i,
  /\bfile\b[\w\s-]{0,32}\bticket\b/i,
  /\blog\b[\w\s-]{0,32}\bticket\b/i,
  /\braise\b[\w\s-]{0,32}\bticket\b/i,
  /\bsubmit\b[\w\s-]{0,32}\bticket\b/i,
  /\bneed\b[\w\s-]{0,32}\bticket\b/i,
];

/**
 * @description Dependencies required to resolve project-manager ticket intake.
 */
export interface ProjectManagerTicketIntakeDeps {
  taskStore: ITaskStore;
  ticketService: TicketService;
}

/**
 * @description Canonical ticket context attached to orchestrated PM intake tasks.
 */
export interface TicketContextNote {
  ticketId: string;
  title: string;
  status: string;
  projectName: string;
  createdFromIntake: boolean;
}

/**
 * @description Resolution payload for one message send after ticket-intake analysis.
 */
export interface ProjectManagerTicketExecutionContext {
  taskId: string;
  ticketCreated: boolean;
  ticketId?: string;
  ticketStatus?: string;
  ticketTitle?: string;
  source: string;
  ticketContext?: TicketContextNote;
}

interface ResolveTicketIntakeArgs {
  requestedTaskId: string;
  resolvedAgentId: string;
  source: string;
  text: string;
  /** Accountable owner resolved from the validated session or trusted service-user header. */
  ownerSub?: string;
  /** When true, skip ticket auto-creation regardless of message content. Default: false. */
  chatOnly?: boolean;
}

/**
 * @description Resolves whether a direct PM chat message should create a canonical internal ticket first.
 * When ticket intake is detected, a dedicated PM task is created and linked to that ticket.
 *
 * @param deps - Task/ticket persistence dependencies.
 * @param args - Message execution inputs.
 * @returns Execution context describing the task/ticket that should back orchestration.
 */
export async function resolveProjectManagerTicketExecutionContext(
  deps: ProjectManagerTicketIntakeDeps,
  args: ResolveTicketIntakeArgs,
): Promise<ProjectManagerTicketExecutionContext> {
  if (args.chatOnly || !shouldCreateTicketForMessage(args.resolvedAgentId, args.text)) {
    return {
      taskId: args.requestedTaskId,
      ticketCreated: false,
      source: args.source,
    };
  }

  const title = deriveTicketTitle(args.text);
  const ticket = await deps.ticketService.createTicket(
    buildTicketInput(title, args.text, args.resolvedAgentId, args.ownerSub),
  );
  const task = await deps.taskStore.create(
    buildTaskInput(title, ticket.ticketId, args.resolvedAgentId, args.requestedTaskId, args.ownerSub),
  );
  await deps.ticketService.linkTask(ticket.ticketId, task.taskId, 'primary');

  logger.info(
    { ticketId: ticket.ticketId, taskId: task.taskId, requestedTaskId: args.requestedTaskId, agentId: args.resolvedAgentId },
    'Created canonical internal ticket and dedicated PM task for direct ticket intake',
  );

  return {
    taskId: task.taskId,
    ticketCreated: true,
    ticketId: ticket.ticketId,
    ticketStatus: ticket.status,
    ticketTitle: ticket.title,
    source: 'swarmbot-ticket-intake',
    ticketContext: buildTicketContext(ticket.ticketId, ticket.title, ticket.status),
  };
}

function shouldCreateTicketForMessage(agentId: string, text: string): boolean {
  if (!isProjectManagerAgent(agentId)) {
    return false;
  }
  return CREATE_TICKET_PATTERNS.some((pattern) => pattern.test(text));
}

function isProjectManagerAgent(agentId: string): boolean {
  const normalized = normalizeValue(agentId);
  return normalized === PROJECT_MANAGER_AGENT_ID || normalized === PROJECT_MANAGER_NAME;
}

function buildTicketInput(title: string, description: string, agentId: string, ownerSub?: string) {
  return {
    title,
    ticketType: 'build' as const,
    description,
    // Inbound from PM chat is explicit work intake; queue it immediately so the QueueManager
    // can pick it up on the next poll cycle instead of stranding it in manual triage.
    status: 'approved' as const,
    priority: 'none' as const,
    labels: [],
    workspaceId: null,
    assignedAgentId: agentId,
    ownerSub,
    parentTicketId: null,
    externalProvider: null,
    externalId: null,
    externalUrl: null,
    metadata: mergeTicketProjectMetadata({
      intakeSource: 'project-manager-direct-chat',
    }),
  };
}

function buildTaskInput(
  title: string,
  ticketId: string,
  agentId: string,
  requestedTaskId: string,
  ownerSub?: string,
) {
  return {
    title,
    processingMode: 'agentic' as const,
    agentId,
    ownerSub,
    metadata: mergeTicketProjectMetadata({
      source: 'project-manager-ticket-intake',
      ticketId,
      requestedTaskId,
    }),
  };
}

function buildTicketContext(ticketId: string, title: string, status: string): TicketContextNote {
  return {
    ticketId,
    title,
    status,
    projectName: DEFAULT_PROJECT_NAME,
    createdFromIntake: true,
  };
}

function deriveTicketTitle(text: string): string {
  const normalized = normalizeWhitespace(text);
  const suffix = extractTicketSuffix(normalized);
  const candidate = stripPolitePrefix(suffix || normalized);
  return ensureSentenceTitle(candidate || 'New Swarm Ticket');
}

function extractTicketSuffix(text: string): string {
  const match = text.match(/\bticket\b(?:\s+(?:to|for|about|that)\b)?\s*(.+)$/i);
  return normalizeWhitespace(match?.[1] || '');
}

function stripPolitePrefix(text: string): string {
  return text.replace(/^(please|hey|hi|hello|i need|need)\s+/i, '').trim();
}

function ensureSentenceTitle(text: string): string {
  const trimmed = text.replace(/[.?!]+$/g, '').trim();
  if (!trimmed) {
    return 'New Swarm Ticket';
  }
  const capped = trimmed.length > 120 ? `${trimmed.slice(0, 117).trim()}...` : trimmed;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}
