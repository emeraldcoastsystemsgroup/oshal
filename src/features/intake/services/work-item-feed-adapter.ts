/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added intake adapter contract for provider pull integrations
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added subticket inclusion control to provider intake adapter input
 */

import type { ExternalWorkItem } from '@/entities/ticket';
import type { IntakeProvider } from '@/shared/types';

/**
 * @description Input used by provider adapters to pull external work items.
 */
export interface PullWorkItemsInput {
  limit: number;
  cursor?: string;
  since?: string;
  includeSubtickets?: boolean;
  useStoredCursor?: boolean;
  persistCursor?: boolean;
}

/**
 * @description Provider pull result in normalized shape.
 */
export interface PullWorkItemsResult {
  items: ExternalWorkItem[];
  nextCursor?: string;
  source: string;
}

/**
 * @description Adapter boundary for provider-specific intake implementations.
 */
export interface WorkItemFeedAdapter {
  readonly provider: IntakeProvider;
  pullWorkItems(input: PullWorkItemsInput): Promise<PullWorkItemsResult>;
}
