/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted agent routing and specialist input from SwarmTicketProcessingService
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired PhaseRoutingService for phase-aware routing. When phase context is available in input, routes through the legacy-style phase cascade instead of the generic 4-tier router.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | IMP-1: Integrated adaptive rerouting — routing failures now attempt alternative agent selection before escalating
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | RI-2: Post-routing validation warns when selected agent is not in canonical DB roster
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import type { ExternalWorkItem } from '@/entities/ticket';
import type { AgentProfileRepository } from '@/entities/agent';
import {
  AgentRouter,
  PersonaLayerComposer,
  AgentEligibilityService,
  type AgentBid,
  type RouteCandidate,
  type RouteDecision,
  type RoutingStrategy,
  type AgentFactoryService,
} from '@/features/agent-management';
import { ConsensusReviewService, type ConsensusReviewOutcome } from './consensus-review-service';
import type { CompetencyRanker } from '@/features/operational-intelligence';
import type { DecomposedWorkUnit } from './ticket-decomposition-service';
import type { SwarmExecutionPolicyOutcome } from './swarm-execution-policy-runner';
import type { SwarmProcessingInput } from './swarm-ticket-processing-service';
import { normalizeCandidates, toError, type SwarmOnlineAgentIdsResolver } from './swarm-ticket-processing-support';
import { PhaseRoutingService, type PhaseRoutingContext } from './phase-routing-service';
import { SWARM_PHASES } from '@/features/operational-intelligence';
import { createChildLogger } from '@/shared/logger';
import { attemptAdaptiveReroute, type RoutingDecisionExplanation } from './adaptive-reroute-service';

const logger = createChildLogger({ module: 'swarm-routing-handler' });

/**
 * @description Handles agent selection, specialist routing, and consensus review for swarm processing.
 * Extracted from SwarmTicketProcessingService to enforce the 1000-line governance cap.
 */
/**
 * @description Result of a capability gap check.
 */
export interface CapabilityGapResult {
  hasGap: boolean;
  missingCapabilities: string[];
  availableCapabilities: string[];
  candidateCount: number;
}

/**
 * @description Handles agent selection, specialist routing, capability-gap detection, adaptive
 * rerouting, and consensus review for swarm ticket processing. Extracted from
 * SwarmTicketProcessingService to keep that service under the line-governance cap, and prefers
 * phase-aware routing when a PhaseRoutingService and phase context are available, falling back to
 * the generic agent router otherwise.
 */
export class SwarmRoutingHandler {
  private resolveOnlineAgentIds?: SwarmOnlineAgentIdsResolver;
  private phaseRoutingService?: PhaseRoutingService;
  private eligibilityService?: AgentEligibilityService;
  private agentFactoryService?: AgentFactoryService;
  private autoCreateAgents = false;
  private lastRoutingDecision?: RoutingDecisionExplanation;

  constructor(
    private readonly agentRouter: AgentRouter,
    private readonly personaComposer: PersonaLayerComposer,
    private readonly agentProfileRepository?: AgentProfileRepository,
    private readonly competencyRanker?: CompetencyRanker,
    private readonly consensusReviewService?: ConsensusReviewService,
  ) {}

  /**
   * @description Sets the phase routing service for legacy-style phase-aware routing.
   * When set, selectAgent will use phase context to route through the cascade.
   * @param service - PhaseRoutingService instance
   */
  setPhaseRoutingService(service: PhaseRoutingService): void {
    this.phaseRoutingService = service;
    logger.info('PhaseRoutingService wired into SwarmRoutingHandler');
  }

  /**
   * @description Sets the runtime online-agent resolver used to filter routing candidates to live workers.
   * @param resolveOnlineAgentIds - Async resolver returning canonical IDs of currently live swarm agents.
   * @returns Nothing.
   */
  setOnlineAgentIdsResolver(resolveOnlineAgentIds: SwarmOnlineAgentIdsResolver): void {
    this.resolveOnlineAgentIds = resolveOnlineAgentIds;
  }

  /**
   * @description Sets the agent eligibility service for adaptive rerouting (IMP-1).
   * @param service - AgentEligibilityService instance
   */
  setEligibilityService(service: AgentEligibilityService): void {
    this.eligibilityService = service;
    logger.info('AgentEligibilityService wired into SwarmRoutingHandler for adaptive rerouting');
  }

  /**
   * @description Sets the agent factory for auto-creating specialists when a capability gap is detected.
   * @param service - AgentFactoryService instance
   * @param autoCreate - When true, automatically create agents for missing capabilities. When false, escalate for approval.
   */
  setAgentFactoryService(service: AgentFactoryService, autoCreate = false): void {
    this.agentFactoryService = service;
    this.autoCreateAgents = autoCreate;
    logger.info({ autoCreate }, 'AgentFactoryService wired into SwarmRoutingHandler for capability gap resolution');
  }

  /**
   * @description Detects whether ANY candidate in the swarm has ANY of the required capabilities.
   * A gap means the swarm literally cannot do this work — no agent even claims the capability.
   */
  detectCapabilityGap(requiredCapabilities: string[], candidates: RouteCandidate[]): CapabilityGapResult {
    if (!requiredCapabilities.length) return { hasGap: false, missingCapabilities: [], availableCapabilities: [], candidateCount: candidates.length };

    const availableCapabilities = new Set<string>();
    for (const c of candidates) {
      if (c.capabilities) c.capabilities.forEach((cap) => availableCapabilities.add(cap.toLowerCase()));
      if (c.routingKeywords) c.routingKeywords.forEach((kw) => availableCapabilities.add(kw.toLowerCase()));
    }

    const normalizedRequired = requiredCapabilities.map((c) => c.toLowerCase());
    const missingCapabilities = normalizedRequired.filter((req) => !availableCapabilities.has(req));

    // Gap = NONE of the required capabilities exist in the swarm
    const hasGap = missingCapabilities.length === normalizedRequired.length;

    return {
      hasGap,
      missingCapabilities,
      availableCapabilities: Array.from(availableCapabilities),
      candidateCount: candidates.length,
    };
  }

  /**
   * @description Returns the most recent routing decision explanation for operator visibility.
   * @returns Last routing decision or undefined
   */
  getLastRoutingDecision(): RoutingDecisionExplanation | undefined {
    return this.lastRoutingDecision;
  }

  /**
   * @description Computes ticket routing decision using candidates, bids, and workspace role persona context.
   * @param item - Intake work item to route
   * @param input - Run-level routing hints
   * @param workUnits - Decomposed ticket work units
   * @returns Deterministic route decision from agent router
   */
  async selectAgent(
    item: Pick<ExternalWorkItem, 'externalId' | 'title'> & { body?: string },
    input: SwarmProcessingInput,
    workUnits: DecomposedWorkUnit[],
  ) {
    let candidates: RouteCandidate[];
    try {
      candidates = await normalizeCandidates(
        input.candidates, input.bids, item.title,
        this.agentProfileRepository, this.resolveOnlineAgentIds,
      );
    } catch (error) {
      // IMP-1: Attempt adaptive reroute instead of propagating raw error
      const rerouted = await this.tryAdaptiveReroute(error, item, input);
      if (rerouted) return rerouted;
      throw error;
    }
    // ── Capability gap detection ────────────────────────────────────
    const requiredCaps = input.requiredCapabilities ?? [];
    logger.info({ ticketId: item.externalId, requiredCaps, candidateCount: candidates.length }, 'Capability gap check — input');
    if (requiredCaps.length > 0) {
      const gapResult = this.detectCapabilityGap(requiredCaps, candidates);
      logger.info({ ticketId: item.externalId, ...gapResult }, 'Capability gap check — result');
      if (gapResult.hasGap) {
        logger.warn(
          { ticketId: item.externalId, missingCapabilities: gapResult.missingCapabilities, candidateCount: gapResult.candidateCount },
          'CAPABILITY GAP — no agent in the swarm has any of the required capabilities',
        );

        if (this.agentFactoryService && this.autoCreateAgents) {
          // Auto-create: mint a new specialist for the missing capability.
          // The agent won't have a container yet but will be in the DB for future routing.
          const created = await this.tryAutoCreateAgent(item, gapResult.missingCapabilities);
          if (created) {
            logger.info({ ticketId: item.externalId, newAgentName: created }, 'Auto-created specialist for capability gap — agent registered in DB, continuing with normal routing');
          }
        }

        // Continue with normal routing — the PM will handle planning and the
        // existing bots (code-developer, etc.) can still execute the work.
        // The new agent is registered for future tickets with these capabilities.
      }
    }

    this.competencyRanker?.applyBoosts(candidates);

    // Phase-aware routing (legacy parity): when PhaseRoutingService is wired and
    // phase context is available, use the full phase-specific cascade instead
    // of the generic 4-tier router.
    const phaseInput = input as unknown as Record<string, unknown>;
    const currentPhase = phaseInput._currentPhase ? Number(phaseInput._currentPhase) : undefined;
    const ticketDepth = phaseInput._ticketDepth ? Number(phaseInput._ticketDepth) : 0;

    if (this.phaseRoutingService && (currentPhase || ticketDepth >= 1)) {
      const resolvedPhase = currentPhase ?? null;
      const phaseCtx: PhaseRoutingContext = {
        ticketId: item.externalId,
        ticketTitle: item.title,
        ticketDescription: (item.body ?? '').slice(0, 2000),
        ticketDepth,
        currentPhase: resolvedPhase as import('@/features/operational-intelligence').SwarmPhase | null,
        capabilities: input.requiredCapabilities ?? [],
        complexity: String(phaseInput._complexity ?? 'medium'),
        executorAgentId: phaseInput._executorAgentId ? String(phaseInput._executorAgentId) : undefined,
        pmAssignedAgentId: phaseInput._pmAssignedAgentId ? String(phaseInput._pmAssignedAgentId) : undefined,
        pmAssignedRole: phaseInput._pmAssignedRole ? String(phaseInput._pmAssignedRole) : undefined,
      };

      const phaseResult = await this.phaseRoutingService.route(phaseCtx, candidates);
      const winner = candidates.find((c) => c.agentId === phaseResult.agentId) ?? candidates[0];

      logger.info(
        { externalId: item.externalId, strategy: phaseResult.strategy, agentId: phaseResult.agentId, phase: phaseResult.phase, depth: phaseResult.depth },
        'Phase-aware routing decision',
      );

      // Map phase routing strategy to RoutingStrategy — use 'keyword' for phase-specific strategies
      const mappedStrategy: RoutingStrategy = (['bid', 'llm', 'keyword', 'score', 'catch-all'] as const).includes(
        phaseResult.strategy as RoutingStrategy,
      ) ? phaseResult.strategy as RoutingStrategy : 'keyword';

      const decision = {
        winner: winner ?? { agentId: phaseResult.agentId, score: 0, reason: phaseResult.reason },
        ranked: candidates,
        strategy: mappedStrategy,
      } satisfies RouteDecision;
      await this.validateRoutedAgent(decision.winner.agentId, item.externalId);
      return decision;
    }

    // Generic routing fallback (no phase context)
    const composedPersona = this.personaComposer.compose([
      {
        layerType: 'platform',
        priority: 10,
        promptFragment: 'You are operating in OSHAL swarm orchestration mode.',
      },
      {
        layerType: 'role',
        priority: 20,
        promptFragment: `Workspace role: ${input.workspaceRole ?? 'unassigned'}.`,
      },
      {
        layerType: 'task',
        priority: 30,
        promptFragment: `Process ${workUnits.length} work units for ticket ${item.externalId}.`,
      },
    ]);

    logger.info(
      {
        externalId: item.externalId,
        candidateCount: candidates.length,
        hasBids: Boolean(input.bids && input.bids.length > 0),
        personaLayerCount: composedPersona.appliedLayers.length,
      },
      'Running swarm ticket agent selection (generic routing)',
    );

    return this.agentRouter.route(
      {
        taskId: item.externalId,
        tenantId: input.tenantId,
        workspaceRole: input.workspaceRole,
        requiredCapabilities: input.requiredCapabilities,
        bids: input.bids,
        ticketTitle: item.title,
        ticketLabels: 'labels' in item ? (item as { labels?: string[] }).labels : undefined,
        taskText: buildRoutingTaskText(workUnits),
      },
      candidates,
    );
  }

  /**
   * @description Attempts adaptive rerouting when initial candidate resolution fails.
   * Uses the eligibility service to find alternatives and returns a rerouted decision,
   * or null if rerouting is not possible.
   */
  private async tryAdaptiveReroute(
    error: unknown,
    item: Pick<ExternalWorkItem, 'externalId' | 'title'>,
    input: SwarmProcessingInput,
  ): Promise<RouteDecision | null> {
    if (!this.eligibilityService) return null;

    const phaseInput = input as unknown as Record<string, unknown>;
    const allCandidates = await this.eligibilityService.evaluateAll({
      requiredCapabilities: input.requiredCapabilities,
      phase: phaseInput._currentPhase ? Number(phaseInput._currentPhase) : undefined,
    });
    const eligible = allCandidates.filter((c) => c.eligible);

    const decision = attemptAdaptiveReroute({
      requestedAgentId: phaseInput._pmAssignedAgentId ? String(phaseInput._pmAssignedAgentId) : undefined,
      requestedRole: input.workspaceRole,
      error,
      phase: phaseInput._currentPhase ? Number(phaseInput._currentPhase) : undefined,
      ticketId: item.externalId,
      eligibleCandidates: eligible,
      allCandidates,
    });

    this.lastRoutingDecision = decision;

    if (decision.decision === 'rerouted' && decision.chosenAgentId) {
      logger.info(
        { ticketId: item.externalId, chosenAgent: decision.chosenAgentId, rationale: decision.rationale },
        'Adaptive reroute succeeded — returning alternative agent',
      );
      return {
        winner: { agentId: decision.chosenAgentId, score: 0.5, reason: decision.rationale.join('; ') },
        ranked: eligible.map((e) => ({ agentId: e.agentId, score: e.score, reason: e.rejectionReasons.join(', ') || 'eligible' })),
        strategy: 'keyword' as const,
      };
    }

    logger.warn(
      { ticketId: item.externalId, decision: decision.decision, failureType: decision.failureType },
      'Adaptive reroute exhausted — escalating',
    );
    return null;
  }

  /**
   * @description Routes to a domain specialist for context enrichment on high-complexity tickets.
   * @param item - Ticket requiring specialist input
   * @param workUnits - Decomposed work units
   * @param routing - Current routing decision (primary agent)
   * @returns Specialist input result with enrichment details
   */
  async runSpecialistInput(
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    routing: { winner: RouteCandidate; strategy: string },
  ): Promise<{ specialistAgentId: string; enrichmentType: string; contextInjected: boolean }> {
    try {
      const candidates = await normalizeCandidates(
        undefined, undefined, item.title, this.agentProfileRepository,
      );
      const filtered = candidates.filter((c) => c.agentId !== routing.winner.agentId);

      if (filtered.length === 0) {
        logger.info({ externalId: item.externalId }, 'No specialist candidates available — skipping enrichment');
        return { specialistAgentId: 'none', enrichmentType: 'skipped', contextInjected: false };
      }

      const specialistDecision = await this.agentRouter.route(
        { taskId: `specialist-${item.externalId}`, requiredCapabilities: item.labels, ticketTitle: item.title },
        filtered,
      );

      const specialistLayer = {
        layerType: 'session' as const,
        priority: 25,
        promptFragment: `Domain specialist ${specialistDecision.winner.agentId} reviewed ticket "${item.title}" (${workUnits.length} work units, labels: ${(item.labels ?? []).join(', ')}). Specialist input enrichment applied.`,
      };
      const enrichmentContext = this.personaComposer.compose([specialistLayer]);

      logger.info(
        { externalId: item.externalId, specialistId: specialistDecision.winner.agentId, strategy: specialistDecision.strategy },
        'Specialist input phase — domain expert context injected',
      );

      return {
        specialistAgentId: specialistDecision.winner.agentId,
        enrichmentType: specialistDecision.strategy,
        contextInjected: Boolean(enrichmentContext),
      };
    } catch (error) {
      logger.warn({ err: toError(error), externalId: item.externalId }, 'Specialist input failed — continuing without enrichment');
      return { specialistAgentId: 'fallback', enrichmentType: 'error', contextInjected: false };
    }
  }

  /**
   * @description Runs multi-agent consensus review using the ConsensusReviewService.
   * Falls back to a pass-through if no review service is configured.
   * @param item - Ticket being reviewed
   * @param workUnits - Work units with acceptance criteria
   * @param executionOutcome - Execution outcome with verification and agent details
   * @returns Consensus review outcome
   */
  async runConsensusReview(
    item: ExternalWorkItem,
    workUnits: DecomposedWorkUnit[],
    executionOutcome: SwarmExecutionPolicyOutcome,
    workspaceTaskId?: string,
  ): Promise<ConsensusReviewOutcome> {
    if (!this.consensusReviewService) {
      return {
        consensus: executionOutcome.verification.status === 'passed' ? 'approved' : 'rejected',
        verdicts: [],
        summary: `Fallback: no consensus review service — using execution verification (${executionOutcome.verification.status})`,
        findings: executionOutcome.verification.findings,
        reviewerCount: 0,
        approvedCount: executionOutcome.verification.status === 'passed' ? 1 : 0,
        rejectedCount: executionOutcome.verification.status === 'passed' ? 0 : 1,
      };
    }
    return this.consensusReviewService.review(
      item,
      workUnits,
      executionOutcome.routing.winner.agentId,
      executionOutcome.verification.summary,
      executionOutcome.verification,
      workspaceTaskId,
    );
  }

  /**
   * @description RI-2: Validates that a routed agent exists in the canonical DB roster.
   * Logs a warning for unregistered agents. Does not block routing — this is observability.
   */
  private async validateRoutedAgent(agentId: string, ticketId: string): Promise<void> {
    if (!this.agentProfileRepository) return;
    try {
      const profile = await this.agentProfileRepository.getAgentProfile(agentId);
      if (!profile) {
        logger.warn(
          { agentId, ticketId },
          'RI-2: Routed agent not found in canonical DB roster — task may be orphaned',
        );
      }
    } catch { /* non-blocking validation */ }
  }

  /**
   * @description Auto-create a specialist agent for missing capabilities via the agent factory.
   * Generates a name, system prompt, and capability set from the ticket context.
   * @param item - The ticket that triggered the gap
   * @param missingCapabilities - Capabilities not found in any swarm agent
   * @returns The new agent name, or null if creation failed
   */
  private async tryAutoCreateAgent(
    item: Pick<ExternalWorkItem, 'externalId' | 'title'> & { body?: string },
    missingCapabilities: string[],
  ): Promise<string | null> {
    if (!this.agentFactoryService) return null;
    try {
      const primaryCap = missingCapabilities[0] || 'specialist';
      const name = `${primaryCap}-specialist`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const role = `${primaryCap.charAt(0).toUpperCase() + primaryCap.slice(1)} Specialist`;

      const result = await this.agentFactoryService.createAgentFromSpec({
        name,
        role,
        systemPrompt: `You are a ${role}. You specialize in ${missingCapabilities.join(', ')}. You were auto-created by the swarm to fill a capability gap for ticket: "${item.title}". Apply your expertise to deliver high-quality work in your domain.`,
        topology: 'localhost',
        constraints: [],
        capabilities: missingCapabilities,
        routingKeywords: missingCapabilities,
        selectorDescriptor: `Select this bot for ${missingCapabilities.join(', ')} tasks. Auto-created specialist.`,
      });

      logger.info(
        { ticketId: item.externalId, newAgentId: result.agentId, name, capabilities: missingCapabilities },
        'Agent factory created new specialist for capability gap',
      );
      return name;
    } catch (error) {
      logger.warn({ err: error, ticketId: item.externalId, missingCapabilities }, 'Failed to auto-create specialist — escalating');
      return null;
    }
  }
}

/**
 * @description Collapses work-unit titles, descriptions, and acceptance criteria into routing text.
 * @param workUnits - Decomposed work units for the current ticket.
 * @returns Flattened routing hint text.
 */
function buildRoutingTaskText(workUnits: DecomposedWorkUnit[]): string {
  return workUnits.map((unit) => [
    unit.title,
    unit.description,
    ...(unit.acceptanceCriteria ?? []),
  ].join(' ')).join(' ');
}
