/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Implemented abstract BaseAgent runtime class consuming persona/profile infrastructure
 */

import { createChildLogger } from '@/shared/logger';
import type { PersonaLayer, ComposedPersona } from '@/features/agent-management';
import { PersonaLayerComposer } from '@/features/agent-management';
import type { AgentProfile } from '../schemas';

const logger = createChildLogger({ module: 'base-agent' });

/**
 * @description Agent topology — determines which concrete class is used.
 */
export type AgentTopology = 'localhost' | 'swarm';

/**
 * @description Agent runtime role within the deployment.
 */
export type AgentRole = 'primary' | 'worker' | 'specialist' | 'noop';

/**
 * @description Runtime identity resolved at construction time.
 */
export interface AgentIdentity {
  agentId: string;
  name: string;
  topology: AgentTopology;
  role: AgentRole;
  tenantId?: string;
}

/**
 * @description Capability descriptor computed from base capabilities + installed tools.
 */
export interface CapabilityDescriptor {
  agentId: string;
  baseCapabilities: string[];
  toolCapabilities: string[];
  capabilities: string[];
  routingKeywords: string[];
}

/**
 * @description Dependencies injected into agent runtime classes.
 */
export interface BaseAgentDeps {
  profile: AgentProfile;
  identity: AgentIdentity;
  personaLayers?: PersonaLayer[];
  composer?: PersonaLayerComposer;
}

/**
 * @description Abstract base agent runtime.
 * Owns identity, persona composition, and capability tracking.
 * Feature logic belongs in LocalHostAgent or SwarmAgent, not here.
 * Subclasses must implement processMessage() for LLM dispatch.
 */
export abstract class BaseAgent {
  protected readonly profile: AgentProfile;
  protected readonly identity: AgentIdentity;
  protected readonly composer: PersonaLayerComposer;
  protected personaLayers: PersonaLayer[];
  protected composedPersona: ComposedPersona | null = null;
  protected baseCapabilities: string[] = [];
  protected toolCapabilities: string[] = [];
  protected initialized = false;

  constructor(deps: BaseAgentDeps) {
    this.profile = deps.profile;
    this.identity = deps.identity;
    this.personaLayers = deps.personaLayers || [];
    this.composer = deps.composer || new PersonaLayerComposer();
  }

  /**
   * @description Initializes the agent: composes persona, extracts capabilities.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.composedPersona = this.composer.compose(this.personaLayers);
    this.baseCapabilities = this.extractBaseCapabilities();
    this.initialized = true;
    logger.info(
      {
        agentId: this.identity.agentId,
        topology: this.identity.topology,
        role: this.identity.role,
        layerCount: this.composedPersona.appliedLayers.length,
        capabilityCount: this.baseCapabilities.length,
      },
      'Agent initialized',
    );
  }

  /**
   * @description Processes a user message through the agent's LLM provider.
   * @param userMessage - User message text
   * @param taskId - Optional task ID for workspace isolation
   * @param executionScopeId - Optional scope ID for child/review ticket context isolation
   * @returns Response content as text
   */
  abstract processMessage(userMessage: string, taskId?: string, executionScopeId?: string): Promise<string>;

  /**
   * @description Returns the composed system prompt from persona layers.
   */
  getSystemPrompt(): string {
    if (!this.composedPersona) {
      return this.getFallbackPrompt();
    }
    return this.composedPersona.mergedPrompt;
  }

  /**
   * @description Returns the agent's identity.
   */
  getIdentity(): AgentIdentity {
    return this.identity;
  }

  /**
   * @description Returns the agent's profile.
   */
  getProfile(): AgentProfile {
    return this.profile;
  }

  /**
   * @description Returns the agent's capability descriptor.
   */
  getCapabilities(): CapabilityDescriptor {
    const combined = [...new Set([...this.baseCapabilities, ...this.toolCapabilities])];
    return {
      agentId: this.identity.agentId,
      baseCapabilities: this.baseCapabilities,
      toolCapabilities: this.toolCapabilities,
      capabilities: combined,
      routingKeywords: this.extractRoutingKeywords(),
    };
  }

  /**
   * @description Checks if this agent has a specific capability.
   */
  hasCapability(capability: string): boolean {
    return this.baseCapabilities.includes(capability) || this.toolCapabilities.includes(capability);
  }

  /**
   * @description Replaces the current persona layers and recomposes.
   */
  updatePersonaLayers(layers: PersonaLayer[]): void {
    this.personaLayers = layers;
    this.composedPersona = this.composer.compose(this.personaLayers);
    logger.info(
      { agentId: this.identity.agentId, layerCount: this.composedPersona.appliedLayers.length },
      'Persona layers updated',
    );
  }

  /**
   * @description Graceful shutdown hook for subclass cleanup.
   */
  async shutdown(): Promise<void> {
    logger.info({ agentId: this.identity.agentId }, 'Agent shutting down');
  }

  /**
   * @description Extracts base capabilities from profile persona.
   */
  private extractBaseCapabilities(): string[] {
    const persona = this.profile.persona as Record<string, unknown> | undefined;
    if (!persona) {
      return [];
    }
    if (Array.isArray(persona.capabilities)) {
      return persona.capabilities.filter((c): c is string => typeof c === 'string');
    }
    return [];
  }

  /**
   * @description Extracts routing keywords from profile.
   */
  private extractRoutingKeywords(): string[] {
    const metadata = this.profile.metadata as Record<string, unknown> | undefined;
    if (metadata && Array.isArray(metadata.routingKeywords)) {
      return metadata.routingKeywords.filter((k): k is string => typeof k === 'string');
    }
    return [];
  }

  /**
   * @description Builds a fallback prompt when persona layers are absent.
   */
  private getFallbackPrompt(): string {
    const persona = this.profile.persona as Record<string, unknown> | undefined;
    if (persona && typeof persona.systemPrompt === 'string') {
      return persona.systemPrompt;
    }
    return `You are agent "${this.identity.name}". Complete assigned tasks thoroughly.`;
  }
}
