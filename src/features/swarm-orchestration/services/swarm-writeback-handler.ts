/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted writeback handler from swarm-ticket-processing-service to enforce 1000-line file cap
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Distinguished swarm delivery completion from external repository release proof
 */

import type { ExternalWorkItem } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import type { IntakeProvider } from '@/shared/types';
import type { SwarmTicketCycle, SwarmTicketLifecycleSnapshot } from './ticket-cycle-state-machine';
import type { SwarmCyclePolicy, SwarmCyclePolicyService, SwarmEscalationTarget } from './swarm-cycle-policy';
import type { TicketWritebackAdapter, TicketWritebackStatus } from './ticket-writeback-adapter';
import type { TicketStateProjectionService } from './ticket-state-projection-service';
import { SwarmEscalationError, sleep, toError } from './swarm-ticket-processing-support';

const logger = createChildLogger({ module: 'swarm-writeback-handler' });

/**
 * @description Encapsulates provider write-back logic for swarm lifecycle cycle updates.
 * Extracted from SwarmTicketProcessingService to maintain file size constraints.
 */
export class SwarmWritebackHandler {
  constructor(
    private readonly ticketWritebackAdapters: TicketWritebackAdapter[],
    private readonly ticketStateProjectionService: TicketStateProjectionService,
    private readonly cyclePolicyService: SwarmCyclePolicyService,
  ) {}

  /**
   * @description Emits one provider write-back update when an adapter exists for the ticket provider.
   * @param runId - Parent swarm run identifier
   * @param item - Ticket being processed
   * @param cycle - Lifecycle cycle identifier
   * @param status - Write-back lifecycle status
   * @param lifecycle - Current lifecycle snapshot
   * @param policy - Resolved run policy
   * @param details - Optional cycle details
   * @param error - Optional error message
   * @param escalation - Optional escalation descriptor
   */
  async emitWritebackUpdate(
    runId: string,
    item: ExternalWorkItem,
    cycle: SwarmTicketCycle,
    status: TicketWritebackStatus,
    lifecycle: SwarmTicketLifecycleSnapshot,
    policy: SwarmCyclePolicy,
    details?: Record<string, unknown>,
    error?: string,
    escalation?: { target: SwarmEscalationTarget; reason: string },
  ): Promise<void> {
    const adapter = this.resolveWritebackAdapter(item.provider);
    if (!adapter) {
      return;
    }

    const targetTicketState = this.ticketStateProjectionService.project(item, cycle, status, lifecycle);

    const update = {
      runId,
      provider: item.provider,
      cycle,
      status,
      item: {
        externalId: item.externalId,
        title: item.title,
        priority: item.priority,
        status: item.status,
        workflow: item.workflow,
        hierarchy: item.hierarchy,
      },
      lifecycle,
      targetTicketState: targetTicketState ?? undefined,
      escalation,
      details,
      error,
    };

    await this.writeCycleUpdateWithRetry(adapter, update, policy);
  }

  /**
   * @description Emits a failure write-back update without masking the original cycle failure.
   * @param runId - Parent swarm run identifier
   * @param item - Ticket being processed
   * @param cycle - Failed lifecycle cycle
   * @param lifecycle - Failed lifecycle snapshot
   * @param error - Original cycle failure
   * @param policy - Resolved run policy
   */
  async emitFailureWritebackUpdate(
    runId: string,
    item: ExternalWorkItem,
    cycle: SwarmTicketCycle,
    lifecycle: SwarmTicketLifecycleSnapshot,
    error: Error,
    policy: SwarmCyclePolicy,
  ): Promise<void> {
    try {
      await this.emitWritebackUpdate(
        runId,
        item,
        cycle,
        'failed',
        lifecycle,
        policy,
        undefined,
        error.message,
        toEscalationDescriptor(error),
      );
    } catch (writebackError) {
      logger.error(
        {
          err: toError(writebackError),
          runId,
          externalId: item.externalId,
          cycle,
          originalError: error.message,
        },
        'Swarm ticket failure write-back failed',
      );
    }
  }

  /**
   * @description Emits the final completion write-back once a ticket lifecycle fully completes.
   * @param runId - Parent swarm run identifier
   * @param item - Ticket being processed
   * @param lifecycle - Final lifecycle snapshot
   * @param selectedAgentId - Selected execution agent identifier
   * @param workUnitCount - Number of work units processed for the ticket
   * @param policy - Resolved run policy
   */
  async emitLifecycleCompletionWritebackUpdate(
    runId: string,
    item: ExternalWorkItem,
    lifecycle: SwarmTicketLifecycleSnapshot,
    selectedAgentId: string,
    workUnitCount: number,
    policy: SwarmCyclePolicy,
  ): Promise<void> {
    const adapter = this.resolveWritebackAdapter(item.provider);
    const targetTicketState = this.ticketStateProjectionService.projectFinalState(lifecycle);
    if (!adapter || !targetTicketState) {
      return;
    }

    await this.writeCycleUpdateWithRetry(adapter, {
      runId,
      provider: item.provider,
      cycle: 'delivery',
      status: 'completed',
      item: {
        externalId: item.externalId,
        title: item.title,
        priority: item.priority,
        status: item.status,
        workflow: item.workflow,
        hierarchy: item.hierarchy,
      },
      lifecycle,
      targetTicketState,
      details: {
        deliveryStep: 'complete',
        releaseProof: false,
        selectedAgentId,
        workUnitCount,
      },
    }, policy);
  }

  /**
   * @description Writes one provider update with bounded retry behavior from the resolved run policy.
   * @param adapter - Provider write-back adapter
   * @param update - Write-back payload
   * @param policy - Resolved run policy
   */
  private async writeCycleUpdateWithRetry(
    adapter: TicketWritebackAdapter,
    update: Parameters<TicketWritebackAdapter['writeCycleUpdate']>[0],
    policy: SwarmCyclePolicy,
  ): Promise<void> {
    let attempt = 1;
    while (true) {
      try {
        await adapter.writeCycleUpdate(update);
        return;
      } catch (error) {
        if (!this.cyclePolicyService.shouldRetryWriteback(attempt, policy)) {
          throw toError(error);
        }

        logger.warn(
          {
            err: toError(error),
            externalId: update.item.externalId,
            cycle: update.cycle,
            attempt,
          },
          'Retrying swarm ticket write-back update',
        );
        await sleep(policy.writebackRetryDelayMs);
        attempt += 1;
      }
    }
  }

  /**
   * @description Resolves the configured write-back adapter for one provider.
   * @param provider - Intake provider key
   * @returns Matching adapter or null when no provider write-back is configured
   */
  private resolveWritebackAdapter(provider: IntakeProvider): TicketWritebackAdapter | null {
    return this.ticketWritebackAdapters.find((adapter) => adapter.provider === provider) || null;
  }
}

/**
 * @description Extracts escalation descriptor from SwarmEscalationError instances.
 * @param error - Error to inspect
 * @returns Escalation descriptor or undefined for non-escalation errors
 */
function toEscalationDescriptor(
  error: Error,
): { target: SwarmEscalationTarget; reason: string } | undefined {
  if (!(error instanceof SwarmEscalationError)) {
    return undefined;
  }

  return {
    target: error.target,
    reason: error.reason,
  };
}
