/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR        | DESCRIPTION
 * -----------------------------------------------------------------------------
 * (new)               | workflow-publish | 'graph' dispatch path: runs an authored workflow's compiled
 *                       ProcessDefinition through the ProcessDefinitionExecutionEngine. Integrates the graph
 *                       engine as a queue-manager dispatch path (sibling to manifest-worker/staged/swarm),
 *                       NOT as a queue-manager replacement — so it reuses all of QueueManagerService's
 *                       polling, recovery, and sweep machinery. The engine walks the node graph (ordering,
 *                       branches, gates) and dispatches each execute-agent node to its pinned bot via the
 *                       EngineServices adapter. Supersedes dispatch-staged-worker (linear-only).
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Durable execution: load workflowCheckpoint from ticket metadata to resume with state, save a checkpoint before each node, clear on terminal; unifies + fixes the state-loss in the approval-gate resume path.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Run-history recording: optional runRecorder opens a workflow_runs row per dispatch (reused across suspend/resume via metadata.workflowRunId), streams per-node steps via the engine's onStep observer, and closes the run with its terminal disposition. Fire-and-forget like saveCheckpoint — every recorder call is non-throwing so a recording failure can never break a run.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Register the multi-app planner's plan-step executor on the engine instance so a compiled NL plan runs on this same graph rail (data-passing between app-bot steps + approval gates). Additive: studio-authored graphs never emit plan-step nodes.
 */

import type { InternalTicket } from '@/entities/ticket';
import type { TicketService } from '@/features/ticketing';
import type { BotNodeClient } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import {
  ProcessDefinitionExecutionEngine,
  type ProcessDefinition,
  type EngineStateSnapshot,
  type WorkflowRunRecorder,
} from '@/features/workflow-studio';
import { createEngineServicesAdapter } from './engine-services-adapter';
import { registerPlanStepExecutor } from './plan-step-executor';
import type { WorkflowDefinition } from './dispatch-routing';

const logger = createChildLogger({ module: 'dispatch-graph-worker' });

/** Dependencies for the graph dispatch path. Mirrors the staged-worker deps. */
export interface GraphWorkerDispatchDeps {
  activeTicketIds: Set<string>;
  dispatchStartTimes: Map<string, number>;
  resolveAgentIdByName?: (name: string) => Promise<string | undefined>;
  botNodeClient?: BotNodeClient;
  ticketService: TicketService;
  port?: string;
  /** Optional run-history recorder (workflow_runs / workflow_run_steps). All methods are
   *  non-throwing by contract; recording is telemetry and must never break a run. */
  runRecorder?: WorkflowRunRecorder;
}

/**
 * @description Dispatch a ticket whose workflow is an authored ProcessDefinition graph.
 * Builds the engine with a real EngineServices adapter (bot dispatch) and walks the graph
 * to completion, then writes the terminal status. Serial execute-agent nodes hand off
 * sequentially; parallel-split branches fan out concurrently and rejoin at the parallel-join.
 *
 * Human approval-gate nodes SUSPEND the run: the engine returns 'suspended' with a resume node,
 * this worker parks the ticket at approval_required, and operator approval re-polls and resumes
 * from the gate's successor (see the suspend handling below). Approval gates inside a parallel
 * branch are rejected at publish time (no cross-branch suspend).
 */
export async function dispatchGraphTicket(
  ticket: InternalTicket,
  workflow: WorkflowDefinition,
  deps: GraphWorkerDispatchDeps,
): Promise<void> {
  const { ticketId } = ticket;
  const definition = workflow.processDefinition as ProcessDefinition | undefined;
  if (!definition || !definition.nodeGraph) {
    logger.error({ ticketId, ticketType: workflow.ticketType }, 'Graph workflow has no ProcessDefinition/nodeGraph — escalating');
    await deps.ticketService.updateStatus(ticketId, 'escalated', {
      reason: 'graph_workflow_definition_missing',
      source: 'dispatch-graph-worker',
      ticketType: workflow.ticketType,
    }).catch(() => undefined);
    return;
  }

  deps.activeTicketIds.add(ticketId);
  deps.dispatchStartTimes.set(ticketId, Date.now());
  // Hoisted so the catch path can close the run record on a dispatch failure.
  let runId: string | null = null;

  try {
    const engineServices = createEngineServicesAdapter({
      resolveAgentIdByName: deps.resolveAgentIdByName,
      botNodeClient: deps.botNodeClient,
      ticketService: deps.ticketService,
      port: deps.port,
    });
    const engine = new ProcessDefinitionExecutionEngine(engineServices);
    // Multi-app planner: teach this engine the plan-step node type so a compiled NL plan (ordered
    // app-bot delegations with data-passing) runs here. No-op for studio-authored graphs.
    registerPlanStepExecutor(engine);

    // Resume from a durable checkpoint if one exists (approval-gate suspend OR a crash/restart:
    // a graph ticket stays 'approved' during execution, so if the process dies mid-run the next
    // poll re-dispatches it here and it resumes from the checkpoint instead of restarting).
    const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
    const checkpoint = (meta.workflowCheckpoint ?? null) as { resumeNodeId?: string; snapshot?: EngineStateSnapshot } | null;
    const legacyResumeNode = typeof meta.graphResumeNode === 'string' ? meta.graphResumeNode : undefined;
    const resumeFromNodeId = checkpoint?.resumeNodeId ?? legacyResumeNode;
    const resumeState = checkpoint?.snapshot;

    // Persist a checkpoint before each node runs (and once past an approval gate). Non-throwing so
    // a checkpoint write can never break the run; keeps liveMeta so other metadata keys survive.
    let liveMeta: Record<string, unknown> = { ...meta };
    const saveCheckpoint = async (resumeNodeId: string, snapshot: EngineStateSnapshot): Promise<void> => {
      try {
        liveMeta = { ...liveMeta, workflowCheckpoint: { resumeNodeId, snapshot } };
        await deps.ticketService.updateTicket(ticketId, { metadata: liveMeta });
      } catch (err) {
        logger.warn({ err, ticketId, resumeNodeId }, 'Failed to persist workflow checkpoint (continuing)');
      }
    };
    const clearCheckpoint = async (): Promise<void> => {
      if (!('workflowCheckpoint' in liveMeta) && !('graphResumeNode' in liveMeta) && !('workflowRunId' in liveMeta)) return;
      try {
        const { workflowCheckpoint: _c, graphResumeNode: _g, workflowRunId: _r, ...rest } = liveMeta;
        liveMeta = rest;
        await deps.ticketService.updateTicket(ticketId, { metadata: rest });
      } catch (err) {
        logger.warn({ err, ticketId }, 'Failed to clear workflow checkpoint (continuing)');
      }
    };

    // Run-history recording (fire-and-forget, like saveCheckpoint): open (or re-open) the run row
    // and persist its id in metadata so a suspend/resume or crash/restart continues the SAME run.
    runId = await openRunRecord(ticket, workflow, deps, liveMeta, Boolean(resumeFromNodeId));
    if (runId && liveMeta.workflowRunId !== runId) {
      liveMeta = { ...liveMeta, workflowRunId: runId };
      await deps.ticketService.updateTicket(ticketId, { metadata: liveMeta }).catch((err) => {
        logger.warn({ err, ticketId, runId }, 'Failed to persist workflowRunId in ticket metadata (continuing)');
      });
    }
    const recorder = deps.runRecorder;
    const finishRunRecord = async (status: 'completed' | 'escalated' | 'suspended' | 'error', outcome?: string, reason?: string): Promise<void> => {
      if (!recorder || !runId) return;
      await recorder.finishRun(runId, { status, outcome, reason }).catch((err) => {
        logger.warn({ err, ticketId, runId, status }, 'Failed to close workflow run record (continuing)');
      });
    };

    const activeRunId = runId;
    const result = await engine.execute(
      definition,
      ticket as unknown as Record<string, unknown>,
      resumeFromNodeId,
      {
        resumeState,
        onCheckpoint: saveCheckpoint,
        onStep: recorder && activeRunId
          ? (event) => recorder.recordStep(activeRunId, event).catch((err) => {
            logger.warn({ err, ticketId, runId: activeRunId, nodeId: event.nodeId }, 'Failed to record workflow run step (continuing)');
          })
          : undefined,
      },
    );
    logger.info(
      { ticketId, outcome: result.outcome, success: result.success, steps: result.trace.length, resumed: Boolean(resumeFromNodeId) },
      'Graph workflow execution step completed',
    );

    if (result.outcome === 'suspended') {
      // Park at a human approval gate. The engine already checkpointed PAST the gate (resume node +
      // accumulated state), so operator approval re-dispatches and resumes with state intact. If
      // there's no successor node, treat the gate as the end and complete.
      if (!result.resumeNodeId) {
        await finishRunRecord('completed', 'completed', result.reason);
        await clearCheckpoint();
        await deps.ticketService.updateStatus(ticketId, 'complete');
      } else {
        // 'approved' -> 'approval_required' is not a direct legal transition; that state is
        // only reachable from in-process/paused states. Pass through 'paused' (both edges are
        // valid) so the ticket lands at approval_required and the cockpit surfaces it as
        // needing approval. Operator approval (PUT /resume) does approval_required -> approved.
        try {
          await deps.ticketService.updateStatus(ticketId, 'paused');
        } catch {
          /* already paused on a re-run — ignore */
        }
        await deps.ticketService.updateStatus(ticketId, 'approval_required');
        await finishRunRecord('suspended', 'suspended', result.reason);
        logger.info({ ticketId, resumeNode: result.resumeNodeId }, 'Graph workflow paused at approval gate — awaiting operator approval (state checkpointed)');
      }
      return;
    }

    // Terminal: close the run record, then clear the checkpoint so a future run starts clean.
    await finishRunRecord(
      result.outcome === 'completed' ? 'completed' : result.outcome === 'error' ? 'error' : 'escalated',
      result.outcome,
      result.reason,
    );
    await clearCheckpoint();
    const status = result.outcome === 'completed' ? 'complete' : 'escalated';
    await deps.ticketService.updateStatus(
      ticketId,
      status,
      status === 'escalated'
        ? {
          reason: 'graph_workflow_execution_failed',
          source: 'dispatch-graph-worker',
          outcome: result.outcome,
        }
        : undefined,
    );
  } catch (error) {
    logger.error({ err: error, ticketId, ticketType: workflow.ticketType }, 'Graph workflow dispatch failed');
    if (deps.runRecorder && runId) {
      await deps.runRecorder.finishRun(runId, {
        status: 'error',
        outcome: 'error',
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
    await deps.ticketService.updateStatus(ticketId, 'escalated', {
      reason: 'graph_workflow_dispatch_failed',
      source: 'dispatch-graph-worker',
      ticketType: workflow.ticketType,
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  } finally {
    deps.activeTicketIds.delete(ticketId);
    deps.dispatchStartTimes.delete(ticketId);
  }
}

/**
 * @description Open (or re-open) the run-history record for this dispatch. On a resume
 * (approval-gate approval or crash/restart re-poll) the prior run row referenced by
 * metadata.workflowRunId is re-opened so the whole lifecycle stays ONE logical run; otherwise
 * a fresh row is inserted. Non-throwing: any failure returns null and the run proceeds
 * unrecorded (recording is telemetry, never a gate).
 * @param ticket - the dispatched ticket
 * @param workflow - the resolved workflow definition
 * @param deps - graph worker deps (recorder optional)
 * @param meta - the ticket's live metadata (workflowRunId is read from here)
 * @param resuming - whether this dispatch resumes from a checkpoint
 * @returns the active runId, or null when recording is off/unavailable
 */
async function openRunRecord(
  ticket: InternalTicket,
  workflow: WorkflowDefinition,
  deps: GraphWorkerDispatchDeps,
  meta: Record<string, unknown>,
  resuming: boolean,
): Promise<string | null> {
  const recorder = deps.runRecorder;
  if (!recorder) return null;
  try {
    const priorRunId = typeof meta.workflowRunId === 'string' ? meta.workflowRunId : undefined;
    if (priorRunId && resuming) {
      const reopened = await recorder.resumeRun(priorRunId);
      if (reopened) return priorRunId;
    }
    return await recorder.startRun({
      ticketId: ticket.ticketId,
      ownerSub: ticket.ownerSub ?? null,
      ticketType: workflow.ticketType,
      workflowName: workflow.name,
    });
  } catch (error) {
    logger.warn({ err: error, ticketId: ticket.ticketId }, 'Failed to open workflow run record (run continues unrecorded)');
    return null;
  }
}
