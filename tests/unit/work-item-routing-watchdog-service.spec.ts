import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkItemRoutingWatchdogService } from '../../src/features/swarm-orchestration/services/work-item-routing-watchdog-service';

interface FakeWorkItem {
  workItemId: string;
  externalId: string;
  provider: string;
  unitId: string;
  title: string;
  status: string;
  assignedAgentId?: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

class FakeWorkItemRepository {
  readonly items: FakeWorkItem[] = [];

  add(item: Partial<FakeWorkItem> & { externalId: string; status: string }): void {
    const oldIso = new Date(Date.now() - 10 * 60_000).toISOString();
    this.items.push({
      workItemId: item.workItemId ?? `wi-${this.items.length + 1}`,
      externalId: item.externalId,
      provider: item.provider ?? 'direct',
      unitId: item.unitId ?? `unit-${this.items.length + 1}`,
      title: item.title ?? 'Work item',
      status: item.status,
      assignedAgentId: item.assignedAgentId,
      createdAt: item.createdAt ?? oldIso,
      updatedAt: item.updatedAt ?? oldIso,
      metadata: item.metadata ?? {},
    });
  }

  async listRecent(): Promise<FakeWorkItem[]> {
    return this.items;
  }

  async updateStatus(workItemId: string, status: string, assignedAgentId?: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.workItemId === workItemId);
    if (!item) return;
    item.status = status;
    item.assignedAgentId = assignedAgentId;
  }

  async updateMetadata(workItemId: string, metadata: Record<string, unknown>): Promise<void> {
    const item = this.items.find((candidate) => candidate.workItemId === workItemId);
    if (!item) return;
    item.metadata = { ...item.metadata, ...metadata };
  }
}

describe('WorkItemRoutingWatchdogService ticket write-back', () => {
  const originalMaxRetries = process.env.OSHAL_MAX_ROUTING_RETRIES;
  const ticketId = '22222222-2222-4222-8222-222222222222';

  afterEach(() => {
    if (originalMaxRetries === undefined) {
      delete process.env.OSHAL_MAX_ROUTING_RETRIES;
    } else {
      process.env.OSHAL_MAX_ROUTING_RETRIES = originalMaxRetries;
    }
  });

  it('re-approves the owning ticket when routing_failed work is retried', async () => {
    process.env.OSHAL_MAX_ROUTING_RETRIES = '2';
    const repo = new FakeWorkItemRepository();
    const updateTicketStatus = vi.fn(async () => {});
    repo.add({ externalId: ticketId, status: 'routing_failed', assignedAgentId: 'agent-code' });

    const watchdog = new WorkItemRoutingWatchdogService(repo as never, 1, updateTicketStatus);

    await expect(watchdog.retryRoutingFailedItems()).resolves.toBe(1);

    expect(repo.items[0]?.status).toBe('pending');
    expect(repo.items[0]?.metadata).toEqual(expect.objectContaining({ routingRetryCount: 1 }));
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'approved',
      expect.objectContaining({
        reason: 'routing_failed_retry',
        source: 'work-item-routing-watchdog',
        workItemId: 'wi-1',
        retryCount: 1,
        maxRetries: 2,
      }),
    );
  });

  it('suppresses routing retry when the owning ticket is already terminal', async () => {
    process.env.OSHAL_MAX_ROUTING_RETRIES = '2';
    const repo = new FakeWorkItemRepository();
    const updateTicketStatus = vi.fn(async () => {});
    const readTicketStatus = vi.fn(async () => 'complete' as const);
    repo.add({ externalId: ticketId, status: 'routing_failed', assignedAgentId: 'agent-code' });

    const watchdog = new WorkItemRoutingWatchdogService(repo as never, 1, updateTicketStatus, readTicketStatus);

    await expect(watchdog.retryRoutingFailedItems()).resolves.toBe(0);

    expect(repo.items[0]?.status).toBe('routing_failed');
    expect(repo.items[0]?.metadata).toEqual(expect.objectContaining({
      routingRetrySuppressed: true,
      routingRetrySuppressedReason: 'terminal_ticket_status',
      routingRetrySuppressedTicketStatus: 'complete',
    }));
    expect(readTicketStatus).toHaveBeenCalledWith(ticketId);
    expect(updateTicketStatus).not.toHaveBeenCalled();
  });

  it('escalates the owning ticket when routing retries are exhausted', async () => {
    process.env.OSHAL_MAX_ROUTING_RETRIES = '2';
    const repo = new FakeWorkItemRepository();
    const updateTicketStatus = vi.fn(async () => {});
    repo.add({
      externalId: ticketId,
      status: 'routing_failed',
      metadata: { routingRetryCount: 2 },
    });

    const watchdog = new WorkItemRoutingWatchdogService(repo as never, 1, updateTicketStatus);

    await expect(watchdog.retryRoutingFailedItems()).resolves.toBe(0);

    expect(repo.items[0]?.metadata).toEqual(expect.objectContaining({ routingRetryExhausted: true }));
    expect(updateTicketStatus).toHaveBeenCalledWith(
      ticketId,
      'escalated',
      expect.objectContaining({
        reason: 'routing_failed_max_retries_exhausted',
        source: 'work-item-routing-watchdog',
        workItemId: 'wi-1',
        retryCount: 2,
        maxRetries: 2,
      }),
    );
  });
});
