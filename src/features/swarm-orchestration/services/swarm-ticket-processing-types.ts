/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted the public readiness/processing types + SwarmRuntimeUnavailableError out of swarm-ticket-processing-service.ts to keep that file under the 1000-line governance cap. Re-exported from the service module so existing importers are unchanged.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Scrubbed legacy-codebase naming from comments (reworded to 'the legacy implementation')
 */

import type { TicketInteractionMode } from '@/entities/ticket';
import type { PullWorkItemsInput } from '@/features/intake';
import type { IntakeProvider } from '@/shared/types';
import type { AgentBid, RouteCandidate } from '@/features/agent-management';
import type { SwarmCyclePolicyInput } from './swarm-cycle-policy';
import type { SwarmProcessedTicketResult } from './swarm-run-store';

/**
 * @description Describes whether the swarm runtime can execute tickets and, when not, which dependency is missing.
 */
export interface SwarmRuntimeReadiness {
  ready: boolean;
  dependency: 'none' | 'postgres' | 'provider';
  message: string;
  details?: Record<string, unknown>;
}

/**
 * @description Async probe contract that callers supply to report current swarm runtime readiness.
 */
export type SwarmRuntimeReadinessProbe = () => Promise<SwarmRuntimeReadiness>;

/**
 * @description Error raised when ticket processing is attempted while the swarm runtime is not ready, carrying the readiness detail.
 */
export class SwarmRuntimeUnavailableError extends Error {
  constructor(
    public readonly readiness: SwarmRuntimeReadiness,
  ) {
    super(readiness.message);
    this.name = 'SwarmRuntimeUnavailableError';
  }
}

/**
 * @description Provider batch processing input that extends intake pull parameters.
 */
export interface SwarmProcessingInput extends PullWorkItemsInput {
  interactionMode?: TicketInteractionMode;
  policy?: SwarmCyclePolicyInput;
  tenantId?: string;
  workspaceRole?: string;
  requiredCapabilities?: string[];
  candidates?: RouteCandidate[];
  bids?: AgentBid[];
  /** Root ticket workspace ID — children share the root's folder (legacy PHASE_45 parity). */
  workspaceTaskId?: string;
}

/**
 * @description Ticket processing response payload returned to orchestration callers.
 */
export interface SwarmProcessingResult {
  runId: string;
  provider: IntakeProvider;
  source: string;
  nextCursor?: string;
  effectiveCursor: string | null;
  pulledCount: number;
  processedCount: number;
  processed: SwarmProcessedTicketResult[];
}
