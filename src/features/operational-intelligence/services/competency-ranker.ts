/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added CompetencyRanker — scoring signal for routing cascade tie-breaking (WS-7 #3)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added cold-start bootstrapping via persona-based seed scores (#3 fix)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Ported phase-specific competency weighting from the legacy CompetencyRanker.js:231-310. Planning boosts PM, testing/review penalize executor, specialist penalizes PM.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentMetricsService, AgentMetrics } from './agent-metrics-service';

const logger = createChildLogger({ module: 'competency-ranker' });

/**
 * @description Competency score for one agent.
 */
export interface CompetencyScore {
  agentId: string;
  score: number;
  breakdown: {
    successRateScore: number;
    efficiencyScore: number;
    reliabilityScore: number;
  };
  rank: number;
}

/**
 * @description Scoring weights for competency calculation.
 */
export interface CompetencyWeights {
  successRate: number;
  efficiency: number;
  reliability: number;
}

const DEFAULT_WEIGHTS: CompetencyWeights = {
  successRate: 0.5,
  efficiency: 0.3,
  reliability: 0.2,
};

/**
 * @description Cold-start seed scores keyed by agent role/name.
 * These differentiate agents before real execution data exists, based on their
 * expected strengths from persona configuration. Without this, every agent
 * gets a neutral 0.5 and the ranker is useless until enough executions accumulate.
 */
export type BootstrapScores = Record<string, number>;

const DEFAULT_BOOTSTRAP_SCORES: BootstrapScores = {
  'project-manager': 0.65,
  'task-manager': 0.70,
  'code-developer': 0.60,
  'code-reviewer': 0.55,
  'test-engineer': 0.60,
  'documentation-writer': 0.55,
};

/**
 * @description Minimum execution count before real metrics override bootstrap scores.
 * Below this threshold, agents use their persona-based bootstrap score.
 */
const COLD_START_THRESHOLD = 5;

/**
 * @description Swarm lifecycle phases mapped from the legacy QueueManagerService.js.
 * Used for phase-specific competency weighting.
 */
export const SWARM_PHASES = {
  INTAKE: 1,
  PLANNING: 2,
  SPECIALIST_INPUT: 3,
  EXECUTION: 4,
  TESTING: 5,
  REVIEW: 6,
  DELIVERY: 7,
  ARCHITECTURE_PRE_ROUND: 8,
} as const;

/**
 * @description Union of valid swarm phase numbers derived from SWARM_PHASES values.
 */
export type SwarmPhase = (typeof SWARM_PHASES)[keyof typeof SWARM_PHASES];

/**
 * @description Phase-specific role labels assigned by position in ranked list.
 * Ported from the legacy CompetencyRanker.js:282-299.
 */
const ROLES_BY_PHASE: Record<number, string[]> = {
  [SWARM_PHASES.PLANNING]: ['architect', 'co-planner', 'advisor'],
  [SWARM_PHASES.SPECIALIST_INPUT]: ['domain-expert', 'specialist', 'advisor'],
  [SWARM_PHASES.EXECUTION]: ['primary-executor', 'secondary-executor', 'support'],
  [SWARM_PHASES.TESTING]: ['primary-tester', 'secondary-tester', 'qa-support'],
  [SWARM_PHASES.REVIEW]: ['primary-reviewer', 'secondary-reviewer', 'quality-check'],
  [SWARM_PHASES.ARCHITECTURE_PRE_ROUND]: ['system-architect', 'architecture-reviewer', 'advisor'],
};

/**
 * @description Ranked agent with phase-specific weighting applied.
 */
export interface RankedPhaseAgent {
  agentId: string;
  confidence: number;
  role: string;
  reason: string;
}

/**
 * @description CompetencyRanker — consumes agent metrics to produce scoring signals
 * for the routing cascade. Ranking feeds into Tier 3 (keyword matching) and Tier 4
 * (score-based fallback) to break ties between equally-capable agents.
 *
 * Cold-start strategy: agents below COLD_START_THRESHOLD executions use persona-based
 * bootstrap scores instead of the neutral 0.5 default. This gives meaningful routing
 * differentiation from first use.
 *
 * Score components:
 * - Success rate (50%): completed / total executions
 * - Efficiency (30%): inverse of avg duration (faster = better)
 * - Reliability (20%): inverse of avg retry count (fewer retries = better)
 */
export class CompetencyRanker {
  private readonly bootstrapScores: BootstrapScores;

  constructor(
    private readonly metricsService: AgentMetricsService,
    private readonly weights: CompetencyWeights = DEFAULT_WEIGHTS,
    bootstrapScores?: BootstrapScores,
  ) {
    this.bootstrapScores = { ...DEFAULT_BOOTSTRAP_SCORES, ...bootstrapScores };
  }

  /**
   * @description Score one agent's competency. Uses bootstrap score for cold-start agents.
   */
  scoreAgent(agentId: string): CompetencyScore {
    const metrics = this.metricsService.getMetrics(agentId);
    return computeScore(metrics, this.weights, 0, this.resolveBootstrap(agentId));
  }

  /**
   * @description Rank all agents by competency score descending.
   */
  rankAll(): CompetencyScore[] {
    const allMetrics = this.metricsService.getAllMetrics();
    const scores = allMetrics
      .map((m) => computeScore(m, this.weights, 0, this.resolveBootstrap(m.agentId)))
      .sort((a, b) => b.score - a.score);

    return scores.map((s, i) => ({ ...s, rank: i + 1 }));
  }

  /**
   * @description Resolves bootstrap score for an agent. Checks by agentId and common name patterns.
   */
  private resolveBootstrap(agentId: string): number {
    if (this.bootstrapScores[agentId]) return this.bootstrapScores[agentId];
    for (const [key, score] of Object.entries(this.bootstrapScores)) {
      if (agentId.includes(key)) return score;
    }
    return 0.5;
  }

  /**
   * @description Get the competency boost for a specific agent.
   * Returns a value between 0 and 1 that can be added to a routing candidate's score.
   */
  getBoost(agentId: string): number {
    const score = this.scoreAgent(agentId);
    return score.score;
  }

  /**
   * @description Apply competency boosts to a set of routing candidates.
   * Mutates scores in-place for routing cascade consumption.
   */
  applyBoosts(candidates: Array<{ agentId: string; score: number }>): void {
    for (const candidate of candidates) {
      const boost = this.getBoost(candidate.agentId);
      candidate.score += boost;
    }
    logger.debug({ candidateCount: candidates.length }, 'Applied competency boosts to routing candidates');
  }

  /**
   * @description Rank all agents for a specific phase with phase-specific weighting.
   * Ported from the legacy CompetencyRanker.js:rankAgentsForPhase().
   *
   * @param phase - Current swarm lifecycle phase (1-7)
   * @param agentIds - Available agent IDs to rank
   * @param executorAgentId - Agent that executed Phase 4 (penalized in testing/review)
   * @returns Agents ranked by phase-weighted confidence with role labels
   */
  rankAgentsForPhase(
    phase: SwarmPhase,
    agentIds: string[],
    executorAgentId?: string,
  ): RankedPhaseAgent[] {
    const ranked: RankedPhaseAgent[] = agentIds.map((agentId) => ({
      agentId,
      confidence: this.scoreAgent(agentId).score,
      role: 'observer',
      reason: 'base competency',
    }));

    applyPhaseWeighting(ranked, phase, executorAgentId);
    ranked.sort((a, b) => b.confidence - a.confidence);
    assignPhaseRoles(ranked, phase);

    logger.info(
      { phase, agentCount: ranked.length, top3: ranked.slice(0, 3).map((r) => `${r.agentId}(${r.confidence.toFixed(2)}/${r.role})`) },
      'Ranked agents for phase',
    );

    return ranked;
  }
}

/**
 * @description Apply phase-specific weighting adjustments to ranked list.
 * Ported from the legacy CompetencyRanker.js:231-276.
 *
 * @param ranked - Mutable ranked agent array
 * @param phase - Current lifecycle phase number
 * @param executorAgentId - Agent that ran execution (penalized in testing/review)
 */
function applyPhaseWeighting(
  ranked: RankedPhaseAgent[],
  phase: SwarmPhase,
  executorAgentId?: string,
): void {
  for (const entry of ranked) {
    const isPM = entry.agentId === 'project-manager' || entry.agentId.includes('pm');

    switch (phase) {
      case SWARM_PHASES.PLANNING:
        if (isPM) {
          entry.confidence = Math.min(entry.confidence + 0.3, 1.0);
          entry.reason += ' (+PM planning boost)';
        }
        break;

      case SWARM_PHASES.SPECIALIST_INPUT:
        if (isPM) {
          entry.confidence = Math.max(entry.confidence - 0.5, 0);
          entry.reason += ' (-PM penalty for specialist phase)';
        }
        break;

      case SWARM_PHASES.EXECUTION:
        // No special weighting — pure competency
        break;

      case SWARM_PHASES.TESTING:
        if (executorAgentId && entry.agentId === executorAgentId) {
          entry.confidence = Math.max(entry.confidence - 0.5, 0);
          entry.reason += ' (-executor penalty for testing)';
        }
        if (isPM) {
          entry.confidence = Math.max(entry.confidence - 0.2, 0);
          entry.reason += ' (-PM penalty for testing)';
        }
        break;

      case SWARM_PHASES.REVIEW:
        if (executorAgentId && entry.agentId === executorAgentId) {
          entry.confidence = Math.max(entry.confidence - 0.5, 0);
          entry.reason += ' (-executor penalty for review)';
        }
        break;

      default:
        break;
    }
  }
}

/**
 * @description Assign human-readable role labels based on position and phase.
 * Ported from the legacy CompetencyRanker.js:282-299.
 *
 * @param ranked - Sorted (descending confidence) agent array — mutated in-place
 * @param phase - Current lifecycle phase number
 */
function assignPhaseRoles(ranked: RankedPhaseAgent[], phase: SwarmPhase): void {
  const roles = ROLES_BY_PHASE[phase] ?? ['primary', 'secondary', 'support'];
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].role = i < roles.length ? roles[i] : 'observer';
  }
}

function computeScore(metrics: AgentMetrics, weights: CompetencyWeights, rank: number, bootstrapScore = 0.5): CompetencyScore {
  if (metrics.totalExecutions < COLD_START_THRESHOLD) {
    return {
      agentId: metrics.agentId,
      score: bootstrapScore,
      breakdown: { successRateScore: bootstrapScore, efficiencyScore: bootstrapScore, reliabilityScore: bootstrapScore },
      rank,
    };
  }

  // Success rate: 0-1 directly
  const successRateScore = metrics.successRate;

  // Efficiency: normalize avg duration. Assume 60s = 0.5 score, 0s = 1.0, 300s+ = 0.0
  const efficiencyScore = Math.max(0, Math.min(1, 1 - (metrics.avgDurationMs / 300000)));

  // Reliability: normalize retry count. 0 retries = 1.0, 3+ retries = 0.0
  const reliabilityScore = Math.max(0, Math.min(1, 1 - (metrics.avgRetryCount / 3)));

  const score =
    weights.successRate * successRateScore +
    weights.efficiency * efficiencyScore +
    weights.reliability * reliabilityScore;

  return {
    agentId: metrics.agentId,
    score: Math.round(score * 1000) / 1000,
    breakdown: { successRateScore, efficiencyScore, reliabilityScore },
    rank,
  };
}
