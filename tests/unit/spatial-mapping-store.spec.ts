/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 guard — owner-scoping: every data query the SpatialScanStore issues is pinned to WHERE user_sub=$1 with the caller's sub bound, so cross-user rows are impossible by construction (the ADR-036 store contract + the belt beneath the spatial_scans RLS). Uses a fake pool that captures every query; guards against a regression that drops the user_sub predicate and leaks another user's scans.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { SpatialScanStore } from '@/features/spatial-mapping';

interface Captured { sql: string; params: unknown[]; }

/** A fake pg Pool that records every query and returns a canned row. */
function fakePool(): { pool: Pool; calls: Captured[] } {
  const calls: Captured[] = [];
  const row = {
    id: 's1', user_sub: 'user-a', title: 'Room', status: 'queued', source_kind: 'video',
    source_name: 'r.mp4', source_ref: '/x/r.mp4', source_bytes: 10, provider: null,
    artifact_ref: null, gaussian_count: null, error: null,
    created_at: new Date('2026-07-19T00:00:00Z'), updated_at: new Date('2026-07-19T00:00:00Z'),
  };
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [row] };
    },
    // schema bootstrap (apply mode) runs its DDL through a locked client, not pool.query,
    // so the owner-scoping assertions below see only the data queries.
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => { /* noop */ } }),
  } as unknown as Pool;
  return { pool, calls };
}

/** Data queries = everything except the idempotent schema DDL bootstrap. */
const isSchemaDdl = (sql: string): boolean =>
  /CREATE TABLE|CREATE INDEX|ALTER TABLE|CREATE POLICY|pg_policy|DO \$\$/i.test(sql);

describe('SpatialScanStore owner-scoping', () => {
  it('pins every data query to user_sub and binds the caller sub', async () => {
    const { pool, calls } = fakePool();
    const store = new SpatialScanStore(pool);
    const sub = 'user-a';

    await store.insert({ id: 's1', userSub: sub, title: 'Room', sourceKind: 'video', sourceName: 'r.mp4', sourceRef: '/x/r.mp4', sourceBytes: 10 });
    await store.listByUser(sub);
    await store.getById(sub, 's1');
    await store.markReconstructing(sub, 's1');
    await store.markReady(sub, 's1', { provider: 'sim', artifactRef: '/x/scene.splat', gaussianCount: 5000 });
    await store.markFailed(sub, 's1', 'boom');
    await store.countByUser(sub);
    await store.listStaleNonTerminal(sub, '2026-01-01T00:00:00Z');
    await store.delete(sub, 's1');

    const dataQueries = calls.filter((c) => !isSchemaDdl(c.sql));
    expect(dataQueries.length).toBeGreaterThanOrEqual(6);
    for (const q of dataQueries) {
      expect(q.sql).toMatch(/user_sub/);
      expect(q.params).toContain(sub); // the caller sub is always bound
    }
  });

  it('scopes single-scan reads to WHERE user_sub=$1 AND id=$2', async () => {
    const { pool, calls } = fakePool();
    const store = new SpatialScanStore(pool);
    await store.getById('user-a', 's1');
    const get = calls.find((c) => /SELECT/i.test(c.sql) && /WHERE user_sub=\$1 AND id=\$2/.test(c.sql));
    expect(get).toBeTruthy();
    expect(get?.params).toEqual(['user-a', 's1']);
  });

  it('scopes mutations to the owner (never a bare id UPDATE)', async () => {
    const { pool, calls } = fakePool();
    const store = new SpatialScanStore(pool);
    await store.markReady('user-a', 's1', { provider: 'sim', artifactRef: '/x/scene.splat', gaussianCount: 42 });
    const updates = calls.filter((c) => /UPDATE spatial_scans/i.test(c.sql));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.sql).toMatch(/WHERE user_sub=\$1 AND id=\$2/);
    }
  });
});

describe('SpatialScanStore schema bootstrap (hardened posture)', () => {
  const prev = process.env.OSHAL_SCHEMA_BOOTSTRAP;
  afterEach(() => {
    if (prev === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    else process.env.OSHAL_SCHEMA_BOOTSTRAP = prev;
  });

  it('validates (never emits raw CREATE/ALTER DDL) under OSHAL_SCHEMA_BOOTSTRAP=validate-only', async () => {
    process.env.OSHAL_SCHEMA_BOOTSTRAP = 'validate-only';
    const ddl: string[] = [];
    // Fake pool that MODELS the runtime DDL guard: any CREATE/ALTER/DROP throws (as the guarded
    // pool would in validate-only), while the existence-check queries answer "present".
    const pool = {
      query: async (sql: string) => {
        if (/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)) { ddl.push(sql); throw new Error('DDL is disabled by OSHAL_SCHEMA_BOOTSTRAP=validate-only'); }
        if (/to_regclass/i.test(sql)) return { rows: [{ exists: true }] };
        if (/information_schema\.columns/i.test(sql)) return { rows: [{ column_name: 'x' }] };
        return { rows: [] };
      },
    } as unknown as Pool;

    const store = new SpatialScanStore(pool);
    // Must NOT throw: it should validate the migration-093 table/columns, not run guard-rejected DDL.
    await expect(store.ensureSchema()).resolves.toBeUndefined();
    expect(ddl).toEqual([]); // zero DDL statements attempted
  });
});
