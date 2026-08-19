/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard that a failed persistence probe closes its pool before the in-memory fallback engages, so retry loops cannot leak managed-database connections.
 */
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const databaseMocks = vi.hoisted(() => ({
  createOptionalPostgresPool: vi.fn(),
  ensureConversationStoreSchema: vi.fn(),
}));

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/shared/services/database', () => databaseMocks);
vi.mock('@/shared/logger', () => ({ createChildLogger: () => loggerMocks }));

import { InMemoryMessageStore } from '../../src/entities/message/services/in-memory-message-store';
import { InMemoryTaskStore } from '../../src/entities/task/services/in-memory-task-store';
import { MemoryLayerService } from '../../src/features/memory/services/memory-layer-service';

interface StoreCase {
  name: string;
  create: () => object;
  exerciseFallback: (store: object) => Promise<unknown>;
  fallbackResult: unknown;
}

const storeCases: StoreCase[] = [
  {
    name: 'task store',
    create: () => new InMemoryTaskStore(),
    exerciseFallback: (store) => (store as InMemoryTaskStore).get('missing-task'),
    fallbackResult: null,
  },
  {
    name: 'message store',
    create: () => new InMemoryMessageStore(),
    exerciseFallback: (store) => (store as InMemoryMessageStore).getByTask('missing-task'),
    fallbackResult: [],
  },
  {
    name: 'memory layer',
    create: () => new MemoryLayerService({} as never, {} as never),
    exerciseFallback: (store) => (store as MemoryLayerService).listKnowledgeDocuments(),
    fallbackResult: [],
  },
];

describe('persistence initialization pool cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(storeCases)('$name closes its failed pool before completing memory fallback', async ({
    create,
    exerciseFallback,
    fallbackResult,
  }) => {
    const events: string[] = [];
    const end = vi.fn(async () => {
      events.push('end');
    });
    databaseMocks.createOptionalPostgresPool.mockReturnValue({ end } as unknown as Pool);
    databaseMocks.ensureConversationStoreSchema.mockImplementation(async () => {
      events.push('schema');
      throw new Error('schema unavailable');
    });

    const store = create();

    await expect(exerciseFallback(store)).resolves.toEqual(fallbackResult);
    expect(events).toEqual(['schema', 'end']);
    expect(end).toHaveBeenCalledOnce();
    expect((store as { pool?: unknown }).pool).toBeNull();
  });

  it.each(storeCases)('$name preserves memory fallback when closing the failed pool also rejects', async ({
    create,
    exerciseFallback,
    fallbackResult,
  }) => {
    const cleanupError = new Error('pool cleanup failed');
    const end = vi.fn().mockRejectedValue(cleanupError);
    databaseMocks.createOptionalPostgresPool.mockReturnValue({ end } as unknown as Pool);
    databaseMocks.ensureConversationStoreSchema.mockRejectedValue(new Error('schema unavailable'));

    const store = create();

    await expect(exerciseFallback(store)).resolves.toEqual(fallbackResult);
    expect(end).toHaveBeenCalledOnce();
    expect((store as { pool?: unknown }).pool).toBeNull();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      { err: cleanupError },
      expect.stringContaining('Failed to close'),
    );
  });
});
