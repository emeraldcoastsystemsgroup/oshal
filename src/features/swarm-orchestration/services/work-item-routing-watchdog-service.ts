/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added work-item routing watchdog for stale pending assignments and dispatch circuit-breaker escalation support
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | BF-032: Added retryRoutingFailedItems() — auto-retries routing_failed work items up to MAX_ROUTING_RETRIES with exponential backoff
 */

import type { WorkItemRepository } from '@/entities/work-item';
import type { OshalTicketState } from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'work-item-routing-watchdog-service' });

// Issue #17: default 30 minutes is too long for an interactive validation loop —
// stalls take a full half-hour to recover. In development/sandbox we want
// 5 minutes so SP-10 routing_failed marks (set by swarm-agent-worker) get
// re-routed quickly. Production keeps the 30-min default unless overridden.
const DEFAULT_STALE_THRESHOLD_MINUTES = process.env.NODE_ENV === 'development' ? 5 : 30;
const DEFAULT_MAX_ROUTING_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_BASE_MS = 30_000; // 30s, 60s, 120s
const ROUTING_ACTIVE_STATUSES = new Set(['pending', 'assigned', 'subtask-pending', 'subtask-assigned', 'subtask-executing']);
const ROUTING_RETRY_TERMINAL_TICKET_STATUSES = new Set<OshalTicketState>(['complete', 'cancelled', 'escalated']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RoutingTicketStatusUpdater = (
  ticketId: string,
  status: 'approved' | 'escalated',
  metadata: Record<string, unknown>,
) => Promise<void>;

export type RoutingTicketStatusReader = (ticketId: string) => Promise<OshalTicketState | null>;

/**
 * @description Watches persisted work items for stale routing failures and provides a helper for
 * marking all work items for a ticket when queue-manager circuit breakers trip.
 */
export class WorkItemRoutingWatchdogService {
  private readonly staleThresholdMs: number;

  /**
   * @description Creates the watchdog with a repository-backed persistence target.
   *
   * @param repository - Work-item persistence repository used for stale-item inspection and updates
   * @param staleThresholdMinutes - Minutes a pending/assigned work item may remain idle before routing_failed is applied
   */
  constructor(
    private readonly repository: WorkItemRepository,
    staleThresholdMinutes = readPositiveInteger(process.env.OSHAL_ROUTING_FAILURE_MINUTES) ?? DEFAULT_STALE_THRESHOLD_MINUTES,
    private readonly updateTicketStatus?: RoutingTicketStatusUpdater,
    private readonly readTicketStatus?: RoutingTicketStatusReader,
  ) {
    this.staleThresholdMs = staleThresholdMinutes * 60 * 1000;
  }

  /**
   * @description Marks stale pending/assigned work items from the recent queue snapshot.
   *
   * @param limit - Number of recent work items to inspect per sweep
   * @returns Count of work items updated to routing_failed
   */
  async sweepRecentWorkItems(limit = 500): Promise<number> {
    const startedAt = Date.now();
    logger.debug({ limit, staleThresholdMs: this.staleThresholdMs }, 'Starting routing watchdog sweep');
    const recentItems = await this.repository.listRecent(limit);
    const now = Date.now();
    let updatedCount = 0;

    for (const item of recentItems) {
      if (!ROUTING_ACTIVE_STATUSES.has(item.status)) {
        continue;
      }

      const updatedAt = Date.parse(item.updatedAt || item.createdAt || '');
      if (Number.isNaN(updatedAt) || now - updatedAt < this.staleThresholdMs) {
        continue;
      }

      await this.repository.markRoutingFailed(item.workItemId, 'stale_routing_timeout', {
        externalId: item.externalId,
        provider: item.provider,
        unitId: item.unitId,
        previousStatus: item.status,
        staleMinutes: Math.floor((now - updatedAt) / 60000),
      });
      updatedCount += 1;
    }

    const durationMs = Date.now() - startedAt;
    if (updatedCount > 0) {
      logger.warn({ updatedCount, limit, durationMs }, 'Routing watchdog marked stale work items as routing_failed');
    } else {
      logger.debug({ updatedCount, limit, durationMs }, 'Completed routing watchdog sweep');
    }

    return updatedCount;
  }

  /**
   * @description Retries work items stuck in routing_failed status by resetting them to pending.
   * Uses exponential backoff based on retry count stored in metadata.
   * Items that exceed MAX_ROUTING_RETRIES remain in routing_failed (terminal).
   *
   * @param limit - Number of recent work items to inspect per sweep
   * @returns Count of work items retried
   */
  async retryRoutingFailedItems(limit = 500): Promise<number> {
    const startedAt = Date.now();
    const maxRetries = readPositiveInteger(process.env.OSHAL_MAX_ROUTING_RETRIES) ?? DEFAULT_MAX_ROUTING_RETRIES;
    logger.debug({ limit, maxRetries }, 'Starting routing retry sweep');

    const recentItems = await this.repository.listRecent(limit);
    const now = Date.now();
    let retriedCount = 0;
    let exhaustedCount = 0;
    let newlyExhaustedCount = 0;
    let suppressedCount = 0;

    for (const item of recentItems) {
      if (item.status !== 'routing_failed') {
        continue;
      }

      const metadata = (item.metadata && typeof item.metadata === 'object') ? item.metadata as Record<string, unknown> : {};
      if (metadata.routingRetrySuppressed === true) {
        suppressedCount += 1;
        continue;
      }

      const suppressed = await this.suppressRetryIfTerminalTicket(item, metadata);
      if (suppressed) {
        suppressedCount += 1;
        continue;
      }

      const retryCount = typeof metadata.routingRetryCount === 'number' ? metadata.routingRetryCount : 0;

      if (retryCount >= maxRetries) {
        exhaustedCount += 1;
        if (metadata.routingRetryExhausted !== true) {
          await this.markRetryExhausted(item, retryCount, maxRetries, metadata);
          newlyExhaustedCount += 1;
        }
        continue;
      }

      // Exponential backoff: 30s × 2^retryCount
      const backoffMs = DEFAULT_RETRY_BACKOFF_BASE_MS * Math.pow(2, retryCount);
      const updatedAt = Date.parse(item.updatedAt || item.createdAt || '');
      if (!Number.isNaN(updatedAt) && now - updatedAt < backoffMs) {
        continue; // Not yet time to retry
      }

      const nextRetryCount = retryCount + 1;
      logger.info(
        {
          workItemId: item.workItemId,
          assignedAgentId: item.assignedAgentId,
          retryCount: nextRetryCount,
          maxRetries,
          backoffMs,
          title: item.title,
        },
        'Retrying routing_failed work item',
      );

      try {
        await this.repository.updateStatus(item.workItemId, 'pending', item.assignedAgentId);
        // Store retry count in metadata via direct SQL update
        await this.updateRetryMetadata(item.workItemId, nextRetryCount, metadata);
        await this.updateTicketFromRoutingRetry(item, nextRetryCount, maxRetries);
        retriedCount += 1;
      } catch (error) {
        logger.error(
          { err: error, workItemId: item.workItemId },
          'Failed to retry routing_failed work item',
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    if (retriedCount === 0 && exhaustedCount > 0 && newlyExhaustedCount === 0) {
      logger.debug(
        { retriedCount, exhaustedCount, newlyExhaustedCount, suppressedCount, limit, durationMs, maxRetries },
        'Routing retry sweep completed - exhausted items already recorded',
      );
      return retriedCount;
    }
    if (retriedCount > 0) {
      logger.info({ retriedCount, exhaustedCount, limit, durationMs, maxRetries }, 'Routing retry sweep completed — items retried');
    } else if (exhaustedCount > 0) {
      logger.warn({ retriedCount, exhaustedCount, limit, durationMs, maxRetries }, 'Routing retry sweep completed — some items exhausted max retries');
    } else {
      logger.debug({ retriedCount, exhaustedCount, limit, durationMs }, 'Routing retry sweep completed — no retryable items');
    }

    return retriedCount;
  }

  /**
   * @description Updates the retry count metadata on a work item.
   * @param workItemId - Work item to update
   * @param retryCount - New retry count
   * @param existingMetadata - Current metadata object to merge with
   */
  private async updateRetryMetadata(
    workItemId: string,
    retryCount: number,
    existingMetadata: Record<string, unknown>,
  ): Promise<void> {
    const updatedMetadata = {
      ...existingMetadata,
      routingRetryCount: retryCount,
      lastRetryAt: new Date().toISOString(),
    };
    await this.repository.updateMetadata(workItemId, updatedMetadata);
  }

  private async markRetryExhausted(
    item: RoutingWatchdogWorkItem,
    retryCount: number,
    maxRetries: number,
    existingMetadata: Record<string, unknown>,
  ): Promise<void> {
    const exhaustedAt = new Date().toISOString();
    try {
      await this.repository.updateMetadata(item.workItemId, {
        ...existingMetadata,
        routingRetryExhausted: true,
        routingRetriesExhaustedAt: exhaustedAt,
        routingRetryCount: retryCount,
      });
      await this.updateTicketFromRoutingExhaustion(item, retryCount, maxRetries, exhaustedAt);
    } catch (error) {
      logger.error(
        { err: error, workItemId: item.workItemId, retryCount, maxRetries },
        'Failed to mark routing_failed work item retries exhausted',
      );
    }
  }

  private async suppressRetryIfTerminalTicket(
    item: RoutingWatchdogWorkItem,
    existingMetadata: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.readTicketStatus || !UUID_PATTERN.test(item.externalId)) {
      return false;
    }

    let ticketStatus: OshalTicketState | null = null;
    try {
      ticketStatus = await this.readTicketStatus(item.externalId);
    } catch (error) {
      logger.warn(
        { err: error, ticketId: item.externalId, workItemId: item.workItemId },
        'Could not read ticket status before routing retry',
      );
      return false;
    }

    if (!ticketStatus || !ROUTING_RETRY_TERMINAL_TICKET_STATUSES.has(ticketStatus)) {
      return false;
    }

    const suppressedAt = new Date().toISOString();
    await this.repository.updateMetadata(item.workItemId, {
      ...existingMetadata,
      routingRetrySuppressed: true,
      routingRetrySuppressedReason: 'terminal_ticket_status',
      routingRetrySuppressedAt: suppressedAt,
      routingRetrySuppressedTicketStatus: ticketStatus,
    });
    logger.info(
      { ticketId: item.externalId, workItemId: item.workItemId, ticketStatus, suppressedAt },
      'Suppressed routing retry for terminal ticket',
    );
    return true;
  }

  private async updateTicketFromRoutingRetry(
    item: RoutingWatchdogWorkItem,
    retryCount: number,
    maxRetries: number,
  ): Promise<void> {
    if (!this.updateTicketStatus || !UUID_PATTERN.test(item.externalId)) {
      return;
    }
    try {
      await this.updateTicketStatus(item.externalId, 'approved', {
        reason: 'routing_failed_retry',
        source: 'work-item-routing-watchdog',
        workItemId: item.workItemId,
        unitId: item.unitId,
        assignedAgentId: item.assignedAgentId ?? null,
        retryCount,
        maxRetries,
      });
    } catch (error) {
      logger.warn(
        { err: error, ticketId: item.externalId, workItemId: item.workItemId, retryCount, maxRetries },
        'Failed to re-approve ticket for routing retry',
      );
    }
  }

  private async updateTicketFromRoutingExhaustion(
    item: RoutingWatchdogWorkItem,
    retryCount: number,
    maxRetries: number,
    exhaustedAt: string,
  ): Promise<void> {
    if (!this.updateTicketStatus || !UUID_PATTERN.test(item.externalId)) {
      return;
    }
    try {
      await this.updateTicketStatus(item.externalId, 'escalated', {
        reason: 'routing_failed_max_retries_exhausted',
        source: 'work-item-routing-watchdog',
        workItemId: item.workItemId,
        unitId: item.unitId,
        assignedAgentId: item.assignedAgentId ?? null,
        retryCount,
        maxRetries,
        exhaustedAt,
      });
    } catch (error) {
      logger.warn(
        { err: error, ticketId: item.externalId, workItemId: item.workItemId, retryCount, maxRetries },
        'Failed to escalate ticket after routing retries exhausted',
      );
    }
  }

  /**
   * @description Marks all active work items for a ticket as routing_failed.
   *
   * @param ticketId - Ticket identifier used as the work-item externalId
   * @param reason - Reason captured by the caller (for example, max dispatch attempts exceeded)
   * @returns Count of work items updated to routing_failed
   */
  async markTicketRoutingFailures(ticketId: string, reason: string): Promise<number> {
    const startedAt = Date.now();
    logger.info({ ticketId, reason }, 'Marking ticket work items as routing_failed');
    const items = await this.repository.findByExternalIdAnyProvider(ticketId);
    let updatedCount = 0;

    for (const item of items) {
      if (!ROUTING_ACTIVE_STATUSES.has(item.status)) {
        continue;
      }

      await this.repository.markRoutingFailed(item.workItemId, reason, {
        externalId: item.externalId,
        provider: item.provider,
        unitId: item.unitId,
        previousStatus: item.status,
      });
      updatedCount += 1;
    }

    const durationMs = Date.now() - startedAt;
    if (updatedCount > 0) {
      logger.warn({ ticketId, reason, updatedCount, durationMs }, 'Marked ticket work items as routing_failed');
    } else {
      logger.info({ ticketId, reason, updatedCount, durationMs }, 'No active work items required routing_failed updates');
    }

    return updatedCount;
  }
}

/**
 * @description Parses a positive integer environment variable value.
 *
 * @param value - Raw environment value
 * @returns Parsed integer or undefined when invalid
 */
function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

interface RoutingWatchdogWorkItem {
  workItemId: string;
  externalId: string;
  provider?: string;
  unitId?: string;
  title?: string;
  status: string;
  assignedAgentId?: string;
  updatedAt?: string;
  createdAt?: string;
  metadata?: unknown;
}
