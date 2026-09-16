/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the reporting surface for BACKLOG "One slow boot drops the task, message and memory stores to in-memory for the life of the process": a store serving from memory must be visible where an operator looks, and the activation must share one in-flight attempt, drop a failed one, and respect its cooldown.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | The pool double records its listeners, so the subscription to the KEPT pool's idle-client errors is asserted rather than assumed - an unhandled pg Pool 'error' is an uncaught exception, and keeping the pool is what put this module in its path.
 */
/**
 * What this file guards, and what it does NOT.
 *
 * The DEFECTIVE BOUNDARY - a store losing its real connection at boot and never recovering -
 * is proven against a disposable `postgres:16-alpine` in
 * `tests/unit/store-persistence-recovery.spec.ts`. That file is the closure evidence for the
 * database seam; nothing here substitutes for it.
 *
 * These cases guard the two things that file cannot show: the arithmetic of the shared
 * activation (one in-flight attempt for concurrent callers, a failed attempt dropped, a
 * cooldown that stops a down database costing a connect timeout per call), and the reporting
 * surface an operator actually reads - the persistence-mode registry and the /api/readiness
 * `persistence` leg. The activation's `activate` callback and its pool are therefore local
 * doubles on purpose: the variable under test is the retry and reporting logic around them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  createPersistenceActivation,
  persistenceRetryCooldownMs,
} from '@/shared/services/database';
import {
  degradedCatalogs,
  degradedPersistence,
  listCatalogLoads,
  listPersistenceModes,
  recordCatalogLoad,
  recordPersistenceMode,
  resetCatalogLoads,
  resetPersistenceModes,
} from '@/shared/observability';
import { buildReadinessReport, type ReadinessDeps } from '@/app/routes/readiness-routes';

/**
 * The activation passes the pool to `activate` and subscribes to its 'error' event; nothing here
 * touches a database. Recording the listeners is what lets the last case assert the subscription.
 */
function fakePool(): { pool: Pool; listeners: Map<string, Array<(error: unknown) => void>> } {
  const listeners = new Map<string, Array<(error: unknown) => void>>();
  const pool = {
    on(event: string, handler: (error: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return pool;
    },
  } as unknown as Pool;
  return { pool, listeners };
}

/** A ReadinessDeps whose every other leg is deliberately green, so `persistence` is the variable. */
function greenDeps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    activeProvider: () => 'claude-code',
    forcedProvider: () => null,
    noAiDeclared: () => false,
    criticalBots: () => [],
    onlineAgentIds: async () => [],
    credentialPresent: () => true,
    defaultHarness: () => 'claude-code',
    voiceStatus: async () => null,
    dbOk: async () => true,
    catalogLoads: listCatalogLoads,
    degradedCatalogLoads: degradedCatalogs,
    persistenceModes: listPersistenceModes,
    degradedPersistenceModes: degradedPersistence,
    ...overrides,
  };
}

function seedHealthyCatalog(): void {
  recordCatalogLoad({
    catalog: 'connector-specs', source: '/app/swarm-apps/connectors',
    state: 'ok', discovered: 12, loaded: 12, attempts: 1,
  });
}

beforeEach(() => {
  resetPersistenceModes();
  resetCatalogLoads();
  seedHealthyCatalog();
  delete process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS;
});

describe('persistence activation', () => {
  it('shares ONE in-flight attempt across concurrent callers instead of stampeding the pool', async () => {
    let started = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const activation = createPersistenceActivation({
      store: 'concurrent-store', pool: fakePool().pool, retryCooldownMs: 0,
      activate: async () => { started += 1; await gate; },
    });
    const callers = [activation.ready(), activation.ready(), activation.ready()];
    release();
    expect(await Promise.all(callers)).toEqual([true, true, true]);
    // Four bootstraps holding four clients out of one pool is how the observed boot lost its
    // acquire in the first place. The memo is assigned before the first await, so one runs.
    expect(started).toBe(1);
  });

  it('drops a FAILED attempt so the next caller retries, and records the store as memory meanwhile', async () => {
    let attempts = 0;
    const activation = createPersistenceActivation({
      store: 'retrying-store', pool: fakePool().pool, retryCooldownMs: 0,
      activate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Connection terminated due to connection timeout');
      },
    });

    expect(await activation.ready()).toBe(false);
    expect(activation.persistent()).toBe(false);
    const degraded = degradedPersistence().find(r => r.store === 'retrying-store');
    expect(degraded?.mode).toBe('memory');
    expect(degraded?.detail).toContain('connection timeout');
    expect(degraded?.attempts).toBe(1);

    expect(await activation.ready()).toBe(true);
    expect(attempts).toBe(2);
    expect(degradedPersistence().map(r => r.store)).not.toContain('retrying-store');
    expect(listPersistenceModes().find(r => r.store === 'retrying-store')?.mode).toBe('persistent');
  });

  it('holds off a retry for the cooldown, so a down database costs one connect attempt per window', async () => {
    let attempts = 0;
    const activation = createPersistenceActivation({
      store: 'cooling-store', pool: fakePool().pool, retryCooldownMs: 60_000,
      activate: async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
    });
    expect(await activation.ready()).toBe(false);
    expect(await activation.ready()).toBe(false);
    expect(await activation.ready()).toBe(false);
    expect(attempts).toBe(1);
  });

  it('subscribes to the kept pool so one idle-client error cannot take the process down', () => {
    // `pg` emits 'error' on the Pool when an idle client's connection dies. Ending the pool used
    // to make that unreachable for a degraded store; keeping it is what makes a retry possible,
    // so this module has to own the event or EventEmitter rethrows it as an uncaught exception.
    const { pool, listeners } = fakePool();
    createPersistenceActivation({ store: 'kept-pool-store', pool, activate: async () => undefined });
    const handlers = listeners.get('error') ?? [];
    expect(handlers).toHaveLength(1);
    expect(() => handlers[0]?.(new Error('Connection terminated unexpectedly'))).not.toThrow();
  });

  it('never retries, and is never degraded, when no Postgres is configured for the store', async () => {
    let attempts = 0;
    const activation = createPersistenceActivation({
      store: 'databaseless-store', pool: null,
      activate: async () => { attempts += 1; },
    });
    expect(await activation.ready()).toBe(false);
    expect(attempts).toBe(0);
    expect(listPersistenceModes().find(r => r.store === 'databaseless-store')?.mode).toBe('unconfigured');
    expect(degradedPersistence()).toEqual([]);
  });

  it('resolves the cooldown from its environment variable, and falls back on a bad value', () => {
    process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS = '5000';
    expect(persistenceRetryCooldownMs()).toBe(5000);
    process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS = 'soon';
    expect(persistenceRetryCooldownMs()).toBe(30_000);
    process.env.OSHAL_PERSISTENCE_RETRY_COOLDOWN_MS = '-1';
    expect(persistenceRetryCooldownMs()).toBe(30_000);
  });
});

describe('readiness persistence leg', () => {
  it('FAILS the box while a store with Postgres configured is serving from memory, and names it', async () => {
    recordPersistenceMode({ store: 'task-store', mode: 'persistent', attempts: 1 });
    recordPersistenceMode({
      store: 'memory-layer', mode: 'memory', attempts: 2,
      detail: 'Connection terminated due to connection timeout',
    });

    const report = await buildReadinessReport(greenDeps());

    expect(report.ready).toBe(false);
    expect(report.summary).toContain('persistence=fail');
    expect(report.legs.persistence.detail).toContain('memory-layer');
    expect(report.legs.persistence.detail).toContain('MEMORY');
    expect(report.legs.persistence.detail).toContain('2 attempt(s)');
    expect(report.problems.join(' ')).toContain('Connection terminated due to connection timeout');
  });

  it('passes once every configured store is persistent', async () => {
    recordPersistenceMode({ store: 'task-store', mode: 'persistent', attempts: 1 });
    recordPersistenceMode({ store: 'message-store', mode: 'persistent', attempts: 2 });

    const report = await buildReadinessReport(greenDeps());

    expect(report.ready).toBe(true);
    expect(report.summary).toContain('persistence=ok');
    expect(report.legs.persistence.detail).toBe('2/2 store(s) persistent (postgres)');
  });

  it('a database-less box is OFF, not a failure', async () => {
    recordPersistenceMode({ store: 'task-store', mode: 'unconfigured', attempts: 0 });
    recordPersistenceMode({ store: 'message-store', mode: 'unconfigured', attempts: 0 });

    const report = await buildReadinessReport(greenDeps());

    expect(report.ready).toBe(true);
    expect(report.legs.persistence.state).toBe('off');
    expect(report.legs.persistence.detail).toContain('no Postgres configured');
  });

  it('reports OFF, not OK, before any store has declared a mode', async () => {
    const report = await buildReadinessReport(greenDeps());
    expect(report.legs.persistence.state).toBe('off');
    expect(report.legs.persistence.detail).toContain('no fallback-capable store');
    expect(report.ready).toBe(true);
  });
});
