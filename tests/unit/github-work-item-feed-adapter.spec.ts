/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added multi-feed GitHub pull recovery tests for cutover filtering, routing, composite cursors, and partial failures
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Proved pull recovery preserves trusted internal ticket routing instead of inferring from issue labels
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Proved REST recovery converges close and reopen snapshots without overwriting newer push state
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Proved an existing composite cursor bootstraps the newly trusted open-shal feed at the no-history cutover
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GitHubWorkItemFeedAdapter,
  resolveGitHubTicketFeeds,
  type GitHubTicketFeedConfig,
} from '@/features/intake/providers';
import { ensureInternalTicketForWorkItem } from '@/features/swarm-orchestration/services/swarm-internal-ticket-helper';
import type { TicketService } from '@/features/ticketing/services/ticket-service';
import type { InternalTicket } from '@/entities/ticket';

const CUTOVER = '2026-07-20T02:00:00.000Z';
const FEEDS: GitHubTicketFeedConfig[] = [
  {
    id: 'applications',
    issueRepository: 'emeraldcoastsystemsgroup/oshal-applications',
    workRepository: 'emeraldcoastsystemsgroup/oshal-applications',
    releaseRepository: 'emeraldcoastsystemsgroup/oshal-applications',
    ticketType: 'build',
    queueId: 'github-applications-requests',
    queueName: 'GitHub Application Requests',
    labels: ['request'],
    requestMode: 'request-only',
    closePolicy: 'release-proof',
    bootstrap: { mode: 'since', at: CUTOVER },
  },
  {
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
    bootstrap: { mode: 'since', at: CUTOVER },
  },
];

function issue(number: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    labels: [{ name: 'ux' }],
    user: { id: number, login: `requester-${number}` },
    created_at: '2026-07-20T02:05:00.000Z',
    updated_at: updatedAt,
    ...overrides,
  };
}

function repositoryFromUrl(url: string): string {
  return new URL(url).pathname.replace('/repos/', '').replace('/issues', '');
}

function createRepositoryFetch(
  payloads: Record<string, unknown>,
  failures: Set<string> = new Set(),
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const repository = repositoryFromUrl(url);
    if (failures.has(repository)) {
      return new Response('temporary GitHub failure', { status: 502 });
    }
    return new Response(JSON.stringify(payloads[repository] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function buildAdapter(
  fetchImpl: ReturnType<typeof createRepositoryFetch>,
  feeds: GitHubTicketFeedConfig[] = FEEDS,
) {
  return new GitHubWorkItemFeedAdapter({
    feeds,
    tokenProvider: async () => 'test-token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

describe('default GitHub ticket feeds', () => {
  it('routes both core issue repositories into the same core work and release path', () => {
    const coreFeeds = resolveGitHubTicketFeeds({})
      .filter((feed) => feed.queueId === 'github-core-requests');

    expect(coreFeeds.map((feed) => feed.issueRepository)).toEqual([
      'emeraldcoastsystemsgroup/oshal',
      'emeraldcoastsystemsgroup/open-shal',
    ]);
    expect(coreFeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueRepository: 'emeraldcoastsystemsgroup/open-shal',
        workRepository: 'emeraldcoastsystemsgroup/open-shal',
        releaseRepository: 'emeraldcoastsystemsgroup/oshal',
        ticketType: 'oshal-dev',
        requestMode: 'request-only',
        closePolicy: 'release-proof',
      }),
    ]));
  });

  it('bootstraps a missing open-shal cursor position at cutover without resetting old positions', async () => {
    const feeds = resolveGitHubTicketFeeds({});
    const oldPositions = {
      'emeraldcoastsystemsgroup/oshal-applications': {
        updatedAt: '2026-07-20T02:40:00.000Z',
        number: 51,
      },
      'emeraldcoastsystemsgroup/oshal': {
        updatedAt: '2026-07-20T02:50:00.000Z',
        number: 61,
      },
    };
    const oldCursor = `gh1.${Buffer.from(JSON.stringify({
      version: 1,
      positions: oldPositions,
    }), 'utf8').toString('base64url')}`;
    const fetchImpl = createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [],
      'emeraldcoastsystemsgroup/oshal': [],
      'emeraldcoastsystemsgroup/open-shal': [
        issue(1, '2026-07-20T03:00:00.000Z', {
          title: 'Public core request',
          created_at: '2026-07-20T02:05:00.000Z',
          html_url: 'https://github.com/emeraldcoastsystemsgroup/open-shal/issues/1',
        }),
      ],
    });

    const result = await buildAdapter(fetchImpl, feeds).pullWorkItems({
      limit: 10,
      cursor: oldCursor,
    });

    expect(result.items.map((item) => item.externalId)).toEqual([
      'emeraldcoastsystemsgroup/open-shal#1',
    ]);
    expect(result.items[0].rawPayload).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        githubTicket: expect.objectContaining({
          issueRepository: 'emeraldcoastsystemsgroup/open-shal',
          workRepository: 'emeraldcoastsystemsgroup/open-shal',
          releaseRepository: 'emeraldcoastsystemsgroup/oshal',
          queueId: 'github-core-requests',
        }),
      }),
    }));

    const sinceByRepository = Object.fromEntries(fetchImpl.mock.calls.map(([input]) => {
      const url = new URL(String(input));
      return [repositoryFromUrl(url.toString()), url.searchParams.get('since')];
    }));
    expect(sinceByRepository).toEqual({
      'emeraldcoastsystemsgroup/oshal-applications': '2026-07-20T02:39:59.000Z',
      'emeraldcoastsystemsgroup/oshal': '2026-07-20T02:49:59.000Z',
      'emeraldcoastsystemsgroup/open-shal': '2026-07-20T01:59:59.000Z',
    });

    expect(result.nextCursor).toMatch(/^gh1\./);
    const nextCursor = result.nextCursor ?? '';
    const nextState = JSON.parse(
      Buffer.from(nextCursor.slice('gh1.'.length), 'base64url').toString('utf8'),
    ) as { positions: Record<string, { updatedAt: string; number: number }> };
    expect(nextState.positions).toEqual({
      ...oldPositions,
      'emeraldcoastsystemsgroup/open-shal': {
        updatedAt: '2026-07-20T03:00:00.000Z',
        number: 1,
      },
    });
  });
});

describe('GitHubWorkItemFeedAdapter configured feeds', () => {
  it('merges two feeds while filtering pull requests and pre-cutover history', async () => {
    const fetchImpl = createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [
        issue(11, '2026-07-20T02:10:00.000Z'),
        issue(12, '2026-07-20T02:11:00.000Z', {
          pull_request: { url: 'https://api.github.com/pulls/12' },
        }),
      ],
      'emeraldcoastsystemsgroup/oshal': [
        issue(21, '2026-07-20T02:12:00.000Z', {
          created_at: '2026-07-19T23:59:59.000Z',
        }),
        issue(22, '2026-07-20T02:20:00.000Z'),
      ],
    });

    const result = await buildAdapter(fetchImpl).pullWorkItems({ limit: 10 });

    expect(result.source).toBe('github:configured-feeds');
    expect(result.nextCursor).toMatch(/^gh1\./);
    expect(result.items.map((item) => item.externalId)).toEqual([
      'emeraldcoastsystemsgroup/oshal-applications#11',
      'emeraldcoastsystemsgroup/oshal#22',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url] of fetchImpl.mock.calls) {
      expect(new URL(String(url)).searchParams.get('since')).toBe('2026-07-20T01:59:59.000Z');
      expect(new URL(String(url)).searchParams.get('state')).toBe('all');
    }

    const routing = (result.items[1].rawPayload as {
      metadata: { githubTicket: Record<string, unknown> };
    }).metadata.githubTicket;
    expect(routing).toEqual(expect.objectContaining({
      id: 'core',
      issueRepository: 'emeraldcoastsystemsgroup/oshal',
      workRepository: 'emeraldcoastsystemsgroup/open-shal',
      releaseRepository: 'emeraldcoastsystemsgroup/oshal',
      ticketType: 'oshal-dev',
      queueId: 'github-core-requests',
      requestMode: 'request-only',
      closePolicy: 'release-proof',
    }));
    expect(result.items[1].ticketProjection?.metadata.githubIssue).toEqual(
      expect.objectContaining({
        repository: 'emeraldcoastsystemsgroup/oshal',
        number: 22,
        state: 'open',
        stateReason: null,
        updatedAt: '2026-07-20T02:20:00.000Z',
      }),
    );
  });

  it('uses the composite cursor to make a repeated poll idempotent per repository', async () => {
    const fetchImpl = createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [
        issue(31, '2026-07-20T02:30:00.000Z'),
      ],
      'emeraldcoastsystemsgroup/oshal': [
        issue(41, '2026-07-20T02:40:00.000Z'),
      ],
    });
    const adapter = buildAdapter(fetchImpl);

    const first = await adapter.pullWorkItems({ limit: 10 });
    const repeated = await adapter.pullWorkItems({ limit: 10, cursor: first.nextCursor });

    expect(first.items).toHaveLength(2);
    expect(repeated.items).toEqual([]);
    expect(repeated.nextCursor).toBe(first.nextCursor);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('materializes pull recovery with the configured ticket type, queue, URL, and repository routing', async () => {
    const externalUrl = 'https://github.com/emeraldcoastsystemsgroup/oshal/issues/61';
    const fetchImpl = createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [],
      'emeraldcoastsystemsgroup/oshal': [
        issue(61, '2026-07-20T03:00:00.000Z', { html_url: externalUrl }),
      ],
    });
    const result = await buildAdapter(fetchImpl).pullWorkItems({ limit: 10 });
    const createTicket = vi.fn(async () => ({ ticketId: 'ticket-61' }));
    const ticketService = {
      getTicketByExternalId: vi.fn(async () => null),
      createTicket,
      updateTicket: vi.fn(async () => undefined),
    } as unknown as TicketService;

    const ticketId = await ensureInternalTicketForWorkItem(ticketService, result.items[0]);

    expect(ticketId).toBe('ticket-61');
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({
      ticketType: 'oshal-dev',
      externalUrl,
      status: 'backlog',
      metadata: expect.objectContaining({
        queueId: 'github-core-requests',
        queueName: 'GitHub Core Requests',
        githubTicket: expect.objectContaining({
          workRepository: 'emeraldcoastsystemsgroup/open-shal',
          releaseRepository: 'emeraldcoastsystemsgroup/oshal',
        }),
      }),
    }));
  });

  it('returns successful feed work and a partial source when another feed fails', async () => {
    const fetchImpl = createRepositoryFetch(
      {
        'emeraldcoastsystemsgroup/oshal-applications': [
          issue(51, '2026-07-20T02:50:00.000Z'),
        ],
      },
      new Set(['emeraldcoastsystemsgroup/oshal']),
    );

    const result = await buildAdapter(fetchImpl).pullWorkItems({ limit: 10 });

    expect(result.source).toBe('github:partial');
    expect(result.items.map((item) => item.externalId)).toEqual([
      'emeraldcoastsystemsgroup/oshal-applications#51',
    ]);
    expect(result.nextCursor).toMatch(/^gh1\./);
  });

  it('converges a missed close and later reopen through legal ticket transitions', async () => {
    const externalId = 'emeraldcoastsystemsgroup/oshal#71';
    const harness = buildStatefulTicketService(buildInternalTicket({
      externalId,
      status: 'approved',
      metadata: {
        githubIssue: {
          state: 'open',
          stateReason: null,
          updatedAt: '2026-07-20T03:00:00.000Z',
        },
      },
    }));
    const closed = await buildAdapter(createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [],
      'emeraldcoastsystemsgroup/oshal': [issue(71, '2026-07-20T03:05:00.000Z', {
        state: 'closed',
        state_reason: 'completed',
        closed_at: '2026-07-20T03:05:00.000Z',
      })],
    })).pullWorkItems({ limit: 10 });

    await ensureInternalTicketForWorkItem(harness.service, closed.items[0]);

    expect(harness.current().status).toBe('complete');
    expect(harness.updateStatus).toHaveBeenLastCalledWith(
      harness.current().ticketId,
      'complete',
      expect.objectContaining({ source: 'github-reconciliation' }),
    );
    expect(harness.current().metadata.githubIssue).toEqual(expect.objectContaining({
      state: 'closed',
      stateReason: 'completed',
      updatedAt: '2026-07-20T03:05:00.000Z',
    }));

    const reopened = await buildAdapter(createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [],
      'emeraldcoastsystemsgroup/oshal': [issue(71, '2026-07-20T03:10:00.000Z')],
    })).pullWorkItems({ limit: 10 });

    await ensureInternalTicketForWorkItem(harness.service, reopened.items[0]);

    expect(harness.current().status).toBe('backlog');
    expect(harness.updateStatus).toHaveBeenLastCalledWith(
      harness.current().ticketId,
      'backlog',
      expect.objectContaining({ source: 'github-reconciliation' }),
    );
  });

  it('ignores an older REST snapshot than the persisted GitHub snapshot', async () => {
    const externalId = 'emeraldcoastsystemsgroup/oshal#72';
    const harness = buildStatefulTicketService(buildInternalTicket({
      externalId,
      title: 'Newer webhook title',
      status: 'complete',
      metadata: {
        source: 'github-webhook',
        githubIssue: {
          state: 'closed',
          stateReason: 'completed',
          updatedAt: '2026-07-20T04:00:00.000Z',
        },
      },
    }));
    const stale = await buildAdapter(createRepositoryFetch({
      'emeraldcoastsystemsgroup/oshal-applications': [],
      'emeraldcoastsystemsgroup/oshal': [issue(72, '2026-07-20T03:59:59.000Z', {
        title: 'Stale pull title',
        state: 'open',
      })],
    })).pullWorkItems({ limit: 10 });

    await ensureInternalTicketForWorkItem(harness.service, stale.items[0]);

    expect(harness.current().title).toBe('Newer webhook title');
    expect(harness.current().status).toBe('complete');
    expect(harness.updateTicket).not.toHaveBeenCalled();
    expect(harness.updateStatus).not.toHaveBeenCalled();
  });
});

function buildInternalTicket(overrides: Partial<InternalTicket> = {}): InternalTicket {
  return {
    ticketId: '00000000-0000-4000-8000-000000000071',
    ticketType: 'oshal-dev',
    title: 'Issue 71',
    description: 'Body 71',
    status: 'backlog',
    stateGroup: 'backlog',
    executionPhase: null,
    priority: 'medium',
    labels: [],
    workspaceId: null,
    assignedAgentId: null,
    parentTicketId: null,
    externalProvider: 'github',
    externalId: 'emeraldcoastsystemsgroup/oshal#71',
    externalUrl: null,
    metadata: {},
    ownerSub: null,
    createdAt: '2026-07-20T03:00:00.000Z',
    updatedAt: '2026-07-20T03:00:00.000Z',
    ...overrides,
  };
}

function buildStatefulTicketService(initial: InternalTicket): {
  service: TicketService;
  current: () => InternalTicket;
  updateTicket: ReturnType<typeof vi.fn>;
  updateStatus: ReturnType<typeof vi.fn>;
} {
  let ticket = initial;
  const updateTicket = vi.fn(async (_ticketId: string, updates: Partial<InternalTicket>) => {
    ticket = { ...ticket, ...updates };
  });
  const updateStatus = vi.fn(async (_ticketId: string, status: InternalTicket['status']) => {
    ticket = { ...ticket, status };
  });
  const service = {
    getTicketByExternalId: vi.fn(async () => ticket),
    createTicket: vi.fn(async () => ticket),
    updateTicket,
    updateStatus,
  } as unknown as TicketService;
  return { service, current: () => ticket, updateTicket, updateStatus };
}
