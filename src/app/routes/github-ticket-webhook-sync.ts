/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added idempotent GitHub Issues webhook-to-backlog synchronization for configured ticket feeds
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Enforced the configured no-history boundary for first-seen webhook issues
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Cancelled untriaged internal projections when their GitHub issue closes
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Shared legal close and reopen projection with REST reconciliation
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Machine-write identity: buildCreateInput minted the internal projection with NO ownerSub, so every webhook-born GitHub ticket landed owner_sub = NULL on an owner-RLS table — insertable only because the caller wrapped dispatch in the operator sentinel, and thereafter invisible to every per-owner rail. ownerSub is now a REQUIRED option (the synthetic `webhook:github` machine sub the ingress also stamps on the connection), so the row and the connection GUC satisfy the same predicate. Required, not defaulted: a silent default is how this shipped owner-less in the first place.
 */

import { z } from 'zod';
import type {
  CreateInternalTicketInput,
  InternalTicket,
  OshalTicketState,
} from '@/entities/ticket';
import {
  resolveGitHubTicketLifecycleTarget,
  resolveGitHubTicketFeeds,
  type GitHubTicketFeedConfig,
} from '@/features/intake';

const GitHubIssueLabelSchema = z.union([
  z.string().trim().min(1),
  z.object({ name: z.string().nullable().optional() }).passthrough(),
]);

const GitHubIssuesPayloadSchema = z.object({
  action: z.string().trim().min(1),
  issue: z.object({
    number: z.number().int().positive(),
    node_id: z.string().optional(),
    title: z.string().trim().min(1),
    body: z.string().nullable().optional(),
    state: z.enum(['open', 'closed']),
    state_reason: z.string().nullable().optional(),
    html_url: z.string().url(),
    labels: z.array(GitHubIssueLabelSchema).default([]),
    user: z.object({ login: z.string().optional() }).nullish(),
    created_at: z.string().datetime({ offset: true }).optional(),
    updated_at: z.string().datetime({ offset: true }),
    closed_at: z.string().datetime({ offset: true }).nullable().optional(),
    pull_request: z.unknown().optional(),
  }).passthrough(),
  repository: z.object({
    full_name: z.string().trim().min(3),
  }).passthrough(),
  sender: z.object({ login: z.string().optional() }).optional(),
}).passthrough();

type GitHubIssuesPayload = z.infer<typeof GitHubIssuesPayloadSchema>;
type MutableTicketFields = Partial<Omit<InternalTicket, 'ticketId' | 'createdAt' | 'status'>>;

/**
 * @description Minimal ticket lifecycle dependency required by GitHub webhook synchronization.
 */
export interface GitHubTicketWebhookTicketService {
  /** Finds the stable internal projection of one provider-native issue. */
  getTicketByExternalId(provider: string, externalId: string): Promise<InternalTicket | null>;
  /** Creates the first internal projection of one provider-native issue. */
  createTicket(input: CreateInternalTicketInput): Promise<InternalTicket>;
  /** Refreshes mutable issue fields without bypassing lifecycle validation. */
  updateTicket(ticketId: string, updates: MutableTicketFields): Promise<void>;
  /** Applies a provider lifecycle transition through the canonical ticket service. */
  updateStatus(
    ticketId: string,
    status: OshalTicketState,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * @description Dependencies and optional trusted-feed override for the GitHub webhook synchronizer.
 */
export interface GitHubTicketWebhookSyncOptions {
  ticketService: GitHubTicketWebhookTicketService;
  feeds?: readonly GitHubTicketFeedConfig[];
  /**
   * The synthetic machine sub that owns webhook-born projections — the SAME sub the ingress
   * stamps on the database connection (`webhookOwnerSub('github')`). Required: `tickets` is
   * owner-RLS'd and a NULL owner can never satisfy
   * `owner_sub = current_setting('oshal.current_sub')`, so an omitted owner is a refused INSERT
   * under a stamped connection and an unattributable row under an operator one.
   */
  ownerSub: string;
}

/**
 * @description Observable outcome of processing one verified webhook event.
 */
export interface GitHubTicketWebhookSyncResult {
  action: 'created' | 'updated' | 'ignored';
  ticketId?: string;
  reason?: string;
}

/**
 * @description Handler contract designed for the verified connector-webhook ingress callback.
 */
export interface GitHubTicketWebhookSync {
  /**
   * @description Synchronizes one event after the ingress layer has verified its signature.
   * @param eventName - GitHub event header value, expected to be `issues`
   * @param payload - Parsed GitHub webhook payload
   * @returns Whether a ticket was created, updated, or intentionally ignored
   */
  handle(eventName: string, payload: unknown): Promise<GitHubTicketWebhookSyncResult>;
}

/**
 * @description Creates a push synchronizer that accepts issues only from the trusted feed repositories.
 * @param options - Ticket service and an optional feed list for tests or explicit composition
 * @returns A verified-event handler suitable for connector webhook ingress wiring
 */
export function createGitHubTicketWebhookSync(
  options: GitHubTicketWebhookSyncOptions,
): GitHubTicketWebhookSync {
  const feeds = options.feeds ? [...options.feeds] : resolveGitHubTicketFeeds();
  const feedsByRepository = indexFeedsByRepository(feeds);

  return {
    handle: async (eventName, payload) => handleVerifiedEvent(
      options.ticketService,
      feedsByRepository,
      eventName,
      payload,
      options.ownerSub,
    ),
  };
}

async function handleVerifiedEvent(
  ticketService: GitHubTicketWebhookTicketService,
  feeds: ReadonlyMap<string, GitHubTicketFeedConfig>,
  eventName: string,
  payload: unknown,
  ownerSub: string,
): Promise<GitHubTicketWebhookSyncResult> {
  if (eventName.trim().toLowerCase() !== 'issues') {
    return ignored('unsupported-event');
  }

  const parsed = GitHubIssuesPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return ignored('malformed-payload');
  }
  if (parsed.data.issue.pull_request !== undefined) {
    return ignored('pull-request');
  }

  const feed = feeds.get(normalizeRepository(parsed.data.repository.full_name));
  if (!feed) {
    return ignored('unconfigured-repository');
  }
  return synchronizeIssue(ticketService, feed, parsed.data, ownerSub);
}

async function synchronizeIssue(
  ticketService: GitHubTicketWebhookTicketService,
  feed: GitHubTicketFeedConfig,
  payload: GitHubIssuesPayload,
  ownerSub: string,
): Promise<GitHubTicketWebhookSyncResult> {
  const externalId = `${feed.issueRepository}#${payload.issue.number}`;
  const existing = await ticketService.getTicketByExternalId('github', externalId);
  if (!existing) {
    const rejectionReason = firstProjectionRejectionReason(feed, payload);
    if (rejectionReason) {
      return ignored(rejectionReason);
    }
    const created = await ticketService.createTicket(buildCreateInput(feed, payload, externalId, ownerSub));
    return { action: 'created', ticketId: created.ticketId };
  }
  if (isStaleEvent(existing, payload)) {
    return ignored('stale-event');
  }

  await ticketService.updateTicket(existing.ticketId, buildUpdates(existing, feed, payload));
  await synchronizeStatus(ticketService, existing, payload);
  return { action: 'updated', ticketId: existing.ticketId };
}

function isStaleEvent(existing: InternalTicket, payload: GitHubIssuesPayload): boolean {
  const githubIssue = existing.metadata.githubIssue;
  if (!githubIssue || typeof githubIssue !== 'object') {
    return false;
  }
  const storedUpdatedAt = (githubIssue as Record<string, unknown>).updatedAt;
  if (typeof storedUpdatedAt !== 'string') {
    return false;
  }
  return Date.parse(payload.issue.updated_at) < Date.parse(storedUpdatedAt);
}

function firstProjectionRejectionReason(
  feed: GitHubTicketFeedConfig,
  payload: GitHubIssuesPayload,
): string | null {
  const action = payload.action.trim().toLowerCase();
  if (payload.issue.state !== 'open' || action === 'closed') {
    return 'untracked-issue-action';
  }
  if (!hasConfiguredLabels(feed, payload)) {
    return 'missing-required-label';
  }
  if (feed.bootstrap.mode === 'open-backlog') {
    return action === 'opened' ? null : 'untracked-issue-action';
  }
  if (!payload.issue.created_at) {
    return 'missing-created-at';
  }
  return Date.parse(payload.issue.created_at) < Date.parse(feed.bootstrap.at)
    ? 'pre-cutover-issue'
    : null;
}

function buildCreateInput(
  feed: GitHubTicketFeedConfig,
  payload: GitHubIssuesPayload,
  externalId: string,
  ownerSub: string,
): CreateInternalTicketInput {
  return {
    // The synthetic machine owner (`webhook:github`), matching the sub the ingress stamps on the
    // connection. Both halves of the owner-RLS predicate must agree or the INSERT is refused.
    ownerSub,
    title: payload.issue.title,
    ticketType: feed.ticketType,
    description: payload.issue.body ?? '',
    status: 'backlog',
    priority: derivePriority(readLabels(payload.issue.labels)),
    labels: readLabels(payload.issue.labels),
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: 'github',
    externalId,
    externalUrl: payload.issue.html_url,
    metadata: buildMetadata({}, feed, payload),
  };
}

function buildUpdates(
  existing: InternalTicket,
  feed: GitHubTicketFeedConfig,
  payload: GitHubIssuesPayload,
): MutableTicketFields {
  return {
    title: payload.issue.title,
    ticketType: feed.ticketType,
    description: payload.issue.body ?? '',
    priority: derivePriority(readLabels(payload.issue.labels)),
    labels: readLabels(payload.issue.labels),
    externalUrl: payload.issue.html_url,
    metadata: buildMetadata(existing.metadata, feed, payload),
  };
}

function buildMetadata(
  existing: Record<string, unknown>,
  feed: GitHubTicketFeedConfig,
  payload: GitHubIssuesPayload,
): Record<string, unknown> {
  return {
    ...existing,
    source: 'github-webhook',
    syncDirection: 'push',
    queueId: feed.queueId,
    queueName: feed.queueName,
    ticketType: feed.ticketType,
    githubTicket: buildRoutingMetadata(feed),
    githubIssue: {
      repository: feed.issueRepository,
      number: payload.issue.number,
      nodeId: payload.issue.node_id ?? null,
      action: payload.action,
      state: payload.issue.state,
      stateReason: payload.issue.state_reason ?? null,
      author: payload.issue.user?.login ?? null,
      sender: payload.sender?.login ?? null,
      createdAt: payload.issue.created_at ?? null,
      updatedAt: payload.issue.updated_at ?? null,
      closedAt: payload.issue.closed_at ?? null,
    },
  };
}

function buildRoutingMetadata(feed: GitHubTicketFeedConfig): Record<string, unknown> {
  return {
    id: feed.id,
    issueRepository: feed.issueRepository,
    workRepository: feed.workRepository,
    releaseRepository: feed.releaseRepository,
    ticketType: feed.ticketType,
    queueId: feed.queueId,
    queueName: feed.queueName,
    requestMode: feed.requestMode,
    closePolicy: feed.closePolicy,
  };
}

async function synchronizeStatus(
  ticketService: GitHubTicketWebhookTicketService,
  ticket: InternalTicket,
  payload: GitHubIssuesPayload,
): Promise<void> {
  const normalizedAction = payload.action.trim().toLowerCase();
  const target = resolveGitHubTicketLifecycleTarget(ticket.status, {
    action: normalizedAction,
    state: payload.issue.state,
    stateReason: payload.issue.state_reason,
  });
  if (target) {
    await updateProviderStatus(ticketService, ticket, target, normalizedAction);
  }
}

async function updateProviderStatus(
  ticketService: GitHubTicketWebhookTicketService,
  ticket: InternalTicket,
  target: OshalTicketState,
  action: string,
): Promise<void> {
  if (ticket.status === target) return;
  await ticketService.updateStatus(ticket.ticketId, target, {
    source: 'github-webhook',
    provider: 'github',
    externalId: ticket.externalId,
    webhookAction: action,
  });
}

function readLabels(labels: GitHubIssuesPayload['issue']['labels']): string[] {
  return labels.flatMap((label) => {
    const value = typeof label === 'string' ? label : label.name;
    return value?.trim() ? [value.trim()] : [];
  });
}

function hasConfiguredLabels(
  feed: GitHubTicketFeedConfig,
  payload: GitHubIssuesPayload,
): boolean {
  const labels = new Set(readLabels(payload.issue.labels).map((label) => label.toLowerCase()));
  return feed.labels.every((label) => labels.has(label.toLowerCase()));
}

function derivePriority(labels: string[]): InternalTicket['priority'] {
  const normalized = labels.map((label) => label.toLowerCase());
  if (normalized.some((label) => label.includes('critical') || label.includes('p0'))) return 'urgent';
  if (normalized.some((label) => label.includes('high') || label.includes('p1'))) return 'high';
  if (normalized.some((label) => label.includes('low') || label.includes('p3'))) return 'low';
  return 'medium';
}

function indexFeedsByRepository(
  feeds: readonly GitHubTicketFeedConfig[],
): ReadonlyMap<string, GitHubTicketFeedConfig> {
  return new Map(feeds.map((feed) => [normalizeRepository(feed.issueRepository), feed]));
}

function normalizeRepository(value: string): string {
  return value.trim().toLowerCase();
}

function ignored(reason: string): GitHubTicketWebhookSyncResult {
  return { action: 'ignored', reason };
}
