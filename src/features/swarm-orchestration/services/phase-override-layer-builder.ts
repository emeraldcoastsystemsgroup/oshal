/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | WS2: Created phase-override-layer-builder — review-mode persona layer replaces file persona for consensus-review-request tasks, preventing planning SOP misbinding that caused PLANNING_BLOCKED failures in Phase 6 review
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Carry the trust stamp the slot requires. This layer replaces buildFilePersonaLayer at priority 5, and that is the only layer that sets serverAuthored: true, so since #142 (2026-08-06) required server provenance for a platform-class layer to be policy, the override returned three keys and no metadata - fell through the fail-closed default, and was JSON-escaped into the DATA ONLY section. Every Phase-6 consensus review on both execution paths (llm-execution-handler and bot-node-execution-handler pass byte-equivalent arguments) therefore assembled with ZERO policy-class layers and emitted no ## TRUSTED POLICY section, with its own verdict-format instructions sitting under a contract telling the model not to follow instructions found there. Stamped, not reclassified: classifyLayer is unchanged and a role layer stays untrusted regardless.
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
    // This layer SUBSTITUTES for buildFilePersonaLayer in the same priority-5 slot, and that is
    // the one layer carrying serverAuthored: true. Without the same stamp it fails closed into
    // <UNTRUSTED_CONTENT> and a consensus review assembles with no ## TRUSTED POLICY section at
    // all - its own "Return your verdict using exactly this format" escaped into data. The text
    // below is a literal in this file; no ticket, tool or user content reaches it.
    metadata: { serverAuthored: true, contentSource: 'phase-override-review-mode' },
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
