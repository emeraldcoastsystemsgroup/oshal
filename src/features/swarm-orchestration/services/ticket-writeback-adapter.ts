/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added provider-agnostic ticket write-back contract for swarm lifecycle updates
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added canonical ticket-state projection support to write-back update contracts
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added explicit escalation metadata support for provider write-back payloads
 */

import type { ExternalWorkItem, OshalTicketState } from '@/entities/ticket';
import type { IntakeProvider } from '@/shared/types';
import type { SwarmEscalationTarget } from './swarm-cycle-policy';
import type { SwarmTicketCycle, SwarmTicketLifecycleSnapshot } from './ticket-cycle-state-machine';

/**
 * @description Write-back status values emitted from swarm lifecycle processing.
 */
export type TicketWritebackStatus = 'in_progress' | 'completed' | 'failed';

/**
 * @description Provider-agnostic write-back payload for one lifecycle event.
 */
export interface TicketWritebackUpdate {
  runId: string;
  provider: IntakeProvider;
  cycle: SwarmTicketCycle;
  status: TicketWritebackStatus;
  item: Pick<ExternalWorkItem, 'externalId' | 'title' | 'priority' | 'status' | 'workflow' | 'hierarchy'>;
  lifecycle: SwarmTicketLifecycleSnapshot;
  targetTicketState?: OshalTicketState;
  escalation?: {
    target: SwarmEscalationTarget;
    reason: string;
  };
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * @description Boundary for provider-specific ticket write-back implementations.
 */
export interface TicketWritebackAdapter {
  readonly provider: IntakeProvider;
  writeCycleUpdate(update: TicketWritebackUpdate): Promise<void>;
}
