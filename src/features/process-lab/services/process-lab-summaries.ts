/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from process-lab-service.ts (1000-line cap decomposition): pure summarizers that flatten work items, swarm runs, and trace reports into lab artifact shapes
 */

import type { WorkItem } from '@/entities/work-item';
import type { SwarmRunRecord, TicketTraceReport } from '@/features/swarm-orchestration';
import type {
  ProcessLabSwarmRunSummary,
  ProcessLabTraceSummary,
  ProcessLabWorkItemSummary,
} from './process-lab-types';

/**
 * @description Flattens a full work-item entity into the condensed, serializable summary the lab reports on, omitting heavyweight execution/verification payloads in favor of presence flags.
 * @param item The work item produced during the traced run.
 * @returns The condensed work-item summary for the run artifacts.
 */
export function summarizeWorkItem(item: WorkItem): ProcessLabWorkItemSummary {
  return {
    ...(item.assignedAgentId ? { assignedAgentId: item.assignedAgentId } : {}),
    hasExecutionOutput: typeof item.executionOutput !== 'undefined',
    hasVerificationResult: typeof item.verificationResult !== 'undefined',
    status: item.status,
    title: item.title,
    unitId: item.unitId,
    updatedAt: item.updatedAt,
    workItemId: item.workItemId,
  };
}

/**
 * @description Condenses a swarm run record into the lab's reporting shape, summarizing each processed item's decomposition breadth and selected strategy/agent.
 * @param run The swarm run record related to the traced ticket.
 * @returns The condensed swarm-run summary for the run artifacts.
 */
export function summarizeSwarmRun(run: SwarmRunRecord): ProcessLabSwarmRunSummary {
  return {
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    itemCount: run.itemCount,
    processed: run.processed.map((processed) => ({
      externalId: processed.externalId,
      planningDecompositionCount: processed.planningDecomposition?.length ?? 0,
      ...(processed.selectedAgentId ? { selectedAgentId: processed.selectedAgentId } : {}),
      ...(processed.selectedStrategy ? { selectedStrategy: processed.selectedStrategy } : {}),
      title: processed.title,
      workUnitCount: processed.workUnitCount,
    })),
    runId: run.runId,
    startedAt: run.startedAt,
    status: run.status,
  };
}

/**
 * @description Flattens a runtime trace report into the lab's trace summary, surfacing anomaly and regression counts plus per-trace metadata while replacing raw tool calls with a count.
 * @param report The ticket trace report produced by the runtime trace analyzer.
 * @returns The flattened trace summary for the run artifacts.
 */
export function summarizeTraceReport(report: TicketTraceReport): ProcessLabTraceSummary {
  return {
    anomalyCount: report.anomalies.length,
    anomalies: report.anomalies.map((anomaly) => ({
      detail: anomaly.detail,
      runtimeTaskId: anomaly.runtimeTaskId,
      type: anomaly.type,
    })),
    regressionCount: report.regressionHandoffs.length,
    regressionHandoffs: report.regressionHandoffs.map((handoff) => ({
      createdAt: handoff.createdAt,
      feedback: handoff.feedback,
      findings: handoff.findings,
      regressionCount: handoff.regressionCount,
      sourcePhase: handoff.sourcePhase,
    })),
    traceCount: report.traceCount,
    traces: report.traces.map((trace) => ({
      agentId: trace.agentId,
      completionType: trace.completionType,
      createdAt: trace.createdAt,
      externalId: trace.externalId,
      phase: trace.phase,
      role: trace.role,
      round: trace.round,
      runtimeTaskId: trace.runtimeTaskId,
      toolCallCount: trace.toolCalls.length,
    })),
    workspaceTaskId: report.workspaceTaskId,
  };
}
