/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added agent factory for topology-driven runtime class instantiation
 */

import { createChildLogger } from '@/shared/logger';
import type { LLMService } from '@/features/llm-provider';
import type { PersonaLayer, MeshTransport } from '@/features/agent-management';
import type { AgentProfile } from '../schemas';
import { BaseAgent, type AgentTopology, type AgentRole, type AgentIdentity } from './base-agent';
import { LocalHostAgent } from './local-host-agent';
import { SwarmAgent } from './swarm-agent';

const logger = createChildLogger({ module: 'agent-factory' });

/**
 * @description Options for creating an agent via the factory.
 */
export interface CreateAgentOptions {
  profile: AgentProfile;
  topology?: AgentTopology;
  role?: AgentRole;
  tenantId?: string;
  getProvider: () => LLMService;
  personaLayers?: PersonaLayer[];
  meshTransport?: MeshTransport;
  selectorDescriptor?: string;
  routingKeywords?: string[];
}

/**
 * @description Creates the correct agent runtime class based on topology.
 * Topology flags are used only here at the boundary — runtime uses polymorphism.
 * @param options - Agent creation options
 * @returns Initialized agent runtime instance
 */
export async function createAgent(options: CreateAgentOptions): Promise<BaseAgent> {
  const topology = options.topology || resolveTopology(options.profile);
  const role = options.role || resolveRole(options.profile);

  const identity: AgentIdentity = {
    agentId: options.profile.agentId,
    name: options.profile.name,
    topology,
    role,
    tenantId: options.tenantId,
  };

  let agent: BaseAgent;

  if (topology === 'swarm') {
    if (!options.meshTransport) {
      logger.warn(
        { agentId: identity.agentId },
        'Swarm topology requested but no mesh transport — falling back to localhost',
      );
      agent = new LocalHostAgent({
        profile: options.profile,
        identity,
        getProvider: options.getProvider,
        personaLayers: options.personaLayers,
      });
    } else {
      agent = new SwarmAgent({
        profile: options.profile,
        identity,
        getProvider: options.getProvider,
        personaLayers: options.personaLayers,
        meshTransport: options.meshTransport,
        selectorDescriptor: options.selectorDescriptor,
        routingKeywords: options.routingKeywords,
      });
    }
  } else {
    agent = new LocalHostAgent({
      profile: options.profile,
      identity,
      getProvider: options.getProvider,
      personaLayers: options.personaLayers,
    });
  }

  await agent.initialize();

  logger.info(
    { agentId: identity.agentId, topology, role, type: agent.constructor.name },
    'Agent created via factory',
  );

  return agent;
}

/**
 * @description Resolves topology from profile metadata.
 * @param profile - Agent profile
 * @returns Agent topology
 */
function resolveTopology(profile: AgentProfile): AgentTopology {
  const metadata = profile.metadata as Record<string, unknown> | undefined;
  if (metadata && metadata.topology === 'swarm') {
    return 'swarm';
  }
  return 'localhost';
}

/**
 * @description Resolves role from profile metadata.
 * @param profile - Agent profile
 * @returns Agent role
 */
function resolveRole(profile: AgentProfile): AgentRole {
  const metadata = profile.metadata as Record<string, unknown> | undefined;
  if (metadata && typeof metadata.role === 'string') {
    const role = metadata.role as string;
    if (role === 'primary' || role === 'worker' || role === 'specialist' || role === 'noop') {
      return role;
    }
  }
  return 'primary';
}
