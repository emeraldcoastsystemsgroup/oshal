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
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Session 19: Wired enforceHandoverGate into architecture and planning rounds — handover missing now logged as structured enforcement event
 * 9 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Switched handover gates from non-strict (warn-only) to strict (block advancement) after E2E validation plan confirmed
 */

import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { ExternalWorkItem } from '@/entities/ticket';
import type { RouteDecision } from '@/features/agent-management';
import { SWARM_PHASES } from '@/features/operational-intelligence';
import type {
  IntakeArtifactBlueprint,
  IntakePlanStatus,
  IntakePlanningEntryMode,
  IntakePlanningMode,
  IntakeRecommendedPath,
} from '@/shared/types/intake';
import { createChildLogger } from '@/shared/logger';
import type { PhaseGateConfig } from './phase-gate-config';
import type { MultiRoundDispatchService } from './multi-round-dispatch-service';
import type { SwarmOnlineAgentIdsResolver } from './swarm-ticket-processing-support';
import type { SwarmCyclePolicy } from './swarm-cycle-policy';
import { enforceHandoverGate } from './swarm-ticket-lifecycle-helpers';
import type {
  AgentAssignment,
  DecomposedWorkUnit,
  TicketDecompositionService,
  WorkUnitType,
} from './ticket-decomposition-service';
import type { SwarmProcessingInput } from './swarm-ticket-processing-service';
import type { SwarmProcessedTicketResult } from './swarm-run-store';
import type { SwarmTicketLifecycleSnapshot } from './ticket-cycle-state-machine';

const logger = createChildLogger({ module: 'planning-round-orchestrator' });

const SYSTEM_ARCHITECT_AGENT_ID = 'a0000000-0000-0000-0000-000000000018';
/** @description PM always owns Phase 2 planning — bypasses routing to prevent keyword-match fallback selecting wrong agents. */
const SYSTEM_PM_AGENT_ID = 'a0000000-0000-0000-0000-000000000001';
const ARCHITECTURE_PHASE = 8;
const TECHNICAL_SPECIFICATION_FILE = 'TECHNICAL-SPECIFICATION.md';
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
    const planningDispatch = await this.runPlanningRounds(
      input,
      multiRoundDispatch,
      context.planningEntry,
      context.preparationPacket,
    );
    const planningResult = await this.parsePlanningOutput(input, planningDispatch.finalOutput, artifactPaths.workspacePath);
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
    const archGate = enforceHandoverGate(input.item.externalId, archResult, true);
    if (!archGate.passed) {
      logger.warn({ ticketId: input.item.externalId, phase: ARCHITECTURE_PHASE, missing: archGate.missingHandovers }, 'Architecture handover gate failed — continuing with warning (handovers written to agent workspace)');
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
  ): Promise<{ routing: RouteDecision; finalOutput: unknown }> {
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
    );
    const planGate = enforceHandoverGate(input.item.externalId, result, true);
    if (!planGate.passed) {
      logger.warn({ ticketId: input.item.externalId, phase: SWARM_PHASES.PLANNING, missing: planGate.missingHandovers }, 'Planning handover gate failed — continuing with warning (handovers written to agent workspace)');
    }

    return { routing, finalOutput: result.finalOutput };
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
        pmAssignedAgentId: assignment?.suggestedAgentId,
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

interface PlanningEntryDetails {
  mode: IntakePlanningEntryMode;
  planStatus: IntakePlanStatus;
  suppliedPlanSummary?: string;
  suppliedArtifacts: string[];
  suppliedArtifactPaths: string[];
}

interface PreparationPacketDetails {
  pmPrepPacket?: string;
  artifactBlueprints: IntakeArtifactBlueprint[];
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

/** @description Reads planning-entry metadata while preserving the legacy discovery path by default. */
function derivePlanningEntry(itemMeta: Record<string, unknown>): PlanningEntryDetails {
  const suppliedArtifacts = readMergedStringArray(
    itemMeta.suppliedPlanningArtifacts,
    itemMeta.suppliedPlanArtifacts,
    itemMeta.providedPlanArtifacts,
  );
  const suppliedArtifactPaths = readMergedStringArray(
    itemMeta.suppliedPlanningArtifactPaths,
    itemMeta.providedPlanPaths,
    itemMeta.suppliedPlanPaths,
  );
  const suppliedPlanSummary = firstNonEmptyString(
    itemMeta.suppliedPlanSummary,
    itemMeta.planSummary,
    itemMeta.outcomeBrief,
  );

  const explicitMode = normalizePlanningEntryMode(itemMeta.planningEntryMode);
  const explicitStatus = normalizePlanStatus(itemMeta.planStatus);

  const inferredMode: IntakePlanningEntryMode = explicitMode
    ?? ((explicitStatus === 'supplied' || explicitStatus === 'approved' || suppliedArtifacts.length > 0 || suppliedArtifactPaths.length > 0 || Boolean(suppliedPlanSummary))
      ? 'validate-existing'
      : 'discovery');

  const inferredStatus: IntakePlanStatus = explicitStatus
    ?? (inferredMode === 'validate-existing' ? 'supplied' : 'missing');

  return {
    mode: inferredMode,
    planStatus: inferredStatus,
    suppliedPlanSummary,
    suppliedArtifacts,
    suppliedArtifactPaths,
  };
}

function buildPlanningEntrySection(planningEntry: PlanningEntryDetails): string[] {
  const lines = [
    '## Planning Entry Mode',
    `- Mode: ${planningEntry.mode}`,
    `- Plan status: ${planningEntry.planStatus}`,
  ];

  if (planningEntry.suppliedPlanSummary) {
    lines.push(`- Supplied plan summary: ${planningEntry.suppliedPlanSummary}`);
  }
  if (planningEntry.suppliedArtifacts.length > 0) {
    lines.push(`- Declared supplied artifacts: ${planningEntry.suppliedArtifacts.join(', ')}`);
  }
  if (planningEntry.suppliedArtifactPaths.length > 0) {
    lines.push(`- Supplied artifact paths: ${planningEntry.suppliedArtifactPaths.join(', ')}`);
  }

  if (planningEntry.mode === 'validate-existing') {
    lines.push('- IMPORTANT: treat the supplied plan as the starting point. Validate, tighten, resource, and fill gaps. Do NOT restart discovery from zero unless the package is clearly insufficient.');
  } else {
    lines.push('- IMPORTANT: no approved plan was supplied. Use the standard discovery-first planning path.');
  }

  return lines;
}

function derivePreparationPacket(itemMeta: Record<string, unknown>): PreparationPacketDetails {
  return {
    pmPrepPacket: firstNonEmptyString(itemMeta.pmPrepPacket, itemMeta.projectPreparationPacket),
    artifactBlueprints: readArtifactBlueprints(itemMeta.artifactBlueprints),
  };
}

function buildPreparationPacketSection(preparationPacket: PreparationPacketDetails): string[] {
  if (!preparationPacket.pmPrepPacket && preparationPacket.artifactBlueprints.length === 0) {
    return [];
  }

  const lines = [
    '## Project Preparation Packet',
    '- Read PM-PREP-PACKET.md first when it exists in the workspace root. Treat it as the explicit artifact contract for how this project should be prepared before execution.',
  ];

  if (preparationPacket.artifactBlueprints.length > 0) {
    lines.push(
      `- Declared artifact blueprints: ${preparationPacket.artifactBlueprints.map((artifact) => `${artifact.displayName} (${artifact.ownerRole})`).join(', ')}`,
    );
  }

  if (preparationPacket.pmPrepPacket) {
    lines.push(
      '',
      '### Inline PM Prep Packet',
      preparationPacket.pmPrepPacket,
    );
  }

  return lines;
}

/** @description Builds the single work unit used for child-ticket direct execution. */
function buildDirectExecutionUnit(
  item: ExternalWorkItem,
  itemMeta: Record<string, unknown>,
  _ticketDepth: number,
): DecomposedWorkUnit {
  const recommendedPath = normalizeRecommendedPath(itemMeta.recommendedPath);
  const directExecutionPreamble = recommendedPath === 'instant-answer'
    ? 'This ticket was classified as instant-answer work. First ask: can I answer this quickly as a verbal response from the current context and internal knowledge? If yes, answer immediately and concisely. Do not create a heavyweight plan, and avoid tools/files unless they are clearly necessary.'
    : (recommendedPath === 'direct-execution'
      ? 'This ticket was classified for direct execution. Keep the solution lightweight and move straight into implementation.'
      : undefined);

  return {
    unitId: `${item.externalId}-unit-1`,
    title: item.title,
    description: [directExecutionPreamble, item.body ?? item.title].filter(Boolean).join('\n\n'),
    acceptanceCriteria: readStringArray(itemMeta.acceptanceCriteria),
    labels: item.labels ?? [],
    priority: item.priority,
    workType: (itemMeta.workType as WorkUnitType | undefined) ?? 'implementation',
    parentUnitId: null,
    // Child tickets are still root execution units within their own swarm run.
    // Ticket depth drives routing context, but work-unit depth must stay 0 so the
    // execution lifecycle uses the normal assigned/completed flow instead of subtask semantics.
    depth: 0,
  };
}

/** @description Builds the root planning work unit dispatched to the PM. */
function buildPlanningWorkUnit(
  item: ExternalWorkItem,
  planningEntry: PlanningEntryDetails,
  preparationPacket: PreparationPacketDetails,
): DecomposedWorkUnit {
  const planningEntrySection = buildPlanningEntrySection(planningEntry);
  const preparationPacketSection = buildPreparationPacketSection(preparationPacket);
  const validateExistingMode = planningEntry.mode === 'validate-existing';
  const isIncident = (item.labels ?? []).some((l: string) => ['incident', 'rca-requested'].includes(l.toLowerCase()));

  if (isIncident) {
    return buildIncidentPlanningWorkUnit(item, planningEntrySection, preparationPacketSection);
  }

  return {
    unitId: `${item.externalId}-planning`,
    title: `Plan and decompose: ${item.title}`,
    description: [
      validateExistingMode
        ? 'You are validating and tightening a supplied plan package before build begins. Do NOT restart planning from zero when the supplied materials are usable.'
        : 'You are the planning authority for this ticket. Read the full ticket and produce a structured implementation plan.',
      '',
      `## Ticket: ${item.title}`,
      '',
      item.body ?? '',
      '',
      ...planningEntrySection,
      ...(preparationPacketSection.length > 0 ? ['', ...preparationPacketSection] : []),
      '',
      '## Your Task',
      '0. Read PM-PREP-PACKET.md first when present. Use it as the explicit preparation contract and artifact-quality bar.',
      '0a. Follow PMP-style project controls for scope, schedule, estimates, risks, stakeholders/communications, resources, dependencies, and readiness. Respect TOGAF-style architect outputs as the architecture source of truth. Require downstream execution agents to follow RALF handovers and delivery discipline.',
      validateExistingMode
        ? '1. Read the supplied plan package and existing workspace artifacts first. Reuse good planning work instead of starting over.'
        : '1. Read TECHNICAL-SPECIFICATION.md when it exists and reference it explicitly.',
      validateExistingMode
        ? '2. Validate the supplied plan for architecture, functional scope, integration boundaries, hosting, costing, estimate, phasing, and resourcing gaps.'
        : '2. Produce IMPLEMENTATION-PLAN.md in the workspace root.',
      validateExistingMode
        ? '3. Produce a tightened IMPLEMENTATION-PLAN.md in the workspace root that becomes the approved build plan.'
        : '3. Synthesize the architecture, business requirements, constraints, and dependencies into a build-ready plan.',
      validateExistingMode
        ? '4. Fill only the missing or weak parts. Do NOT re-discover solved work unless the supplied plan is insufficient.'
        : '4. For each subtask, specify a clear title, description, files to create, acceptance criteria, and suggested agent role.',
      validateExistingMode
        ? '5. Add a ## PLAN VALIDATION section summarizing what was accepted, what was corrected, and what gaps still remain.'
        : '5. Add sequencing, dependencies, and delivery notes that help execution move cleanly.',
      validateExistingMode
        ? '6. Add a ## RESOURCING CHECK section naming the specialist roles or agents needed for build.'
        : '6. Decompose the implementation into concrete subtasks (2-7 subtasks).',
      validateExistingMode
        ? '7. Include a ## SUBTASK DECOMPOSITION section with the build-ready subtasks (2-7 subtasks).'
        : '7. Include a ## SUBTASK DECOMPOSITION section with the build-ready subtasks (2-7 subtasks).',
      '',
      '## Required Output Format',
      'Your response MUST include a section with this exact header:',
      '',
      '## SUBTASK DECOMPOSITION',
      '',
      '### Subtask 1: [Clear title describing the work]',
      'Description of what needs to be done, acceptance criteria, and suggested agent role.',
      '',
      '### Subtask 2: [Clear title describing the work]',
      'Description of what needs to be done, acceptance criteria, and suggested agent role.',
    ].join('\n'),
    acceptanceCriteria: ['Planning output includes IMPLEMENTATION-PLAN.md and a ## SUBTASK DECOMPOSITION section with 2+ subtasks'],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'analysis',
    parentUnitId: null,
    depth: 0,
  };
}

/** @description Builds the incident investigation planning work unit — single bot assignment, no decomposition. */
function buildIncidentPlanningWorkUnit(
  item: ExternalWorkItem,
  planningEntrySection: string[],
  preparationPacketSection: string[],
): DecomposedWorkUnit {
  return {
    unitId: `${item.externalId}-planning`,
    title: `Investigate incident: ${item.title}`,
    description: [
      'You are the **Incident Investigation Lead**. This is an infrastructure incident, NOT a software development ticket.',
      '',
      '**DO NOT decompose this into multiple subtasks.** Assign the ENTIRE investigation to ONE specialist bot.',
      '**DO NOT write TypeScript, test suites, npm packages, or software applications.**',
      '',
      `## Incident: ${item.title}`,
      '',
      item.body ?? '',
      '',
      ...planningEntrySection,
      ...(preparationPacketSection.length > 0 ? ['', ...preparationPacketSection] : []),
      '',
      '## Your Task as PM',
      '1. Read the incident data above.',
      '2. Write **README.md** — Brief incident summary and evidence inventory.',
      '3. Create exactly ONE subtask that assigns the full investigation to a single specialist.',
      '',
      '## CRITICAL: ONE SUBTASK, ONE BOT',
      'Do NOT split this into separate RCA, topology, and remediation subtasks.',
      'One bot gets everything. That bot will:',
      '- Analyze the evidence and produce a root cause analysis with confidence levels',
      '- Assess topology impact and blast radius',
      '- Search memory for similar past incidents',
      '- Write remediation scripts (DO NOT EXECUTE) with rollback procedures',
      '- Produce all deliverables in the workspace',
      '',
      '## Required Output Format',
      'Your response MUST include:',
      '',
      '## SUBTASK DECOMPOSITION',
      '',
      '### Subtask 1: Investigate and remediate — [incident title]',
      'Full incident investigation: root cause analysis, topology impact assessment, remediation scripts, rollback procedures.',
      '',
      'Use all provided evidence: alert data, SISM infrastructure context, topology graph, ServiceNow changes, Splunk logs.',
      'Search memory for similar past incidents. Use graph and OpenSearch tools if available.',
      '',
      '**Deliverables:**',
      '- deliverables/RCA-REPORT.md — Root cause with confidence, contributing factors, alternatives',
      '- deliverables/IMPACT-ASSESSMENT.md — Blast radius, affected systems, business impact',
      '- deliverables/scripts/diagnose.sh — Diagnostic commands to verify current state',
      '- deliverables/scripts/remediate.sh — Fix steps with preflight checks (DO NOT EXECUTE)',
      '- deliverables/scripts/rollback.sh — Rollback procedures if remediation fails',
      '',
      '**Suggested agent role:** rca-specialist',
    ].join('\n'),
    acceptanceCriteria: ['Single investigation subtask assigned to rca-specialist with all deliverables specified'],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'analysis',
    parentUnitId: null,
    depth: 0,
  };
}

/** @description Builds the pre-planning architecture work unit dispatched to the system architect. */
function buildArchitectureWorkUnit(item: ExternalWorkItem, planningEntry: PlanningEntryDetails): DecomposedWorkUnit {
  const planningEntrySection = buildPlanningEntrySection(planningEntry);
  const validateExistingMode = planningEntry.mode === 'validate-existing';
  return {
    unitId: `${item.externalId}-architecture`,
    title: `Write technical specification: ${item.title}`,
    description: [
      validateExistingMode
        ? 'You are the system architect reviewing a supplied plan package before build planning begins. Validate the existing architecture and fill only the missing technical gaps.'
        : 'You are the system architect for this ticket. Perform the technical discovery before implementation planning begins.',
      '',
      `## Ticket: ${item.title}`,
      '',
      item.body ?? '',
      '',
      ...planningEntrySection,
      '',
      '## Required Deliverable',
      `Write ${TECHNICAL_SPECIFICATION_FILE} to the workspace root.`,
      validateExistingMode
        ? 'Review the supplied plan first. Preserve valid decisions, correct weak ones, and document any missing architecture, integration, stack, hosting, or deployment detail.'
        : 'Ground every external API statement in fetched documentation and document the implementation strategy clearly.',
    ].join('\n'),
    acceptanceCriteria: [`${TECHNICAL_SPECIFICATION_FILE} exists in the workspace root and references the required dependencies and data contracts`],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'analysis',
    parentUnitId: null,
    depth: 0,
  };
}

/** @description Builds a single execution work unit when planning cannot decompose the root ticket. */
function buildSingleWorkUnit(item: ExternalWorkItem): DecomposedWorkUnit {
  return {
    unitId: `${item.externalId}-unit-1`,
    title: item.title,
    description: item.body ?? item.title,
    acceptanceCriteria: [],
    labels: item.labels ?? [],
    priority: item.priority,
    workType: 'implementation',
    parentUnitId: null,
    depth: 0,
  };
}

/** @description Resolves the workspace path shared by all agents working on a ticket. */
function resolveWorkspacePath(workspaceTaskId: string): string {
  const workspaceRoot = process.env.SHARED_WORKSPACE_ROOT
    || (existsSync('/app/workspace') ? '/app/workspace' : resolve(process.cwd(), 'workspace-shared'));
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

/** @description Normalizes a metadata field into a string array. */
function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** @description Reads and merges multiple metadata fields into one deduplicated string array. */
function readMergedStringArray(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => readStringArray(value)))];
}

/** @description Reads artifact blueprints from metadata when they are persisted as JSON objects. */
function readArtifactBlueprints(value: unknown): IntakeArtifactBlueprint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const artifactId = typeof record.artifactId === 'string' ? record.artifactId.trim() : '';
    const displayName = typeof record.displayName === 'string' ? record.displayName.trim() : '';
    const purpose = typeof record.purpose === 'string' ? record.purpose.trim() : '';
    const ownerRole = typeof record.ownerRole === 'string' ? record.ownerRole.trim() : '';
    const governingStandards = readStringArray(record.governingStandards);
    const minimumContents = readStringArray(record.minimumContents);
    const exampleOutline = readStringArray(record.exampleOutline);

    if (!artifactId || !displayName || !purpose || !ownerRole || governingStandards.length === 0 || minimumContents.length === 0 || exampleOutline.length === 0) {
      return [];
    }

    return [{
      artifactId,
      displayName,
      purpose,
      ownerRole,
      governingStandards,
      minimumContents,
      exampleOutline,
    }];
  });
}

/** @description Reads the first non-empty string from a list of metadata values. */
function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** @description Normalizes planning-entry metadata into the supported contract. */
function normalizePlanningEntryMode(value: unknown): IntakePlanningEntryMode | undefined {
  return value === 'validate-existing' || value === 'discovery'
    ? value
    : undefined;
}

/** @description Normalizes plan-status metadata into the supported contract. */
function normalizePlanStatus(value: unknown): IntakePlanStatus | undefined {
  return value === 'missing' || value === 'supplied' || value === 'approved' || value === 'gap-fill-required'
    ? value
    : undefined;
}

/** @description Returns whether the optional architecture pre-round is enabled — forced via env var or auto-triggered for high-complexity tickets. */
function normalizeRecommendedPath(value: unknown): IntakeRecommendedPath | undefined {
  return value === 'instant-answer' || value === 'direct-execution' || value === 'structured-project'
    ? value
    : undefined;
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
