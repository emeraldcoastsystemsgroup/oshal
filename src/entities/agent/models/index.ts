/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added barrel exports for agent runtime models
 */

export {
  BaseAgent,
  type AgentTopology,
  type AgentRole,
  type AgentIdentity,
  type CapabilityDescriptor,
  type BaseAgentDeps,
} from './base-agent';
export { LocalHostAgent, type LocalHostAgentDeps } from './local-host-agent';
export { SwarmAgent, type SwarmAgentDeps, type DelegationResult } from './swarm-agent';
export { createAgent, type CreateAgentOptions } from './agent-factory';
