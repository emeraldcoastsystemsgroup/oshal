/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added 7-phase lifecycle gate configuration with complexity-driven phase skipping
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Restored review gating for medium-complexity tickets so completion review is required on medium/high paths
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'phase-gate-config' });

/**
 * @description The seven lifecycle phases for swarm ticket processing.
 * Modeled after the legacy implementation's TicketPhaseManager 7-phase progression.
 */
export const SWARM_PHASE_ORDER = [
  'intake',
  'planning',
  'specialist_input',
  'execution',
  'testing',
  'review',
  'delivery',
] as const;

/**
 * @description One lifecycle phase identifier.
 */
export type SwarmPhase = (typeof SWARM_PHASE_ORDER)[number];

/**
 * @description Complexity rating for a ticket, drives which phases are required.
 */
export type TicketComplexity = 'low' | 'medium' | 'high';

/**
 * @description Configuration for which phases are active for a given complexity level.
 */
export interface PhaseGateConfig {
  complexity: TicketComplexity;
  activePhases: SwarmPhase[];
  complexityScore: number;
}

/**
 * @description Phase requirements by complexity level.
 * - Low (1-3): intake → planning → execution → delivery (skip specialist_input, testing, review)
 * - Medium (4-6): intake → planning → execution → testing → review → delivery (skip specialist_input only)
 * - High (7-10): all 7 phases active
 */
const PHASE_REQUIREMENTS: Record<TicketComplexity, SwarmPhase[]> = {
  low: ['intake', 'planning', 'execution', 'delivery'],
  medium: ['intake', 'planning', 'execution', 'testing', 'review', 'delivery'],
  high: ['intake', 'planning', 'specialist_input', 'execution', 'testing', 'review', 'delivery'],
};

/**
 * @description Scores a ticket's complexity based on heuristics: work unit count,
 * label signals, description length, and acceptance criteria count.
 * @param workUnitCount - Number of decomposed work units
 * @param labels - Ticket labels/tags
 * @param descriptionLength - Character length of ticket body
 * @param acceptanceCriteriaCount - Number of acceptance criteria across all units
 * @returns Complexity score from 1-10
 */
export function scoreComplexity(
  workUnitCount: number,
  labels: string[],
  descriptionLength: number,
  acceptanceCriteriaCount: number,
): number {
  let score = 1;

  // Work unit count contribution (0-3 points)
  if (workUnitCount >= 4) score += 3;
  else if (workUnitCount >= 2) score += 2;
  else if (workUnitCount >= 1) score += 1;

  // Description length contribution (0-2 points)
  if (descriptionLength > 2000) score += 2;
  else if (descriptionLength > 500) score += 1;

  // Acceptance criteria contribution (0-2 points)
  if (acceptanceCriteriaCount >= 5) score += 2;
  else if (acceptanceCriteriaCount >= 2) score += 1;

  // Label signals (0-3 points)
  const highComplexityLabels = [
    'complex', 'architecture', 'security', 'migration', 'breaking-change', 'multi-team',
    'agent-extension', 'tool-registration', 'multi-component', 'swarm-test', 'baseline-test',
    'infrastructure', 'integration', 'full-stack',
  ];
  const matchCount = labels.filter((l) => highComplexityLabels.some((h) => l.toLowerCase().includes(h))).length;
  if (matchCount >= 2) score += 3;
  else if (matchCount >= 1) score += 2;

  // High label count signals multi-faceted work (0-2 points)
  if (labels.length >= 5) score += 2;
  else if (labels.length >= 3) score += 1;

  return Math.min(score, 10);
}

/**
 * @description Maps a numeric complexity score to a complexity level.
 * @param score - Complexity score from 1-10
 * @returns Complexity level
 */
export function complexityFromScore(score: number): TicketComplexity {
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/**
 * @description Resolves the phase gate configuration for a ticket based on its complexity.
 * @param workUnitCount - Number of decomposed work units
 * @param labels - Ticket labels
 * @param descriptionLength - Description character length
 * @param acceptanceCriteriaCount - Total acceptance criteria
 * @returns Phase gate configuration with active phases
 */
export function resolvePhaseGateConfig(
  workUnitCount: number,
  labels: string[],
  descriptionLength: number,
  acceptanceCriteriaCount: number,
): PhaseGateConfig {
  // Note: Incident tickets bypass the phase system entirely via queue-manager-service.
  // They never reach this function. This is only for build tickets.
  const complexityScore = scoreComplexity(workUnitCount, labels, descriptionLength, acceptanceCriteriaCount);
  const complexity = complexityFromScore(complexityScore);
  const activePhases = PHASE_REQUIREMENTS[complexity];

  logger.info(
    { complexityScore, complexity, activePhasesCount: activePhases.length, activePhases },
    'Resolved phase gate configuration',
  );

  return { complexity, activePhases, complexityScore };
}

/**
 * @description Checks whether a given phase is active in the gate configuration.
 * @param phase - Phase to check
 * @param config - Phase gate configuration
 * @returns True if the phase should be executed
 */
export function isPhaseActive(phase: SwarmPhase, config: PhaseGateConfig): boolean {
  return config.activePhases.includes(phase);
}
