/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Ported MeshBroadcastNetwork.js:broadcastBidRequest() from the legacy implementation. Broadcasts BID_REQUEST signals to all registered agents, collects confidence bids within a configurable window, and returns ranked claimants.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Session 20: Fixed bid collection — requestBid() now awaits agent responses via MeshCommunicationService.request() instead of returning null. Agents respond on the broadcaster's direct channel and responses are collected within the bid window.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import { randomUUID } from 'crypto';
import { createChildLogger } from '@/shared/logger';
import type { MeshTransport, MeshEnvelope } from './mesh-communication-service';
import { type MeshCommunicationService, MESH_CHANNELS } from './mesh-communication-service';
import type { AgentBid } from './selection-bid-service';

const logger = createChildLogger({ module: 'mesh-bid-broadcaster' });

/**
 * @description Bid request payload sent to each agent for self-evaluation.
 */
export interface BidRequestPayload {
  signalId: string;
  signalType: 'BID_REQUEST';
  ticketId: string;
  ticketTitle: string;
  ticketDescription: string;
  capabilities: string[];
  complexity: string;
  phase: string;
}

/**
 * @description Result of a broadcast bid request across the swarm mesh.
 */
export interface BroadcastBidResult {
  signalId: string;
  totalAgents: number;
  responded: number;
  claims: AgentBid[];
  lead: AgentBid | null;
  elapsedMs: number;
}

/**
 * @description Configuration for the mesh bid broadcaster.
 */
export interface MeshBidBroadcasterOptions {
  /** Max time to wait for all bids (default 10000ms). */
  bidWindowMs?: number;
  /** Minimum confidence to accept a claim (default 0.3). */
  minClaimConfidence?: number;
}

/**
 * @description Broadcasts BID_REQUEST signals to all registered agents via the mesh transport,
 * collects confidence bids within a configurable window, and returns ranked claimants.
 *
 * Ported from the legacy MeshBroadcastNetwork.js. Never throws — returns null on failure
 * so the caller can fall through to LLM Router or CapabilityMatcher.
 */
export class MeshBidBroadcaster {
  private readonly bidWindowMs: number;
  private readonly minClaimConfidence: number;
  private meshCommService?: MeshCommunicationService;

  constructor(
    private readonly meshTransport: MeshTransport,
    private readonly resolveOnlineAgentIds: () => Promise<string[]>,
    options: MeshBidBroadcasterOptions = {},
  ) {
    this.bidWindowMs = options.bidWindowMs ?? 10_000;
    this.minClaimConfidence = options.minClaimConfidence ?? 0.3;
    logger.info(
      { bidWindowMs: this.bidWindowMs, minClaimConfidence: this.minClaimConfidence },
      'MeshBidBroadcaster initialized',
    );
  }

  /**
   * @description Sets the MeshCommunicationService for request/reply bid collection.
   * When set, requestBid() uses correlationId-based replies instead of fire-and-forget.
   */
  setMeshCommunicationService(service: MeshCommunicationService): void {
    this.meshCommService = service;
    logger.info('MeshCommunicationService wired into MeshBidBroadcaster for request/reply bids');
  }

  /**
   * @description Broadcast a BID_REQUEST to all online agents and return ranked claimants.
   * This is the main entry point for mesh bid routing (oshal: meshBroadcast.broadcastBidRequest).
   *
   * @param ticketId - Ticket being routed
   * @param ticketTitle - Ticket title for agent self-evaluation
   * @param ticketDescription - Ticket description for agent context
   * @param capabilities - Extracted capability hints from ticket analysis
   * @param complexity - Ticket complexity level
   * @param phase - Current lifecycle phase (PLANNING, EXECUTION, etc.)
   * @param excludeAgentIds - Agent IDs to exclude from bidding
   * @returns Broadcast result with ranked claims, or null on failure
   */
  async broadcastBidRequest(
    ticketId: string,
    ticketTitle: string,
    ticketDescription: string,
    capabilities: string[],
    complexity: string,
    phase: string,
    excludeAgentIds: string[] = [],
  ): Promise<BroadcastBidResult | null> {
    const startTime = Date.now();
    const signalId = `bid_${ticketId}_${Date.now()}`;

    try {
      const onlineAgentIds = await this.resolveOnlineAgentIds();
      logger.info(
        { signalId, ticketId, phase, onlineCount: onlineAgentIds.length, excludeCount: excludeAgentIds.length },
        'Starting bid broadcast',
      );
      const targetAgents = onlineAgentIds.filter((id) => !excludeAgentIds.includes(id));

      if (targetAgents.length === 0) {
        logger.info({ ticketId, phase }, 'No online agents available for bid broadcast');
        return null;
      }

      const payload: BidRequestPayload = {
        signalId,
        signalType: 'BID_REQUEST',
        ticketId,
        ticketTitle,
        ticketDescription: ticketDescription.slice(0, 2000),
        capabilities,
        complexity,
        phase,
      };

      // Broadcast to all target agents via mesh transport
      const bidPromises = targetAgents.map((agentId) =>
        this.requestBid(agentId, payload),
      );

      // Collect bids within the bid window using Promise.allSettled + timeout
      const bidsRaw = await Promise.race([
        Promise.allSettled(bidPromises),
        timeout(this.bidWindowMs),
      ]);

      const bids = Array.isArray(bidsRaw) ? bidsRaw : [];
      const claims = this.extractClaims(bids, targetAgents);

      // Rank by confidence descending
      claims.sort((a, b) => b.confidence - a.confidence);
      const lead = claims.length > 0 ? claims[0] : null;
      const elapsedMs = Date.now() - startTime;

      logger.info(
        {
          signalId,
          ticketId,
          phase,
          totalAgents: targetAgents.length,
          responded: claims.length,
          lead: lead ? `${lead.agentId}(${lead.confidence.toFixed(2)})` : 'none',
          elapsedMs,
        },
        'BID_REQUEST broadcast completed',
      );

      return { signalId, totalAgents: targetAgents.length, responded: claims.length, claims, lead, elapsedMs };
    } catch (error) {
      logger.error({ err: error, ticketId, phase }, 'Bid broadcast failed — returning null for fallback');
      return null;
    }
  }

  /**
   * @description Converts a broadcast bid result into AgentBid[] for the AgentRouter.
   * @param result - Broadcast result (may be null)
   * @returns Array of qualified bids, or empty array
   */
  toBids(result: BroadcastBidResult | null): AgentBid[] {
    if (!result) return [];
    return result.claims.filter((c) => c.confidence >= this.minClaimConfidence);
  }

  /**
   * @description Request a bid from a single agent via the mesh transport.
   * Uses MeshCommunicationService.request() for correlationId-based reply collection
   * when available, falling back to fire-and-forget publish otherwise.
   * @param agentId - Target agent
   * @param payload - BID_REQUEST payload
   * @returns AgentBid response or null if agent didn't respond
   */
  private async requestBid(agentId: string, payload: BidRequestPayload): Promise<AgentBid | null> {
    const correlationId = randomUUID();
    const envelope: Omit<MeshEnvelope, 'messageType'> = {
      correlationId,
      fromAgentId: 'queue-manager',
      toAgentId: agentId,
      channel: MESH_CHANNELS.agentDirect(agentId),
      payload: { ...payload as unknown as Record<string, unknown>, type: 'bid_request' },
    };

    try {
      if (this.meshCommService) {
        // Use request/reply — waits for agent to respond on our direct channel
        const reply = await this.meshCommService.request(envelope, this.bidWindowMs);
        const replyPayload = reply.payload as Record<string, unknown> | undefined;
        if (replyPayload?.signalType === 'BID_RESPONSE' && typeof replyPayload.confidence === 'number') {
          return {
            agentId: String(replyPayload.agentId || agentId),
            confidence: replyPayload.confidence as number,
            estimatedCost: 0,
            estimatedLatencyMs: 0,
          };
        }
        return null;
      }

      // Fallback: fire-and-forget publish (no reply collection)
      await this.meshTransport.publish({ ...envelope, messageType: 'request' });
      return null;
    } catch (err) {
      // Timeout or transport failure — agent didn't respond in time
      logger.debug({ err, agentId, correlationId }, 'Bid request to agent failed or timed out');
      return null;
    }
  }

  /**
   * @description Extract valid claims from settled bid promises.
   * @param settled - Promise.allSettled results
   * @param agentIds - Ordered agent IDs matching promise indices
   * @returns Filtered bids above minimum confidence
   */
  private extractClaims(
    settled: PromiseSettledResult<AgentBid | null>[],
    agentIds: string[],
  ): AgentBid[] {
    const claims: AgentBid[] = [];
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'fulfilled' && result.value && result.value.confidence >= this.minClaimConfidence) {
        claims.push(result.value);
      }
    }
    return claims;
  }
}

/**
 * @description Creates a timeout promise that resolves with an empty array after ms.
 * @param ms - Timeout in milliseconds
 * @returns Promise that resolves to empty array after timeout
 */
function timeout(ms: number): Promise<PromiseSettledResult<AgentBid | null>[]> {
  return new Promise((resolve) => setTimeout(() => resolve([]), ms));
}
