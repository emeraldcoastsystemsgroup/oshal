/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation: GET /api/v1/tickets/:ticketId/workflow read model. Ownership and application-result access are checked before anything else, then a redacted projection is returned: the currently registered definition (explicitly not a run snapshot), the latest owner-matched graph run, status history, graph-gate receipts and direct child tickets. Each source degrades to an explicit "unavailable" flag instead of failing the whole read. Imports go through the swarm-orchestration and workflow-studio barrels, and the handler is split into one loader per source.
 */
import type { Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../composition-root';
import type { InternalTicket } from '@/entities/ticket';
import { WorkflowPipelineRegistry } from '@/features/swarm-orchestration';
import {
  WorkflowRunHistoryStore,
  redactRunPayload,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from '@/features/workflow-studio';
import { canAccessResource } from '@/shared/middleware/authz';
import { createChildLogger } from '@/shared/logger';
import { canReadTicketApplicationResult } from './ticket-application-access';
import { projectWorkflowGateReceipts, type WorkflowGateReceipt } from './ticket-workflow-approval-receipts';

const logger = createChildLogger({ module: 'cockpit-ticket-workflow-route' });
const MAX_GRAPH_NODES = 200;
const MAX_GRAPH_EDGES = 400;
const MAX_RUN_STEPS = 200;

/** The registered workflow definition shape, taken from the registry's own resolve signature. */
type RegisteredWorkflow = NonNullable<ReturnType<WorkflowPipelineRegistry['resolve']>>;
type RunReader = Pick<WorkflowRunHistoryStore, 'listRuns' | 'getRun'>;

/**
 * @description Injectable collaborators for the ticket workflow read. Tests pass doubles; production
 * resolves the run-history store from the pool and the definition from the pipeline registry.
 */
export interface TicketWorkflowRouteDeps {
  runReader?: RunReader | null;
  resolveWorkflow?: (ticketType: string) => RegisteredWorkflow | undefined;
  canReadApplicationResult?: typeof canReadTicketApplicationResult;
}

interface HistoryProjection {
  available: boolean;
  approvalGates: WorkflowGateReceipt[];
  entries: Array<{ fromStatus: string; toStatus: string; changedByLabel: string; createdAt: string }>;
}

interface ChildrenProjection {
  available: boolean;
  entries: Array<{ ticketId: string; title: string; status: string; ticketType: string; assignedAgentId: string }>;
}

interface RunProjection {
  available: boolean;
  run: ReturnType<typeof projectRun> | null;
  otherRunCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function label(value: unknown, limit = 200): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function projectGraphNode(raw: unknown) {
  const node = record(raw);
  const config = record(node.config);
  const type = label(node.type, 80);
  return {
    id: label(node.id, 120),
    type,
    title: label(node.title),
    agentBinding: ['execute-agent', 'verify-output', 'review'].includes(type)
      ? label(config.agentBinding || config.agentId, 120)
      : '',
  };
}

function projectGraphEdge(raw: unknown) {
  const edge = record(raw);
  return {
    source: label(edge.source, 120),
    target: label(edge.target, 120),
    label: label(edge.label, 120),
  };
}

function projectDefinition(workflow: RegisteredWorkflow | undefined) {
  if (!workflow) return null;
  const graph = record(record(workflow.processDefinition).nodeGraph);
  const rawNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph.edges) ? graph.edges : [];
  return {
    name: label(workflow.name),
    pipeline: label(workflow.pipeline, 80),
    ticketType: label(workflow.ticketType, 80),
    defaultWorkerBot: label(workflow.workerBot, 120),
    declaredReviewerBot: label(workflow.reviewerBot, 120),
    // Registry contents may have changed since the ticket ran. This is NOT a run snapshot.
    historicalSnapshot: false,
    graphTruncated: rawNodes.length > MAX_GRAPH_NODES || rawEdges.length > MAX_GRAPH_EDGES,
    nodes: rawNodes.slice(0, MAX_GRAPH_NODES).map(projectGraphNode),
    edges: rawEdges.slice(0, MAX_GRAPH_EDGES).map(projectGraphEdge),
  };
}

function projectRun(run: WorkflowRunDetail) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  return {
    runId: run.runId,
    workflowName: label(run.workflowName),
    status: label(run.status, 80),
    outcome: label(run.outcome, 120),
    reason: String(redactRunPayload(label(run.reason, 400))),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    resumedCount: run.resumedCount,
    stepCount: steps.length,
    stepsTruncated: steps.length > MAX_RUN_STEPS,
    steps: steps.slice(0, MAX_RUN_STEPS).map((step) => ({
      stepId: step.stepId,
      seq: step.seq,
      nodeId: label(step.nodeId, 120),
      nodeType: label(step.nodeType, 80),
      nodeTitle: label(step.nodeTitle),
      agentId: label(step.agentId, 120),
      status: label(step.status, 80),
      inputSummary: redactRunPayload(step.inputSummary),
      outputSummary: redactRunPayload(step.outputSummary),
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
  };
}

async function loadHistory(ctx: AppContext, ticket: InternalTicket): Promise<HistoryProjection> {
  try {
    const history = await ctx.ticketService.getStatusHistory(ticket.ticketId, 100);
    return {
      available: true,
      approvalGates: projectWorkflowGateReceipts(history, ticket.status),
      entries: history.map((entry) => ({
        fromStatus: label(entry.fromStatus, 80),
        toStatus: label(entry.toStatus, 80),
        changedByLabel: label(entry.changedByLabel || entry.changedBy, 160),
        createdAt: entry.createdAt,
      })),
    };
  } catch (error) {
    logger.error({ err: error, ticketId: ticket.ticketId }, 'Ticket workflow history unavailable');
    return { available: false, approvalGates: [], entries: [] };
  }
}

async function loadChildren(ctx: AppContext, ticketId: string, ownerSub: string | null): Promise<ChildrenProjection> {
  try {
    const children = await ctx.ticketService.listTickets({ parentTicketId: ticketId, ownerSub: ownerSub ?? '', limit: 100 });
    return {
      available: true,
      entries: children
        .filter((child) => child.ownerSub === ownerSub && child.parentTicketId === ticketId)
        .map((child) => ({
          ticketId: child.ticketId,
          title: label(child.title),
          status: label(child.status, 80),
          ticketType: label(child.ticketType, 80),
          assignedAgentId: label(child.assignedAgentId, 120),
        })),
    };
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Ticket workflow children unavailable');
    return { available: false, entries: [] };
  }
}

async function loadRun(
  runReader: RunReader | null,
  ticketId: string,
  ownerSub: string | null,
  currentRunId: string,
): Promise<RunProjection> {
  if (!runReader || !ownerSub) return { available: false, run: null, otherRunCount: 0 };
  try {
    const runs = await runReader.listRuns({ ticketId, ownerSub, limit: 20 });
    const matching = runs.filter((run: WorkflowRunSummary) => run.ticketId === ticketId && run.ownerSub === ownerSub);
    const selected = matching.find((run: WorkflowRunSummary) => run.runId === currentRunId) ?? matching[0];
    if (!selected) return { available: true, run: null, otherRunCount: 0 };
    const detail = await runReader.getRun(selected.runId);
    if (!detail || detail.ticketId !== ticketId || detail.ownerSub !== ownerSub) {
      return { available: false, run: null, otherRunCount: 0 };
    }
    return { available: true, run: projectRun(detail), otherRunCount: matching.length - 1 };
  } catch (error) {
    logger.error({ err: error, ticketId }, 'Ticket workflow run unavailable');
    return { available: false, run: null, otherRunCount: 0 };
  }
}

function buildWorkflowPayload(
  ticket: InternalTicket,
  workflow: RegisteredWorkflow | undefined,
  sources: { history: HistoryProjection; children: ChildrenProjection; run: RunProjection },
) {
  const metadata = record(ticket.metadata);
  const { history, children, run } = sources;
  return {
    success: true,
    ticket: {
      ticketId: ticket.ticketId,
      title: label(ticket.title),
      ticketType: label(ticket.ticketType, 80),
      queueId: label(metadata.queueId, 120),
      queueName: label(metadata.queueName, 160),
      status: label(ticket.status, 80),
      assignedAgentId: label(ticket.assignedAgentId, 120),
    },
    definition: projectDefinition(workflow),
    run: run.run,
    runHistoryAvailable: run.available,
    otherRunCount: run.otherRunCount,
    history: history.entries,
    historyAvailable: history.available,
    approvalGates: history.approvalGates,
    children: children.entries,
    childrenAvailable: children.available,
  };
}

/**
 * @description Owner- and application-scoped read model for one ticket's current route and observed
 * work. A ticket the caller cannot read answers 404 (never 403) so its existence is not disclosed;
 * each secondary source (history, children, run) degrades to an explicit unavailable flag.
 * @param ctx - Composition context providing the ticket service and database pool.
 * @param deps - Optional collaborators; omitted entries resolve to the production implementations.
 * @returns Express handler for GET /tickets/:ticketId/workflow.
 */
export function handleGetCockpitTicketWorkflow(ctx: AppContext, deps: TicketWorkflowRouteDeps = {}): RequestHandler {
  const runReader = deps.runReader === undefined
    ? (ctx.pool ? new WorkflowRunHistoryStore(ctx.pool) : null)
    : deps.runReader;
  const resolveWorkflow = deps.resolveWorkflow ?? ((ticketType: string) => WorkflowPipelineRegistry.getInstance().resolve(ticketType));
  const canReadApplicationResult = deps.canReadApplicationResult ?? canReadTicketApplicationResult;

  return async (req: Request, res: Response) => {
    const ticketId = String(req.params.ticketId || '');
    const startedAt = Date.now();
    logger.debug({ ticketId }, 'Ticket workflow read requested');
    try {
      const ticket = await ctx.ticketService.getTicket(ticketId);
      if (!ticket || !canAccessResource(req, ticket.ownerSub ?? null)
        || !await canReadApplicationResult(ctx, req, ticket)) {
        res.status(404).json({ success: false, error: 'Ticket not found' });
        return;
      }
      const ownerSub = ticket.ownerSub ?? null;
      const currentRunId = label(record(ticket.metadata).workflowRunId, 120);
      const [history, children, run] = await Promise.all([
        loadHistory(ctx, ticket),
        loadChildren(ctx, ticketId, ownerSub),
        loadRun(runReader, ticketId, ownerSub, currentRunId),
      ]);
      res.json(buildWorkflowPayload(ticket, resolveWorkflow(ticket.ticketType || ''), { history, children, run }));
      logger.debug({ ticketId, durationMs: Date.now() - startedAt }, 'Ticket workflow read served');
    } catch (error) {
      logger.error({ err: error, ticketId }, 'Failed to load ticket workflow');
      res.status(500).json({ success: false, error: 'Failed to load ticket workflow' });
    }
  };
}
