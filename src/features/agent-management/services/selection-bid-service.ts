/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added extension-layer bid selection scaffold for swarm delegation
 */

/**
 * @description Agent bid payload used by swarm selection logic.
 */
export interface AgentBid {
  agentId: string;
  confidence: number;
  estimatedCost: number;
  estimatedLatencyMs: number;
}

/**
 * @description Selects the winning bid by confidence and cost tie-breakers.
 */
export class SelectionBidService {
  chooseWinner(bids: AgentBid[]): AgentBid {
    if (bids.length === 0) {
      throw new Error('No bids submitted');
    }

    const ranked = [...bids].sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }

      if (a.estimatedCost !== b.estimatedCost) {
        return a.estimatedCost - b.estimatedCost;
      }

      return a.estimatedLatencyMs - b.estimatedLatencyMs;
    });

    return ranked[0];
  }
}
