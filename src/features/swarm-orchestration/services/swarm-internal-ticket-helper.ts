/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Extracted helper for internal ticket upsert from ExternalWorkItem during swarm processing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Changed default ticket status from backlog to approved so queue manager processes tickets immediately
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Preserved provider-authoritative ticket type, queue, URL, and routing metadata during pull reconciliation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Converged GitHub close and reopen snapshots while rejecting stale REST projections before cursor checkpointing
 */

import type { TicketService } from '@/features/ticketing';
import type { ExternalWorkItem, InternalTicket, TicketPriority } from '@/entities/ticket';
import {
  resolveGitHubTicketLifecycleTarget,
  type GitHubTicketLifecycleSnapshot,
} from '@/features/intake';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'swarm-internal-ticket-helper' });

/**
 * @description Ensures an internal ticket exists for a given ExternalWorkItem.
 * If one exists (matched by externalProvider + externalId), updates title/description/labels.
 * If not, creates a new internal ticket in backlog.
 *
 * @param ticketService - TicketService instance
 * @param item - External work item from intake
 * @returns Internal ticket ID
 */
export async function ensureInternalTicketForWorkItem(
  ticketService: TicketService,
  item: ExternalWorkItem,
): Promise<string> {
  try {
    const existing = await ticketService.getTicketByExternalId(item.provider, item.externalId);
    const projection = projectInternalTicket(item);
    const incomingGitHubSnapshot = item.provider === 'github'
      ? readGitHubSnapshot(projection.metadata)
      : null;

    if (existing) {
      const previousGitHubSnapshot = readGitHubSnapshot(existing.metadata);
      if (
        incomingGitHubSnapshot
        && previousGitHubSnapshot
        && isOlderGitHubSnapshot(incomingGitHubSnapshot, previousGitHubSnapshot)
      ) {
        logger.info(
          {
            ticketId: existing.ticketId,
            externalId: item.externalId,
            incomingUpdatedAt: incomingGitHubSnapshot.updatedAt,
            persistedUpdatedAt: previousGitHubSnapshot.updatedAt,
          },
          'Ignored stale GitHub pull snapshot',
        );
        return existing.ticketId;
      }

      await synchronizeGitHubPullStatus(
        ticketService,
        existing,
        incomingGitHubSnapshot,
        previousGitHubSnapshot?.state,
        item.externalId,
      );
      const metadata = { ...existing.metadata, ...projection.metadata };
      const needsUpdate = existing.title !== item.title
        || existing.description !== (item.body ?? '')
        || JSON.stringify(existing.labels) !== JSON.stringify(item.labels ?? [])
        || existing.ticketType !== projection.ticketType
        || existing.externalUrl !== projection.externalUrl
        || JSON.stringify(existing.metadata) !== JSON.stringify(metadata);

      if (needsUpdate) {
        await ticketService.updateTicket(existing.ticketId, {
          title: item.title,
          ticketType: projection.ticketType,
          description: item.body ?? '',
          labels: item.labels ?? [],
          externalUrl: projection.externalUrl,
          metadata,
        });
        logger.info({ ticketId: existing.ticketId, externalId: item.externalId }, 'Updated internal ticket from work item');
      }
      return existing.ticketId;
    }

    const ticket = await ticketService.createTicket({
      title: item.title,
      ticketType: projection.ticketType,
      description: item.body ?? '',
      externalProvider: item.provider,
      externalId: item.externalId,
      externalUrl: projection.externalUrl,
      status: 'backlog',
      priority: mapExternalPriority(item.priority),
      labels: item.labels ?? [],
      metadata: projection.metadata,
      workspaceId: null,
      assignedAgentId: null,
      parentTicketId: null,
    });
    await synchronizeGitHubPullStatus(
      ticketService,
      ticket,
      incomingGitHubSnapshot,
      null,
      item.externalId,
    );

    logger.info(
      { ticketId: ticket.ticketId, provider: item.provider, externalId: item.externalId },
      'Created internal ticket from work item',
    );
    return ticket.ticketId;
  } catch (error) {
    logger.error({ err: error, provider: item.provider, externalId: item.externalId }, 'Failed to ensure internal ticket');
    if (item.provider === 'github') {
      throw error;
    }
    return '';
  }
}

interface GitHubPullSnapshot extends GitHubTicketLifecycleSnapshot {
  updatedAt: string;
}

function readGitHubSnapshot(metadata: Record<string, unknown>): GitHubPullSnapshot | null {
  const value = metadata.githubIssue;
  if (!value || typeof value !== 'object') {
    return null;
  }
  const issue = value as Record<string, unknown>;
  const state = issue.state;
  const updatedAt = issue.updatedAt;
  if (
    (state !== 'open' && state !== 'closed')
    || typeof updatedAt !== 'string'
    || !Number.isFinite(Date.parse(updatedAt))
  ) {
    return null;
  }
  return {
    state,
    stateReason: typeof issue.stateReason === 'string' ? issue.stateReason : null,
    updatedAt,
  };
}

function isOlderGitHubSnapshot(
  incoming: GitHubPullSnapshot,
  persisted: GitHubPullSnapshot,
): boolean {
  return Date.parse(incoming.updatedAt) < Date.parse(persisted.updatedAt);
}

async function synchronizeGitHubPullStatus(
  ticketService: TicketService,
  ticket: InternalTicket,
  incoming: GitHubPullSnapshot | null,
  previousProviderState: 'open' | 'closed' | null | undefined,
  externalId: string,
): Promise<void> {
  if (!incoming) return;
  const target = resolveGitHubTicketLifecycleTarget(
    ticket.status,
    incoming,
    previousProviderState,
  );
  if (!target || target === ticket.status) return;
  await ticketService.updateStatus(ticket.ticketId, target, {
    source: 'github-reconciliation',
    provider: 'github',
    externalId,
    providerState: incoming.state,
    providerUpdatedAt: incoming.updatedAt,
  });
}

function projectInternalTicket(item: ExternalWorkItem): {
  ticketType: string;
  externalUrl: string | null;
  metadata: Record<string, unknown>;
} {
  if (item.ticketProjection) {
    return {
      ticketType: item.ticketProjection.ticketType,
      externalUrl: item.ticketProjection.externalUrl,
      metadata: { ...item.ticketProjection.metadata },
    };
  }
  return {
    ticketType: inferLegacyTicketType(item.labels ?? []),
    externalUrl: null,
    metadata: {},
  };
}

function inferLegacyTicketType(labels: string[]): string {
  const incidentLabels = new Set(['incident', 'rca-requested']);
  return labels.some((label) => incidentLabels.has(label.toLowerCase())) ? 'incident' : 'build';
}

const VALID_PRIORITIES = new Set<TicketPriority>(['none', 'urgent', 'high', 'medium', 'low']);

/**
 * @description Maps external priority strings to valid TicketPriority values.
 * @param value - External priority value
 * @returns Valid TicketPriority or 'none' as fallback
 */
function mapExternalPriority(value?: string): TicketPriority {
  if (value && VALID_PRIORITIES.has(value as TicketPriority)) {
    return value as TicketPriority;
  }
  return 'none';
}
