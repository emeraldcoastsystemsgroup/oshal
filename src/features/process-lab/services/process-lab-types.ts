/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted from process-lab-service.ts (1000-line cap decomposition): shared Process Lab interfaces and ticket-status classification sets
 */

import type {
  InternalTicket,
  TicketPriority,
  TicketStatusHistoryRecord,
  OshalTicketState,
} from '@/entities/ticket';

/**
 * @description Ticket statuses the lab treats as terminal outcomes: once a traced ticket reaches one of these, watching stops and artifact collection begins.
 */
export const TERMINAL_TICKET_STATUSES = new Set<OshalTicketState>([
  'complete',
  'cancelled',
  'escalated',
  'customer_action',
]);

/**
 * @description Ticket statuses that indicate the ticket entered (or moved past) the build pipeline, used to detect builds that started without an observed approval gate.
 */
export const BUILD_LIKE_TICKET_STATUSES = new Set<OshalTicketState>([
  'in_process_build',
  'in_process_test',
  'in_process_release',
  'in_process_deploy',
  'customer_action',
  'complete',
  'escalated',
  'cancelled',
]);

/**
 * @description Defines a reusable Process Lab test scenario: the request to run, its complexity tier, and the timing/approval knobs that control how the ticket lifecycle is exercised and traced.
 */
export interface ProcessLabScenario {
  id: string;
  name: string;
  complexity: 'low' | 'medium' | 'high';
  description: string;
  goal: string;
  autoApproveBuild: boolean;
  planningWaitMs: number;
  completionWaitMs: number;
  ticket: {
    title: string;
    description: string;
    labels: string[];
    priority: TicketPriority;
  };
}

/**
 * @description Input for starting a Process Lab run: selects a scenario by id and optionally overrides ticket and timing fields so callers can tweak a run without defining a new scenario.
 */
export interface StartProcessLabRunInput {
  scenarioId: string;
  overrides?: {
    autoApproveBuild?: boolean;
    completionWaitMs?: number;
    description?: string;
    planningWaitMs?: number;
    priority?: TicketPriority;
    title?: string;
  };
}

/**
 * @description A timestamped log entry captured during a run, used to build a human-readable timeline of what the lab observed and any warnings or errors.
 */
export interface ProcessLabEvent {
  at: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

/**
 * @description Tracks the progress and outcome of one discrete phase of a run (e.g. preflight, create ticket, assessment) so the UI can show step-by-step status.
 */
export interface ProcessLabStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  message?: string;
}

/**
 * @description A snapshot of queue and swarm-run state taken before a run starts, used to judge whether the environment is clean enough for a clean trace and to give context for the assessment.
 */
export interface ProcessLabPreflightSnapshot {
  activeCount: number;
  approvalRequiredCount: number;
  approvedCount: number;
  busyCount: number;
  escalatedCount: number;
  inProcessBuildCount: number;
  inProcessDesignCount: number;
  nonTerminalSample: Array<{
    status: string;
    ticketId: string;
    title: string;
  }>;
  swarmRunCount: number;
  swarmRunInProgressCount: number;
}

/**
 * @description A condensed, serializable view of a work item produced during a run, exposing only the fields the lab reports on rather than the full work-item entity.
 */
export interface ProcessLabWorkItemSummary {
  assignedAgentId?: string;
  hasExecutionOutput: boolean;
  hasVerificationResult: boolean;
  status: string;
  title: string;
  unitId: string;
  updatedAt: string;
  workItemId: string;
}

/**
 * @description A condensed view of a swarm run related to the traced ticket, summarizing its processed items, planning decomposition, and selected strategy/agent for reporting.
 */
export interface ProcessLabSwarmRunSummary {
  completedAt?: string;
  itemCount: number;
  processed: Array<{
    externalId: string;
    planningDecompositionCount: number;
    selectedAgentId?: string;
    selectedStrategy?: string;
    title: string;
    workUnitCount: number;
  }>;
  runId: string;
  startedAt: string;
  status: string;
}

/**
 * @description A flattened summary of a runtime trace report for the traced ticket, surfacing anomalies, regression handoffs, and per-trace metadata for the run's artifacts.
 */
export interface ProcessLabTraceSummary {
  anomalyCount: number;
  anomalies: Array<{
    detail: string;
    runtimeTaskId: string;
    type: string;
  }>;
  regressionCount: number;
  regressionHandoffs: Array<{
    createdAt: string;
    feedback: string | null;
    findings: string[];
    regressionCount: number;
    sourcePhase: number;
  }>;
  traceCount: number;
  traces: Array<{
    agentId: string | null;
    completionType: string;
    createdAt: string | null;
    externalId: string | null;
    phase: number | null;
    role: string | null;
    round: number | null;
    runtimeTaskId: string;
    toolCallCount: number;
  }>;
  workspaceTaskId: string;
}

/**
 * @description The full bundle of evidence collected for a run (ticket, child tickets, status history, work items, related swarm runs, and trace summary) that the assessment is built from.
 */
export interface ProcessLabArtifacts {
  childTickets: InternalTicket[];
  preflight?: ProcessLabPreflightSnapshot;
  relatedSwarmRuns: ProcessLabSwarmRunSummary[];
  statusHistory: TicketStatusHistoryRecord[];
  ticket?: InternalTicket | null;
  trace?: ProcessLabTraceSummary;
  workItems: ProcessLabWorkItemSummary[];
  workspaceTaskId?: string;
}

/**
 * @description A single diagnostic finding from the assessment, carrying a stable code, a human-readable message, and a severity used to roll up the overall run health.
 */
export interface ProcessLabAssessmentFinding {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

/**
 * @description The combined assessment of a run, pairing the heuristic summary and findings with an optional AI-generated narrative and overall health status.
 */
export interface ProcessLabAssessment {
  generatedAt: string;
  heuristicSummary: string;
  findings: ProcessLabAssessmentFinding[];
  providerName?: string;
  status: 'healthy' | 'attention' | 'failed';
  aiSummary?: string;
  aiSummaryError?: string;
}

/**
 * @description The complete in-memory state of a single Process Lab run, including its scenario, step progress, event log, collected artifacts, and final assessment.
 */
export interface ProcessLabRun {
  artifacts?: ProcessLabArtifacts;
  assessment?: ProcessLabAssessment;
  completedAt?: string;
  currentStepId?: string;
  error?: string;
  events: ProcessLabEvent[];
  runId: string;
  scenario: ProcessLabScenario;
  startedAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  steps: ProcessLabStep[];
  ticketId?: string;
  ticketStatus?: string;
  updatedAt: string;
}

/**
 * @description A lightweight, list-friendly projection of a run used by listings, exposing identity, scenario, status, and latest-event fields without the full run detail.
 */
export interface ProcessLabRunSummary {
  assessmentStatus?: ProcessLabAssessment['status'];
  completedAt?: string;
  latestEvent?: ProcessLabEvent;
  runId: string;
  scenarioComplexity: ProcessLabScenario['complexity'];
  scenarioId: string;
  scenarioName: string;
  startedAt: string;
  status: ProcessLabRun['status'];
  ticketId?: string;
  ticketStatus?: string;
  updatedAt: string;
}
