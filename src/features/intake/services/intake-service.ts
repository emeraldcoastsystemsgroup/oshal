/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake orchestration service with provider adapters and cursor checkpointing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Propagated subticket inclusion input through intake orchestration
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added crash-safe pull reconciliation that checkpoints only after every item is materialized
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guarded reconciliation checkpoints with atomic cursor compare-and-set
 */

import { createChildLogger } from '@/shared/logger';
import type { IntakeProvider } from '@/shared/types';
import type { PullWorkItemsInput, PullWorkItemsResult, WorkItemFeedAdapter } from './work-item-feed-adapter';
import type { WorkItemCursorStore } from './intake-cursor-store';

const logger = createChildLogger({ module: 'intake-service' });

/**
 * @description Pull result returned by IntakeService with effective cursor metadata.
 */
export interface IntakePullResult extends PullWorkItemsResult {
  provider: IntakeProvider;
  effectiveCursor: string | null;
}

/**
 * @description Successful reconciliation result after normalized work has been materialized.
 */
export interface IntakeReconcileResult extends IntakePullResult {
  materializedTicketIds: string[];
}

/**
 * @description Idempotent boundary that materializes one normalized provider item.
 */
export type IntakeWorkItemMaterializer = (
  item: PullWorkItemsResult['items'][number],
) => Promise<string>;

/**
 * @description Orchestrates provider intake adapters while persisting cursors.
 */
export class IntakeService {
  private readonly adapterByProvider: Map<IntakeProvider, WorkItemFeedAdapter>;

  constructor(
    adapters: WorkItemFeedAdapter[],
    private readonly cursorStore: WorkItemCursorStore,
  ) {
    this.adapterByProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  /**
   * @description Lists providers currently available through registered adapters.
   */
  listProviders(): IntakeProvider[] {
    return [...this.adapterByProvider.keys()].sort();
  }

  /**
   * @description Pulls normalized work items for one provider and updates cursor checkpoints.
   */
  async pull(provider: IntakeProvider, input: PullWorkItemsInput): Promise<IntakePullResult> {
    const adapter = this.adapterByProvider.get(provider);
    if (!adapter) {
      throw new Error(`Intake adapter is not registered for provider: ${provider}`);
    }

    const storedCursor = await this.cursorStore.getCursor(provider);
    const effectiveCursor = input.useStoredCursor === false
      ? input.cursor ?? null
      : input.cursor ?? storedCursor;

    logger.info(
      {
        provider,
        requestedCursor: input.cursor,
        storedCursor,
        effectiveCursor,
        limit: input.limit,
        includeSubtickets: input.includeSubtickets ?? false,
      },
      'Starting intake pull',
    );

    const result = await adapter.pullWorkItems({
      ...input,
      cursor: effectiveCursor ?? undefined,
    });

    if ((input.persistCursor ?? true) && result.nextCursor) {
      await this.cursorStore.setCursor(provider, result.nextCursor);
    }

    logger.info(
      {
        provider,
        pulledCount: result.items.length,
        nextCursor: result.nextCursor,
        source: result.source,
      },
      'Completed intake pull',
    );

    return {
      provider,
      effectiveCursor,
      ...result,
    };
  }

  /**
   * @description Pulls and materializes provider work, advancing its cursor only after every upsert succeeds.
   * @param provider - Registered intake provider
   * @param input - Pull bounds and cursor selection
   * @param materialize - Idempotent internal ticket upsert boundary
   * @returns Pulled work plus the internal ticket identifiers that were materialized
   */
  async reconcile(
    provider: IntakeProvider,
    input: PullWorkItemsInput,
    materialize: IntakeWorkItemMaterializer,
  ): Promise<IntakeReconcileResult> {
    const result = await this.pull(provider, { ...input, persistCursor: false });
    const materializedTicketIds: string[] = [];
    for (const item of result.items) {
      const ticketId = await materialize(item);
      if (!ticketId) {
        throw new Error(`Failed to materialize ${item.provider}:${item.externalId}`);
      }
      materializedTicketIds.push(ticketId);
    }
    if ((input.persistCursor ?? true) && result.nextCursor) {
      const checkpointed = await this.cursorStore.compareAndSetCursor(
        provider,
        result.effectiveCursor,
        result.nextCursor,
      );
      if (!checkpointed) {
        logger.warn(
          {
            provider,
            effectiveCursor: result.effectiveCursor,
            rejectedCursor: result.nextCursor,
          },
          'Skipped stale reconciliation checkpoint after a concurrent cursor advance',
        );
      }
    }
    return { ...result, materializedTicketIds };
  }
}
