/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile runtime wiring helper for dedicated persisted chat-agent profile endpoints
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired workspace config sync so model/provider profile changes propagate to runtime globalState.json
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { AgentProfileRepository } from '@/entities/agent';
import { AgentProfileController, AgentProfileService, WorkspaceConfigSyncService } from '@/features/agent-profile';

const logger = createChildLogger({ module: 'agent-profile-runtime' });

/**
 * @description Creates the dedicated agent-profile service/controller pair.
 * @param pool - Shared database pool.
 * @param recomposeSelector - Callback used to refresh selector-composition after profile updates.
 * @returns Wired profile runtime components.
 */
export function createAgentProfileComponents(
  pool: Pool,
  recomposeSelector: (agentId: string) => Promise<unknown>,
): { agentProfileController: AgentProfileController; agentProfileService: AgentProfileService } {
  const repository = new AgentProfileRepository(pool);
  const workspaceConfigSync = new WorkspaceConfigSyncService();
  const agentProfileService = new AgentProfileService({
    repository,
    recomposeSelector,
    syncWorkspaceConfig: (agentId, patch) => workspaceConfigSync.syncAgentWorkspaceConfig(agentId, patch),
  });
  const agentProfileController = new AgentProfileController(agentProfileService, logger);
  return { agentProfileController, agentProfileService };
}
