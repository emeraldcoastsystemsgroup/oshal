/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added non-invasive Process Lab runner for ticket lifecycle tracing, artifact capture, and optional AI assessment
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 1000-line cap decomposition: moved interfaces/status sets to process-lab-types.ts, scenario catalog to process-lab-scenarios.ts, summarizers to process-lab-summaries.ts, and assessment builders to process-lab-assessment.ts; public exports re-exported here unchanged
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InternalTicket } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import type { LLMService } from '@/features/llm-provider';
import {
  RuntimeTraceAnalyzerService,
  type SwarmTicketProcessingService,
} from '@/features/swarm-orchestration';
import type { TicketService, WorkspaceService } from '@/features/ticketing';
import { createChildLogger } from '@/shared/logger';
import { buildAiAssessmentPrompt, buildHeuristicAssessment, extractTextContent } from './process-lab-assessment';
import { DEFAULT_SCENARIOS, INITIAL_STEP_DEFINITIONS } from './process-lab-scenarios';
import { summarizeSwarmRun, summarizeTraceReport, summarizeWorkItem } from './process-lab-summaries';
import {
  BUILD_LIKE_TICKET_STATUSES,
  TERMINAL_TICKET_STATUSES,
  type ProcessLabArtifacts,
  type ProcessLabAssessment,
  type ProcessLabEvent,
  type ProcessLabPreflightSnapshot,
  type ProcessLabRun,
  type ProcessLabRunSummary,
  type ProcessLabScenario,
  type ProcessLabStep,
  type ProcessLabTraceSummary,
  type StartProcessLabRunInput,
} from './process-lab-types';

export type {
  ProcessLabArtifacts,
  ProcessLabAssessment,
  ProcessLabAssessmentFinding,
  ProcessLabEvent,
  ProcessLabPreflightSnapshot,
  ProcessLabRun,
  ProcessLabRunSummary,
  ProcessLabScenario,
  ProcessLabStep,
  ProcessLabSwarmRunSummary,
  ProcessLabTraceSummary,
  ProcessLabWorkItemSummary,
  StartProcessLabRunInput,
} from './process-lab-types';

const logger = createChildLogger({ module: 'process-lab-service' });

const DEFAULT_PROJECT_METADATA = {
  project: 'Process Lab',
  projectId: 'process-lab',
  projectIdentifier: 'process-lab',
  projectName: 'Process Lab',
  workspaceSlug: 'process-lab',
} as const;

interface ProcessLabServiceDeps {
  getProvider: () => LLMService;
  swarmTicketProcessingService?: Pick<SwarmTicketProcessingService, 'listRuns'>;
  ticketService: TicketService;
  traceAnalyzer?: RuntimeTraceAnalyzerService;
  workItemRepository?: Pick<WorkItemRepository, 'findByExternalIdAnyProvider'>;
  workspaceService: WorkspaceService;
}

interface PlanningWatchResult {
  observedStatuses: string[];
  reachedApprovalGate: boolean;
  ticket: InternalTicket;
}

/**
 * @description Orchestrates non-invasive Process Lab runs that drive a scenario ticket through its lifecycle, observe planning and build gates, collect artifacts, and produce heuristic plus optional AI assessments. Runs are tracked in memory and exposed for listing and inspection.
 */
export class ProcessLabService {
  private readonly runs = new Map<string, ProcessLabRun>();
  private readonly scenarios = new Map<string, ProcessLabScenario>(DEFAULT_SCENARIOS.map((scenario) => [scenario.id, scenario]));
  private readonly traceAnalyzer: RuntimeTraceAnalyzerService;

  /**
   * @description Constructs the service with its collaborators, defaulting to a fresh trace analyzer when one is not injected.
   * @param deps Service dependencies (provider accessor, ticket/workspace services, and optional swarm, work-item, and trace collaborators).
   */
  constructor(private readonly deps: ProcessLabServiceDeps) {
    this.traceAnalyzer = deps.traceAnalyzer ?? new RuntimeTraceAnalyzerService();
  }

  /**
   * @description Returns deep copies of the built-in scenarios so callers can present available runs without mutating the service's defaults.
   * @returns The list of available Process Lab scenarios.
   */
  listScenarios(): ProcessLabScenario[] {
    return DEFAULT_SCENARIOS.map((scenario) => cloneValue(scenario));
  }

  /**
   * @description Returns the most recent runs as lightweight summaries, sorted newest-first and capped to the requested limit.
   * @param limit Maximum number of run summaries to return (defaults to 20).
   * @returns Summaries of the most recent runs.
   */
  listRuns(limit = 20): ProcessLabRunSummary[] {
    return [...this.runs.values()]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, limit)
      .map((run) => this.buildRunSummary(run));
  }

  /**
   * @description Looks up a single run by id and returns a deep copy so callers cannot mutate the stored state, or null when no such run exists.
   * @param runId The identifier of the run to fetch.
   * @returns A copy of the run, or null if not found.
   */
  getRun(runId: string): ProcessLabRun | null {
    const run = this.runs.get(runId);
    return run ? cloneValue(run) : null;
  }

  /**
   * @description Resolves the requested scenario (applying any overrides), registers a queued run, and kicks off its asynchronous execution in the background, returning the initial run state immediately.
   * @param input The scenario id and optional ticket/timing overrides for the run.
   * @returns A copy of the newly queued run.
   */
  startRun(input: StartProcessLabRunInput): ProcessLabRun {
    const scenario = this.resolveScenario(input.scenarioId, input.overrides);
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run: ProcessLabRun = {
      events: [],
      runId,
      scenario,
      startedAt: now,
      status: 'queued',
      steps: INITIAL_STEP_DEFINITIONS.map((step) => ({ ...step, status: 'pending' })),
      updatedAt: now,
    };

    this.runs.set(runId, run);
    this.addEvent(runId, 'info', 'Scenario queued', {
      complexity: scenario.complexity,
      scenarioId: scenario.id,
    });

    void this.executeRun(runId).catch((error) => {
      logger.error({ err: error, runId }, 'Process Lab run failed');
      this.failRun(runId, error instanceof Error ? error.message : String(error));
    });

    return cloneValue(run);
  }

  private resolveScenario(
    scenarioId: string,
    overrides?: StartProcessLabRunInput['overrides'],
  ): ProcessLabScenario {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) {
      throw new Error(`Unknown Process Lab scenario: ${scenarioId}`);
    }

    if (!overrides) {
      return cloneValue(scenario);
    }

    return {
      ...cloneValue(scenario),
      autoApproveBuild: overrides.autoApproveBuild ?? scenario.autoApproveBuild,
      completionWaitMs: overrides.completionWaitMs ?? scenario.completionWaitMs,
      planningWaitMs: overrides.planningWaitMs ?? scenario.planningWaitMs,
      ticket: {
        ...cloneValue(scenario.ticket),
        description: overrides.description ?? scenario.ticket.description,
        priority: overrides.priority ?? scenario.ticket.priority,
        title: overrides.title ?? scenario.ticket.title,
      },
    };
  }

  private async executeRun(runId: string): Promise<void> {
    this.updateRun(runId, (run) => {
      run.status = 'running';
      run.updatedAt = new Date().toISOString();
    });

    let preflight: ProcessLabPreflightSnapshot | undefined;

    try {
      preflight = await this.runPreflight(runId);
      const createdTicket = await this.createTraceTicket(runId);
      const planningResult = await this.watchPlanning(runId, createdTicket.ticketId);
      await this.approveBuildGate(runId, planningResult.ticket, planningResult.reachedApprovalGate);
      const finalTicket = await this.watchOutcome(runId, createdTicket.ticketId);
      const artifacts = await this.collectArtifacts(runId, finalTicket.ticketId, preflight);
      await this.runAssessment(runId, artifacts);

      this.updateRun(runId, (run) => {
        run.artifacts = artifacts;
        run.completedAt = new Date().toISOString();
        run.currentStepId = undefined;
        run.status = 'completed';
        run.ticketStatus = finalTicket.status;
        run.updatedAt = new Date().toISOString();
      });
      this.addEvent(runId, 'info', 'Scenario completed', { ticketId: finalTicket.ticketId, finalStatus: finalTicket.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addEvent(runId, 'error', 'Scenario execution failed', { error: message });

      const ticketId = this.runs.get(runId)?.ticketId;
      if (ticketId) {
        const artifacts = await this.safeCollectArtifacts(runId, ticketId, preflight);
        if (artifacts) {
          this.updateRun(runId, (run) => {
            run.artifacts = artifacts;
          });
          await this.runAssessment(runId, artifacts);
        }
      }

      this.failRun(runId, message);
    }
  }

  private async runPreflight(runId: string): Promise<ProcessLabPreflightSnapshot> {
    this.startStep(runId, 'preflight', 'Reading current queue and run state');

    const [tickets, runs] = await Promise.all([
      this.deps.ticketService.listTickets({ limit: 500 }),
      this.deps.swarmTicketProcessingService?.listRuns(50) ?? Promise.resolve([]),
    ]);

    const nonTerminalTickets = tickets.filter((ticket) => !TERMINAL_TICKET_STATUSES.has(ticket.status));
    const snapshot: ProcessLabPreflightSnapshot = {
      activeCount: nonTerminalTickets.length,
      approvalRequiredCount: tickets.filter((ticket) => ticket.status === 'approval_required').length,
      approvedCount: tickets.filter((ticket) => ticket.status === 'approved').length,
      busyCount: tickets.filter((ticket) => ticket.status.startsWith('in_process')).length,
      escalatedCount: tickets.filter((ticket) => ticket.status === 'escalated').length,
      inProcessBuildCount: tickets.filter((ticket) => ticket.status === 'in_process_build').length,
      inProcessDesignCount: tickets.filter((ticket) => ticket.status === 'in_process_design').length,
      nonTerminalSample: nonTerminalTickets.slice(0, 8).map((ticket) => ({
        status: ticket.status,
        ticketId: ticket.ticketId,
        title: ticket.title,
      })),
      swarmRunCount: runs.length,
      swarmRunInProgressCount: runs.filter((run) => run.status === 'in_progress').length,
    };

    const tone = snapshot.activeCount > 0 || snapshot.swarmRunInProgressCount > 0 ? 'warning' : 'info';
    this.addEvent(runId, tone, 'Preflight snapshot captured', {
      activeCount: snapshot.activeCount,
      approvedCount: snapshot.approvedCount,
      inProgressRuns: snapshot.swarmRunInProgressCount,
    });
    this.completeStep(runId, 'preflight', snapshot.activeCount > 0
      ? `Environment already has ${snapshot.activeCount} non-terminal tickets.`
      : 'Environment is clear enough for a clean trace.');
    this.updateRun(runId, (run) => {
      run.artifacts = { ...(run.artifacts ?? {}), childTickets: [], preflight: snapshot, relatedSwarmRuns: [], statusHistory: [], workItems: [] };
    });
    return snapshot;
  }

  private async createTraceTicket(runId: string): Promise<InternalTicket> {
    const run = this.requireRun(runId);
    this.startStep(runId, 'create-ticket', 'Creating approved Process Lab ticket');

    const ticket = await this.deps.ticketService.createTicket({
      ticketType: 'build',
      assignedAgentId: null,
      description: run.scenario.ticket.description,
      externalId: null,
      externalProvider: null,
      externalUrl: null,
      labels: run.scenario.ticket.labels,
      metadata: {
        ...DEFAULT_PROJECT_METADATA,
        processLabRunId: runId,
        processLabScenarioId: run.scenario.id,
      source: 'process-lab',
      },
      parentTicketId: null,
      priority: run.scenario.ticket.priority,
      status: 'approved',
      title: run.scenario.ticket.title,
      workspaceId: null,
    });

    this.updateRun(runId, (draft) => {
      draft.ticketId = ticket.ticketId;
      draft.ticketStatus = ticket.status;
    });

    this.addEvent(runId, 'info', 'Created approved ticket', {
      ticketId: ticket.ticketId,
      title: ticket.title,
    });
    this.completeStep(runId, 'create-ticket', `Ticket ${ticket.ticketId.slice(0, 8)} created in approved state.`);
    return ticket;
  }

  private async watchPlanning(runId: string, ticketId: string): Promise<PlanningWatchResult> {
    const run = this.requireRun(runId);
    this.startStep(runId, 'planning-watch', 'Watching for planning activity and approval gate');

    const deadline = Date.now() + run.scenario.planningWaitMs;
    let lastStatus = '';
    const observedStatuses: string[] = [];

    while (Date.now() <= deadline) {
      const ticket = await this.requireTicket(ticketId);
      this.updateRun(runId, (draft) => {
        draft.ticketStatus = ticket.status;
      });

      if (ticket.status !== lastStatus) {
        lastStatus = ticket.status;
        observedStatuses.push(ticket.status);
        this.addEvent(runId, 'info', 'Observed ticket status change', {
          stateGroup: ticket.stateGroup,
          status: ticket.status,
          ticketId: ticket.ticketId,
        });
      }

      if (ticket.status === 'approval_required') {
        this.completeStep(runId, 'planning-watch', 'Planning reached approval_required.');
        return { observedStatuses, reachedApprovalGate: true, ticket };
      }

      if (BUILD_LIKE_TICKET_STATUSES.has(ticket.status) || TERMINAL_TICKET_STATUSES.has(ticket.status)) {
        const message = ticket.status === 'in_process_build'
          ? 'Build started before an approval gate was observed.'
          : `Planning stage resolved into ${ticket.status}.`;
        this.completeStep(runId, 'planning-watch', message);
        return { observedStatuses, reachedApprovalGate: false, ticket };
      }

      await sleep(4_000);
    }

    throw new Error(`Timed out waiting for planning activity on ticket ${ticketId}`);
  }

  private async approveBuildGate(runId: string, ticket: InternalTicket, reachedApprovalGate: boolean): Promise<void> {
    const run = this.requireRun(runId);
    this.startStep(runId, 'approve-build', 'Handling build approval gate');

    if (!reachedApprovalGate) {
      this.addEvent(runId, 'warning', 'Approval gate was not observed before build or terminal flow', {
        ticketId: ticket.ticketId,
        status: ticket.status,
      });
      this.skipStep(runId, 'approve-build', 'Skipped because the approval gate was not observed.');
      return;
    }

    if (!run.scenario.autoApproveBuild) {
      this.skipStep(runId, 'approve-build', 'Scenario left the ticket paused at approval_required.');
      return;
    }

    await this.deps.ticketService.updateStatusAs(ticket.ticketId, 'in_process_build', 'process-lab', 'Process Lab');
    this.updateRun(runId, (draft) => {
      draft.ticketStatus = 'in_process_build';
    });
    this.addEvent(runId, 'info', 'Approved ticket for build', {
      from: 'approval_required',
      ticketId: ticket.ticketId,
      to: 'in_process_build',
    });
    this.completeStep(runId, 'approve-build', 'Parent ticket moved to in_process_build.');
  }

  private async watchOutcome(runId: string, ticketId: string): Promise<InternalTicket> {
    const run = this.requireRun(runId);
    this.startStep(runId, 'outcome-watch', 'Watching until the traced ticket reaches an outcome');

    const deadline = Date.now() + run.scenario.completionWaitMs;
    let lastStatus = run.ticketStatus ?? '';

    while (Date.now() <= deadline) {
      const ticket = await this.requireTicket(ticketId);
      this.updateRun(runId, (draft) => {
        draft.ticketStatus = ticket.status;
      });

      if (ticket.status !== lastStatus) {
        lastStatus = ticket.status;
        this.addEvent(runId, 'info', 'Observed ticket status change', {
          stateGroup: ticket.stateGroup,
          status: ticket.status,
          ticketId: ticket.ticketId,
        });
      }

      if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
        this.completeStep(runId, 'outcome-watch', `Ticket reached ${ticket.status}.`);
        return ticket;
      }

      await sleep(5_000);
    }

    throw new Error(`Timed out waiting for a terminal outcome on ticket ${ticketId}`);
  }

  private async collectArtifacts(
    runId: string,
    ticketId: string,
    preflight?: ProcessLabPreflightSnapshot,
  ): Promise<ProcessLabArtifacts> {
    this.startStep(runId, 'collect-artifacts', 'Collecting ticket history, work items, runs, and trace summary');
    const artifacts = await this.buildArtifacts(ticketId, preflight);
    this.updateRun(runId, (run) => {
      run.artifacts = artifacts;
      run.ticketStatus = artifacts.ticket?.status;
    });
    this.completeStep(runId, 'collect-artifacts', `Collected ${artifacts.statusHistory.length} status records and ${artifacts.workItems.length} work items.`);
    return artifacts;
  }

  private async safeCollectArtifacts(
    runId: string,
    ticketId: string,
    preflight?: ProcessLabPreflightSnapshot,
  ): Promise<ProcessLabArtifacts | null> {
    try {
      return await this.buildArtifacts(ticketId, preflight);
    } catch (error) {
      this.addEvent(runId, 'warning', 'Artifact collection failed during cleanup', {
        error: error instanceof Error ? error.message : String(error),
        ticketId,
      });
      return null;
    }
  }

  private async buildArtifacts(
    ticketId: string,
    preflight?: ProcessLabPreflightSnapshot,
  ): Promise<ProcessLabArtifacts> {
    const [ticket, childTickets, rawHistory, rawWorkItems, rawRuns] = await Promise.all([
      this.deps.ticketService.getTicket(ticketId),
      this.deps.ticketService.listTickets({ parentTicketId: ticketId }),
      this.deps.ticketService.getStatusHistory(ticketId, 100),
      this.deps.workItemRepository?.findByExternalIdAnyProvider(ticketId) ?? Promise.resolve([]),
      this.deps.swarmTicketProcessingService?.listRuns(100) ?? Promise.resolve([]),
    ]);

    const statusHistory = [...rawHistory].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    const workItems = rawWorkItems.map((item) => summarizeWorkItem(item));
    const relatedSwarmRuns = rawRuns
      .filter((run) => run.processed.some((processed) => processed.externalId === ticketId))
      .map((run) => summarizeSwarmRun(run))
      .slice(0, 12);

    const trace = ticket ? await this.maybeBuildTraceSummary(ticket) : undefined;

    return {
      childTickets: cloneValue(childTickets),
      preflight,
      relatedSwarmRuns,
      statusHistory: cloneValue(statusHistory),
      ticket: ticket ? cloneValue(ticket) : ticket,
      trace,
      workItems,
      workspaceTaskId: trace?.workspaceTaskId,
    };
  }

  private async maybeBuildTraceSummary(ticket: InternalTicket): Promise<ProcessLabTraceSummary | undefined> {
    const workspaceTaskId = await this.resolveWorkspaceTaskId(ticket);
    if (!workspaceTaskId) {
      return undefined;
    }

    try {
      const report = this.traceAnalyzer.buildTicketTraceReport(ticket.ticketId, workspaceTaskId);
      return summarizeTraceReport(report);
    } catch (error) {
      logger.warn({ err: error, ticketId: ticket.ticketId, workspaceTaskId }, 'Failed to build Process Lab trace summary');
      return undefined;
    }
  }

  private async resolveWorkspaceTaskId(ticket: InternalTicket): Promise<string | undefined> {
    if (ticket.workspaceId) {
      const workspace = await this.deps.workspaceService.getWorkspace(ticket.workspaceId);
      if (workspace?.path) {
        return path.basename(workspace.path);
      }
    }

    const directWorkspaceCandidate = path.resolve(process.cwd(), 'workspace-shared', ticket.ticketId);
    return path.basename(directWorkspaceCandidate);
  }

  private async runAssessment(runId: string, artifacts: ProcessLabArtifacts): Promise<void> {
    this.startStep(runId, 'assessment', 'Building heuristic findings and optional AI summary');
    const heuristicAssessment = buildHeuristicAssessment(this.requireRun(runId), artifacts);
    const aiSummaryResult = await this.buildAiSummary(runId, artifacts, heuristicAssessment);

    const assessment: ProcessLabAssessment = {
      ...heuristicAssessment,
      generatedAt: new Date().toISOString(),
      ...(aiSummaryResult?.aiSummary ? { aiSummary: aiSummaryResult.aiSummary } : {}),
      ...(aiSummaryResult?.providerName ? { providerName: aiSummaryResult.providerName } : {}),
      ...(aiSummaryResult?.error ? { aiSummaryError: aiSummaryResult.error } : {}),
    };

    this.updateRun(runId, (run) => {
      run.assessment = assessment;
    });
    this.completeStep(runId, 'assessment', `Assessment marked the run as ${assessment.status}.`);
  }

  private async buildAiSummary(
    runId: string,
    artifacts: ProcessLabArtifacts,
    assessment: Omit<ProcessLabAssessment, 'generatedAt' | 'providerName' | 'aiSummary' | 'aiSummaryError'>,
  ): Promise<{ aiSummary?: string; error?: string; providerName?: string } | null> {
    try {
      const provider = this.deps.getProvider();
      const providerName = provider.getProviderName();
      const prompt = buildAiAssessmentPrompt(this.requireRun(runId), artifacts, assessment);
      const response = await provider.sendRequest({
        agentId: 'process-lab',
        interactionMode: 'chat',
        maxTokens: 900,
        messages: [{ content: prompt, role: 'user' }],
        systemPrompt: 'You are the OSHAL Process Lab analyst. Explain what happened in a swarm trace, what is healthy, and what needs attention. Be specific and concise.',
        taskId: `process-lab-assessment-${runId}`,
        temperature: 0.2,
      });
      const aiSummary = extractTextContent(response).trim();
      if (!aiSummary) {
        return { error: 'Provider returned an empty assessment.', providerName };
      }
      this.addEvent(runId, 'info', 'AI assessment completed', { providerName });
      return { aiSummary, providerName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addEvent(runId, 'warning', 'AI assessment skipped', { error: message });
      return { error: message };
    }
  }

  private buildRunSummary(run: ProcessLabRun): ProcessLabRunSummary {
    return {
      assessmentStatus: run.assessment?.status,
      completedAt: run.completedAt,
      latestEvent: run.events[run.events.length - 1],
      runId: run.runId,
      scenarioComplexity: run.scenario.complexity,
      scenarioId: run.scenario.id,
      scenarioName: run.scenario.name,
      startedAt: run.startedAt,
      status: run.status,
      ticketId: run.ticketId,
      ticketStatus: run.ticketStatus,
      updatedAt: run.updatedAt,
    };
  }

  private requireRun(runId: string): ProcessLabRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Process Lab run not found: ${runId}`);
    }
    return run;
  }

  private async requireTicket(ticketId: string): Promise<InternalTicket> {
    const ticket = await this.deps.ticketService.getTicket(ticketId);
    if (!ticket) {
      throw new Error(`Ticket not found: ${ticketId}`);
    }
    return ticket;
  }

  private startStep(runId: string, stepId: string, message: string): void {
    this.updateRun(runId, (run) => {
      const step = requireStep(run, stepId);
      step.status = 'running';
      step.startedAt = step.startedAt ?? new Date().toISOString();
      step.message = message;
      run.currentStepId = stepId;
      run.updatedAt = new Date().toISOString();
    });
    this.addEvent(runId, 'info', message, { stepId });
  }

  private completeStep(runId: string, stepId: string, message: string): void {
    this.finishStep(runId, stepId, 'completed', message);
  }

  private skipStep(runId: string, stepId: string, message: string): void {
    this.finishStep(runId, stepId, 'skipped', message);
  }

  private failStep(runId: string, stepId: string, message: string): void {
    this.finishStep(runId, stepId, 'failed', message);
  }

  private finishStep(
    runId: string,
    stepId: string,
    status: ProcessLabStep['status'],
    message: string,
  ): void {
    this.updateRun(runId, (run) => {
      const step = requireStep(run, stepId);
      step.completedAt = new Date().toISOString();
      step.message = message;
      step.startedAt = step.startedAt ?? step.completedAt;
      step.status = status;
      if (run.currentStepId === stepId) {
        run.currentStepId = undefined;
      }
      run.updatedAt = new Date().toISOString();
    });
  }

  private addEvent(
    runId: string,
    level: ProcessLabEvent['level'],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.updateRun(runId, (run) => {
      run.events.push({
        at: new Date().toISOString(),
        data,
        level,
        message,
      });
      if (run.events.length > 250) {
        run.events.splice(0, run.events.length - 250);
      }
      run.updatedAt = new Date().toISOString();
    });
  }

  private failRun(runId: string, error: string): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }

    if (run.currentStepId) {
      this.failStep(runId, run.currentStepId, error);
    }

    this.updateRun(runId, (draft) => {
      draft.completedAt = new Date().toISOString();
      draft.currentStepId = undefined;
      draft.error = error;
      draft.status = 'failed';
      draft.updatedAt = new Date().toISOString();
    });
  }

  private updateRun(runId: string, mutate: (run: ProcessLabRun) => void): void {
    const current = this.requireRun(runId);
    const draft = cloneValue(current);
    mutate(draft);
    draft.updatedAt = draft.updatedAt ?? new Date().toISOString();
    this.runs.set(runId, draft);
  }
}

function requireStep(run: ProcessLabRun, stepId: string): ProcessLabStep {
  const step = run.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new Error(`Process Lab step not found: ${stepId}`);
  }
  return step;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
