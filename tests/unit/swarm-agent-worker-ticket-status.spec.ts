import { describe, expect, it, vi } from 'vitest';
import type { MeshEnvelope } from '../../src/features/agent-management';
import { SwarmAgentWorker } from '../../src/features/swarm-orchestration/services/swarm-agent-worker';

interface FakeWorkItem {
  workItemId: string;
  externalId: string;
  provider: string;
  status: string;
  executionOutput: unknown;
}

class FakeWorkItemRepository {
  readonly items: FakeWorkItem[] = [];

  add(item: Partial<FakeWorkItem> & { externalId: string }): void {
    this.items.push({
      workItemId: item.workItemId ?? `wi-${this.items.length + 1}`,
      externalId: item.externalId,
      provider: item.provider ?? 'direct',
      status: item.status ?? 'assigned',
      executionOutput: item.executionOutput ?? null,
    });
  }

  async findByExternalIdAnyProvider(externalId: string): Promise<FakeWorkItem[]> {
    return this.items.filter((item) => item.externalId === externalId);
  }

  async setExecutionOutput(workItemId: string, output: unknown): Promise<void> {
    const item = this.items.find((candidate) => candidate.workItemId === workItemId);
    if (item) item.executionOutput = output;
  }

  async updateStatus(workItemId: string, status: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.workItemId === workItemId);
    if (item) item.status = status;
  }
}

class FakeTransport {
  readonly ackedEntryIds: string[] = [];
  consumeQueue: Array<{ entryId: string; envelope: MeshEnvelope }> = [];

  async publish(): Promise<void> {}

  async consume(): Promise<Array<{ entryId: string; envelope: MeshEnvelope }>> {
    const batch = [...this.consumeQueue];
    this.consumeQueue = [];
    return batch;
  }

  async ack(_channel: string, entryId: string): Promise<void> {
    this.ackedEntryIds.push(entryId);
  }

  async claimOrphaned(): Promise<Array<{ entryId: string; envelope: MeshEnvelope }>> {
    return [];
  }
}

describe('SwarmAgentWorker ticket terminal bridge', () => {
  const ticketId = '11111111-1111-4111-8111-111111111111';

  it('marks a UUID ticket complete when the worker stores a clean completed work item', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const updateTicketStatus = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'assigned' });
    transport.consumeQueue.push({ entryId: 'entry-1', envelope: buildEnvelope(ticketId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      updateTicketStatus,
      handler: async () => ({ success: true, output: { content: 'done' } }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(repo.items[0]?.status).toBe('completed');
    expect(transport.ackedEntryIds).toContain('entry-1');
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'complete',
      expect.objectContaining({
        source: 'swarm-agent-worker',
        workItemId: 'wi-1',
        terminalStatus: 'completed',
      }),
    );
  });

  it('completes (does not escalate) a successful ticket whose answer merely mentions throttle/auth keywords', async () => {
    // Regression: broad throttle/auth keyword patterns must not scan successful
    // answer content. An RCA answer that explains a 429/quota/401 is a correct result,
    // not a provider failure, and must terminate as complete.
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const updateTicketStatus = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'assigned' });
    transport.consumeQueue.push({ entryId: 'entry-rca', envelope: buildEnvelope(ticketId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      updateTicketStatus,
      handler: async () => ({
        success: true,
        output: {
          content:
            'Root cause: the API returned HTTP 429 because the request rate exceeded the account quota; '
            + 'the 401 Unauthorized earlier was a stale OAuth token. The rate-limit / throttling has since cleared.',
        },
      }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(repo.items[0]?.status).toBe('completed');
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'complete',
      expect.objectContaining({ terminalStatus: 'completed' }),
    );
  });

  it('records the visible ticket assignment when a worker accepts an envelope', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const recordTicketAssignment = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'pending' });
    transport.consumeQueue.push({
      entryId: 'entry-assignment',
      envelope: buildEnvelope(ticketId, { phase: 4, round: 1 }),
    });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      recordTicketAssignment,
      handler: async () => ({ success: true, output: { content: 'assigned and done' } }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(recordTicketAssignment).toHaveBeenCalledWith(
      ticketId,
      'agent-code-developer',
      expect.objectContaining({
        source: 'swarm-agent-worker',
        workItemId: 'wi-1',
        correlationId: `correlation:${ticketId}`,
        phase: 4,
        round: 1,
      }),
    );
  });

  it('records internal worker activity around execution', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const recordTicketActivity = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'pending' });
    transport.consumeQueue.push({ entryId: 'entry-activity', envelope: buildEnvelope(ticketId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      recordTicketActivity,
      handler: async () => ({ success: true, output: { content: 'activity tracked' } }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(recordTicketActivity).toHaveBeenCalledWith(
      ticketId,
      expect.objectContaining({
        source: 'swarm-agent-worker',
        event: 'execution_started',
        internalComment: true,
        correlationId: `correlation:${ticketId}`,
        agentId: 'agent-code-developer',
      }),
    );
    expect(recordTicketActivity).toHaveBeenCalledWith(
      ticketId,
      expect.objectContaining({
        source: 'swarm-agent-worker',
        event: 'execution_finished',
        resultSuccess: true,
      }),
    );
  });

  it('escalates a UUID ticket when the provider wrapper reports a CLI stall as text', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const updateTicketStatus = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'assigned' });
    transport.consumeQueue.push({ entryId: 'entry-2', envelope: buildEnvelope(ticketId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      updateTicketStatus,
      handler: async () => ({
        success: true,
        output: { content: 'Claude Code CLI encountered an error: Claude CLI stalled - no output for 180s.' },
      }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(repo.items[0]?.status).toBe('completed');
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'escalated',
      expect.objectContaining({
        reason: 'swarm_worker_execution_failed',
        message: expect.stringContaining('Claude Code CLI encountered an error'),
        failureClass: 'provider_runtime_stall',
        providerRuntime: 'claude-code-cli',
        nextAction: expect.stringContaining('fallback provider'),
      }),
    );
  });

  it('repairs a stuck UUID ticket when orphan dedup finds an already-completed work item', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const updateTicketStatus = vi.fn(async () => {});
    const handler = vi.fn(async () => ({ success: true, output: { content: 'should not run' } }));
    repo.add({ externalId: ticketId, status: 'completed', executionOutput: { content: 'already done' } });
    transport.consumeQueue.push({ entryId: 'entry-dedup', envelope: buildEnvelope(ticketId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      updateTicketStatus,
      handler,
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(handler).not.toHaveBeenCalled();
    expect(transport.ackedEntryIds).toContain('entry-dedup');
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'complete',
      expect.objectContaining({
        source: 'swarm-agent-worker',
        workItemId: 'wi-1',
        terminalStatus: 'completed',
      }),
    );
  });

  it('lets a routing_failed work item recover on retry and escalates the ticket on failed execution', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const updateTicketStatus = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'routing_failed', executionOutput: { stale: true } });
    transport.consumeQueue.push({ entryId: 'entry-routing-retry', envelope: buildEnvelope(ticketId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      updateTicketStatus,
      handler: async () => ({ success: false, error: 'retry still failed' }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(repo.items[0]?.status).toBe('failed');
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'escalated',
      expect.objectContaining({
        reason: 'swarm_worker_execution_failed',
        message: 'retry still failed',
      }),
    );
  });

  it('does not run UUID-only ticket checks for synthetic review external ids', async () => {
    const repo = new FakeWorkItemRepository();
    const transport = new FakeTransport();
    const isTicketTerminal = vi.fn(async () => false);
    const reviewExternalId = `review:${ticketId}:r2`;
    repo.add({ externalId: reviewExternalId, status: 'assigned' });
    transport.consumeQueue.push({ entryId: 'entry-3', envelope: buildEnvelope(reviewExternalId) });

    const worker = new SwarmAgentWorker({
      transport: transport as never,
      workItemRepository: repo as never,
      pollIntervalMs: 10,
      isTicketTerminal,
      handler: async () => ({ success: true, output: { content: 'reviewed' } }),
    });

    await worker.start();
    await delay(50);
    worker.stop();

    expect(isTicketTerminal).not.toHaveBeenCalled();
    expect(transport.ackedEntryIds).toContain('entry-3');
  });
});

function buildEnvelope(externalId: string, payload: Record<string, unknown> = {}): MeshEnvelope {
  return {
    correlationId: `correlation:${externalId}`,
    fromAgentId: 'swarm-controller',
    toAgentId: 'agent-code-developer',
    channel: 'agent.agent-code-developer',
    payload: { externalId, ...payload },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
