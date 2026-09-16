/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard that a failed persistence probe closes its pool before the in-memory fallback engages, so retry loops cannot leak managed-database connections.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Partial-mock the database barrel instead of replacing it with a two-key object. createPersistenceActivation arrived in the barrel and both in-memory stores call it, so every case here threw on construction and the file was red on main with nobody acting on it.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Assert the contract that EXISTS. createPersistenceActivation deliberately replaced SEQ 1's design: a failed probe now KEEPS its pool so the next operation can retry into persistence, and the bill for keeping it - pg emitting 'error' on an idle client it has already discarded, which with no listener is an uncaught exception - is paid by an explicit listener instead of by ending the pool. These cases now pin that: memory answers without the pool being ended, the listener exists and swallows an idle error, and the SAME pool carries the recovery. Renamed from ...-pool-cleanup, which would have read as a promise the code no longer makes.
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

// PARTIAL mock: a hoisted object that LISTS the barrel's exports goes red the moment the barrel
// grows one the spec never asked about - which is how six files were left red on main at once.
vi.mock('@/shared/services/database', async (importOriginal) => ({ ...await importOriginal<object>(), ...databaseMocks }));
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

describe('a failed persistence probe keeps its pool for the retry that follows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(storeCases)('$name answers from memory WITHOUT ending the pool, and owns its idle errors', async ({
    create,
    exerciseFallback,
    fallbackResult,
  }) => {
    const end = vi.fn(async () => {});
    const listeners: Array<(error: Error) => void> = [];
    const on = vi.fn((event: string, handler: (error: Error) => void) => { if (event === 'error') listeners.push(handler); });
    databaseMocks.createOptionalPostgresPool.mockReturnValue({ end, on } as unknown as Pool);
    databaseMocks.ensureConversationStoreSchema.mockRejectedValue(new Error('schema unavailable'));

    const store = create();

    // The degrade survives: the caller is answered from memory, never with the failure.
    await expect(exerciseFallback(store)).resolves.toEqual(fallbackResult);
    // And the pool is still open, because the next operation is allowed to recover persistence.
    expect(end, 'the pool must be KEPT after a failed probe - see createPersistenceActivation').not.toHaveBeenCalled();
    expect((store as { pool?: unknown }).pool).not.toBeNull();

    // Keeping it means owning pg's idle-client 'error', which is otherwise an uncaught exception.
    expect(listeners, 'a kept pool with no error listener takes the process down').toHaveLength(1);
    expect(() => listeners[0](new Error('idle client died'))).not.toThrow();
    expect(loggerMocks.error).toHaveBeenCalled();
  });

  it.each(storeCases)('$name recovers persistence on the SAME pool once the schema answers', async ({
    create,
    exerciseFallback,
    fallbackResult,
  }) => {
    // The cooldown exists so a dead database is not hammered; zero it so the retry is the thing
    // under test rather than the clock.
    vi.stubEnv('OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS', '0');
    const end = vi.fn(async () => {});
    // Once the retry succeeds the store is PERSISTENT and really queries this pool, so the
    // double carries that seam as well; an empty result is all these assertions need.
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool = { end, on: vi.fn(), query } as unknown as Pool;
    databaseMocks.createOptionalPostgresPool.mockReturnValue(pool);
    databaseMocks.ensureConversationStoreSchema
      .mockRejectedValueOnce(new Error('schema unavailable'))
      .mockResolvedValue(undefined);

    const store = create();
    await expect(exerciseFallback(store)).resolves.toEqual(fallbackResult);
    await exerciseFallback(store);

    // Both attempts ran against the pool the store kept - that is what keeping it was FOR.
    expect(databaseMocks.ensureConversationStoreSchema.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of databaseMocks.ensureConversationStoreSchema.mock.calls) expect(call[0]).toBe(pool);
    expect(end).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
