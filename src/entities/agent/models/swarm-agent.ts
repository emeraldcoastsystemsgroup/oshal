/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Implemented SwarmAgent — extends LocalHostAgent with delegation, routing, and mesh coordination
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Changed broadcastCapabilities target from swarm-coordinator to project-manager
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added replyToEnvelope for bot-to-bot mesh reply pattern
 */

import { createChildLogger } from '@/shared/logger';
import { MESH_CHANNELS } from '@/features/agent-management';
import type { MeshEnvelope, MeshTransport } from '@/features/agent-management';
import { LocalHostAgent, type LocalHostAgentDeps } from './local-host-agent';
import type { CapabilityDescriptor } from './base-agent';

const logger = createChildLogger({ module: 'swarm-agent' });

/**
 * @description Result of delegating a task to another agent in the swarm.
 */
export interface DelegationResult {
  delegatedTo: string;
  correlationId: string;
  channel: string;
  success: boolean;
}

/**
 * @description Dependencies specific to SwarmAgent.
 */
export interface SwarmAgentDeps extends LocalHostAgentDeps {
  meshTransport: MeshTransport;
  selectorDescriptor?: string;
  routingKeywords?: string[];
}

/**
 * @description Concrete swarm runtime extending LocalHostAgent with delegation,
 * mesh coordination, and multi-agent capability broadcasting.
 * Inherits local execution — adds the ability to delegate when needed.
 */
export class SwarmAgent extends LocalHostAgent {
  private readonly meshTransport: MeshTransport;
  private readonly selectorDescriptor: string;
  private readonly swarmRoutingKeywords: string[];

  constructor(deps: SwarmAgentDeps) {
    super(deps);
    // Override topology to swarm after super() sets it to localhost
    (this.identity as { topology: string }).topology = 'swarm';
    this.meshTransport = deps.meshTransport;
    this.selectorDescriptor = deps.selectorDescriptor || '';
    this.swarmRoutingKeywords = deps.routingKeywords || [];
  }

  /**
   * @description Initializes the swarm agent and logs mesh readiness.
   */
  async initialize(): Promise<void> {
    await super.initialize();
    logger.info(
      {
        agentId: this.identity.agentId,
        selectorLength: this.selectorDescriptor.length,
        routingKeywords: this.swarmRoutingKeywords.length,
      },
      'SwarmAgent initialized with mesh transport',
    );
  }

  /**
   * @description Builds a swarm-scoped system prompt with delegation context.
   */
  override getSystemPrompt(): string {
    const localPrompt = super.getSystemPrompt();
    const swarmContext = [
      '[Swarm Mode: Active]',
      'You may delegate subtasks to other agents in the swarm when the work exceeds your capabilities.',
      'Provide structured output suitable for verification against acceptance criteria.',
    ].join('\n');
    return `${localPrompt}\n\n${swarmContext}`;
  }

  /**
   * @description Delegates a task to a target agent via mesh transport.
   * @param targetAgentId - Agent to delegate to
   * @param channel - Mesh channel for the envelope
   * @param payload - Work payload to send
   * @param correlationId - Correlation ID for tracking
   * @returns Delegation result
   */
  async delegateTask(
    targetAgentId: string,
    channel: string,
    payload: Record<string, unknown>,
    correlationId: string,
  ): Promise<DelegationResult> {
    const envelope: MeshEnvelope = {
      correlationId,
      fromAgentId: this.identity.agentId,
      toAgentId: targetAgentId,
      channel,
      payload,
    };

    try {
      await this.meshTransport.publish(envelope);
      logger.info(
        { correlationId, fromAgentId: this.identity.agentId, toAgentId: targetAgentId, channel },
        'Task delegated via mesh',
      );
      return { delegatedTo: targetAgentId, correlationId, channel, success: true };
    } catch (error) {
      logger.error(
        { err: error, correlationId, toAgentId: targetAgentId },
        'Task delegation failed',
      );
      return { delegatedTo: targetAgentId, correlationId, channel, success: false };
    }
  }

  /**
   * @description Replies to an incoming mesh envelope on the sender's direct channel.
   * @param original - The envelope being replied to
   * @param payload - Reply payload
   */
  async replyToEnvelope(
    original: MeshEnvelope,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const reply: MeshEnvelope = {
      correlationId: original.correlationId,
      fromAgentId: this.identity.agentId,
      toAgentId: original.fromAgentId,
      channel: MESH_CHANNELS.agentDirect(original.fromAgentId),
      payload,
      messageType: 'reply',
    };
    await this.meshTransport.publish(reply);
    logger.info(
      { correlationId: original.correlationId, toAgentId: original.fromAgentId },
      'Replied to mesh envelope',
    );
  }

  /**
   * @description Returns capabilities including swarm routing keywords.
   */
  override getCapabilities(): CapabilityDescriptor {
    const base = super.getCapabilities();
    const combinedKeywords = [...new Set([...base.routingKeywords, ...this.swarmRoutingKeywords])];
    return { ...base, routingKeywords: combinedKeywords };
  }

  /**
   * @description Broadcasts this agent's capability descriptor to the swarm mesh.
   * @param channel - Mesh channel for capability announcements
   */
  async broadcastCapabilities(channel = 'swarm.capabilities'): Promise<void> {
    const capabilities = this.getCapabilities();
    const envelope: MeshEnvelope = {
      correlationId: `cap-${this.identity.agentId}-${Date.now()}`,
      fromAgentId: this.identity.agentId,
      toAgentId: 'project-manager',
      channel,
      payload: {
        type: 'capability-update',
        capabilities,
        selectorDescriptor: this.selectorDescriptor,
      },
    };
    await this.meshTransport.publish(envelope);
    logger.info(
      { agentId: this.identity.agentId, capabilityCount: capabilities.capabilities.length },
      'Capabilities broadcast to swarm',
    );
  }

  /**
   * @description Graceful shutdown — logs swarm-specific teardown.
   */
  async shutdown(): Promise<void> {
    logger.info({ agentId: this.identity.agentId }, 'SwarmAgent shutting down');
    await super.shutdown();
  }
}
