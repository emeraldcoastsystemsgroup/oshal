/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added service barrel for extension-layer swarm scaffolds
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Exported Redis mesh transport for durable inter-agent envelope delivery
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Exported runtime agent registry service for live swarm worker availability tracking
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Exported MeshBidBroadcaster — ported from the legacy MeshBroadcastNetwork.js
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | IMP-1: Exported AgentEligibilityService for richer availability model beyond heartbeat-only filtering
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Exported DynamicComposeService so the swarm extension can wire the AgentFactoryService launch deps (createAndStartAgent) through the barrel instead of a deep import
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | Exported delegation-aware BotNodeClient construction options through the feature barrel.
 */

export { RedisMeshTransport, type RedisMeshTransportOptions } from './redis-mesh-transport';
export {
  AgentRuntimeRegistryService,
  type AgentRuntimeRegistration,
  type AgentRuntimeRegistryOptions,
} from './agent-runtime-registry-service';
export {
  PersonaLayerComposer,
  type PersonaLayer,
  type PersonaLayerType,
  type ComposedPersona,
} from './persona-layer-composer';
export {
  AgentRouter,
  type RouteContext,
  type RouteCandidate,
  type RouteDecision,
  type RoutingStrategy,
  type LLMRoutingFunction,
} from './agent-router';
export { SelectionBidService, type AgentBid } from './selection-bid-service';
export {
  MeshCommunicationService,
  MESH_CHANNELS,
  type MeshEnvelope,
  type MeshTransport,
  type MeshSubscription,
  type ConsumedEnvelope,
} from './mesh-communication-service';
export { PersonaLayerStore, type PersistedPersonaLayer } from './persona-layer-store';
export {
  AgentFactoryService,
  type AgentSpecification,
  type AgentCreationResult,
  type AgentOperationalReadiness,
  type AgentFactoryServiceDeps,
} from './agent-factory-service';
export {
  CapabilityExpansionService,
  type CapabilityExpansionSpec,
  type CapabilityExpansionResult,
  type CapabilityExpansionServiceDeps,
  type ToolSpec,
  type ToolInputField,
  type ConfigField,
} from './capability-expansion-service';
export { AgentConfigService, type AgentConfig } from './agent-config-service';
export {
  createAgentConfigRuntimeParamsResolver,
  resolveDispatchConfigFields,
  type DispatchRuntimeParams,
  type RuntimeParamsResolver,
  type DispatchConfigFields,
} from './dispatch-runtime-params';
export {
  AgentMemoryService,
  type AgentMemoryEntry,
  type KnowledgeSource,
  type BootstrapResult,
} from './agent-memory-service';
export {
  SwarmMemoryService,
  type SwarmLearning,
  type CompletedWorkContext,
  type SwarmMemoryEntry,
  type SwarmContextBlock,
} from './swarm-memory-service';
export {
  MeshBidBroadcaster,
  type BidRequestPayload,
  type BroadcastBidResult,
  type MeshBidBroadcasterOptions,
} from './mesh-bid-broadcaster';
export {
  createMeshBidResponder,
  computeBidConfidence,
  type MeshBidResponderOptions,
} from './mesh-bid-responder';
export {
  SwarmBotLifecycleService,
  type SwarmBotLifecycleAction,
  type SwarmBotLifecycleResult,
} from './swarm-bot-lifecycle-service';
export {
  BotContainerSpawnerService,
  type ContainerOperationResult,
  type ContainerStatus,
} from './bot-container-spawner-service';
export {
  DynamicComposeService,
  type DynamicServiceSpec,
  type DynamicComposeOperationResult,
} from './dynamic-compose-service';
export {
  StartupConfigValidator,
  type AgentConfigValidationResult,
  type StartupConfigReport,
} from './startup-config-validator';
export {
  AgentEligibilityService,
  type AgentEligibilitySnapshot,
  type EligibilityEvaluationOptions,
} from './agent-eligibility-service';
export {
  BotNodeClient,
  createRegistryEndpointResolver,
  isControllerInlineContainer,
  resolveDisplayOnline,
  type BotNodeResponse,
  type BotNodeRequest,
  type BotNodeClientOptions,
  type BotEndpointResolver,
} from './bot-node-client';
export {
  NodeAllocatorService,
  type NodeAssignmentConfig,
  type NodeAssignment,
  type PendingMessageInfo,
  type PoolNode,
  type NodeAllocatorOptions,
} from './node-allocator-service';
