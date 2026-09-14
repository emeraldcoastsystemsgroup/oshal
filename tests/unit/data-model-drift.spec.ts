/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Schema-drift guard: the structure-only digest carries owners, RLS state, policy NAMES and key columns and carries NO value, default or policy expression; dropping a policy on a settled baseline raises exactly one named change; an identical schema is silent; a first run has no baseline and never raises; a reading that crossed a migration is explained; a baseline inside the quiet window is still settling; a partial catalog read and an uncomparable digest are REFUSED rather than reported as a dropped schema; the store degrades by name when migration 139 is absent; and service.drift() only advances the baseline on an explicit capture.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildDigest, createDriftStore, diffDigests, DIGEST_TABLE, DIGEST_VERSION,
  QUIET_WINDOW_MS, SCHEMA_DIGEST_INVALID, SCHEMA_DIGEST_PARTIAL,
  createDataModelService, buildSnapshot,
  type DataModelPorts, type DataModelSnapshot, type ModelRelation, type RelationInfo, type SchemaDigest,
} from '@/features/data-model';

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const NOW = Date.parse(T1) + 60 * 60_000;

/** @description One placed relation, with only the fields the digest reads set explicitly. */
function relation(over: Partial<ModelRelation> & { name: string }): ModelRelation {
  return {
    name: over.name, kind: 'table', comment: null, rls: true, forced: true,
    policies: [{ name: 'tickets_owner', command: 'ALL', using: 'owner_sub = current_setting(\'oshal.user_sub\')', check: null }],
    columns: [{ name: 'id', type: 'uuid', nullable: false, default: 'gen_random_uuid()', comment: null },
      { name: 'secret_note', type: 'text', nullable: true, default: '\'the quick brown fox\'', comment: null }],
    primaryKey: ['id'], foreignKeys: [], uniques: [], hypertable: null, materialized: false, source: 'catalog',
    database: 'oshal', owners: ['@core'], definers: {}, access: { state: 'forced', scopes: ['owner'], ownerColumns: ['owner_sub'] },
    ...over,
  } as ModelRelation;
}

/** @description A snapshot holding the given relations. */
function snapshot(tables: ModelRelation[], generatedAt = T1, unowned: string[] = []): DataModelSnapshot {
  return { generatedAt, database: 'oshal', tables, views: [], apps: [], integrations: [], unowned, declaredAbsent: [], sqlite: [] };
}

/** @description A digest of the given relations, stamped at `at` with `migrations` applied. */
function digestOf(tables: ModelRelation[], at = T0, migrations: number | null = 138): SchemaDigest {
  return buildDigest(snapshot(tables, at), migrations);
}

describe('schema digest: structure only, never data', () => {
  it('carries owners, RLS state, policy NAMES and key columns', () => {
    const d = digestOf([relation({ name: 'tickets', foreignKeys: [{ name: 'fk', columns: ['agent_id'], refTable: 'agents', refColumns: ['id'] }] })]);
    expect(d.relations).toHaveLength(1);
    expect(d.relations[0]).toMatchObject({
      relation: 'oshal.tickets', kind: 'table', owners: ['@core'], rls: 'forced',
      policies: ['tickets_owner'], keyColumns: ['agent_id', 'id'], foreignKeys: ['agent_id->agents'],
    });
    expect(d.digestVersion).toBe(DIGEST_VERSION);
    expect(d.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries no column defaults, no non-key columns and no policy expressions', () => {
    const serialized = JSON.stringify(digestOf([relation({ name: 'tickets' })]));
    expect(serialized).not.toContain('the quick brown fox');
    expect(serialized).not.toContain('gen_random_uuid');
    expect(serialized).not.toContain('current_setting');
    expect(serialized).not.toContain('secret_note');
  });

  it('is stable under relation order, so a catalog that lists differently is not a change', () => {
    const a = relation({ name: 'agents' });
    const b = relation({ name: 'tickets' });
    expect(buildDigest(snapshot([a, b])).fingerprint).toBe(buildDigest(snapshot([b, a])).fingerprint);
  });
});

describe('drift detection', () => {
  it('names exactly one change when a policy is dropped on a settled baseline, and raises', () => {
    const before = digestOf([relation({ name: 'scratch_notes' })]);
    const after = buildDigest(snapshot([relation({ name: 'scratch_notes', policies: [] })]), 138);
    const report = diffDigests(before, after, { nowMs: NOW });

    expect(report.state).toBe('drift');
    expect(report.alarm).toBe(true);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toEqual({ kind: 'policies-changed', relation: 'oshal.scratch_notes', before: 'tickets_owner', after: 'none' });
    expect(report.from).toBe(T0);
  });

  it('names RLS turning off, a relation appearing and a relation disappearing', () => {
    const before = digestOf([relation({ name: 'keep' }), relation({ name: 'goes_away' })]);
    const after = buildDigest(snapshot([
      relation({ name: 'keep', access: { state: 'off', scopes: [], ownerColumns: [] } }),
      relation({ name: 'arrived' }), relation({ name: 'filler_a' }), relation({ name: 'filler_b' }),
    ]), 138);
    const kinds = diffDigests(before, after, { nowMs: NOW }).changes.map((c) => `${c.kind}:${c.relation}`);
    expect(kinds).toContain('rls-changed:oshal.keep');
    expect(kinds).toContain('relation-added:oshal.arrived');
    expect(kinds).toContain('relation-removed:oshal.goes_away');
  });
});

describe('the quiet half: what must NOT raise', () => {
  it('an unchanged schema produces no alert and no changes', () => {
    const before = digestOf([relation({ name: 'tickets' })]);
    const after = buildDigest(snapshot([relation({ name: 'tickets' })]), 138);
    const report = diffDigests(before, after, { nowMs: NOW });
    expect(report.state).toBe('unchanged');
    expect(report.alarm).toBe(false);
    expect(report.changes).toEqual([]);
  });

  it('a first run has no baseline, never raises, and says so', () => {
    const report = diffDigests(null, digestOf([relation({ name: 'tickets' })], T1), { nowMs: NOW });
    expect(report.state).toBe('first-run');
    expect(report.alarm).toBe(false);
    expect(report.from).toBeNull();
    expect(report.reason).toMatch(/baseline/i);
  });

  it('a change that crossed a migration is EXPLAINED, not an alarm', () => {
    const before = digestOf([relation({ name: 'tickets' })], T0, 138);
    const after = buildDigest(snapshot([relation({ name: 'tickets' }), relation({ name: 'brand_new' })]), 139);
    const report = diffDigests(before, after, { nowMs: NOW });
    expect(report.state).toBe('explained');
    expect(report.alarm).toBe(false);
    expect(report.reason).toContain('138');
    expect(report.reason).toContain('139');
    expect(report.changes.map((c) => c.relation)).toEqual(['oshal.brand_new']);
  });

  it('a baseline inside the quiet window is still SETTLING, so a mid-deploy reading cannot raise', () => {
    const before = digestOf([relation({ name: 'tickets' })], T1, 138);
    const after = buildDigest(snapshot([relation({ name: 'tickets', policies: [] })]), 138);
    const report = diffDigests(before, after, { nowMs: Date.parse(T1) + QUIET_WINDOW_MS - 60_000 });
    expect(report.state).toBe('settling');
    expect(report.alarm).toBe(false);
    expect(report.changes).toHaveLength(1);
  });
});

describe('refusals: a bad reading must never look like a schema change', () => {
  it('refuses a partial catalog read instead of reporting every table as removed', () => {
    const before = digestOf(['a', 'b', 'c', 'd'].map((n) => relation({ name: n })));
    const after = buildDigest(snapshot([relation({ name: 'a' })]), 138);
    expect(() => diffDigests(before, after, { nowMs: NOW })).toThrow(/failed catalog read/i);
    try { diffDigests(before, after, { nowMs: NOW }); } catch (err) { expect((err as { code: string }).code).toBe(SCHEMA_DIGEST_PARTIAL); }
  });

  it('refuses a snapshot missing tables[] or database', () => {
    expect(() => buildDigest({ generatedAt: T1, database: 'oshal', views: [] } as never)).toThrow(/tables/);
    try { buildDigest(null as never); } catch (err) { expect((err as { code: string }).code).toBe(SCHEMA_DIGEST_INVALID); }
  });

  it('refuses a stored baseline written by another digest version', () => {
    const before = { ...digestOf([relation({ name: 'tickets' })]), digestVersion: 99 };
    const after = buildDigest(snapshot([relation({ name: 'tickets', policies: [] })]), 138);
    expect(() => diffDigests(before, after, { nowMs: NOW })).toThrow(/version 99/);
  });

  it('refuses a baseline with no fingerprint', () => {
    const before = { ...digestOf([relation({ name: 'tickets' })]), fingerprint: '' };
    const after = buildDigest(snapshot([relation({ name: 'tickets', policies: [] })]), 138);
    expect(() => diffDigests(before, after, { nowMs: NOW })).toThrow(/fingerprint/);
  });
});

/** @description A queryable that records statements and can be made to fail like PostgreSQL. */
function fakeDb(behaviour: { rows?: unknown[]; fail?: string } = {}) {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string, params?: unknown[]) => {
      sql.push(text.replace(/\s+/g, ' ').trim());
      if (behaviour.fail) throw Object.assign(new Error('relation does not exist'), { code: behaviour.fail });
      void params;
      return { rows: behaviour.rows ?? [] };
    },
  };
}

describe('the digest store', () => {
  it('reads back the latest digest for a database', async () => {
    const stored = digestOf([relation({ name: 'tickets' })]);
    const db = fakeDb({ rows: [{ captured_at: T0, digest: stored }] });
    const store = createDriftStore(db);
    expect(await store.latest('oshal')).toEqual(stored);
    expect(store.unavailableReason()).toBeNull();
    expect(db.sql[0]).toContain(DIGEST_TABLE);
  });

  it('degrades by name when migration 139 has not been applied', async () => {
    const store = createDriftStore(fakeDb({ fail: '42P01' }));
    expect(await store.latest('oshal')).toBeNull();
    expect(store.unavailableReason()).toContain('migration 139');
  });

  it('re-throws any failure that is NOT a missing table', async () => {
    const store = createDriftStore(fakeDb({ fail: '42501' }));
    await expect(store.latest('oshal')).rejects.toThrow();
    expect(store.unavailableReason()).toBeNull();
  });

  it('ignores a stored row whose digest has no relations[] rather than making it a baseline', async () => {
    const store = createDriftStore(fakeDb({ rows: [{ captured_at: T0, digest: { digestVersion: 1 } }] }));
    expect(await store.latest('oshal')).toBeNull();
  });
});

/**
 * @description A catalog relation carrying the policies and keys the digest reads. RLS stays
 * FORCED whatever the policy list is, because that is what dropping a policy actually looks like
 * in the catalog: the table is still protected, it just no longer grants anyone anything.
 */
function catalogRelation(name: string, policies: string[]): RelationInfo {
  return {
    name, kind: 'table', comment: null, rls: true, forced: true,
    policies: policies.map((p) => ({ name: p, command: 'ALL', using: 'owner_sub = current_setting(oshal.user_sub)', check: null })),
    columns: [{ name: 'id', type: 'uuid', nullable: false, default: null, comment: null }],
    primaryKey: ['id'], foreignKeys: [], uniques: [], hypertable: null, materialized: false, source: 'catalog',
  };
}

/**
 * @description Ports over a REAL buildSnapshot: a real (empty) scan root and a real catalog fold,
 * with the digest history held in an array the fake queryable reads and appends to.
 */
function driftPorts(relations: RelationInfo[], history: SchemaDigest[], migrations: number | null = 138): DataModelPorts {
  return {
    repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-drift-scan-')),
    readPlatformCatalog: async () => ({ database: 'oshal', tables: relations, views: [] }),
    listApps: async () => [],
    migrationCount: async () => migrations,
    digestQueryable: async () => ({
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('INSERT')) { history.push(JSON.parse(String((params ?? [])[6])) as SchemaDigest); return { rows: [] }; }
        const last = history[history.length - 1];
        return { rows: last ? [{ captured_at: last.capturedAt, digest: last }] : [] };
      },
    }),
  };
}

/** @description A baseline digest built through the same real pipeline the service uses. */
async function baselineFor(relations: RelationInfo[], at: string, migrations: number | null = 138): Promise<SchemaDigest> {
  const snap = await buildSnapshot(driftPorts(relations, []));
  return buildDigest({ ...snap, generatedAt: at }, migrations);
}

describe('service.drift: reading never acknowledges, capturing does', () => {
  it('a read reports the drift and leaves the baseline where it was', async () => {
    const history = [await baselineFor([catalogRelation('scratch_notes', ['scratch_owner'])], T0)];
    const service = createDataModelService(driftPorts([catalogRelation('scratch_notes', [])], history), { now: () => NOW });
    const outcome = await service.drift();

    expect(outcome.available).toBe(true);
    expect(outcome.report?.state).toBe('drift');
    expect(outcome.report?.alarm).toBe(true);
    expect(outcome.report?.changes).toHaveLength(1);
    expect(outcome.report?.changes[0]).toMatchObject({ kind: 'policies-changed', relation: 'oshal.scratch_notes', before: 'scratch_owner' });
    expect(outcome.captured).toBe(false);
    expect(history).toHaveLength(1);
  });

  it('an explicit capture records the new digest as the baseline', async () => {
    const history = [await baselineFor([catalogRelation('scratch_notes', ['scratch_owner'])], T0)];
    const service = createDataModelService(driftPorts([catalogRelation('scratch_notes', [])], history), { now: () => NOW });
    const outcome = await service.drift({ capture: true });

    expect(outcome.captured).toBe(true);
    expect(history).toHaveLength(2);
    expect(history[1].relations[0].policies).toEqual([]);
  });

  it('an unchanged schema stays quiet end to end', async () => {
    const relations = [catalogRelation('scratch_notes', ['scratch_owner'])];
    const history = [await baselineFor(relations, T0)];
    const service = createDataModelService(driftPorts(relations, history), { now: () => NOW });
    const outcome = await service.drift();

    expect(outcome.report?.state).toBe('unchanged');
    expect(outcome.report?.alarm).toBe(false);
    expect(outcome.report?.changes).toEqual([]);
  });

  it('a first run has no baseline and never raises', async () => {
    const service = createDataModelService(driftPorts([catalogRelation('scratch_notes', ['scratch_owner'])], []), { now: () => NOW });
    const outcome = await service.drift();
    expect(outcome.report?.state).toBe('first-run');
    expect(outcome.report?.alarm).toBe(false);
  });

  it('answers unavailable, not a failure, when the digest table is absent', async () => {
    const ports = driftPorts([catalogRelation('scratch_notes', ['scratch_owner'])], []);
    const service = createDataModelService({
      ...ports,
      digestQueryable: async () => ({ query: async () => { throw Object.assign(new Error('nope'), { code: '42P01' }); } }),
    }, { now: () => NOW });
    const outcome = await service.drift();

    expect(outcome.available).toBe(false);
    expect(outcome.unavailableReason).toContain('migration 139');
    expect(outcome.report).toBeNull();
  });
});
