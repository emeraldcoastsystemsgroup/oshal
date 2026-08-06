/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm ticket processing service for the original lifecycle orchestration loop
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Refactored provider processing into helper methods to enforce function length constraints
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added provider write-back integration for swarm lifecycle cycle updates
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit ticket-mode boundary and canonical ticket-state projection for provider write-back
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Realigned Plane write-back progression with legacy queue-manager phase semantics and final customer-action transition
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Added bounded verification policy and retry-aware write-back handling for testable swarm execution
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit escalation propagation and retry delay handling across swarm processing write-back flow
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Added escalation store integration and run-timing propagation for max-cycle and duration guardrails
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Added optional WorkItemRepository for persistent work unit tracking across swarm lifecycle
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Fixed execution output polling timeout cap from 120s to 600s to support long-running LLM tasks
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | Added processTickets for direct ticket submission bypassing intake adapters
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | Added 2-level hierarchical subtask support: parent in-review, subtask lifecycle, completion rollup
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | Wired SubtaskLifecycleService into processing pipeline: parent registration, subtask tracking, per-subtask dispatch
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | Extracted writeback methods to SwarmWritebackHandler to enforce 1000-line file cap
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | Wired dispatchSubtask callback into runExecutionPolicy for integrated per-subtask dispatch
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | Updated call sites for async SubtaskLifecycleService methods (store-backed persistence)
 * 17 | maintainer@emeraldcoastsystemsgroup.com   | Added delivery-phase metrics recording so ticket completion is tracked, not just execution
 * 18 | maintainer@emeraldcoastsystemsgroup.com   | Added work-unit text hints to routing so selection can use implementation criteria, not just ticket titles
 * 19 | maintainer@emeraldcoastsystemsgroup.com   | Added TicketService setter and internal ticket upsert at processOneTicket intake
 * 20 | maintainer@emeraldcoastsystemsgroup.com   | Extracted subtask + routing methods to SwarmSubtaskHandler and SwarmRoutingHandler for governance compliance
 * 21 | maintainer@emeraldcoastsystemsgroup.com   | Added online-agent resolver setter so runtime routing can target live swarm workers only
 * 22 | maintainer@emeraldcoastsystemsgroup.com   | Wired MultiRoundDispatchService into execution phase for multi-agent dispatch with handover enforcement
 * 23 | maintainer@emeraldcoastsystemsgroup.com   | Propagated shared workspaceTaskId through consensus review delegation to keep review sessions on the top-parent workspace
 * 24 | maintainer@emeraldcoastsystemsgroup.com   | Stage 3: Wired PhaseRegressionService for testing/review regression loops and QueueGovernanceService for phase-level state tracking. Regression on testing/review failure re-enters execution with feedback injection. Escalation when regression limit exceeded.
 * 25 | maintainer@emeraldcoastsystemsgroup.com   | Stage 3.5: Wired PM agent into planning phase — Phase 2 now dispatches to PM via MultiRoundDispatchService instead of deterministic parseBodySteps. PM reads ticket, produces structured SUBTASK DECOMPOSITION, parsed into real work units. Falls back to deterministic when multi-round not wired.
 * 26 | maintainer@emeraldcoastsystemsgroup.com   | Phase context propagation: selectAgent() now accepts phaseContext param, all 3 call sites in processOneTicket() pass currentPhase/ticketDepth/complexity/executorAgentId. PhaseRoutingService now activates at runtime.
 * 27 | maintainer@emeraldcoastsystemsgroup.com   | Extracted Phase 2 planning orchestration into PlanningRoundOrchestrator and removed planning-only work item side effects before decomposition short-circuit
 * 28 | maintainer@emeraldcoastsystemsgroup.com   | Hardened work-item persistence so duplicate deterministic unitIds do not recreate completed rows during retry cycles
 * 29 | maintainer@emeraldcoastsystemsgroup.com   | TD-2: Regression loop-back — Phases 4-6 now wrapped in bounded loop. Testing/review failures trigger real re-execution of Phase 4 with regression feedback injection instead of escalating.
 * 30 | maintainer@emeraldcoastsystemsgroup.com   | Wired SwarmMetricsCollector into all processOneTicket exit paths — recordTicketMetrics now called on every ticket completion/escalation/planning-only finish
 * 31 | maintainer@emeraldcoastsystemsgroup.com   | Session 19: Imported enforceHandoverGate for handover enforcement hardening — gate checks now available on multi-round phase transitions
 * 32 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed retired legacy product references (provider name is noop; narration removed)
 * 33 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: propagate the durable TicketService authority to lifecycle memory persistence.
 */

import { randomUUID } from 'crypto';
import type { ExternalWorkItem, TicketInteractionMode } from '@/entities/ticket';
import type { WorkItemRepository } from '@/entities/work-item';
import type { AgentProfileRepository } from '@/entities/agent';
import { createChildLogger } from '@/shared/logger';
import type { IntakeProvider } from '@/shared/types';
import type { IntakeService, PullWorkItemsInput } from '@/features/intake';
import {
  AgentRouter,
  MeshCommunicationService,
  PersonaLayerComposer,
  type AgentBid,
  type MeshTransport,
  type RouteCandidate,
  type SwarmMemoryService,
} from '@/features/agent-management';
import {
  TicketCycleStateMachine,
  type SwarmTicketCycle,
} from './ticket-cycle-state-machine';
import { resolvePhaseGateConfig, type PhaseGateConfig } from './phase-gate-config';
import { ConsensusReviewService } from './consensus-review-service'; // used as constructor param type
import type { CompetencyRanker } from '@/features/operational-intelligence';
import type { TicketService } from '@/features/ticketing';
import { ensureInternalTicketForWorkItem } from './swarm-internal-ticket-helper';
import { SwarmSubtaskHandler } from './swarm-subtask-handler';
import { SwarmRoutingHandler } from './swarm-routing-handler';
import { TicketDecompositionService, type DecomposedWorkUnit, type SubtaskDecompositionInput } from './ticket-decomposition-service';
import {
  InMemorySwarmRunStore,
  type SwarmProcessedTicketResult,
  type SwarmRunRecord,
  type SwarmRunStore,
} from './swarm-run-store';
import {
  SwarmCyclePolicyService,
  type SwarmCyclePolicy,
  type SwarmCyclePolicyInput,
} from './swarm-cycle-policy';
import {
  InMemorySwarmEscalationStore,
  type SwarmEscalationStore,
} from './swarm-escalation-store';
import {
  SwarmExecutionPolicyRunner,
  type SwarmExecutionPolicyOutcome,
} from './swarm-execution-policy-runner';
import { SwarmVerificationService } from './swarm-verification-service';
import {
  InMemoryMeshTransport,
  toError,
  type SwarmOnlineAgentIdsResolver,
} from './swarm-ticket-processing-support';
import type { TicketWritebackAdapter } from './ticket-writeback-adapter';
import { TicketStateProjectionService } from './ticket-state-projection-service';
import { SubtaskLifecycleService } from './subtask-lifecycle-service';
import { SwarmWritebackHandler } from './swarm-writeback-handler';
import type { MultiRoundDispatchService } from './multi-round-dispatch-service';
import type { PhaseRegressionService } from './phase-regression-service';
import type { QueueGovernanceService } from '../services/queue-governance-service';
import type { SwarmMetricsCollector, TicketProcessingMetrics } from './swarm-metrics-collector';
import { PlanningRoundOrchestrator } from './planning-round-orchestrator';
import { SwarmExecutionLifecycleService } from './swarm-execution-lifecycle-service';
import { RALFHandoverManager } from './ralf-handover-manager';
import {
  resolveWorkspaceTaskId as resolveWorkspaceTaskIdHelper,
  awaitExecutionOutput as awaitExecutionOutputHelper,
  buildProcessingResult,
  enforceHandoverGate,
} from './swarm-ticket-lifecycle-helpers';
import {
  SwarmRuntimeUnavailableError,
  type SwarmRuntimeReadiness,
  type SwarmRuntimeReadinessProbe,
  type SwarmProcessingInput,
  type SwarmProcessingResult,
} from './swarm-ticket-processing-types';

const logger = createChildLogger({ module: 'swarm-ticket-processing-service' });

interface CycleExecutionResult<T> {
  details: Record<string, unknown>;
  value: T;
}

// Public readiness/processing types now live in ./swarm-ticket-processing-types to keep this
// file under the 1000-line governance cap. Re-exported here so existing importers of this
// module continue to resolve them unchanged.
export { SwarmRuntimeUnavailableError };
export type {
  SwarmRuntimeReadiness,
  SwarmRuntimeReadinessProbe,
  SwarmProcessingInput,
  SwarmProcessingResult,
};

/**
 * @description Orchestrates intake tickets through decomposition, selection, dispatch, and verification.
 */
export class SwarmTicketProcessingService {
  private readonly meshService: MeshCommunicationService;

  private readonly executionPolicyRunner: SwarmExecutionPolicyRunner;

  private readonly writebackHandler: SwarmWritebackHandler;

  private readonly subtaskHandler: SwarmSubtaskHandler;

  private readonly routingHandler: SwarmRoutingHandler;

  private readonly planningRoundOrchestrator: PlanningRoundOrchestrator;

  private readonly executionLifecycleService: SwarmExecutionLifecycleService;

  /**
   * @description Creates a processing service with default in-memory components for local runs.
   * @param intakeService - Intake service used to pull provider work items
   * @param runStore - Optional run store implementation
   * @param decompositionService - Optional decomposition strategy implementation
   * @param agentRouter - Optional router implementation
   * @param personaComposer - Optional persona composition strategy
   * @param cyclePolicyService - Optional bounded retry and regression policy service
   * @param verificationService - Optional verification service
   * @param ticketWritebackAdapters - Optional provider write-back adapters
   * @param ticketStateProjectionService - Optional canonical ticket-state projection service
   */
  constructor(
    private readonly intakeService: IntakeService,
    private readonly runStore: SwarmRunStore = new InMemorySwarmRunStore(),
    private readonly decompositionService: TicketDecompositionService = new TicketDecompositionService(),
    private readonly agentRouter: AgentRouter = new AgentRouter(),
    private readonly personaComposer: PersonaLayerComposer = new PersonaLayerComposer(),
    private readonly cyclePolicyService: SwarmCyclePolicyService = new SwarmCyclePolicyService(),
    private readonly verificationService: SwarmVerificationService = new SwarmVerificationService(),
    private readonly ticketWritebackAdapters: TicketWritebackAdapter[] = [],
    private readonly ticketStateProjectionService: TicketStateProjectionService = new TicketStateProjectionService(),
    private readonly escalationStore: SwarmEscalationStore = new InMemorySwarmEscalationStore(),
    private readonly workItemRepository?: WorkItemRepository,
    meshTransport?: MeshTransport,
    private readonly agentProfileRepository?: AgentProfileRepository,
    private readonly subtaskLifecycleService: SubtaskLifecycleService = new SubtaskLifecycleService(),
    private readonly swarmMemoryService?: SwarmMemoryService,
    private readonly consensusReviewService?: ConsensusReviewService,
    private readonly competencyRanker?: CompetencyRanker,
    private readonly recordDeliveryMetrics?: (event: {
      agentId: string; ticketExternalId: string; swarmRunId: string;
      durationMs: number; outcome: 'completed' | 'failed' | 'escalated';
      retryCount: number; verificationAttempts: number;
    }) => void,
    private readonly runtimeReadinessProbe?: SwarmRuntimeReadinessProbe,
  ) {
    this.meshService = new MeshCommunicationService(meshTransport || new InMemoryMeshTransport());
    this.executionPolicyRunner = new SwarmExecutionPolicyRunner(
      this.verificationService,
      this.cyclePolicyService,
      this.decompositionService,
      this.subtaskLifecycleService,
    );
    this.writebackHandler = new SwarmWritebackHandler(
      this.ticketWritebackAdapters,
      this.ticketStateProjectionService,
      this.cyclePolicyService,
    );
    this.subtaskHandler = new SwarmSubtaskHandler(
      this.decompositionService,
      this.subtaskLifecycleService,
      this.meshService,
      this.workItemRepository,
      (externalId, policy) => awaitExecutionOutputHelper(externalId, policy, this.workItemRepository),
    );
    this.routingHandler = new SwarmRoutingHandler(
      this.agentRouter,
      this.personaComposer,
      this.agentProfileRepository,
      this.competencyRanker,
      this.consensusReviewService,
    );
    this.planningRoundOrchestrator = new PlanningRoundOrchestrator({
      decompositionService: this.decompositionService,
      getMultiRoundDispatch: () => this.multiRoundDispatch,
      selectAgent: (item, input, workUnits, phaseContext) => this.selectAgent(item, input, workUnits, phaseContext),
      registerParentsWithLifecycle: (workUnits) => this.registerParentsWithLifecycle(workUnits),
      persistWorkItems: (runId, item, workUnits, assignedAgentId) => this.persistWorkItems(runId, item, workUnits, assignedAgentId),
    });
    this.executionLifecycleService = new SwarmExecutionLifecycleService({
      executionPolicyRunner: this.executionPolicyRunner,
      meshService: this.meshService,
      routingHandler: this.routingHandler,
      subtaskHandler: this.subtaskHandler,
      writebackHandler: this.writebackHandler,
      cyclePolicyService: this.cyclePolicyService,
      escalationStore: this.escalationStore,
      workItemRepository: this.workItemRepository,
      swarmMemoryService: this.swarmMemoryService,
      recordDeliveryMetrics: this.recordDeliveryMetrics,
      getRegressionService: () => this.regressionService,
      getGovernanceService: () => this.governanceService,
      selectAgent: (item, input, workUnits, phaseContext) => this.selectAgent(item, input, workUnits, phaseContext),
      handoverManager: new RALFHandoverManager(),
    });
  }

  /** @description Optional TicketService — injected post-construction to avoid expanding the constructor. */
  private ticketService?: TicketService;

  /** @description Optional MultiRoundDispatchService — enables multi-agent dispatch per phase (legacy parity). */
  private multiRoundDispatch?: MultiRoundDispatchService;

  /** @description Optional PhaseRegressionService — enables regression loops on testing/review failure. */
  private regressionService?: PhaseRegressionService;

  /** @description Optional QueueGovernanceService — enables phase-level state tracking. */
  private governanceService?: QueueGovernanceService;

  /** @description Optional SwarmMetricsCollector — records per-ticket processing metrics for cockpit dashboards. */
  private metricsCollector?: SwarmMetricsCollector;

  /**
   * @description Sets the ticket service for internal ticket creation during swarm processing.
   * @param service - TicketService instance from composition root
   */
  setTicketService(service: TicketService): void {
    this.ticketService = service;
    this.executionLifecycleService.setTicketService(service);
    logger.info('TicketService wired into SwarmTicketProcessingService');
  }

  /**
   * @description Sets the phase regression service for testing/review regression loops.
   * @param service - PhaseRegressionService instance from composition root
   */
  setPhaseRegressionService(service: PhaseRegressionService): void {
    this.regressionService = service;
    logger.info('PhaseRegressionService wired into SwarmTicketProcessingService');
  }

  /**
   * @description Sets the queue governance service for phase-level state tracking.
   * @param service - QueueGovernanceService instance from composition root
   */
  setGovernanceService(service: QueueGovernanceService): void {
    this.governanceService = service;
    logger.info('QueueGovernanceService wired into SwarmTicketProcessingService');
  }

  /**
   * @description Sets the metrics collector for recording per-ticket processing metrics.
   * @param collector - SwarmMetricsCollector instance from composition root
   */
  setMetricsCollector(collector: SwarmMetricsCollector): void {
    this.metricsCollector = collector;
    logger.info('SwarmMetricsCollector wired into SwarmTicketProcessingService');
  }

  /**
   * @description Sets the multi-round dispatch service for multi-agent phase execution.
   * When set, phases 2-6 will use 2 rounds (primary + reviewer) instead of single dispatch.
   * @param service - MultiRoundDispatchService instance from composition root
   */
  setMultiRoundDispatch(service: MultiRoundDispatchService): void {
    this.multiRoundDispatch = service;
    logger.info('MultiRoundDispatchService wired into SwarmTicketProcessingService');
  }

  /** @description Sets the runtime online-agent resolver used to keep routing pinned to live workers. */
  setOnlineAgentIdsResolver(resolveOnlineAgentIds: SwarmOnlineAgentIdsResolver): void {
    this.routingHandler.setOnlineAgentIdsResolver(resolveOnlineAgentIds);
  }

  /**
   * @description Sets the phase routing service for legacy-style phase-aware routing.
   * Delegates to the internal routing handler.
   * @param service - PhaseRoutingService instance from composition root
   */
  setPhaseRoutingService(service: import('./phase-routing-service').PhaseRoutingService): void {
    this.routingHandler.setPhaseRoutingService(service);
    logger.info('PhaseRoutingService wired into SwarmTicketProcessingService via SwarmRoutingHandler');
  }

  /** @description Sets the agent factory for auto-creating specialists when capability gaps are detected. */
  setAgentFactoryForRouting(service: import('@/features/agent-management/services/agent-factory-service').AgentFactoryService, autoCreate = false): void {
    this.routingHandler.setAgentFactoryService(service, autoCreate);
    logger.info({ autoCreate }, 'AgentFactory wired into routing for capability gap resolution');
  }

  /** @description Sets the eligibility service for IMP-1 adaptive rerouting. */
  setEligibilityService(service: import('@/features/agent-management/services/agent-eligibility-service').AgentEligibilityService): void {
    this.routingHandler.setEligibilityService(service);
  }

  /**
   * @description Processes intake work items for one provider through the current swarm lifecycle.
   * @param provider - Intake provider key
   * @param input - Processing configuration and optional selection hints
   * @returns Batch processing result including per-ticket lifecycle outputs
   */
  async processProvider(
    provider: IntakeProvider,
    input: SwarmProcessingInput,
  ): Promise<SwarmProcessingResult> {
    const startedAt = Date.now();
    const runId = randomUUID();
    const processed: SwarmProcessedTicketResult[] = [];
    const interactionMode = input.interactionMode ?? 'ticket';
    const policy = this.cyclePolicyService.resolve(input.policy);

    await this.ensureRuntimeReady();
    this.ensureTicketInteractionMode(interactionMode, provider);
    logger.info({ runId, provider, interactionMode, policy, limit: input.limit, cursor: input.cursor }, 'Starting swarm provider processing run');
    await this.createRunRecord(runId, provider);

    try {
      const intakeResult = await this.pullAndProcessTickets(runId, provider, input, processed, policy, startedAt);
      await this.runStore.complete(runId, processed);
      logger.info({ runId, provider, pulledCount: intakeResult.items.length, processedCount: processed.length, durationMs: Date.now() - startedAt }, 'Completed swarm provider processing run');
      return buildProcessingResult(runId, provider, intakeResult, processed);
    } catch (error) {
      await this.handleRunFailure(error, runId, provider, startedAt, processed);
      throw toError(error);
    }
  }

  /**
   * @description Processes tickets directly without going through an intake adapter.
   * @param tickets - External work items to process
   * @param input - Processing configuration
   * @returns Batch processing result
   */
  async processTickets(
    tickets: ExternalWorkItem[],
    input: Partial<SwarmProcessingInput> = {},
  ): Promise<SwarmProcessingResult> {
    const startedAt = Date.now();
    const runId = randomUUID();
    const processed: SwarmProcessedTicketResult[] = [];
    const provider: IntakeProvider = tickets[0]?.provider ?? 'direct';
    const fullInput: SwarmProcessingInput = { limit: tickets.length, ...input };
    const policy = this.cyclePolicyService.resolve(fullInput.policy);

    await this.ensureRuntimeReady();
    logger.info({ runId, ticketCount: tickets.length }, 'Starting direct ticket processing run');
    await this.createRunRecord(runId, provider);

    try {
      for (const item of tickets) {
        processed.push(await this.processOneTicket(runId, item, fullInput, policy, startedAt));
      }
      await this.runStore.complete(runId, processed);
      logger.info({ runId, processedCount: processed.length, durationMs: Date.now() - startedAt }, 'Direct ticket processing run completed');
      return {
        runId,
        provider,
        source: 'direct',
        effectiveCursor: null,
        pulledCount: tickets.length,
        processedCount: processed.length,
        processed,
      };
    } catch (error) {
      await this.handleRunFailure(error, runId, provider, startedAt, processed);
      throw toError(error);
    }
  }

  /**
   * @description Returns a previously tracked swarm processing run record.
   * @param runId - Run identifier
   * @returns Run record when present, otherwise null
   */
  async getRun(runId: string): Promise<SwarmRunRecord | null> {
    const startedAt = Date.now();
    logger.info({ runId }, 'Fetching swarm run record');

    const run = await this.runStore.get(runId);

    logger.info(
      {
        runId,
        found: Boolean(run),
        durationMs: Date.now() - startedAt,
      },
      'Fetched swarm run record',
    );

    return run;
  }

  /**
   * @description Lists recent swarm run records.
   * @param limit - Maximum number of records to return
   * @returns Array of recent run records
   */
  async listRuns(limit = 50): Promise<SwarmRunRecord[]> {
    return this.runStore.list(limit);
  }

  /**
   * @description Reports whether the current swarm runtime can execute tickets end-to-end.
   * @returns Readiness result with missing dependency details when unavailable
   */
  async getRuntimeReadiness(): Promise<SwarmRuntimeReadiness> {
    if (this.runtimeReadinessProbe) {
      try {
        return await this.runtimeReadinessProbe();
      } catch (error) {
        const normalized = toError(error);
        return {
          ready: false,
          dependency: 'postgres',
          message: 'Swarm runtime readiness probe failed',
          details: { error: normalized.message },
        };
      }
    }

    return {
      ready: true,
      dependency: 'none',
      message: 'Swarm runtime readiness probe not configured; assuming caller-managed execution context',
    };
  }

  /**
   * @description Persists an in-progress run record before processing starts.
   * @param runId - Run identifier
   * @param provider - Intake provider key
   * @returns Promise resolved when record is created
   */
  private async createRunRecord(runId: string, provider: IntakeProvider): Promise<void> {
    await this.runStore.create({
      runId,
      provider,
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * @description Pulls provider items and processes each ticket sequentially.
   * @param runId - Parent run identifier
   * @param input - Run-level processing input
   * @param processed - Mutable processed ticket accumulator
   * @returns Intake pull result used for response metadata
   */
  private async pullAndProcessTickets(
    runId: string,
    provider: IntakeProvider,
    input: SwarmProcessingInput,
    processed: SwarmProcessedTicketResult[],
    policy: SwarmCyclePolicy,
    runStartedAt: number,
  ) {
    const intakeResult = await this.intakeService.pull(provider, input);
    for (const item of intakeResult.items) {
      processed.push(await this.processOneTicket(runId, item, input, policy, runStartedAt));
    }

    return intakeResult;
  }

  /**
   * @description Handles processing failure with logging and failed-run persistence.
   * @param error - Unknown throwable from processing flow
   * @param runId - Run identifier
   * @param provider - Intake provider key
   * @param startedAt - Millisecond timestamp when run started
   * @param processed - Partial processed results gathered before failure
   * @returns Promise resolved after failed run persistence
   */
  private async handleRunFailure(
    error: unknown,
    runId: string,
    provider: IntakeProvider,
    startedAt: number,
    processed: SwarmProcessedTicketResult[],
  ): Promise<void> {
    const normalizedError = toError(error);
    logger.error(
      {
        err: normalizedError,
        runId,
        provider,
        durationMs: Date.now() - startedAt,
      },
      'Swarm provider processing run failed',
    );
    await this.runStore.fail(runId, normalizedError, processed);
  }

  /**
   * @description Blocks execution when required swarm dependencies are unavailable.
   * @returns Promise resolved when runtime is ready
   */
  private async ensureRuntimeReady(): Promise<void> {
    const readiness = await this.getRuntimeReadiness();
    if (!readiness.ready) {
      throw new SwarmRuntimeUnavailableError(readiness);
    }
  }


  /**
   * @description Processes one intake work item through the 7-phase lifecycle.
   * Phases: intake → planning → specialist_input → execution → testing → review → delivery.
   * Complexity scoring determines which phases are active (low skips specialist_input/testing/review).
   * @param runId - Parent run identifier
   * @param item - Intake work item to process
   * @param input - Run-level processing input
   * @returns Per-ticket lifecycle and routing result
   */
  private async processOneTicket(
    runId: string,
    item: ExternalWorkItem,
    input: SwarmProcessingInput,
    policy: SwarmCyclePolicy,
    runStartedAt: number,
  ): Promise<SwarmProcessedTicketResult> {
    // Use root workspace ID from input if set (child tickets share root workspace — legacy PHASE_45 pattern).
    // Falls back to resolving from the item's external ID (root tickets).
    const workspaceTaskId = input.workspaceTaskId || await this.resolveWorkspaceTaskId(item);

    // Internal ticket upsert — ensures the work item has an internal record
    if (this.ticketService) {
      await ensureInternalTicketForWorkItem(this.ticketService, item);
    }

    // Phase 1: INTAKE — classify ticket, score complexity, resolve phase gates
    const descriptionLength = (item.body ?? '').length;
    const workUnitsPreview = this.decompositionService.decompose(item);
    const acCount = workUnitsPreview.reduce((sum, u) => sum + (u.acceptanceCriteria?.length ?? 0), 0);
    const phaseGate = resolvePhaseGateConfig(workUnitsPreview.length, item.labels ?? [], descriptionLength, acCount);
    const lifecycle = new TicketCycleStateMachine(item.provider, item.externalId, phaseGate);

    await this.executeCycle(runId, item, lifecycle, 'intake', policy, async () => ({
      value: undefined,
      details: {
        title: item.title,
        labels: item.labels,
        priority: item.priority ?? null,
        complexity: phaseGate.complexity,
        complexityScore: phaseGate.complexityScore,
        activePhases: phaseGate.activePhases,
      },
    }));

    // Phase 2: PLANNING — delegate root-ticket decomposition to the extracted planning orchestrator.
    // This avoids creating execution work items before the queue manager has converted PM
    // subtasks into child tickets, which was the direct-submit completion stall observed in Session 100.
    await this.executionLifecycleService.updateGovernancePhase(item.externalId, 'planning', 2);
    const planning = await this.executeCycle(runId, item, lifecycle, 'planning', policy, async () => {
      const result = await this.planningRoundOrchestrator.execute({
        runId,
        item,
        input,
        policy,
        phaseGate,
        workspaceTaskId,
      });

      return {
        value: result,
        details: {
          workUnitCount: result.workUnits.length,
          selectedAgentId: result.routing.winner.agentId,
          strategy: result.routing.strategy,
          planningSource: result.planningSource,
          stopAfterPlanning: result.stopAfterPlanning,
          artifactPaths: result.artifactPaths,
        },
      };
    });

    // Persist the routed agent assignment to the ticket for metrics and cockpit visibility
    if (this.ticketService && planning.routing?.winner?.agentId) {
      const winnerId = planning.routing.winner.agentId;
      await this.ticketService.updateTicket(item.externalId, {
        assignedAgentId: winnerId,
      }).catch((err) => {
        logger.warn({ err, ticketId: item.externalId }, 'Failed to persist assigned agent on ticket (non-fatal)');
      });
      // Record in junction table so all agents working this ticket are tracked
      await this.ticketService.assignAgent(item.externalId, winnerId, 'primary', 'planning').catch((err) => {
        logger.warn({ err, ticketId: item.externalId }, 'Failed to record agent assignment (non-fatal)');
      });
    }

    if (planning.stopAfterPlanning) {
      logger.info(
        {
          externalId: item.externalId,
          subtaskCount: planning.workUnits.length,
          artifactPaths: planning.artifactPaths,
        },
        'Phase 2 produced subtask decomposition — stopping parent pipeline so the queue manager can create child tickets',
      );
      await this.executionLifecycleService.updateGovernancePhase(item.externalId, 'delivery', 7);

      const planningOnlyResult = this.planningRoundOrchestrator.buildPlanningOnlyResult(
        item,
        lifecycle.snapshot(),
        planning,
      );
      if (!planningOnlyResult) {
        throw new Error(`Planning short-circuit failed for ticket ${item.externalId}`);
      }
      this.recordTicketMetrics(runId, item, phaseGate, lifecycle, 'completed', runStartedAt, planning.routing.winner.agentId);
      return planningOnlyResult;
    }

    const executeLifecycleCycle = <T>(
      cycle: SwarmTicketCycle,
      operation: () => Promise<CycleExecutionResult<T>>,
    ) => this.executeCycle(runId, item, lifecycle, cycle, policy, operation);

    // Phase 3: SPECIALIST_INPUT — route to domain expert for context enrichment (high complexity only)
    if (lifecycle.isActive('specialist_input')) {
      await this.executeCycle(runId, item, lifecycle, 'specialist_input', policy, async () => {
        const specialistResult = await this.routingHandler.runSpecialistInput(item, planning.workUnits, planning.routing);
        return {
          value: specialistResult,
          details: {
            specialistAgentId: specialistResult.specialistAgentId,
            enrichmentType: specialistResult.enrichmentType,
            contextInjected: specialistResult.contextInjected,
          },
        };
      });
    }

    // Phases 4-6: EXECUTION → TESTING → REVIEW with bounded regression loop.
    // When testing or review fails within regression budget, Phase 4 re-executes with
    // feedback from the failed phase injected into the execution context.
    const maxRegressionLoops = 3;
    let executionOutcome = await this.runExecutionPhase(
      runId, item, lifecycle, input, planning.workUnits, planning.routing, policy, runStartedAt, workspaceTaskId,
    );

    for (let regressionLoop = 0; regressionLoop < maxRegressionLoops; regressionLoop++) {
      // Phase 5: TESTING — first verification pass (medium+ complexity)
      if (lifecycle.isActive('testing')) {
        await this.executionLifecycleService.updateGovernancePhase(item.externalId, 'testing', 5);
        const testResult = await this.executionLifecycleService.executeTestingWithRegression({
          runId, item, lifecycle, executionOutcome, policy, workspaceTaskId, executeCycle: executeLifecycleCycle,
        });

        if (testResult.outcome === 'escalated') {
          this.recordTicketMetrics(runId, item, phaseGate, lifecycle, 'escalated', runStartedAt, executionOutcome.routing.winner.agentId);
          return this.executionLifecycleService.finalizeTicketProcessing({
            runId, item, lifecycle, executionOutcome, policy, executeCycle: executeLifecycleCycle,
          });
        }

        if (testResult.outcome === 'regress') {
          logger.info(
            { externalId: item.externalId, regressionLoop: regressionLoop + 1, feedback: testResult.feedback?.substring(0, 200) },
            'Regression loop: re-executing Phase 4 with testing feedback',
          );
          executionOutcome = await this.runExecutionPhase(
            runId, item, lifecycle, input, planning.workUnits, planning.routing, policy, runStartedAt, workspaceTaskId,
            testResult.feedback,
          );
          continue; // Restart the testing/review loop with new execution output
        }
      }

      // Phase 6: REVIEW — multi-agent consensus review (high complexity only)
      if (lifecycle.isActive('review')) {
        await this.executionLifecycleService.updateGovernancePhase(item.externalId, 'review', 6);
        const reviewResult = await this.executionLifecycleService.executeReviewWithRegression({
          item, lifecycle, executionOutcome,
          workUnits: { workUnits: planning.workUnits, routing: planning.routing },
          policy, workspaceTaskId, executeCycle: executeLifecycleCycle,
        });

        if (reviewResult.outcome === 'escalated') {
          this.recordTicketMetrics(runId, item, phaseGate, lifecycle, 'escalated', runStartedAt, executionOutcome.routing.winner.agentId);
          return this.executionLifecycleService.finalizeTicketProcessing({
            runId, item, lifecycle, executionOutcome, policy, executeCycle: executeLifecycleCycle,
          });
        }

        if (reviewResult.outcome === 'regress') {
          logger.info(
            { externalId: item.externalId, regressionLoop: regressionLoop + 1, feedback: reviewResult.feedback?.substring(0, 200) },
            'Regression loop: re-executing Phase 4 with review feedback',
          );
          executionOutcome = await this.runExecutionPhase(
            runId, item, lifecycle, input, planning.workUnits, planning.routing, policy, runStartedAt, workspaceTaskId,
            reviewResult.feedback,
          );
          continue; // Restart the testing/review loop with new execution output
        }
      }

      // Both testing and review passed — break out of regression loop
      break;
    }

    // Phase 7: DELIVERY — finalize, writeback, store learnings
    await this.executionLifecycleService.updateGovernancePhase(item.externalId, 'delivery', 7);
    this.recordTicketMetrics(runId, item, phaseGate, lifecycle, 'completed', runStartedAt, executionOutcome.routing.winner.agentId);
    return this.executionLifecycleService.finalizeTicketProcessing({
      runId, item, lifecycle, executionOutcome, policy, executeCycle: executeLifecycleCycle,
    });
  }

  /**
   * @description Runs Phase 4 (EXECUTION) through the bounded execution policy.
   * Extracted as a reusable helper so the regression loop can re-invoke it with feedback.
   * @param regressionFeedback - Optional feedback from a failed testing/review phase to inject into re-execution context.
   * @returns Execution policy outcome.
   */
  private async runExecutionPhase(
    runId: string,
    item: ExternalWorkItem,
    lifecycle: TicketCycleStateMachine,
    input: SwarmProcessingInput,
    workUnits: DecomposedWorkUnit[],
    routing: { winner: RouteCandidate; strategy: string },
    policy: SwarmCyclePolicy,
    runStartedAt: number,
    workspaceTaskId: string,
    regressionFeedback?: string,
  ): Promise<SwarmExecutionPolicyOutcome> {
    await this.executionLifecycleService.updateGovernancePhase(item.externalId, 'execution', 4);

    const targetItem = regressionFeedback
      ? { ...item, body: `${item.body ?? ''}\n\n---\n## Regression Feedback\n${regressionFeedback}` }
      : item;

    if (regressionFeedback) {
      logger.info(
        { externalId: item.externalId, feedbackLength: regressionFeedback.length },
        'Injecting regression feedback into execution context',
      );
    }

    // Adapt routing subset to full RouteDecision expected by lifecycle service
    const fullRouting = { ...routing, ranked: [routing.winner], candidates: [routing.winner] } as unknown as import('@/features/agent-management').RouteDecision;
    return this.executeCycle(runId, item, lifecycle, 'execution', policy, async () =>
      this.executionLifecycleService.runExecutionPolicy(
        targetItem, input, workUnits, fullRouting, runId, policy, runStartedAt, workspaceTaskId,
      ),
    );
  }

  /** @description Persists decomposed work units as internal work items with agent assignment. */
  private async persistWorkItems(
    runId: string,
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    assignedAgentId: string,
  ): Promise<void> {
    if (!this.workItemRepository) {
      return;
    }
    try {
      for (const unit of workUnits) {
        const defaultStatus = unit.depth > 0 ? 'subtask-assigned' : 'assigned';
        const wi = await this.workItemRepository.create({
          swarmRunId: runId, externalId: item.externalId,
          provider: item.provider, unitId: unit.unitId,
          title: unit.title, description: unit.description,
          acceptanceCriteria: unit.acceptanceCriteria,
          labels: unit.labels, priority: unit.priority,
          parentId: unit.parentUnitId ?? null,
          depth: unit.depth,
        });

        if (wi.status === 'completed' || wi.status === 'failed' || wi.status === 'routing_failed') {
          logger.info(
            { runId, externalId: item.externalId, unitId: unit.unitId, status: wi.status },
            'Skipping work-item reassignment because a terminal row already exists for this deterministic unit',
          );
          continue;
        }

        await this.workItemRepository.updateStatus(wi.workItemId, defaultStatus, assignedAgentId);
      }
    } catch (error) {
      logger.error({ err: toError(error), runId, externalId: item.externalId }, 'Failed to persist work items');
    }
  }

  /** @description Delegates to SwarmSubtaskHandler. */
  async createSubtasks(runId: string, parentWorkItemId: string, input: SubtaskDecompositionInput, assignedAgentId: string): Promise<DecomposedWorkUnit[]> {
    return this.subtaskHandler.createSubtasks(runId, parentWorkItemId, input, assignedAgentId);
  }

  /** @description Delegates to SwarmSubtaskHandler. */
  async checkAndCompleteParents(runId: string): Promise<number> {
    return this.subtaskHandler.checkAndCompleteParents(runId);
  }

  /** @description Delegates to SwarmSubtaskHandler. */
  async dispatchSubtasksForParent(runId: string, parentUnitId: string, assignedAgentId: string, policy: SwarmCyclePolicy): Promise<{ dispatched: number; completed: number; failed: number }> {
    return this.subtaskHandler.dispatchSubtasksForParent(runId, parentUnitId, assignedAgentId, policy);
  }


  /** @description Records ticket processing metrics to the SwarmMetricsCollector when wired. */
  private recordTicketMetrics(
    runId: string,
    item: ExternalWorkItem,
    phaseGate: PhaseGateConfig,
    lifecycle: TicketCycleStateMachine,
    outcome: 'completed' | 'failed' | 'escalated',
    startedAt: number,
    agentId: string,
  ): void {
    if (!this.metricsCollector) return;
    const snap = lifecycle.snapshot();
    const phases = snap.cycles
      .filter((c) => c.status === 'completed' || c.status === 'failed')
      .map((c, i) => ({
        phase: c.cycle,
        phaseIndex: i + 1,
        durationMs: c.startedAt && c.completedAt ? new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime() : 0,
        agentId,
        rounds: 1,
        status: (c.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
        artifactsValid: true,
        handoverWritten: c.status === 'completed',
      }));
    const metrics: TicketProcessingMetrics = {
      ticketId: item.externalId,
      runId,
      agentId,
      complexity: phaseGate.complexity,
      phases,
      totalDurationMs: Date.now() - startedAt,
      outcome,
      regressionCount: 0,
      executionAttempts: 1,
      verificationAttempts: 0,
      artifactComplianceScore: 1.0,
      handoverCount: phases.length,
      staleLoopDetected: false,
      approvalRequired: false,
      completedAt: new Date().toISOString(),
    };
    this.metricsCollector.recordTicketMetrics(metrics);
  }

  /** @description Executes one lifecycle cycle and emits provider write-back for start, completion, and failure states. */
  private async executeCycle<T>(
    runId: string,
    item: ExternalWorkItem,
    lifecycle: TicketCycleStateMachine,
    cycle: SwarmTicketCycle,
    policy: SwarmCyclePolicy,
    operation: () => Promise<CycleExecutionResult<T>>,
  ): Promise<T> {
    try {
      const startedSnapshot = lifecycle.begin(cycle);
      await this.writebackHandler.emitWritebackUpdate(runId, item, cycle, 'in_progress', startedSnapshot, policy);
      const result = await operation();
      const completedSnapshot = lifecycle.complete(cycle, result.details);
      await this.writebackHandler.emitWritebackUpdate(runId, item, cycle, 'completed', completedSnapshot, policy, result.details);
      return result.value;
    } catch (error) {
      const normalizedError = toError(error);
      const failedSnapshot = lifecycle.fail(cycle, normalizedError);
      await this.writebackHandler.emitFailureWritebackUpdate(runId, item, cycle, failedSnapshot, normalizedError, policy);
      throw normalizedError;
    }
  }

  /**
   * @description Enforces that provider processing runs only execute in ticket mode.
   * @param interactionMode - Requested interaction mode
   * @param provider - Provider being processed
   * @returns Nothing
   * @throws Error when a non-ticket mode is used with provider processing
   */
  private ensureTicketInteractionMode(
    interactionMode: TicketInteractionMode,
    provider: IntakeProvider,
  ): void {
    if (interactionMode === 'ticket') {
      return;
    }

    throw new Error(`Swarm provider processing for ${provider} only supports ticket interaction mode`);
  }

  /** @description Delegates to SwarmSubtaskHandler. */
  private async registerParentsWithLifecycle(workUnits: DecomposedWorkUnit[]): Promise<void> {
    return this.subtaskHandler.registerParentsWithLifecycle(workUnits);
  }

  /**
   * @description Delegates to SwarmRoutingHandler with optional phase context injection.
   * When phaseContext is provided, populates the hidden properties that PhaseRoutingService
   * reads to activate the legacy-style phase-specific routing cascade.
   * @param item - Work item to route
   * @param input - Processing input (mutated with phase context when provided)
   * @param workUnits - Decomposed work units
   * @param phaseContext - Optional phase context for phase-aware routing
   */
  private async selectAgent(
    item: Pick<ExternalWorkItem, 'externalId' | 'title' | 'body'>,
    input: SwarmProcessingInput,
    workUnits: DecomposedWorkUnit[],
    phaseContext?: {
      currentPhase?: number;
      ticketDepth?: number;
      complexity?: string;
      executorAgentId?: string;
      pmAssignedAgentId?: string;
      pmAssignedRole?: string;
    },
  ) {
    if (phaseContext) {
      const ctx = input as unknown as Record<string, unknown>;
      if (phaseContext.currentPhase !== undefined) ctx._currentPhase = phaseContext.currentPhase;
      if (phaseContext.ticketDepth !== undefined) ctx._ticketDepth = phaseContext.ticketDepth;
      if (phaseContext.complexity !== undefined) ctx._complexity = phaseContext.complexity;
      if (phaseContext.executorAgentId !== undefined) ctx._executorAgentId = phaseContext.executorAgentId;
      if (phaseContext.pmAssignedAgentId !== undefined) ctx._pmAssignedAgentId = phaseContext.pmAssignedAgentId;
      if (phaseContext.pmAssignedRole !== undefined) ctx._pmAssignedRole = phaseContext.pmAssignedRole;
    }
    return this.routingHandler.selectAgent(item, input, workUnits);
  }

  /** @description Delegates to swarm-ticket-lifecycle-helpers. */
  private async resolveWorkspaceTaskId(item: ExternalWorkItem): Promise<string> {
    return resolveWorkspaceTaskIdHelper(item, this.ticketService);
  }
}
