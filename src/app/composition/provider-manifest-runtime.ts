/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime manifest wiring helpers for live agent startup assembly
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Switched manifest profile loading to dedicated persisted agent-profile service with legacy config override fallback removed
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentProfileService } from '@/features/agent-profile';
import type { SwitchFrameworkService } from '@/features/tool-switch';
import type { SelectorCompositionService } from '@/features/selector-composition';
// eslint-disable-next-line no-restricted-imports -- two-runtimes: LLM execution runtime, deliberately off the barrel graph (barrel split, TODO-BOUNDARY-FINDING)
import {
  AgentStartupManifestService,
  ClineRuntimeConfigSyncService,
  type AgentStartupProfile,
} from '@/features/llm-provider/services';

const logger = createChildLogger({ module: 'provider-manifest-runtime' });

/**
 * @description Creates the live agent startup manifest service backed by the current app runtime.
 * @param agentProfileService - Dedicated agent-profile service.
 * @param switchFrameworkService - Switch-framework service for enabled tool state.
 * @param selectorCompositionService - Selector composition service for computed Layer-1 context.
 * @param defaults - Default standalone chat agent identity.
 * @returns Configured manifest service.
 */
export function createAgentStartupManifestService(
  agentProfileService: AgentProfileService,
  switchFrameworkService: SwitchFrameworkService,
  selectorCompositionService: SelectorCompositionService,
  defaults: { agentId: string; agentName: string },
): AgentStartupManifestService {
  const runtimeSyncService = new ClineRuntimeConfigSyncService();

  return new AgentStartupManifestService({
    loadAgentProfile: async (agentId) => readAgentProfile(agentProfileService, agentId, defaults),
    loadAgentTools: async (agentId) => switchFrameworkService.getAgentTools(agentId),
    loadComposedSelector: async (agentId) => selectorCompositionService.getComposedSelector(agentId),
    readMcpSettings: () => runtimeSyncService.readMcpSettings(),
    getMcpSettingsPath: () => runtimeSyncService.getMcpSettingsPath(),
  });
}

/**
 * @description Reads the manifest-ready agent profile from dedicated persisted storage.
 * @param agentProfileService - Dedicated agent-profile service.
 * @param agentId - Active agent identifier.
 * @param defaults - Default standalone chat agent identity.
 * @returns Manifest-ready agent profile or null when the agent is missing.
 */
async function readAgentProfile(
  agentProfileService: AgentProfileService,
  agentId: string,
  defaults: { agentId: string; agentName: string },
): Promise<AgentStartupProfile | null> {
  const profile = await agentProfileService.getAgentProfile(agentId);
  if (!profile) {
    logger.warn({ agentId }, 'Agent profile not found while building startup manifest');
    return null;
  }

  return {
    agentId,
    name: profile.name || defaults.agentName,
    status: profile.status,
    providerId: profile.providerId,
    modelId: profile.modelId,
    persona: profile.persona,
    metadata: profile.metadata,
    projectUrl: profile.projectUrl,
    avatarUrl: profile.avatarUrl,
  };
}
