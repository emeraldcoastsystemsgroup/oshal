/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GitHub Issues intake adapter — second provider proof (M5)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Multiplexed configured request feeds, added no-history cutovers and durable composite cursors, and carried trusted queue/work/release routing metadata
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Reconciled open and closed issue snapshots with provider lifecycle metadata
 */

import {
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  type ExternalWorkItem,
} from '@/entities/ticket';
import type {
  PullWorkItemsInput,
  PullWorkItemsResult,
  WorkItemFeedAdapter,
} from '../services/work-item-feed-adapter';
import { createChildLogger } from '@/shared/logger';
import type { IntakeProvider } from '@/shared/types';
import {
  decodeGitHubCursor,
  encodeGitHubCursor,
  isGitHubIssueAfterPosition,
  repositoryKey,
  type GitHubCursorPosition,
  type GitHubCursorState,
} from './github-issue-cursor';
import {
  buildGitHubTicketRouting,
  resolveGitHubTicketFeeds,
  type GitHubTicketFeedConfig,
} from './github-ticket-provider-config';

const logger = createChildLogger({ module: 'github-work-item-feed-adapter' });
const GITHUB_API_VERSION = '2022-11-28';
const MAX_PAGES_PER_FEED = 20;

/**
 * @description Async controller-local credential provider for GitHub issue reads and writeback.
 */
export type GitHubTicketTokenProvider = () => Promise<string | null>;

/**
 * @description Injectable GitHub adapter dependencies used by runtime composition and focused tests.
 */
export interface GitHubWorkItemFeedAdapterOptions {
  feeds?: GitHubTicketFeedConfig[];
  tokenProvider?: GitHubTicketTokenProvider;
  fetchImpl?: typeof fetch;
}

interface FeedIssueCandidate {
  feed: GitHubTicketFeedConfig;
  issue: GitHubIssue;
}

interface FeedFetchResult {
  feed: GitHubTicketFeedConfig;
  candidates: FeedIssueCandidate[];
}

/**
 * @description GitHub Issues adapter that multiplexes trusted repository feeds into one provider cursor.
 */
export class GitHubWorkItemFeedAdapter implements WorkItemFeedAdapter {
  readonly provider: IntakeProvider = 'github';

  private readonly feeds: GitHubTicketFeedConfig[];
  private readonly tokenProvider: GitHubTicketTokenProvider;
  private readonly fetchImpl: typeof fetch;

  /**
   * @description Creates a GitHub issue feed adapter with controller-injected credentials when available.
   * @param options - Optional trusted feeds, token provider, and HTTP implementation
   */
  constructor(options: GitHubWorkItemFeedAdapterOptions = {}) {
    this.feeds = options.feeds ?? resolveGitHubTicketFeeds();
    this.tokenProvider = options.tokenProvider ?? defaultTokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * @description Pulls issue updates from every configured feed and returns one globally bounded batch.
   * @param input - Pull configuration including the shared composite cursor
   * @returns Normalized work items with the next composite checkpoint
   */
  async pullWorkItems(input: PullWorkItemsInput): Promise<PullWorkItemsResult> {
    const token = (await this.tokenProvider())?.trim();
    if (!token || this.feeds.length === 0) {
      logger.warn(
        { hasCredential: Boolean(token), feedCount: this.feeds.length },
        'Skipping GitHub intake pull — missing explicit credential binding or feed configuration',
      );
      return { items: [], source: 'github-config-missing' };
    }

    const cursor = applyRequestedSince(decodeGitHubCursor(input.cursor, this.feeds), input.since);
    const settled = await Promise.allSettled(
      this.feeds.map((feed) => this.fetchFeed(feed, cursor, input.limit, token)),
    );
    const successful = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failures = settled.flatMap((result, index) => result.status === 'rejected'
      ? [{ feed: this.feeds[index], error: result.reason }]
      : []);

    if (successful.length === 0 && failures.length > 0) {
      throw new AggregateError(failures.map((failure) => failure.error), 'Every GitHub ticket feed failed');
    }
    for (const failure of failures) {
      logger.error(
        { err: failure.error, feedId: failure.feed.id, repository: failure.feed.issueRepository },
        'GitHub ticket feed pull failed; preserving its cursor for reconciliation',
      );
    }

    const emitted = mergeCandidates(successful, input.limit);
    const nextCursor = advanceCursor(cursor, emitted);
    const items = emitted.map((candidate) => mapIssueToWorkItem(candidate));
    logger.info(
      { feedCount: this.feeds.length, failedFeeds: failures.length, mapped: items.length },
      'GitHub ticket feed pull completed',
    );

    return {
      items,
      nextCursor: encodeGitHubCursor(nextCursor),
      source: failures.length > 0 ? 'github:partial' : 'github:configured-feeds',
    };
  }

  private async fetchFeed(
    feed: GitHubTicketFeedConfig,
    cursor: GitHubCursorState,
    limit: number,
    token: string,
  ): Promise<FeedFetchResult> {
    const position = cursor.positions[repositoryKey(feed.issueRepository)];
    let url: URL | null = buildIssuesUrl(feed, position, limit);
    const candidates: FeedIssueCandidate[] = [];
    let page = 0;

    while (url && candidates.length < limit && page < MAX_PAGES_PER_FEED) {
      const response = await this.fetchImpl(url.toString(), { headers: githubHeaders(token) });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API ${response.status} for ${feed.issueRepository}: ${body.slice(0, 200)}`);
      }
      const issues = await response.json() as GitHubIssue[];
      candidates.push(...issues
        .filter((issue) => isEligibleIssue(feed, issue, position))
        .map((issue) => ({ feed, issue })));
      url = readNextPage(response.headers.get('link'));
      page += 1;
    }

    return { feed, candidates };
  }
}

function buildIssuesUrl(
  feed: GitHubTicketFeedConfig,
  position: GitHubCursorPosition,
  limit: number,
): URL {
  const url = new URL(`https://api.github.com/repos/${feed.issueRepository}/issues`);
  url.searchParams.set('state', 'all');
  url.searchParams.set('per_page', String(Math.min(Math.max(limit, 1), 100)));
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('since', overlapTimestamp(position.updatedAt));
  if (feed.labels.length > 0) {
    url.searchParams.set('labels', feed.labels.join(','));
  }
  return url;
}

function isEligibleIssue(
  feed: GitHubTicketFeedConfig,
  issue: GitHubIssue,
  position: GitHubCursorPosition,
): boolean {
  if (issue.pull_request) {
    return false;
  }
  if (
    feed.bootstrap.mode === 'since'
    && Date.parse(issue.created_at) < Date.parse(feed.bootstrap.at)
  ) {
    return false;
  }
  return isGitHubIssueAfterPosition(
    { updatedAt: issue.updated_at, number: issue.number },
    position,
  );
}

function mergeCandidates(results: FeedFetchResult[], limit: number): FeedIssueCandidate[] {
  return results
    .flatMap((result) => result.candidates)
    .sort(compareCandidates)
    .slice(0, Math.max(limit, 0));
}

function compareCandidates(left: FeedIssueCandidate, right: FeedIssueCandidate): number {
  return Date.parse(left.issue.updated_at) - Date.parse(right.issue.updated_at)
    || repositoryKey(left.feed.issueRepository).localeCompare(repositoryKey(right.feed.issueRepository))
    || left.issue.number - right.issue.number;
}

function advanceCursor(
  cursor: GitHubCursorState,
  emitted: FeedIssueCandidate[],
): GitHubCursorState {
  const next: GitHubCursorState = {
    version: 1,
    positions: Object.fromEntries(
      Object.entries(cursor.positions).map(([repository, position]) => [repository, { ...position }]),
    ),
  };
  for (const candidate of emitted) {
    next.positions[repositoryKey(candidate.feed.issueRepository)] = {
      updatedAt: candidate.issue.updated_at,
      number: candidate.issue.number,
    };
  }
  return next;
}

function applyRequestedSince(cursor: GitHubCursorState, since: string | undefined): GitHubCursorState {
  if (!since) {
    return cursor;
  }
  const normalized = new Date(since).toISOString();
  const positions = Object.fromEntries(Object.entries(cursor.positions).map(([repository, position]) => [
    repository,
    Date.parse(normalized) > Date.parse(position.updatedAt)
      ? { updatedAt: normalized, number: 0 }
      : position,
  ]));
  return { version: 1, positions };
}

function mapIssueToWorkItem(candidate: FeedIssueCandidate): ExternalWorkItem {
  const { feed, issue } = candidate;
  const labels = (issue.labels ?? []).map(readLabelName).filter(Boolean);
  const externalId = `${feed.issueRepository}#${issue.number}`;
  const routing = buildGitHubTicketRouting(feed);
  return {
    provider: 'github',
    externalId,
    title: issue.title,
    body: issue.body ?? '',
    labels,
    priority: derivePriority(labels),
    status: issue.state,
    actor: issue.user ? { id: String(issue.user.id), name: issue.user.login } : undefined,
    timestamps: { createdAt: issue.created_at, updatedAt: issue.updated_at },
    ticketProjection: {
      ticketType: feed.ticketType,
      externalUrl: issue.html_url ?? null,
      metadata: {
        source: 'github-reconciliation',
        syncDirection: 'pull',
        queueId: feed.queueId,
        queueName: feed.queueName,
        ticketType: feed.ticketType,
        githubTicket: routing,
        githubIssue: {
          repository: feed.issueRepository,
          number: issue.number,
          state: issue.state,
          stateReason: issue.state_reason ?? null,
          author: issue.user?.login ?? null,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at ?? null,
        },
      },
    },
    workflow: buildExternalTicketWorkflow('backlog'),
    hierarchy: buildExternalTicketHierarchy(externalId),
    rawPayload: {
      ...issue,
      metadata: { githubTicket: routing },
    },
  };
}

function readLabelName(label: string | { name?: string }): string {
  return typeof label === 'string' ? label : label.name?.trim() ?? '';
}

function derivePriority(labels: string[]): string {
  const lower = labels.map((label) => label.toLowerCase());
  if (lower.some((label) => label.includes('critical') || label.includes('p0'))) return 'urgent';
  if (lower.some((label) => label.includes('high') || label.includes('p1'))) return 'high';
  if (lower.some((label) => label.includes('low') || label.includes('p3'))) return 'low';
  return 'medium';
}

function overlapTimestamp(timestamp: string): string {
  return new Date(Math.max(0, new Date(timestamp).getTime() - 1000)).toISOString();
}

function readNextPage(linkHeader: string | null): URL | null {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      return new URL(match[1]);
    }
  }
  return null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function defaultTokenProvider(): Promise<string | null> {
  return process.env.GITHUB_TICKET_TOKEN?.trim()
    || process.env.GITHUB_ISSUES_TOKEN?.trim()
    || process.env.GITHUB_TOKEN?.trim()
    || null;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url?: string;
  state: string;
  labels: Array<string | { name?: string }>;
  user?: { id: number; login: string };
  created_at: string;
  updated_at: string;
  state_reason?: string | null;
  closed_at?: string | null;
  pull_request?: unknown;
}
