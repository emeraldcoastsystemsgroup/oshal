/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Proved provider reconciliation checkpoints only after every idempotent ticket upsert succeeds
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Proved atomic reconciliation checkpoints reject a slower concurrent cursor regression
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  type ExternalWorkItem,
} from '@/entities/ticket';
import { IntakeService } from '@/features/intake/services/intake-service';
import {
  InMemoryIntakeCursorStore,
  PostgresIntakeCursorStore,
  type WorkItemCursorStore,
} from '@/features/intake/services/intake-cursor-store';
import type { WorkItemFeedAdapter } from '@/features/intake/services/work-item-feed-adapter';

describe('IntakeService reconcile', () => {
  it('materializes every item before advancing the durable provider cursor', async () => {
    const events: string[] = [];
    const cursorStore = buildCursorStore(events);
    const adapter = buildAdapter(events);
    const service = new IntakeService([adapter], cursorStore);

    const result = await service.reconcile('github', { limit: 10 }, async (item) => {
      events.push(`materialize:${item.externalId}`);
      return `ticket:${item.externalId}`;
    });

    expect(result.materializedTicketIds).toEqual(['ticket:org/repo#1', 'ticket:org/repo#2']);
    expect(events).toEqual([
      'pull:none',
      'materialize:org/repo#1',
      'materialize:org/repo#2',
      'cursor:cursor-2',
    ]);
  });

  it('does not checkpoint a partial batch and safely retries from the stored cursor', async () => {
    const events: string[] = [];
    const cursorStore = buildCursorStore(events);
    const adapter = buildAdapter(events);
    const service = new IntakeService([adapter], cursorStore);
    let failSecond = true;
    const materialize = vi.fn(async (item: ExternalWorkItem) => {
      events.push(`materialize:${item.externalId}`);
      if (item.externalId.endsWith('#2') && failSecond) {
        throw new Error('ticket store unavailable');
      }
      return `ticket:${item.externalId}`;
    });

    await expect(service.reconcile('github', { limit: 10 }, materialize)).rejects.toThrow(
      'ticket store unavailable',
    );
    expect(cursorStore.compareAndSetCursor).not.toHaveBeenCalled();

    failSecond = false;
    const retried = await service.reconcile('github', { limit: 10 }, materialize);

    expect(retried.materializedTicketIds).toHaveLength(2);
    expect(adapter.pullWorkItems).toHaveBeenCalledTimes(2);
    expect(adapter.pullWorkItems).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: undefined,
    }));
    expect(cursorStore.compareAndSetCursor).toHaveBeenCalledWith('github', null, 'cursor-2');
  });

  it('does not let a slower concurrent reconciliation regress a newer cursor', async () => {
    const cursorStore = new InMemoryIntakeCursorStore();
    let pullCount = 0;
    const adapter: WorkItemFeedAdapter = {
      provider: 'github',
      pullWorkItems: vi.fn(async () => {
        pullCount += 1;
        return pullCount === 1
          ? { items: [buildItem(1)], nextCursor: 'cursor-older', source: 'github:test' }
          : { items: [buildItem(2)], nextCursor: 'cursor-newer', source: 'github:test' };
      }),
    };
    const service = new IntakeService([adapter], cursorStore);
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const slower = service.reconcile('github', { limit: 1 }, async () => {
      markFirstStarted();
      await firstBlocked;
      return 'ticket-older';
    });
    await firstStarted;

    const faster = await service.reconcile('github', { limit: 1 }, async () => 'ticket-newer');
    expect(faster.materializedTicketIds).toEqual(['ticket-newer']);
    expect(await cursorStore.getCursor('github')).toBe('cursor-newer');

    releaseFirst();
    await slower;

    expect(await cursorStore.getCursor('github')).toBe('cursor-newer');
  });

  it('uses a conditional Postgres upsert for cross-process cursor races', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ provider: 'github' }] });
    const store = new PostgresIntakeCursorStore({ query } as never);

    await expect(store.compareAndSetCursor('github', 'cursor-observed', 'cursor-stale'))
      .resolves.toBe(false);
    await expect(store.compareAndSetCursor('github', null, 'cursor-first'))
      .resolves.toBe(true);

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE oshal_intake_cursors.cursor_value = $3::text'),
      ['github', 'cursor-stale', 'cursor-observed'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['github', 'cursor-first', null],
    );
  });
});

function buildCursorStore(events: string[]): WorkItemCursorStore & {
  setCursor: ReturnType<typeof vi.fn>;
  compareAndSetCursor: ReturnType<typeof vi.fn>;
} {
  let currentCursor: string | null = null;
  return {
    getCursor: vi.fn(async () => currentCursor),
    setCursor: vi.fn(async (_provider, cursor) => {
      currentCursor = cursor;
      events.push(`cursor:${cursor}`);
    }),
    compareAndSetCursor: vi.fn(async (_provider, expectedCursor, cursor) => {
      if (currentCursor !== expectedCursor) return false;
      currentCursor = cursor;
      events.push(`cursor:${cursor}`);
      return true;
    }),
  };
}

function buildAdapter(events: string[]): WorkItemFeedAdapter & {
  pullWorkItems: ReturnType<typeof vi.fn>;
} {
  return {
    provider: 'github',
    pullWorkItems: vi.fn(async (input) => {
      events.push(`pull:${input.cursor ?? 'none'}`);
      return {
        items: [buildItem(1), buildItem(2)],
        nextCursor: 'cursor-2',
        source: 'github:test',
      };
    }),
  };
}

function buildItem(number: number): ExternalWorkItem {
  const externalId = `org/repo#${number}`;
  return {
    provider: 'github',
    externalId,
    title: `Issue ${number}`,
    body: '',
    labels: [],
    workflow: buildExternalTicketWorkflow('backlog'),
    hierarchy: buildExternalTicketHierarchy(externalId),
    rawPayload: {},
  };
}
