/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | WS2: Created phase-override-layer-builder — review-mode persona layer replaces file persona for consensus-review-request tasks, preventing planning SOP misbinding that caused PLANNING_BLOCKED failures in Phase 6 review
 */

import { createChildLogger } from '@/shared/logger';
import type { PersonaLayer } from '@/features/agent-management';

const logger = createChildLogger({ module: 'phase-override-layer-builder' });

/**
 * @description Builds a review-mode persona layer for consensus-review-request tasks.
 *
 * The normal file-persona layer (priority 5) instructs the bot to read its YAML context
 * file which contains planning SOPs. When task-manager is assigned as round-1 reviewer,
 * it reads project-manager-context.md → follows planning SOP → blocks with PLANNING_BLOCKED.
 *
 * This layer replaces the file persona for review tasks. The bot still knows its identity
 * and role, but is redirected to return a review verdict rather than trigger planning flows.
 *
 * @param agentId - Agent identifier (for logging)
 * @param agentName - Human-readable agent name
 * @param role - Review role from the envelope payload (e.g. 'qa-gatekeeper', 'domain-specialist-review')
 * @returns Persona layer at priority 5 (same slot as the file persona it replaces)
 */
function buildReviewModePersonaLayer(
  agentId: string,
  agentName: string,
  role: string,
): PersonaLayer {
  logger.debug({ agentId, agentName, role }, 'Building review-mode persona layer — file persona suppressed for review task');
  return {
    layerType: 'platform',
    priority: 5,
    promptFragment: [
      '# REVIEW MODE — Phase 6 Consensus Review',
      `You are **${agentName}** acting as **${role}**.`,
      '',
      '## This is a REVIEW task — NOT a planning task.',
      '- Do NOT read PROCESS-FLOW.md or TECHNICAL-SPECIFICATION.md.',
      '- Do NOT create deliverables/, planning artifacts, or architecture documents.',
      '- Do NOT follow planning or implementation SOPs from your standard context file.',
      '- Do NOT request files that are only needed for planning phases.',
      '',
      '## Your only job in this task:',
      '1. Read the execution output and work units provided below.',
      '2. Evaluate the deliverable against the acceptance criteria.',
      '3. Return your verdict using exactly this format:',
      '   Verdict: APPROVED | REJECTED | NEEDS REVISION',
      '   Findings: [list each specific issue or confirmation, one per line]',
      '   Summary: [concise conclusion, 1-3 sentences]',
    ].join('\n'),
  };
}

/**
 * @description Returns a review-mode persona layer when the payload type is a consensus review,
 * or null when no phase override is needed (all other task types).
 *
 * This is called in llm-execution-handler.ts to conditionally replace buildFilePersonaLayer()
 * for review tasks without modifying file-persona logic for any other task type.
 *
 * @param payloadType - The envelope payload `type` field
 * @param agentId - Agent identifier (for logging)
 * @param agentName - Human-readable agent name
 * @param role - Review role from the envelope payload
 * @returns Review-mode PersonaLayer, or null for non-review task types
 */
export function buildPhasePersonaOverride(
  payloadType: string,
  agentId: string,
  agentName: string,
  role: string,
): PersonaLayer | null {
  if (payloadType !== 'consensus-review-request') {
    return null;
  }
  return buildReviewModePersonaLayer(agentId, agentName, role);
}
