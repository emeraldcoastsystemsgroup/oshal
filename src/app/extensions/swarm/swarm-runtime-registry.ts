/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted runtime-registry + heartbeat helpers out of extensions/swarm/index.ts to keep that file under the 1000-line governance cap. Behavior-preserving move; startRuntimeAgentHeartbeat now takes a structural subset of the bindings so no circular import on SwarmExtensionBindings.
 */

import { createChildLogger } from '@/shared/logger';
import type { AgentProfileRepository } from '@/entities/agent';
import {
  MESH_CHANNELS,
  type AgentRuntimeRegistryService,
  type AgentRuntimeRegistration,
} from '@/features/agent-management';
import type { SwarmRuntimeIdentity } from './swarm-bot-registry';

const logger = createChildLogger({ module: 'swarm-runtime-registry' });

const RUNTIME_REGISTRY_HEARTBEAT_MS = 30000;

export function canUseRuntimeRegistry(env: NodeJS.ProcessEnv = process.env): boolean {
  // Registry service connects to REDIS_URL or defaults to localhost:6379.
  // Always enable on the host so the dashboard can read bot heartbeats,
  // even when REDIS_URL is not explicitly set (localhost default works).
  if (typeof env.REDIS_URL === 'string' && env.REDIS_URL.trim().length > 0) return true;
  // Host API server: no REDIS_URL but localhost:6379 is the swarm Redis
  return true;
}

/**
 * @description Builds an online agent resolver that combines Redis heartbeat presence with
 * Postgres agent status. Disabled bots (status=inactive) are excluded even when their
 * container is running and publishing heartbeats. Closes TD-20.
 * @param registryService - Runtime registry that reads Redis heartbeats
 * @param profileRepo - Agent profile repo that reads Postgres status
 * @returns Resolver function returning only active + online agent IDs
 */
export function buildStatusAwareOnlineResolver(
  registryService: AgentRuntimeRegistryService,
  profileRepo?: AgentProfileRepository,
): () => Promise<string[]> {
  return async () => {
    const onlineIds = await registryService.listOnlineAgentIds();
    if (!profileRepo) return onlineIds;
    try {
      const agents = await profileRepo.listAgents();
      const inactiveIds = new Set(
        agents.filter((a) => a.status !== 'active').map((a) => a.agentId),
      );
      if (inactiveIds.size === 0) return onlineIds;
      const filtered = onlineIds.filter((id) => !inactiveIds.has(id));
      if (filtered.length < onlineIds.length) {
        logger.info(
          { removedCount: onlineIds.length - filtered.length, inactiveIds: [...inactiveIds] },
          'Excluded DB-inactive agents from online resolver',
        );
      }
      return filtered;
    } catch {
      return onlineIds;
    }
  };
}

export function buildRuntimeAliasChannels(runtimeIdentity: SwarmRuntimeIdentity): string[] {
  return [runtimeIdentity.agentName, ...runtimeIdentity.aliases]
    .filter((alias) => alias.length > 0 && alias !== runtimeIdentity.agentId)
    .map((alias) => MESH_CHANNELS.agentDirect(alias));
}

export function startRuntimeAgentHeartbeat(bindings: {
  runtimeRegistryService?: AgentRuntimeRegistryService;
  runtimeIdentity: SwarmRuntimeIdentity;
}): void {
  if (!bindings.runtimeRegistryService) {
    return;
  }
  // BF-030: Don't publish heartbeats from the host API server — it is the
  // control plane, not a swarm worker. Guard on SWARM_MODE or fallback identity.
  const swarmMode = process.env.SWARM_MODE || 'single';
  if (swarmMode !== 'container' || bindings.runtimeIdentity.agentId === 'unknown-agent') {
    logger.info(
      { swarmMode, agentId: bindings.runtimeIdentity.agentId },
      'Skipping heartbeat — host API server is read-only for runtime registry',
    );
    return;
  }

  const startedAt = new Date().toISOString();
  const publishHeartbeat = async () => {
    const registration = buildRuntimeRegistration(bindings.runtimeIdentity, startedAt);
    await bindings.runtimeRegistryService!.upsertAgent(registration);
  };

  publishHeartbeat().catch((error) => {
    logger.error({ err: error, agentId: bindings.runtimeIdentity.agentId }, 'Failed to publish initial runtime heartbeat');
  });

  const timer = setInterval(() => {
    publishHeartbeat().catch((error) => {
      logger.error({ err: error, agentId: bindings.runtimeIdentity.agentId }, 'Failed to refresh runtime heartbeat');
    });
  }, RUNTIME_REGISTRY_HEARTBEAT_MS);
  timer.unref?.();
}

function buildRuntimeRegistration(
  runtimeIdentity: SwarmRuntimeIdentity,
  startedAt: string,
): AgentRuntimeRegistration {
  return {
    agentId: runtimeIdentity.agentId,
    agentName: runtimeIdentity.agentName,
    aliases: runtimeIdentity.aliases,
    role: runtimeIdentity.role,
    capabilities: runtimeIdentity.capabilities,
    status: 'online',
    endpointUrl: runtimeIdentity.endpointUrl,
    internalEndpointUrl: runtimeIdentity.internalEndpointUrl,
    externalPort: runtimeIdentity.externalPort,
    startedAt,
    heartbeatAt: new Date().toISOString(),
  };
}
