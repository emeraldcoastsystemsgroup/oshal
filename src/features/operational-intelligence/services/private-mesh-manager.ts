/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added PrivateMeshManager — ad-hoc breakout channels with auto-expiry (WS-7 #7)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { MeshTransport } from '@/features/agent-management';

const logger = createChildLogger({ module: 'private-mesh-manager' });

/**
 * @description Default channel expiry time (1 hour).
 */
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;

/**
 * @description A private breakout channel for focused agent collaboration.
 */
export interface BreakoutChannel {
  channelId: string;
  channelName: string;
  createdBy: string;
  participants: string[];
  ticketExternalId?: string;
  phase?: number;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  messageCount: number;
}

/**
 * @description Options for creating a breakout channel.
 */
export interface CreateBreakoutOptions {
  createdBy: string;
  participants: string[];
  ticketExternalId?: string;
  phase?: number;
  expiryMs?: number;
}

/**
 * @description PrivateMeshManager — allows agents to create ad-hoc private channels
 * on the mesh transport for focused sub-conversations during complex phases.
 *
 * Ported from the legacy implementation's PrivateMeshManager.js. Each breakout channel:
 * - Has a unique name on the mesh (swarm.breakout.{channelId})
 * - Is scoped to specific participants
 * - Auto-expires after a configurable duration (default 1h)
 * - Is cleaned up on phase completion
 *
 * Use cases:
 * - Architect + code-developer need a side channel during execution
 * - Task-manager + specialist collaborate during consensus review
 * - Research agent feeds findings to executor without polluting main channel
 */
export class PrivateMeshManager {
  private readonly meshTransport: MeshTransport | null;
  private readonly channels = new Map<string, BreakoutChannel>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(meshTransport: MeshTransport | null = null) {
    this.meshTransport = meshTransport;
  }

  /**
   * @description Create a private breakout channel for agent collaboration.
   * @param opts - Channel creation options
   * @returns Created breakout channel descriptor
   */
  createChannel(opts: CreateBreakoutOptions): BreakoutChannel {
    const channelId = randomUUID().slice(0, 12);
    const expiryMs = opts.expiryMs ?? DEFAULT_EXPIRY_MS;
    const now = new Date();

    const channel: BreakoutChannel = {
      channelId,
      channelName: `swarm.breakout.${channelId}`,
      createdBy: opts.createdBy,
      participants: [...opts.participants],
      ticketExternalId: opts.ticketExternalId,
      phase: opts.phase,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiryMs).toISOString(),
      expired: false,
      messageCount: 0,
    };

    this.channels.set(channelId, channel);
    logger.info(
      { channelId, participants: opts.participants, expiryMs, ticketId: opts.ticketExternalId },
      'Breakout channel created',
    );
    return channel;
  }

  /**
   * @description Send a message on a breakout channel.
   * @param channelId - Channel identifier
   * @param fromAgentId - Sender agent
   * @param payload - Message payload
   */
  async sendOnChannel(
    channelId: string,
    fromAgentId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) {
      logger.warn({ channelId }, 'Breakout channel not found');
      return;
    }
    if (channel.expired) {
      logger.warn({ channelId }, 'Breakout channel expired');
      return;
    }
    if (!channel.participants.includes(fromAgentId)) {
      logger.warn({ channelId, fromAgentId }, 'Agent not a participant');
      return;
    }

    if (this.meshTransport) {
      try {
        await this.meshTransport.publish({
          correlationId: `breakout:${channelId}:${randomUUID().slice(0, 8)}`,
          fromAgentId,
          toAgentId: '*',
          channel: channel.channelName,
          payload,
        });
      } catch (err) {
        logger.error({ err, channelId, fromAgentId }, 'Failed to publish on breakout channel');
        return;
      }
    }

    channel.messageCount += 1;
    logger.debug({ channelId, fromAgentId, messageCount: channel.messageCount }, 'Message sent on breakout');
  }

  /**
   * @description Close a breakout channel explicitly.
   * @param channelId - Channel to close
   */
  closeChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    channel.expired = true;
    logger.info({ channelId, messageCount: channel.messageCount }, 'Breakout channel closed');
  }

  /**
   * @description Close all channels for a specific ticket+phase (called on phase completion).
   * @param ticketExternalId - Ticket identifier
   * @param phase - Phase number
   * @returns Number of channels closed
   */
  closeChannelsForPhase(ticketExternalId: string, phase: number): number {
    let closed = 0;
    for (const channel of this.channels.values()) {
      if (channel.ticketExternalId === ticketExternalId && channel.phase === phase && !channel.expired) {
        channel.expired = true;
        closed += 1;
      }
    }
    if (closed > 0) {
      logger.info({ ticketExternalId, phase, closedCount: closed }, 'Breakout channels closed for phase');
    }
    return closed;
  }

  /**
   * @description Get active (non-expired) channels.
   * @returns Active breakout channels
   */
  getActiveChannels(): BreakoutChannel[] {
    this.expireStaleChannels();
    return [...this.channels.values()].filter((c) => !c.expired);
  }

  /**
   * @description Get a specific channel by ID.
   * @param channelId - Channel identifier
   * @returns Channel descriptor or null
   */
  getChannel(channelId: string): BreakoutChannel | null {
    return this.channels.get(channelId) ?? null;
  }

  /**
   * @description Start the automatic expiry cleanup timer.
   * @param intervalMs - Cleanup interval (default 60s)
   */
  startCleanup(intervalMs = 60000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.expireStaleChannels(), intervalMs);
    logger.info({ intervalMs }, 'Breakout channel cleanup started');
  }

  /**
   * @description Stop the cleanup timer.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Breakout channel cleanup stopped');
    }
  }

  /**
   * @description Expire channels that have passed their expiry time.
   */
  private expireStaleChannels(): void {
    const now = Date.now();
    for (const channel of this.channels.values()) {
      if (!channel.expired && new Date(channel.expiresAt).getTime() < now) {
        channel.expired = true;
        logger.info({ channelId: channel.channelId, messageCount: channel.messageCount }, 'Breakout channel auto-expired');
      }
    }
  }
}
