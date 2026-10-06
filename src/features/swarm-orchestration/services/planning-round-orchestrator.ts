/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted Phase 2 planning orchestration with optional architecture pre-round, artifact gates, and planning-only short-circuit handling
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Fixed planning artifact return values and PM assignment lookup after extraction follow-up
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ensureArtifact now returns string | undefined (warn instead of throw) — prevents infinite retry loop when architecture round times out
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Fixed SYSTEM_ARCHITECT_AGENT_ID from slug 'architect-bot' to canonical UUID — slug dispatch targeted dead Redis channel
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | BF-030: Added SYSTEM_PM_AGENT_ID — planning phase always routes to PM; keyword matching fallback was selecting wrong agents (tester-bot) when capability strings didn't match exactly
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Fixed child-ticket direct execution units to remain root-level within their own run so execution polling persists completion normally
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Phase 8 now auto-enables for high-complexity tickets (score >= 7) in addition to USE_ARCHITECTURE_PHASE env var — removes silent skip for complex work
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Session 19: Wired assessHandoverCoverage into architecture and planning rounds — handover missing now logged as structured enforcement event
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Switched handover gates from non-strict (warn-only) to strict (block advancement) after E2E validation plan confirmed
 * 10 | maintainer@emeraldcoastsystemsgroup.com   | Follows the rename to assessHandoverCoverage / allHandoversPresent, and stops calling it a failed gate. These two call sites logged 'continuing with warning' immediately after the helper logged that the ticket was blocked - the same execution saying both. Neither gates; both now say coverage and say the phase continues.
 * 11 | maintainer@emeraldcoastsystemsgroup.com   | CKR-17 step 2: the inline workspace-root chain here resolves through resolveSharedWorkspaceRoot() like every other site. It read ONE of the six.
 * 12 | maintainer@emeraldcoastsystemsgroup.com   | The planning-entry and preparation-packet readers and the work-unit builders moved to ./planning-work-units.ts because this file crossed 800 code lines. Pure move; behaviour unchanged.
 * 13 | maintainer@emeraldcoastsystemsgroup.com   | The PM planning round carries the root ticket's owner and persisted verified issuer (readRoundOwner) so it can run in-process on the owner's hosted ladder (docs/security/http-delegation.md, "Build-lane planning runs in-process").
 * 14 | maintainer@emeraldcoastsystemsgroup.com   | When the last planning round ran in-process, decomposition reads its reply from memory (planning-output-source.ts): no shared-volume fallback, the plan is recorded as IMPLEMENTATION-PLAN.md only when absent, and a failed round throws PlanningDecompositionError for the queue manager to escalate. Mesh rounds keep the existing parse path.
 * 15 | maintainer@emeraldcoastsystemsgroup.com   | parseInProcessPlan takes the round's start time: a reply without the decomposition section is decomposed from the IMPLEMENTATION-PLAN.md the planning node wrote during the round (readFreshPlanFile); an older file is still never read, and a reply that carries the section is recorded and parsed as before.
 * 16 | maintainer@emeraldcoastsystemsgroup.com   | ADR-081 privileged lane (general fix): a PM assignment naming a privileged worker is dropped before phase-4 routing (routablePmAssignment), which takes the assignment first, so routing chooses an ordinary agent; the role hint stays.
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { RouteDecision } from '@/features/agent-management';
import { SWARM_PHASES } from '@/features/operational-intelligence';
import type { IntakePlanningMode } from '@/shared/types/intake';
import { createChildLogger } from '@/shared/logger';
import type { PhaseGateConfig } from './phase-gate-config';
import type { MultiRoundDispatchService, RoundOwner } from './multi-round-dispatch-service';
import type { SwarmOnlineAgentIdsResolver } from './swarm-ticket-processing-support';
import type { SwarmCyclePolicy } from './swarm-cycle-policy';
import { assessHandoverCoverage } from './swarm-ticket-lifecycle-helpers';
import type {
  AgentAssignment,
  DecomposedWorkUnit,
  TicketDecompositionService,
} from './ticket-decomposition-service';
import type { SwarmProcessingInput } from './swarm-ticket-processing-service';
import type { SwarmProcessedTicketResult } from './swarm-run-store';
import type { SwarmTicketLifecycleSnapshot } from './ticket-cycle-state-machine';
import { resolveSharedWorkspaceRoot } from '@/shared/workspace-root';
import { readOwnerPrincipalIssuer } from '@/shared/security/owner-principal-issuer';
import { hasSubtaskDecomposition, readFreshPlanFile, readInProcessPlanText, recordImplementationPlan } from './planning-output-source';
import { routablePmAssignment } from './swarm-privileged-worker-gate';
import {
  TECHNICAL_SPECIFICATION_FILE,
  buildArchitectureWorkUnit,
  buildDirectExecutionUnit,
  buildPlanningWorkUnit,
  buildSingleWorkUnit,
  derivePlanningEntry,
  derivePreparationPacket,
  normalizeRecommendedPath,
  type PlanningEntryDetails,
  type PreparationPacketDetails,
} from './planning-work-units';

const logger = createChildLogger({ module: 'planning-round-orchestrator' });

const SYSTEM_ARCHITECT_AGENT_ID = 'a0000000-0000-0000-0000-000000000018';
/** @description PM always owns Phase 2 planning — bypasses routing to prevent keyword-match fallback selecting wrong agents. */
const SYSTEM_PM_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';
const ARCHITECTURE_PHASE = 8;
const IMPLEMENTATION_PLAN_FILE = 'IMPLEMENTATION-PLAN.md';

/**
 * @description Artifact paths produced during the planning lifecycle.
 */
export interface PlanningArtifactPaths {
  workspacePath: string;
  technicalSpecificationPath?: string;
  implementationPlanPath?: string;
}

/**
 * @description Input required to execute Phase 2 planning orchestration.
 */
export interface PlanningPhaseExecutionInput {
  runId: string;
  item: ExternalWorkItem;
  input: SwarmProcessingInput;
  policy: SwarmCyclePolicy;
  phaseGate: PhaseGateConfig;
  workspaceTaskId: string;
}

/**
 * @description Result returned from the extracted planning orchestration.
 */
export interface PlanningPhaseExecutionResult {
  workUnits: DecomposedWorkUnit[];
  routing: RouteDecision;
  planningSource: 'child-direct' | 'root-direct' | 'llm-planning' | 'single-work-unit';
  stopAfterPlanning: boolean;
  artifactPaths: PlanningArtifactPaths;
  agentAssignments?: AgentAssignment[];
}

/**
 * @description Dependencies required by the planning orchestrator.
 */
export interface PlanningRoundOrchestratorDeps {
  decompositionService: TicketDecompositionService;
  getMultiRoundDispatch: () => MultiRoundDispatchService | undefined;
  getOnlineAgentIdsResolver?: () => SwarmOnlineAgentIdsResolver | undefined;
  selectAgent: (
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
  ) => Promise<RouteDecision>;
  registerParentsWithLifecycle: (workUnits: DecomposedWorkUnit[]) => Promise<void>;
  persistWorkItems: (
    runId: string,
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    assignedAgentId: string,
  ) => Promise<void>;
}

/**
 * @description Orchestrates the extracted planning flow for root and child tickets.
 * Handles optional architecture discovery, PM planning, artifact gates, and the
 * planning-only short-circuit used when a root ticket decomposes into child work.
 */
export class PlanningRoundOrchestrator {
  constructor(private readonly deps: PlanningRoundOrchestratorDeps) {}

  /**
   * @description Executes the planning path for a ticket and returns the work that should follow.
   * @param input - Planning execution input.
   * @returns Planning result with work units, routing, artifact paths, and stop signal.
   */
  async execute(input: PlanningPhaseExecutionInput): Promise<PlanningPhaseExecutionResult> {
    const context = derivePlanningContext(input.item, input.input);
    if (context.isSpecialistDispatch) {
      return this.executeDirectSpecialistPath(input, context);
    }

    return this.executeRootPlanningPath(input, context);
  }

  /**
   * @description Builds the processed-ticket payload used when planning intentionally stops before execution.
   * @param item - Ticket that finished planning.
   * @param lifecycle - Lifecycle snapshot after the planning phase.
   * @param planning - Planning execution result.
   * @returns Planning-only processing result, or null when execution should continue.
   */
  buildPlanningOnlyResult(
    item: ExternalWorkItem,
    lifecycle: SwarmTicketLifecycleSnapshot,
    planning: PlanningPhaseExecutionResult,
  ): SwarmProcessedTicketResult | null {
    if (!planning.stopAfterPlanning) {
      return null;
    }

    return {
      externalId: item.externalId,
      title: item.title,
      selectedAgentId: planning.routing.winner.agentId,
      selectedStrategy: planning.routing.strategy,
      workUnitCount: planning.workUnits.length,
      lifecycle,
      planningDecomposition: planning.workUnits.map((unit) => ({
        title: unit.title,
        description: unit.description,
        acceptanceCriteria: unit.acceptanceCriteria,
        workType: unit.workType ?? 'implementation',
        labels: unit.labels,
      })),
      agentAssignments: planning.agentAssignments,
    };
  }

  /** @description Executes the child-ticket direct specialist path. */
  private async executeDirectSpecialistPath(
    input: PlanningPhaseExecutionInput,
    context: DerivedPlanningContext,
  ): Promise<PlanningPhaseExecutionResult> {
    const nextWorkUnits = [buildDirectExecutionUnit(input.item, context.itemMeta, context.ticketDepth)];
    const routing = await this.selectExecutionRouting(input, context, nextWorkUnits);
    await this.deps.registerParentsWithLifecycle(nextWorkUnits);
    await this.deps.persistWorkItems(input.runId, input.item, nextWorkUnits, routing.winner.agentId);

    logger.info(
      {
        externalId: input.item.externalId,
        ticketDepth: context.ticketDepth,
        selectedAgentId: routing.winner.agentId,
        directExecutionSource: context.directExecutionSource,
        reason: context.directExecutionReason,
      },
      'Planning resolved to direct specialist execution',
    );

    return {
      workUnits: nextWorkUnits,
      routing,
      planningSource: context.directExecutionSource ?? 'child-direct',
      stopAfterPlanning: false,
      artifactPaths: { workspacePath: resolveWorkspacePath(input.workspaceTaskId) },
    };
  }

  /** @description Executes the root-ticket planning path with optional architecture discovery. */
  private async executeRootPlanningPath(
    input: PlanningPhaseExecutionInput,
    context: DerivedPlanningContext,
  ): Promise<PlanningPhaseExecutionResult> {
    const multiRoundDispatch = this.deps.getMultiRoundDispatch();
    logger.info({ externalId: input.item.externalId, hasMultiRound: !!multiRoundDispatch }, 'Planning orchestrator — checking multi-round dispatch availability');
    if (!multiRoundDispatch) {
      logger.warn({ externalId: input.item.externalId }, 'Multi-round dispatch NOT available — falling back to single work unit');
      return this.executeSingleWorkUnitFallback(input);
    }

    const artifactPaths = await this.runArchitectureIfEnabled(input, multiRoundDispatch, context.planningEntry);
    const planningStartedAt = Date.now();
    const planningDispatch = await this.runPlanningRounds(
      input,
      multiRoundDispatch,
      context.planningEntry,
      context.preparationPacket,
    );
    const planningResult = planningDispatch.inProcess
      ? await this.parseInProcessPlan(input, planningDispatch.finalOutput, planningStartedAt)
      : await this.parsePlanningOutput(input, planningDispatch.finalOutput, artifactPaths.workspacePath);
    artifactPaths.implementationPlanPath = planningResult.implementationPlanPath;

    if (planningResult.agentAssignments.length > 0) {
      (input.input as unknown as Record<string, unknown>)._pmAgentAssignments = planningResult.agentAssignments;
    }

    if (context.requiresHumanApprovalAfterPlanning || planningResult.workUnits.length > 1) {
      return {
        workUnits: planningResult.workUnits,
        routing: planningDispatch.routing,
        planningSource: 'llm-planning',
        stopAfterPlanning: true,
        artifactPaths,
        agentAssignments: planningResult.agentAssignments,
      };
    }

    const routing = await this.selectExecutionRouting(input, context, planningResult.workUnits);
    await this.deps.registerParentsWithLifecycle(planningResult.workUnits);
    await this.deps.persistWorkItems(input.runId, input.item, planningResult.workUnits, routing.winner.agentId);

    return {
      workUnits: planningResult.workUnits,
      routing,
      planningSource: 'llm-planning',
      stopAfterPlanning: false,
      artifactPaths,
      agentAssignments: planningResult.agentAssignments,
    };
  }

  /** @description Runs the optional architecture discovery round and enforces the spec artifact gate. */
  private async runArchitectureIfEnabled(
    input: PlanningPhaseExecutionInput,
    multiRoundDispatch: MultiRoundDispatchService,
    planningEntry: PlanningEntryDetails,
  ): Promise<PlanningArtifactPaths> {
    const workspacePath = resolveWorkspacePath(input.workspaceTaskId);
    const artifactPaths: PlanningArtifactPaths = { workspacePath };
    const complexity = input.phaseGate.complexity;
    const enabled = isArchitecturePhaseEnabled(complexity);

    logger.info(
      { ticketId: input.item.externalId, complexity, enabled, envVar: process.env.USE_ARCHITECTURE_PHASE ?? 'unset' },
      `Phase 8 (Architecture Pre-Round) trigger decision`,
    );

    if (!enabled) {
      return artifactPaths;
    }

    const architectAgentId = await this.resolveArchitectAgentId(input.item.title);
    const archResult = await multiRoundDispatch.executePhaseWithRounds(
      input.runId,
      input.item.externalId,
      ARCHITECTURE_PHASE,
      [buildArchitectureWorkUnit(input.item, planningEntry)],
      architectAgentId,
      input.policy,
      input.workspaceTaskId,
    );
    const archCoverage = assessHandoverCoverage(input.item.externalId, archResult, true);
    if (!archCoverage.passed) {
      // Reported, not enforced — the phase proceeds. Said plainly here because the pair of lines
      // this replaces claimed a gate had failed and the ticket was blocked, then continued.
      logger.warn({ ticketId: input.item.externalId, phase: ARCHITECTURE_PHASE, missing: archCoverage.missingHandovers }, 'Architecture handover coverage incomplete — continuing (handovers are written to the agent workspace)');
    }

    artifactPaths.technicalSpecificationPath = ensureArtifact(
      workspacePath,
      TECHNICAL_SPECIFICATION_FILE,
      'System architect must write TECHNICAL-SPECIFICATION.md before PM planning can start',
    );
    return artifactPaths;
  }

  /** @description Runs the PM planning rounds and captures the routing decision used for planning. */
  private async runPlanningRounds(
    input: PlanningPhaseExecutionInput,
    multiRoundDispatch: MultiRoundDispatchService,
    planningEntry: PlanningEntryDetails,
    preparationPacket: PreparationPacketDetails,
  ): Promise<{ routing: RouteDecision; finalOutput: unknown; inProcess: boolean }> {
    const initialWorkUnits = [buildPlanningWorkUnit(input.item, planningEntry, preparationPacket)];
    // PM always owns planning — bypass routing to prevent keyword-match fallback selecting wrong agents.
    const routing: RouteDecision = {
      winner: { agentId: SYSTEM_PM_AGENT_ID, score: 1, reason: 'system-pm-fixed' },
      ranked: [{ agentId: SYSTEM_PM_AGENT_ID, score: 1, reason: 'system-pm-fixed' }],
      strategy: 'catch-all',
    };

    const result = await multiRoundDispatch.executePhaseWithRounds(
      input.runId,
      input.item.externalId,
      SWARM_PHASES.PLANNING,
      initialWorkUnits,
      routing.winner.agentId,
      input.policy,
      input.workspaceTaskId,
      readRoundOwner(input.item),
    );
    const planCoverage = assessHandoverCoverage(input.item.externalId, result, true);
    if (!planCoverage.passed) {
      logger.warn({ ticketId: input.item.externalId, phase: SWARM_PHASES.PLANNING, missing: planCoverage.missingHandovers }, 'Planning handover coverage incomplete — continuing (handovers are written to the agent workspace)');
    }

    // The phase output is the last round's; when that round ran in-process it is read from memory.
    const inProcess = result.rounds[result.rounds.length - 1]?.executedInProcess === true;
    return { routing, finalOutput: result.finalOutput, inProcess };
  }

  /**
   * @description Decomposes the plan an in-process round returned, from memory only, and records it
   * as IMPLEMENTATION-PLAN.md in the root folder. No file on the shared volume is read: no disk
   * fallback, and an existing plan file is left untouched.
   * @param input - Planning execution input.
   * @param finalOutput - The in-process round's output.
   * @param roundStartedAt - When the planning round was dispatched (epoch ms); a plan file the
   *   planning node wrote after it stands in for a reply that carries no decomposition section.
   * @returns The parsed units and assignments, and the plan path when it was written.
   * @throws PlanningDecompositionError when the round failed or returned no text.
   */
  private async parseInProcessPlan(
    input: PlanningPhaseExecutionInput,
    finalOutput: unknown,
    roundStartedAt: number,
  ): Promise<{ workUnits: DecomposedWorkUnit[]; agentAssignments: AgentAssignment[]; implementationPlanPath: string | undefined }> {
    const reply = readInProcessPlanText(input.item.externalId, finalOutput);
    const workspaceRoot = resolveSharedWorkspaceRoot();
    const fromFile = hasSubtaskDecomposition(reply) ? undefined : readFreshPlanFile(workspaceRoot, input.workspaceTaskId, roundStartedAt);
    const text = fromFile ?? reply;
    const implementationPlanPath = fromFile
      ? join(workspaceRoot, input.workspaceTaskId, IMPLEMENTATION_PLAN_FILE)
      : recordImplementationPlan(workspaceRoot, input.workspaceTaskId, reply);
    const parsed = await this.deps.decompositionService.decomposeFromPlanningOutput(text, input.item);
    logger.info(
      { externalId: input.item.externalId, unitCount: parsed.workUnits.length, implementationPlanPath, source: fromFile ? 'plan-file-written-during-round' : 'in-process' },
      'In-process planning output parsed',
    );
    return { ...parsed, implementationPlanPath };
  }

  /** @description Parses PM output and enforces the implementation-plan artifact gate. */
  private async parsePlanningOutput(
    input: PlanningPhaseExecutionInput,
    finalOutput: unknown,
    workspacePath: string,
  ): Promise<{ workUnits: DecomposedWorkUnit[]; agentAssignments: AgentAssignment[]; implementationPlanPath: string | undefined }> {
    let planOutput = typeof finalOutput === 'string'
      ? finalOutput
      : JSON.stringify(finalOutput ?? '');
    const implementationPlanPath = ensureArtifact(
      workspacePath,
      IMPLEMENTATION_PLAN_FILE,
      'Project manager must write IMPLEMENTATION-PLAN.md before decomposition can proceed',
    );

    // If the round output doesn't contain subtask markers, read IMPLEMENTATION-PLAN.md from disk.
    // The PM writes the plan to disk but attempt_completion returns a summary, not the full plan.
    if (implementationPlanPath && !planOutput.includes('SUBTASK DECOMPOSITION') && !planOutput.includes('### Subtask')) {
      try {
        const diskPlan = require('fs').readFileSync(implementationPlanPath, 'utf8');
        if (diskPlan.includes('SUBTASK DECOMPOSITION') || diskPlan.includes('### Subtask')) {
          logger.info({ externalId: input.item.externalId }, 'Round output lacks subtask markers — reading IMPLEMENTATION-PLAN.md from disk');
          planOutput = diskPlan;
        }
      } catch { /* file read failed — continue with round output */ }

      // Also check agent-scoped workspace (PM writes to {ticketId}__{agentId}/)
      if (!planOutput.includes('SUBTASK DECOMPOSITION')) {
        try {
          const agentWs = resolve(workspacePath, '..', `${input.item.externalId}__a0000000-0000-0000-0000-000000000001`);
          const agentPlan = join(agentWs, IMPLEMENTATION_PLAN_FILE);
          if (existsSync(agentPlan)) {
            const diskPlan = require('fs').readFileSync(agentPlan, 'utf8');
            if (diskPlan.includes('SUBTASK DECOMPOSITION') || diskPlan.includes('### Subtask')) {
              logger.info({ externalId: input.item.externalId, path: agentPlan }, 'Found subtask markers in agent workspace IMPLEMENTATION-PLAN.md');
              planOutput = diskPlan;
            }
          }
        } catch { /* agent workspace read failed */ }
      }
    }

    const parsed = await this.deps.decompositionService.decomposeFromPlanningOutput(planOutput, input.item, workspacePath);

    logger.info(
      {
        externalId: input.item.externalId,
        unitCount: parsed.workUnits.length,
        implementationPlanPath,
      },
      'Planning output parsed successfully',
    );

    return {
      ...parsed,
      implementationPlanPath,
    };
  }

  /** @description Selects the execution agent for the next phase, preserving PM assignment hints when present. */
  private async selectExecutionRouting(
    input: PlanningPhaseExecutionInput,
    context: DerivedPlanningContext,
    workUnits: DecomposedWorkUnit[],
  ): Promise<RouteDecision> {
    const assignment = findAssignmentForUnit(workUnits[0], context.itemMeta, input.input);

    // For child-direct tickets without PM assignment, ensure requiredCapabilities
    // are populated from the ticket's own labels so the router picks the right specialist.
    const routingInput = { ...input.input };
    if (context.isSpecialistDispatch && !assignment?.suggestedAgentId && !assignment?.suggestedRole) {
      const existingCaps = routingInput.requiredCapabilities ?? [];
      if (existingCaps.length > 0) {
        logger.info(
          { externalId: input.item.externalId, requiredCapabilities: existingCaps },
          'Using label-derived capabilities for child-direct specialist routing',
        );
      }
    }

    return this.deps.selectAgent(
      input.item,
      routingInput,
      workUnits,
      {
        currentPhase: SWARM_PHASES.EXECUTION,
        ticketDepth: context.ticketDepth,
        complexity: input.phaseGate.complexity,
        pmAssignedAgentId: routablePmAssignment(input.item.externalId, assignment?.suggestedAgentId),
        pmAssignedRole: assignment?.suggestedRole,
      },
    );
  }

  /** @description Provides the legacy single-work-unit fallback when multi-round planning is unavailable. */
  private async executeSingleWorkUnitFallback(
    input: PlanningPhaseExecutionInput,
  ): Promise<PlanningPhaseExecutionResult> {
    const workUnits = [buildSingleWorkUnit(input.item)];
    const routing = await this.deps.selectAgent(
      input.item,
      input.input,
      workUnits,
      { currentPhase: SWARM_PHASES.EXECUTION, ticketDepth: 0, complexity: input.phaseGate.complexity },
    );
    await this.deps.registerParentsWithLifecycle(workUnits);
    await this.deps.persistWorkItems(input.runId, input.item, workUnits, routing.winner.agentId);

    logger.warn({ externalId: input.item.externalId }, 'Planning fell back to a single work unit because multi-round dispatch is unavailable');

    return {
      workUnits,
      routing,
      planningSource: 'single-work-unit',
      stopAfterPlanning: false,
      artifactPaths: { workspacePath: resolveWorkspacePath(input.workspaceTaskId) },
    };
  }

  /** @description Resolves the architect agent when the architecture round is enabled. */
  private async resolveArchitectAgentId(title: string): Promise<string> {
    const resolver = this.deps.getOnlineAgentIdsResolver?.();
    const onlineAgentIds = resolver ? await resolver() : [];
    const architectOnline = onlineAgentIds.length === 0 || onlineAgentIds.includes(SYSTEM_ARCHITECT_AGENT_ID);
    if (!architectOnline) {
      logger.warn({ title, onlineAgentIds }, 'Architecture round requested while architect-bot is offline; dispatching anyway');
    }
    return SYSTEM_ARCHITECT_AGENT_ID;
  }
}

interface DerivedPlanningContext {
  itemMeta: Record<string, unknown>;
  ticketDepth: number;
  isSpecialistDispatch: boolean;
  requiresHumanApprovalAfterPlanning: boolean;
  directExecutionSource?: 'child-direct' | 'root-direct';
  directExecutionReason?: string;
  planningEntry: PlanningEntryDetails;
  preparationPacket: PreparationPacketDetails;
}

/** @description Determines the routing context used by the planning flow. */
function derivePlanningContext(
  item: ExternalWorkItem,
  input: SwarmProcessingInput,
): DerivedPlanningContext {
  const itemRecord = item as Record<string, unknown>;
  const rawPayload = itemRecord.rawPayload as Record<string, unknown> | undefined;
  const rawMeta = rawPayload?.metadata as Record<string, unknown> | undefined;
  const itemMeta = (itemRecord.metadata as Record<string, unknown> | undefined) ?? rawMeta ?? {};
  const ticketDepth = Number(itemMeta.depth ?? 0);
  const recommendedPath = normalizeRecommendedPath(itemMeta.recommendedPath);
  const planningMode = normalizePlanningMode(itemMeta.planningMode);
  const rootBypassesPlanning = ticketDepth === 0
    && (recommendedPath === 'direct-execution'
      || recommendedPath === 'instant-answer'
      || planningMode === 'none'
      || planningMode === 'lightweight');

  // Only child tickets (depth >= 1) skip PM planning for direct specialist execution.
  // Root tickets now also bypass PM when the intake L1 processor explicitly marks
  // them as instant-answer or direct-execution work.
  return {
    itemMeta,
    ticketDepth,
    isSpecialistDispatch: ticketDepth >= 1 || rootBypassesPlanning,
    requiresHumanApprovalAfterPlanning: ticketDepth === 0 && !rootBypassesPlanning,
    directExecutionSource: ticketDepth >= 1 ? 'child-direct' : (rootBypassesPlanning ? 'root-direct' : undefined),
    directExecutionReason: ticketDepth >= 1
      ? 'child-ticket specialist execution'
      : (rootBypassesPlanning ? `recommendedPath=${recommendedPath ?? 'unknown'} planningMode=${planningMode ?? 'unknown'}` : undefined),
    planningEntry: derivePlanningEntry(itemMeta),
    preparationPacket: derivePreparationPacket(itemMeta),
  };
}

/**
 * @description The root ticket's owner and the verified issuer persisted with it, read from the
 * queued ticket the work item wraps (buildWorkItem's rawPayload). An in-process planning round
 * refuses without both.
 * @param item - The work item for the root ticket.
 * @returns The owner subject and verified issuer, each null when absent.
 */
function readRoundOwner(item: ExternalWorkItem): RoundOwner {
  const rawPayload = (item as Record<string, unknown>).rawPayload as Record<string, unknown> | undefined;
  const ownerSub = typeof rawPayload?.ownerSub === 'string' && rawPayload.ownerSub.trim() ? rawPayload.ownerSub : null;
  const metadata = rawPayload?.metadata as Record<string, unknown> | undefined;
  return { ownerSub, principalIssuer: readOwnerPrincipalIssuer(metadata) };
}

/** @description Resolves the workspace path shared by all agents working on a ticket. */
function resolveWorkspacePath(workspaceTaskId: string): string {
  const workspaceRoot = resolveSharedWorkspaceRoot();
  return join(workspaceRoot, workspaceTaskId);
}

/**
 * @description Checks that an expected artifact exists before planning continues.
 * Returns the artifact path when found, or `undefined` when missing.
 * Logs a warning instead of throwing so a timed-out or skipped phase does not
 * cause an infinite retry loop — the caller decides whether absence is fatal.
 */
function ensureArtifact(workspacePath: string, fileName: string, message: string): string | undefined {
  const artifactPath = join(workspacePath, fileName);
  if (!existsSync(artifactPath)) {
    logger.warn({ workspacePath, fileName, message }, 'Expected artifact missing — proceeding without it');
    return undefined;
  }
  return artifactPath;
}

/** @description Looks for a PM agent assignment matching the current work unit or child metadata. */
function findAssignmentForUnit(
  unit: DecomposedWorkUnit | undefined,
  itemMeta: Record<string, unknown>,
  input: SwarmProcessingInput,
): AgentAssignment | undefined {
  const directAssignment = readDirectAssignment(itemMeta);
  if (directAssignment) {
    return directAssignment;
  }

  const assignments = ((input as unknown as Record<string, unknown>)._pmAgentAssignments as AgentAssignment[] | undefined) ?? [];
  if (!unit || assignments.length === 0) {
    return undefined;
  }

  const normalizedTitle = normalizeTitle(unit.title);
  return assignments.find((assignment) => normalizeTitle(assignment.subtaskTitle) === normalizedTitle);
}

/** @description Reads a direct PM assignment stored on child-ticket metadata. */
function readDirectAssignment(itemMeta: Record<string, unknown>): AgentAssignment | undefined {
  const suggestedRole = typeof itemMeta.pmAssignedRole === 'string' ? itemMeta.pmAssignedRole : undefined;
  const suggestedAgentId = typeof itemMeta.pmAssignedAgentId === 'string' ? itemMeta.pmAssignedAgentId : undefined;
  if (!suggestedRole && !suggestedAgentId) {
    return undefined;
  }

  return {
    subtaskTitle: typeof itemMeta.subtaskTitle === 'string' ? itemMeta.subtaskTitle : 'direct-child-assignment',
    suggestedRole: suggestedRole ?? 'implementation',
    suggestedAgentId,
  };
}

/** @description Normalizes a title for fuzzy assignment matching. */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @description Normalizes intake planning-mode metadata when present. */
function normalizePlanningMode(value: unknown): IntakePlanningMode | undefined {
  return value === 'none' || value === 'lightweight' || value === 'structured'
    ? value
    : undefined;
}

/** @description Returns whether the optional architecture pre-round is enabled - forced via env var or auto-triggered for high-complexity tickets. */
function isArchitecturePhaseEnabled(complexity?: string): boolean {
  if (process.env.USE_ARCHITECTURE_PHASE === 'true') return true;
  if (process.env.USE_ARCHITECTURE_PHASE === 'false') return false;
  // Auto-enable for high-complexity tickets when env var is unset or 'auto'
  return complexity === 'high';
}
