/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added trusted multi-repository GitHub request-feed configuration with a fixed no-history cutover and work/release routing metadata
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Accepted requests filed directly against the active open-shal core work repository into the existing core queue
 */

import { z } from 'zod';

const GitHubRepositorySchema = z.string().trim().regex(
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  'expected owner/repository',
);

const GitHubFeedBootstrapSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('since'),
    at: z.string().datetime({ offset: true }),
  }),
  z.object({
    mode: z.literal('open-backlog'),
  }),
]);

const GitHubTicketFeedConfigSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  issueRepository: GitHubRepositorySchema,
  workRepository: GitHubRepositorySchema,
  releaseRepository: GitHubRepositorySchema,
  ticketType: z.string().trim().min(1),
  queueId: z.string().trim().min(1),
  queueName: z.string().trim().min(1),
  labels: z.array(z.string().trim().min(1)).default([]),
  requestMode: z.literal('request-only').default('request-only'),
  closePolicy: z.enum(['manual', 'release-proof']).default('release-proof'),
  bootstrap: GitHubFeedBootstrapSchema,
});

const GitHubTicketRoutingSchema = GitHubTicketFeedConfigSchema.pick({
  id: true,
  issueRepository: true,
  workRepository: true,
  releaseRepository: true,
  ticketType: true,
  queueId: true,
  queueName: true,
  requestMode: true,
  closePolicy: true,
});

/**
 * @description Trusted server-side definition for one GitHub Issues request feed.
 */
export type GitHubTicketFeedConfig = z.infer<typeof GitHubTicketFeedConfigSchema>;

/**
 * @description Repository-routing metadata attached to normalized GitHub tickets.
 */
export type GitHubTicketRouting = z.infer<typeof GitHubTicketRoutingSchema>;

const DEFAULT_GITHUB_TICKET_FEEDS: GitHubTicketFeedConfig[] = [
  GitHubTicketFeedConfigSchema.parse({
    id: 'applications',
    issueRepository: 'emeraldcoastsystemsgroup/oshal-applications',
    workRepository: 'emeraldcoastsystemsgroup/oshal-applications',
    releaseRepository: 'emeraldcoastsystemsgroup/oshal-applications',
    ticketType: 'build',
    queueId: 'github-applications-requests',
    queueName: 'GitHub Application Requests',
    labels: [],
    requestMode: 'request-only',
    closePolicy: 'release-proof',
    bootstrap: { mode: 'since', at: '2026-07-20T02:00:00.000Z' },
  }),
  GitHubTicketFeedConfigSchema.parse({
    id: 'core',
    issueRepository: 'emeraldcoastsystemsgroup/oshal',
    workRepository: 'emeraldcoastsystemsgroup/open-shal',
    releaseRepository: 'emeraldcoastsystemsgroup/oshal',
    ticketType: 'oshal-dev',
    queueId: 'github-core-requests',
    queueName: 'GitHub Core Requests',
    labels: [],
    requestMode: 'request-only',
    closePolicy: 'release-proof',
    bootstrap: { mode: 'since', at: '2026-07-20T02:00:00.000Z' },
  }),
  GitHubTicketFeedConfigSchema.parse({
    id: 'core-work',
    issueRepository: 'emeraldcoastsystemsgroup/open-shal',
    workRepository: 'emeraldcoastsystemsgroup/open-shal',
    releaseRepository: 'emeraldcoastsystemsgroup/oshal',
    ticketType: 'oshal-dev',
    queueId: 'github-core-requests',
    queueName: 'GitHub Core Requests',
    labels: [],
    requestMode: 'request-only',
    closePolicy: 'release-proof',
    bootstrap: { mode: 'since', at: '2026-07-20T02:00:00.000Z' },
  }),
];

/**
 * @description Resolves the trusted GitHub feed list from JSON configuration, legacy single-repository variables, or the OSHAL defaults.
 * @param env - Environment containing optional GitHub feed overrides
 * @returns Validated GitHub feed definitions
 */
export function resolveGitHubTicketFeeds(
  env: NodeJS.ProcessEnv = process.env,
): GitHubTicketFeedConfig[] {
  const configured = env.GITHUB_TICKET_FEEDS?.trim();
  if (configured) {
    return parseConfiguredFeeds(configured);
  }

  const legacy = buildLegacyFeed(env);
  if (legacy) {
    return [legacy];
  }

  return DEFAULT_GITHUB_TICKET_FEEDS.map(cloneFeed);
}

/**
 * @description Reads trusted repository-routing metadata from a normalized GitHub issue payload.
 * @param rawPayload - External work-item raw payload
 * @returns Validated routing metadata or null when the payload is unrelated or malformed
 */
export function readGitHubTicketRouting(rawPayload: unknown): GitHubTicketRouting | null {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null;
  }
  const metadata = (rawPayload as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const result = GitHubTicketRoutingSchema.safeParse(
    (metadata as Record<string, unknown>).githubTicket,
  );
  return result.success ? result.data : null;
}

/**
 * @description Projects a feed definition into the immutable routing metadata carried with a ticket.
 * @param feed - Validated GitHub feed definition
 * @returns Repository-routing metadata safe to persist with an internal ticket
 */
export function buildGitHubTicketRouting(feed: GitHubTicketFeedConfig): GitHubTicketRouting {
  return GitHubTicketRoutingSchema.parse(feed);
}

function parseConfiguredFeeds(raw: string): GitHubTicketFeedConfig[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`GITHUB_TICKET_FEEDS must be valid JSON: ${toErrorMessage(error)}`);
  }
  const feeds = z.array(GitHubTicketFeedConfigSchema).min(1).parse(value);
  assertUniqueFeedKeys(feeds);
  return feeds;
}

function buildLegacyFeed(env: NodeJS.ProcessEnv): GitHubTicketFeedConfig | null {
  const owner = env.GITHUB_OWNER?.trim();
  const repository = env.GITHUB_REPO?.trim();
  if (!owner && !repository) {
    return null;
  }
  if (!owner || !repository) {
    throw new Error('Legacy GitHub intake requires both GITHUB_OWNER and GITHUB_REPO');
  }
  const issueRepository = `${owner}/${repository}`;
  return GitHubTicketFeedConfigSchema.parse({
    id: 'legacy',
    issueRepository,
    workRepository: issueRepository,
    releaseRepository: issueRepository,
    ticketType: 'build',
    queueId: 'github-requests',
    queueName: 'GitHub Requests',
    labels: (env.GITHUB_LABELS ?? '').split(',').map((label) => label.trim()).filter(Boolean),
    requestMode: 'request-only',
    closePolicy: 'manual',
    bootstrap: { mode: 'open-backlog' },
  });
}

function assertUniqueFeedKeys(feeds: GitHubTicketFeedConfig[]): void {
  const ids = new Set<string>();
  const repositories = new Set<string>();
  for (const feed of feeds) {
    const repository = feed.issueRepository.toLowerCase();
    if (ids.has(feed.id)) {
      throw new Error(`Duplicate GitHub ticket feed id: ${feed.id}`);
    }
    if (repositories.has(repository)) {
      throw new Error(`Duplicate GitHub issue repository: ${feed.issueRepository}`);
    }
    ids.add(feed.id);
    repositories.add(repository);
  }
}

function cloneFeed(feed: GitHubTicketFeedConfig): GitHubTicketFeedConfig {
  return {
    ...feed,
    labels: [...feed.labels],
    bootstrap: { ...feed.bootstrap },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
