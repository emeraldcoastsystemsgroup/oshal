/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent-profile runtime wiring helper for dedicated persisted chat-agent profile endpoints
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Wired workspace config sync so model/provider profile changes propagate to runtime globalState.json
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Inject the installed provider-switch resolution into AgentProfileController so /api/agents reports the rung (bot-row | fleet-default | registry) that will serve the next dispatch.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { AgentProfileRepository } from '@/entities/agent';
import { AgentProfileController, AgentProfileService, WorkspaceConfigSyncService } from '@/features/agent-profile';
import { resolveInstalledProviderSwitch } from './provider-switch-runtime';
import { getActiveRegistry, registryHarnessEntry } from '@/app/extensions/swarm/swarm-bot-registry';

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
  // /api/agents reports the rung that will serve the next dispatch: the installed switch
  // snapshot (agent_config row > fleet default) over the registry declaration.
  const agentProfileController = new AgentProfileController(
    agentProfileService,
    logger,
    (agentId) => resolveInstalledProviderSwitch(agentId, registryHarnessEntry(agentId)),
    getActiveRegistry,
  );
  return { agentProfileController, agentProfileService };
}
