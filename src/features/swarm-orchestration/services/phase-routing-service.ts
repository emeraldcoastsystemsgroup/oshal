/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ported phase-specific routing decision chain from the legacy QueueManagerService.js:1100-1421. Implements depth-based routing, PM assignment override, mesh bid integration, and phase-specific agent exclusion/boosting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import {
  SWARM_PHASES,
  type SwarmPhase,
  type CompetencyRanker,
  type RankedPhaseAgent,
} from '@/features/operational-intelligence';
import type { AgentRouter, RouteCandidate, RouteDecision, RouteContext, LLMRoutingFunction, MeshBidBroadcaster, BroadcastBidResult } from '@/features/agent-management';

const logger = createChildLogger({ module: 'phase-routing-service' });

/**
 * @description Context for a phase routing decision. Mirrors the legacy implementation's ticket + analysis
 * data passed to the routing chain in QueueManagerService.js:1030-1100.
 */
export interface PhaseRoutingContext {
  ticketId: string;
  ticketTitle: string;
  ticketDescription: string;
  ticketDepth: number;
  currentPhase: SwarmPhase | null;
  capabilities: string[];
  complexity: string;
  executorAgentId?: string;
  pmAssignedAgentId?: string;
  pmAssignedRole?: string;
}

/**
 * @description Result of a phase routing decision.
 */
export interface PhaseRoutingResult {
  agentId: string;
  strategy: string;
  phase: SwarmPhase | null;
  depth: number;
  reason: string;
}

/**
 * @description Phase-specific routing service ported from the legacy QueueManagerService.js:1100-1421.
 *
 * Routing decision chain:
 *   Root ticket (depth 0) with phase lifecycle:
 *     - PLANNING: mesh bid → LLM → PM fallback
 *     - SPECIALIST_INPUT: mesh bid (exclude PM) → phaseManager → any non-PM
 *     - EXECUTION: PM-assigned → LLM → mesh bid → capability matcher
 *     - TESTING: mesh bid (exclude executor+PM) → any non-executor
 *     - REVIEW: consensus cycle or single reviewer (exclude executor)
 *     - DELIVERY: auto-complete
 *
 *   Subtask (depth 1+):
 *     - LLM Router → mesh bid → capability matcher (never PM)
 */
export class PhaseRoutingService {
  constructor(
    private readonly agentRouter: AgentRouter,
    private readonly competencyRanker?: CompetencyRanker,
    private readonly meshBidBroadcaster?: MeshBidBroadcaster,
  ) {}

  /**
   * @description Execute the full routing decision chain for a ticket at a given phase and depth.
   * Ported from the legacy QueueManagerService.js:1100-1421.
   *
   * @param ctx - Phase routing context with ticket details
   * @param candidates - Available route candidates from agent registry
   * @returns Routing decision with selected agent and strategy
   */
  async route(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    if (candidates.length === 0) {
      logger.warn({ ticketId: ctx.ticketId }, 'No candidates available — cannot route');
      return { agentId: 'project-manager', strategy: 'catch-all', phase: ctx.currentPhase, depth: ctx.ticketDepth, reason: 'no candidates' };
    }

    // Apply phase-specific competency weighting to candidates
    if (this.competencyRanker && ctx.currentPhase) {
      const ranked = this.competencyRanker.rankAgentsForPhase(
        ctx.currentPhase,
        candidates.map((c) => c.agentId),
        ctx.executorAgentId,
      );
      this.applyRankedScores(candidates, ranked);
    }

    // Depth-based routing split
    if (ctx.ticketDepth === 0 && ctx.currentPhase) {
      return this.routeRootTicket(ctx, candidates);
    }
    if (ctx.ticketDepth >= 1) {
      return this.routeSubtask(ctx, candidates);
    }

    // Root ticket without phase data — PM fallback
    return this.pmFallback(ctx, candidates, 'root-no-phase');
  }

  /**
   * @description Route root ticket (depth 0) through phase-specific cascade.
   */
  private async routeRootTicket(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    switch (ctx.currentPhase) {
      case SWARM_PHASES.PLANNING:
        return this.routePlanning(ctx, candidates);
      case SWARM_PHASES.SPECIALIST_INPUT:
        return this.routeSpecialistInput(ctx, candidates);
      case SWARM_PHASES.EXECUTION:
        return this.routeExecution(ctx, candidates);
      case SWARM_PHASES.TESTING:
        return this.routeTesting(ctx, candidates);
      case SWARM_PHASES.REVIEW:
        return this.routeReview(ctx, candidates);
      case SWARM_PHASES.DELIVERY:
        return { agentId: 'auto', strategy: 'delivery-auto', phase: ctx.currentPhase, depth: 0, reason: 'delivery phase auto-completes' };
      default:
        return this.pmFallback(ctx, candidates, `unknown-phase-${ctx.currentPhase}`);
    }
  }

  /**
   * @description Phase 2: PLANNING — mesh bid → LLM → PM fallback.
   */
  private async routePlanning(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    // Tier 1: Mesh bid broadcast
    const meshResult = await this.tryMeshBid(ctx, candidates, 'PLANNING');
    if (meshResult) return meshResult;

    // Tier 2: AgentRouter (includes LLM routing if configured)
    const routerResult = await this.tryAgentRouter(ctx, candidates);
    if (routerResult && routerResult.agentId !== 'project-manager') return routerResult;

    // Tier 3: PM fallback (natural choice for planning)
    return this.pmFallback(ctx, candidates, 'planning-default');
  }

  /**
   * @description Phase 3: SPECIALIST_INPUT — mesh bid (exclude PM) → any non-PM.
   */
  private async routeSpecialistInput(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    const nonPM = candidates.filter((c) => !isPM(c.agentId));

    const meshResult = await this.tryMeshBid(ctx, nonPM, 'SPECIALIST_INPUT', ['project-manager']);
    if (meshResult) return meshResult;

    if (nonPM.length > 0) {
      const best = nonPM.sort((a, b) => b.score - a.score)[0];
      return this.result(best.agentId, 'specialist-score', ctx, `highest-scoring non-PM specialist`);
    }

    return this.pmFallback(ctx, candidates, 'specialist-no-alternatives');
  }

  /**
   * @description Phase 4: EXECUTION — PM-assigned → LLM → mesh bid → capability matcher.
   * This is the most sophisticated routing phase. PM assignments override everything.
   */
  private async routeExecution(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    // Step 1: PM-assigned agent (explicit assignment from planning phase)
    if (ctx.pmAssignedAgentId) {
      const assigned = candidates.find((c) => c.agentId === ctx.pmAssignedAgentId);
      if (assigned) {
        logger.info({ ticketId: ctx.ticketId, agentId: assigned.agentId }, 'PM-assigned agent for execution');
        return this.result(assigned.agentId, 'pm-assigned', ctx, `PM assignment: ${ctx.pmAssignedRole ?? 'direct'}`);
      }
      logger.warn({ ticketId: ctx.ticketId, pmAssigned: ctx.pmAssignedAgentId }, 'PM-assigned agent not in candidate set');
    }

    // Step 2: Mesh bid — agents self-evaluate via BID_REQUEST/BID_RESPONSE
    const meshResult = await this.tryMeshBid(ctx, candidates, 'EXECUTION');
    if (meshResult) return meshResult;

    // Step 3: AgentRouter (LLM routing if configured, keyword matching)
    const routerResult = await this.tryAgentRouter(ctx, candidates);
    if (routerResult) return routerResult;

    // Step 4: Highest score fallback (capability matcher equivalent)
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    return this.result(best.agentId, 'capability-score', ctx, 'highest capability score');
  }

  /**
   * @description Phase 5: TESTING — exclude executor+PM, route to fresh eyes.
   */
  private async routeTesting(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    const excludeIds = [ctx.executorAgentId, 'project-manager'].filter(Boolean) as string[];
    const eligible = candidates.filter((c) => !excludeIds.includes(c.agentId));

    const meshResult = await this.tryMeshBid(ctx, eligible.length > 0 ? eligible : candidates, 'TESTING', excludeIds);
    if (meshResult) return meshResult;

    if (eligible.length > 0) {
      const best = eligible.sort((a, b) => b.score - a.score)[0];
      return this.result(best.agentId, 'testing-score', ctx, `fresh-eyes tester (executor: ${ctx.executorAgentId})`);
    }

    // Last resort: any agent that isn't the executor
    const anyNonExecutor = candidates.find((c) => c.agentId !== ctx.executorAgentId);
    return this.result(
      anyNonExecutor?.agentId ?? candidates[0].agentId,
      'testing-fallback',
      ctx,
      'no eligible testers — fallback',
    );
  }

  /**
   * @description Phase 6: REVIEW — exclude executor, route to reviewer.
   */
  private async routeReview(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    const nonExecutor = candidates.filter((c) => c.agentId !== ctx.executorAgentId);
    const eligible = nonExecutor.length > 0 ? nonExecutor : candidates;

    const best = eligible.sort((a, b) => b.score - a.score)[0];
    return this.result(best.agentId, 'review-score', ctx, `reviewer (executor excluded: ${ctx.executorAgentId})`);
  }

  /**
   * @description Route subtask (depth 1+): pm-assigned → mesh bid → capability matcher.
   * PM is never selected for subtask execution (oshal: QueueManagerService.js:1382-1421).
   * 2026-04-02: Added pm-assigned Step 1 — child tickets with resolved pmAssignedAgentId
   * now route directly to the specialist instead of falling through to keyword matching.
   */
  private async routeSubtask(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult> {
    logger.info(
      { ticketId: ctx.ticketId, depth: ctx.ticketDepth, capabilities: ctx.capabilities, pmAssignedAgentId: ctx.pmAssignedAgentId ?? null },
      'Subtask routing — pm-assigned → mesh bid → capability matcher',
    );

    // Step 1: PM-assigned agent (explicit assignment from planning decomposition)
    if (ctx.pmAssignedAgentId) {
      const assigned = candidates.find((c) => c.agentId === ctx.pmAssignedAgentId);
      if (assigned) {
        logger.info({ ticketId: ctx.ticketId, agentId: assigned.agentId }, 'PM-assigned agent for subtask execution');
        return this.result(assigned.agentId, 'pm-assigned', ctx, `PM assignment: ${ctx.pmAssignedRole ?? 'direct'}`);
      }
      logger.warn({ ticketId: ctx.ticketId, pmAssigned: ctx.pmAssignedAgentId }, 'PM-assigned agent not in candidate set — falling through');
    }

    // Step 2: AgentRouter — bid auction → LLM routing → keyword → score (exclude PM)
    const nonPM = candidates.filter((c) => !isPM(c.agentId));
    const routerResult = await this.tryAgentRouter(ctx, nonPM.length > 0 ? nonPM : candidates);
    if (routerResult && !isPM(routerResult.agentId)) return routerResult;

    // Last resort — general-bot catch-all (not PM — PM is a planner, not a doer)
    const generalBot = candidates.find((c) => c.agentId === 'a0000000-0000-0000-0000-000000000099');
    if (generalBot) {
      return this.result(generalBot.agentId, 'subtask-fallback-general', ctx, 'general-bot catch-all');
    }
    return this.pmFallback(ctx, candidates, 'subtask-all-tiers-exhausted');
  }

  // ── Tier helpers ──────────────────────────────────────────────────

  /**
   * @description Try mesh bid broadcast for a routing phase.
   */
  private async tryMeshBid(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
    phase: string,
    excludeAgentIds: string[] = [],
  ): Promise<PhaseRoutingResult | null> {
    if (!this.meshBidBroadcaster) {
      logger.debug({ ticketId: ctx.ticketId, phase }, 'Mesh bid skipped — no broadcaster');
      return null;
    }

    const bidResult = await this.meshBidBroadcaster.broadcastBidRequest(
      ctx.ticketId, ctx.ticketTitle, ctx.ticketDescription,
      ctx.capabilities, ctx.complexity, phase, excludeAgentIds,
    );

    if (!bidResult?.lead) {
      logger.info(
        { ticketId: ctx.ticketId, phase, responded: bidResult?.responded ?? 0, totalAgents: bidResult?.totalAgents ?? 0 },
        'Mesh bid returned no lead — falling through',
      );
      return null;
    }

    const leadCandidate = candidates.find((c) => c.agentId === bidResult.lead!.agentId);
    if (!leadCandidate) {
      logger.warn(
        { ticketId: ctx.ticketId, phase, leadAgentId: bidResult.lead.agentId, candidateIds: candidates.map((c) => c.agentId) },
        'Mesh bid leader not in candidate set — falling through',
      );
      return null;
    }

    return this.result(leadCandidate.agentId, `mesh-bid-${phase.toLowerCase()}`, ctx, `mesh bid leader (confidence: ${bidResult.lead.confidence.toFixed(2)})`);
  }

  /**
   * @description Try the 4-tier AgentRouter for a routing decision.
   */
  private async tryAgentRouter(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
  ): Promise<PhaseRoutingResult | null> {
    try {
      const routeCtx: RouteContext = {
        taskId: ctx.ticketId,
        requiredCapabilities: ctx.capabilities,
        ticketTitle: ctx.ticketTitle,
        taskText: ctx.ticketDescription.slice(0, 500),
      };
      const decision = await this.agentRouter.route(routeCtx, candidates);
      if (decision.strategy !== 'catch-all') {
        return this.result(decision.winner.agentId, `router-${decision.strategy}`, ctx, `AgentRouter tier: ${decision.strategy}`);
      }
    } catch (err) {
      logger.warn({ err, ticketId: ctx.ticketId }, 'AgentRouter failed — falling through');
    }
    return null;
  }

  /**
   * @description PM fallback route.
   */
  private pmFallback(
    ctx: PhaseRoutingContext,
    candidates: RouteCandidate[],
    reason: string,
  ): PhaseRoutingResult {
    const pm = candidates.find((c) => isPM(c.agentId));
    const agentId = pm?.agentId ?? candidates[0]?.agentId ?? 'project-manager';
    return this.result(agentId, 'pm-fallback', ctx, reason);
  }

  /**
   * @description Build a PhaseRoutingResult.
   */
  private result(
    agentId: string,
    strategy: string,
    ctx: PhaseRoutingContext,
    reason: string,
  ): PhaseRoutingResult {
    logger.info(
      { ticketId: ctx.ticketId, agentId, strategy, phase: ctx.currentPhase, depth: ctx.ticketDepth, reason },
      'Phase routing decision',
    );
    return { agentId, strategy, phase: ctx.currentPhase, depth: ctx.ticketDepth, reason };
  }

  /**
   * @description Mutates candidate scores based on phase-weighted competency rankings.
   */
  private applyRankedScores(candidates: RouteCandidate[], ranked: RankedPhaseAgent[]): void {
    const scoreMap = new Map(ranked.map((r) => [r.agentId, r.confidence]));
    for (const c of candidates) {
      const phaseScore = scoreMap.get(c.agentId);
      if (phaseScore !== undefined) {
        c.score = c.score * 0.3 + phaseScore * 0.7;
      }
    }
  }
}

/**
 * @description Check if an agent ID belongs to the project-manager.
 */
function isPM(agentId: string): boolean {
  return agentId === 'project-manager' || agentId.includes('pm-bot') || agentId.includes('project-manager');
}
