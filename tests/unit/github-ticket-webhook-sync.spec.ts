/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added GitHub issue webhook sync contract tests for idempotent backlog intake, lifecycle mirroring, and safe event filtering
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guarded first-seen projections against historical and non-opened issue events
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Covered external closure of an untriaged backlog projection
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Proved open-shal issue intake uses the shared core queue with open-shal work and oshal release routing
 */

import { describe, expect, it, vi } from 'vitest';
import { createGitHubTicketWebhookSync } from '@/app/routes/github-ticket-webhook-sync';
import {
  resolveGitHubTicketFeeds,
  type GitHubTicketFeedConfig,
} from '@/features/intake/providers';

const CORE_FEED: GitHubTicketFeedConfig = {
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
};

interface ExistingTicket {
  ticketId: string;
  status: string;
  metadata: Record<string, unknown>;
}

function buildTicketService(existing: ExistingTicket | null = null) {
  return {
    getTicketByExternalId: vi.fn(async (_provider: string, _externalId: string) => existing),
    createTicket: vi.fn(async (_input: unknown) => ({ ticketId: 'ticket-new', status: 'backlog' })),
    updateTicket: vi.fn(async (_ticketId: string, _updates: unknown) => undefined),
    updateStatus: vi.fn(async (_ticketId: string, _status: string, _metadata?: unknown) => undefined),
  };
}

function issuePayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    action,
    repository: { full_name: CORE_FEED.issueRepository },
    issue: {
      number: 42,
      title: 'Make the cockpit mobile friendly',
      body: 'The header overflows on narrow screens.',
      html_url: 'https://github.com/emeraldcoastsystemsgroup/oshal/issues/42',
      state: action === 'closed' ? 'closed' : 'open',
      labels: [{ name: 'ux' }, { name: 'mobile' }],
      created_at: '2026-07-20T02:30:00.000Z',
      updated_at: '2026-07-20T02:30:00.000Z',
      user: { login: 'requester' },
      ...overrides,
    },
    sender: { login: 'requester' },
  };
}

describe('GitHub ticket webhook sync', () => {
  it('creates a configured repository issue in backlog with queue and repository routing metadata', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('opened'));

    expect(result).toEqual(expect.objectContaining({ action: 'created', ticketId: 'ticket-new' }));
    expect(ticketService.getTicketByExternalId).toHaveBeenCalledWith(
      'github',
      'emeraldcoastsystemsgroup/oshal#42',
    );
    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Make the cockpit mobile friendly',
      description: 'The header overflows on narrow screens.',
      ticketType: 'oshal-dev',
      status: 'backlog',
      labels: ['ux', 'mobile'],
      externalProvider: 'github',
      externalId: 'emeraldcoastsystemsgroup/oshal#42',
      externalUrl: 'https://github.com/emeraldcoastsystemsgroup/oshal/issues/42',
      metadata: expect.objectContaining({
        queueId: 'github-core-requests',
        queueName: 'GitHub Core Requests',
        githubTicket: expect.objectContaining({
          id: 'core',
          issueRepository: 'emeraldcoastsystemsgroup/oshal',
          workRepository: 'emeraldcoastsystemsgroup/open-shal',
          releaseRepository: 'emeraldcoastsystemsgroup/oshal',
          requestMode: 'request-only',
          closePolicy: 'release-proof',
        }),
      }),
    }));
  });

  it('routes open-shal issue 1 through the core queue to open-shal work and oshal release', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({
      ticketService,
      feeds: resolveGitHubTicketFeeds({}),
    });
    const payload = issuePayload('opened', {
      number: 1,
      title: 'Public core request',
      body: 'Route this request through the active work repository.',
      html_url: 'https://github.com/emeraldcoastsystemsgroup/open-shal/issues/1',
    });
    payload.repository.full_name = 'emeraldcoastsystemsgroup/open-shal';

    const result = await sync.handle('issues', payload);

    expect(result).toEqual(expect.objectContaining({ action: 'created', ticketId: 'ticket-new' }));
    expect(ticketService.getTicketByExternalId).toHaveBeenCalledWith(
      'github',
      'emeraldcoastsystemsgroup/open-shal#1',
    );
    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Public core request',
      ticketType: 'oshal-dev',
      status: 'backlog',
      externalProvider: 'github',
      externalId: 'emeraldcoastsystemsgroup/open-shal#1',
      externalUrl: 'https://github.com/emeraldcoastsystemsgroup/open-shal/issues/1',
      metadata: expect.objectContaining({
        queueId: 'github-core-requests',
        queueName: 'GitHub Core Requests',
        githubTicket: expect.objectContaining({
          id: 'core-work',
          issueRepository: 'emeraldcoastsystemsgroup/open-shal',
          workRepository: 'emeraldcoastsystemsgroup/open-shal',
          releaseRepository: 'emeraldcoastsystemsgroup/oshal',
          requestMode: 'request-only',
          closePolicy: 'release-proof',
        }),
        githubIssue: expect.objectContaining({
          repository: 'emeraldcoastsystemsgroup/open-shal',
          number: 1,
        }),
      }),
    }));
  });

  it('updates an existing ticket for a duplicate edited event instead of creating another ticket', async () => {
    const ticketService = buildTicketService({
      ticketId: 'ticket-existing',
      status: 'backlog',
      metadata: { preserved: true },
    });
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('edited', {
      title: 'Updated mobile request',
      body: 'Updated issue details.',
    }));

    expect(result).toEqual(expect.objectContaining({ action: 'updated', ticketId: 'ticket-existing' }));
    expect(ticketService.createTicket).not.toHaveBeenCalled();
    expect(ticketService.updateTicket).toHaveBeenCalledWith(
      'ticket-existing',
      expect.objectContaining({
        title: 'Updated mobile request',
        description: 'Updated issue details.',
        labels: ['ux', 'mobile'],
      }),
    );
  });

  it('ignores an out-of-order event older than the persisted GitHub projection', async () => {
    const ticketService = buildTicketService({
      ticketId: 'ticket-current',
      status: 'approved',
      metadata: { githubIssue: { updatedAt: '2026-07-20T03:00:00.000Z' } },
    });
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('closed', {
      updated_at: '2026-07-20T02:30:00.000Z',
    }));

    expect(result).toEqual({ action: 'ignored', reason: 'stale-event' });
    expect(ticketService.updateTicket).not.toHaveBeenCalled();
    expect(ticketService.updateStatus).not.toHaveBeenCalled();
  });

  it('does not import an issue created before the configured activation boundary', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('opened', {
      created_at: '2026-07-20T01:59:59.000Z',
    }));

    expect(result).toEqual({ action: 'ignored', reason: 'pre-cutover-issue' });
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('does not create a projection from a first-seen closed event', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('closed'));

    expect(result).toEqual({ action: 'ignored', reason: 'untracked-issue-action' });
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('enforces configured intake labels before creating a first projection', async () => {
    const ticketService = buildTicketService();
    const feed = { ...CORE_FEED, labels: ['request'] };
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [feed] });

    const result = await sync.handle('issues', issuePayload('opened'));

    expect(result).toEqual({ action: 'ignored', reason: 'missing-required-label' });
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('creates a post-cutover issue when a later labeled event first satisfies the feed filter', async () => {
    const ticketService = buildTicketService();
    const feed = { ...CORE_FEED, labels: ['request'] };
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [feed] });

    const result = await sync.handle('issues', issuePayload('labeled', {
      labels: [{ name: 'request' }],
    }));

    expect(result).toEqual(expect.objectContaining({ action: 'created' }));
    expect(ticketService.createTicket).toHaveBeenCalledTimes(1);
  });

  it('derives the same label-based priority used by pull reconciliation', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    await sync.handle('issues', issuePayload('opened', {
      labels: [{ name: 'request' }, { name: 'p1-high' }],
    }));

    expect(ticketService.createTicket).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'high',
      labels: ['request', 'p1-high'],
    }));
  });

  it('ignores issue events from repositories that are not configured', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });
    const payload = issuePayload('opened');
    payload.repository.full_name = 'emeraldcoastsystemsgroup/untrusted';

    const result = await sync.handle('issues', payload);

    expect(result).toEqual(expect.objectContaining({ action: 'ignored' }));
    expect(ticketService.getTicketByExternalId).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('ignores pull requests delivered through the GitHub issues event shape', async () => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('opened', {
      pull_request: { url: 'https://api.github.com/repos/emeraldcoastsystemsgroup/oshal/pulls/42' },
    }));

    expect(result).toEqual(expect.objectContaining({ action: 'ignored' }));
    expect(ticketService.getTicketByExternalId).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  it('maps a closed GitHub issue to complete when the internal transition is legal', async () => {
    const ticketService = buildTicketService({
      ticketId: 'ticket-approved',
      status: 'approved',
      metadata: {},
    });
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('closed'));

    expect(result).toEqual(expect.objectContaining({ action: 'updated', ticketId: 'ticket-approved' }));
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-approved',
      'complete',
      expect.objectContaining({ source: 'github-webhook' }),
    );
  });

  it('maps a not-planned GitHub closure to cancelled instead of complete', async () => {
    const ticketService = buildTicketService({
      ticketId: 'ticket-not-planned',
      status: 'approved',
      metadata: {},
    });
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    await sync.handle('issues', issuePayload('closed', { state_reason: 'not_planned' }));

    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-not-planned',
      'cancelled',
      expect.objectContaining({ source: 'github-webhook' }),
    );
  });

  it('cancels an untriaged backlog projection when the GitHub issue closes', async () => {
    const ticketService = buildTicketService({
      ticketId: 'ticket-backlog',
      status: 'backlog',
      metadata: {},
    });
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('closed'));

    expect(result).toEqual(expect.objectContaining({ action: 'updated', ticketId: 'ticket-backlog' }));
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-backlog',
      'cancelled',
      expect.objectContaining({ source: 'github-webhook' }),
    );
  });

  it('maps a reopened GitHub issue back to backlog', async () => {
    const ticketService = buildTicketService({
      ticketId: 'ticket-complete',
      status: 'complete',
      metadata: {},
    });
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    const result = await sync.handle('issues', issuePayload('reopened'));

    expect(result).toEqual(expect.objectContaining({ action: 'updated', ticketId: 'ticket-complete' }));
    expect(ticketService.updateStatus).toHaveBeenCalledWith(
      'ticket-complete',
      'backlog',
      expect.objectContaining({ source: 'github-webhook' }),
    );
  });

  it.each([
    ['an unrelated event', 'push', issuePayload('opened')],
    ['a null payload', 'issues', null],
    ['a missing repository', 'issues', { action: 'opened', issue: { number: 42 } }],
    ['a non-numeric issue number', 'issues', issuePayload('opened', { number: 'forty-two' })],
  ])('safely ignores %s', async (_case, eventName, payload) => {
    const ticketService = buildTicketService();
    const sync = createGitHubTicketWebhookSync({ ticketService, feeds: [CORE_FEED] });

    await expect(sync.handle(eventName, payload)).resolves.toEqual(
      expect.objectContaining({ action: 'ignored' }),
    );
    expect(ticketService.getTicketByExternalId).not.toHaveBeenCalled();
    expect(ticketService.createTicket).not.toHaveBeenCalled();
    expect(ticketService.updateTicket).not.toHaveBeenCalled();
    expect(ticketService.updateStatus).not.toHaveBeenCalled();
  });
});
