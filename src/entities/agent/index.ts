/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial placeholder barrel for agent entity layer
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Exported dedicated agent-profile schemas and repository for persisted bot personalization
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime model exports for BaseAgent, LocalHostAgent, SwarmAgent
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported CreateAgentInput for agent-factory bot provisioning
 */

/**
 * @description Barrel export for the agent entity module.
 * Exposes agent profile validation, persistence primitives, and runtime models.
 */
export { AgentProfileRepository, type CreateAgentInput } from './repositories';
export {
  AgentSummarySchema,
  AgentProfileSchema,
  AgentProfileUpdateSchema,
  UpdateAgentProfileRequestSchema,
  AgentBulkProfileTemplateSchema,
  BulkAgentProfileRequestSchema,
  AgentBulkConfigStatusSchema,
  AgentBulkConfigResultSchema,
  type AgentSummary,
  type AgentProfile,
  type AgentProfileUpdateInput,
  type UpdateAgentProfileRequest,
  type AgentBulkProfileTemplate,
  type BulkAgentProfileRequest,
  type AgentBulkConfigStatus,
  type AgentBulkConfigResult,
} from './schemas';
export {
  BaseAgent,
  LocalHostAgent,
  SwarmAgent,
  type AgentTopology,
  type AgentRole,
  type AgentIdentity,
  type CapabilityDescriptor,
  type BaseAgentDeps,
  type LocalHostAgentDeps,
  type SwarmAgentDeps,
  type DelegationResult,
  createAgent,
  type CreateAgentOptions,
} from './models';
