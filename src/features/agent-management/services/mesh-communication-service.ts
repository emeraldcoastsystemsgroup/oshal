/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added extension-layer mesh communication scaffold for swarm channels
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Expanded MeshTransport with subscribe/consume/ack, added MeshCommunicationService direct/broadcast/request methods
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added configChange channel for any-bot -> OSHAL config broadcast-up reconciliation (ADR-034)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added remoteTaskResult channel: remote-client task completions/failures were forwarded only as targeted agent.{requester} replies that nothing on the controller consumed — this well-known channel gives the controller one subscription point to land results on the originating work item (mirrors the configChange broadcast-up pattern).
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'mesh-communication' });

/**
 * @description Channel naming conventions for the swarm mesh.
 */
export const MESH_CHANNELS = {
  agentDirect: (agentId: string) => `agent.${agentId}`,
  broadcast: 'swarm.broadcast',
  ticketExecute: 'swarm.ticket.execute',
  capabilities: 'swarm.capabilities',
  /**
   * Bot -> controller config-change broadcast (ADR-034). An any-bot publishes here
   * when its bot-level runtime config changes locally (or a swarm-owning bot reports
   * a sub-bot change); the OSHAL controller subscribes and reconciles the change into
   * the authoritative per-agent record.
   */
  configChange: 'swarm.config-change',
  /**
   * Remote-client -> controller task-result landing channel. The remote-client
   * routes publish every completed/failed remote task here IN ADDITION to the
   * targeted agent.{requester} reply, and the controller subscribes
   * (subscribeRemoteTaskResults) to land the result on the originating work item
   * (work_items.external_id = the task envelope's correlationId).
   */
  remoteTaskResult: 'swarm.remote-task-result',
} as const;

/**
 * @description Internal mesh envelope for agent-to-agent communication.
 */
export interface MeshEnvelope {
  correlationId: string;
  fromAgentId: string;
  toAgentId: string;
  channel: string;
  payload: Record<string, unknown>;
  messageType?: 'request' | 'reply' | 'broadcast' | 'event';
}

/**
 * @description Consumed envelope with its Redis Stream entry ID.
 */
export interface ConsumedEnvelope {
  entryId: string;
  envelope: MeshEnvelope;
}

/**
 * @description Handle returned by subscribe calls to stop the subscription.
 */
export interface MeshSubscription {
  stop(): void;
}

/**
 * @description Pluggable mesh transport boundary for queue/pubsub adapters.
 */
export interface MeshTransport {
  publish(envelope: MeshEnvelope): Promise<void>;
  consume(channel: string, consumerId: string, count?: number): Promise<ConsumedEnvelope[]>;
  ack(channel: string, entryId: string, group?: string): Promise<void>;
  subscribe(
    channel: string,
    consumerId: string,
    handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
    pollIntervalMs?: number,
  ): MeshSubscription;
}

/**
 * @description Pending reply tracker for request/reply pattern.
 */
interface PendingReply {
  resolve: (envelope: MeshEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * @description Mesh communication service — the swarm's internal network.
 * Provides send, subscribe, direct messaging (VPN tunnels), broadcast, and request/reply.
 */
export class MeshCommunicationService {
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly subscriptions: MeshSubscription[] = [];

  constructor(private readonly transport: MeshTransport) {}

  /**
   * @description Sends an envelope on any channel.
   */
  async send(envelope: MeshEnvelope): Promise<void> {
    await this.transport.publish(envelope);
  }

  /**
   * @description Sends a direct message to a specific agent's channel (VPN tunnel).
   */
  async sendDirect(
    toAgentId: string,
    fromAgentId: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    await this.transport.publish({
      correlationId: correlationId || randomUUID(),
      fromAgentId,
      toAgentId,
      channel: MESH_CHANNELS.agentDirect(toAgentId),
      payload,
      messageType: 'event',
    });
  }

  /**
   * @description Broadcasts a message to all agents on the swarm broadcast channel.
   */
  async broadcast(
    fromAgentId: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    await this.transport.publish({
      correlationId: correlationId || randomUUID(),
      fromAgentId,
      toAgentId: '*',
      channel: MESH_CHANNELS.broadcast,
      payload,
      messageType: 'broadcast',
    });
  }

  /**
   * @description Subscribes to a channel. Returns a handle to stop the subscription.
   */
  subscribe(
    channel: string,
    consumerId: string,
    handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
    pollIntervalMs?: number,
  ): MeshSubscription {
    const sub = this.transport.subscribe(channel, consumerId, handler, pollIntervalMs);
    this.subscriptions.push(sub);
    return sub;
  }

  /**
   * @description Subscribes to an agent's direct channel (VPN tunnel endpoint).
   * Automatically routes reply messages to pending request/reply promises.
   */
  subscribeAgent(
    agentId: string,
    handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
    pollIntervalMs?: number,
  ): MeshSubscription {
    return this.subscribe(
      MESH_CHANNELS.agentDirect(agentId),
      agentId,
      async (envelope, entryId) => {
        if (envelope.messageType === 'reply' && this.pendingReplies.has(envelope.correlationId)) {
          const pending = this.pendingReplies.get(envelope.correlationId)!;
          this.pendingReplies.delete(envelope.correlationId);
          clearTimeout(pending.timer);
          pending.resolve(envelope);
          return;
        }
        await handler(envelope, entryId);
      },
      pollIntervalMs,
    );
  }

  /**
   * @description Sends a request and waits for a reply on the sender's direct channel.
   * The receiver must reply using the same correlationId to agent.{fromAgentId}.
   */
  async request(
    envelope: Omit<MeshEnvelope, 'messageType'>,
    timeoutMs = 30000,
  ): Promise<MeshEnvelope> {
    const correlationId = envelope.correlationId || randomUUID();
    const fullEnvelope: MeshEnvelope = {
      ...envelope,
      correlationId,
      messageType: 'request',
    };

    return new Promise<MeshEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(correlationId);
        reject(new Error(`Mesh request timed out after ${timeoutMs}ms (correlationId: ${correlationId})`));
      }, timeoutMs);

      this.pendingReplies.set(correlationId, { resolve, reject, timer });
      this.transport.publish(fullEnvelope).catch((err) => {
        this.pendingReplies.delete(correlationId);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * @description Stops all active subscriptions.
   */
  stopAll(): void {
    for (const sub of this.subscriptions) {
      sub.stop();
    }
    this.subscriptions.length = 0;
    for (const [id, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Mesh service shutting down'));
      this.pendingReplies.delete(id);
    }
    logger.info({ subscriptionCount: this.subscriptions.length }, 'All mesh subscriptions stopped');
  }
}
