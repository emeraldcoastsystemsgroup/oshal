/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proved GitHub writeback remains comment-only and surfaces provider failures for retry
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubTicketWritebackAdapter } from '@/features/swarm-orchestration/providers/github-ticket-writeback-adapter';
import type { TicketWritebackUpdate } from '@/features/swarm-orchestration/services/ticket-writeback-adapter';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GitHubTicketWritebackAdapter', () => {
  it('posts a comment without issuing an issue-state close request', async () => {
    vi.stubEnv('GITHUB_TICKET_WRITEBACK_TOKEN', 'ticket-token');
    const fetchMock = vi.fn(async () => new Response('', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await new GitHubTicketWritebackAdapter().writeCycleUpdate(buildUpdate());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/emeraldcoastsystemsgroup/oshal/issues/42/comments');
    expect(request).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(request?.body))).toEqual(expect.objectContaining({
      body: expect.stringContaining('"releaseProof": false'),
    }));
  });

  it('throws a provider error so the bounded writeback retry policy can run', async () => {
    vi.stubEnv('GITHUB_TICKET_WRITEBACK_TOKEN', 'ticket-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('temporary failure', { status: 502 })));

    await expect(
      new GitHubTicketWritebackAdapter().writeCycleUpdate(buildUpdate()),
    ).rejects.toThrow('GitHub comment post failed (502)');
  });
});

function buildUpdate(): TicketWritebackUpdate {
  return {
    runId: 'run-1',
    provider: 'github',
    cycle: 'delivery',
    status: 'completed',
    item: {
      externalId: 'emeraldcoastsystemsgroup/oshal#42',
      title: 'Ticket provider request',
      priority: 'medium',
      status: 'open',
      workflow: {
        stateKey: 'backlog',
        stateGroup: 'backlog',
        stateLabel: 'Backlog',
        mode: 'ticket',
        isTerminal: false,
        requiresCustomerAction: false,
        requiresHumanReview: false,
      },
      hierarchy: {
        rootExternalId: 'emeraldcoastsystemsgroup/oshal#42',
        isSubticket: false,
        visibility: 'root_only',
        childExternalIds: [],
        childCount: 0,
      },
    },
    lifecycle: {
      currentCycle: 'delivery',
      completedCycles: [],
      failedCycles: [],
      history: [],
    },
    targetTicketState: 'complete',
    details: { deliveryStep: 'complete', releaseProof: false },
  } as TicketWritebackUpdate;
}
