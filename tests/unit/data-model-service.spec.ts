/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Data-model explorer service guards: a snapshot built from ports over a real temp source tree; the TTL cache (hit, expiry, forced refresh) and one shared in-flight build for concurrent callers; a failing time-series port that degrades instead of failing the snapshot; store cards for missing, failing and healthy ports; Redis key-family masking that keeps emails, ids and long numbers out of family labels.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CORE_OWNER, createDataModelService, keyFamily, maskSegment, tallyFamilies, type CatalogSnapshot, type DataModelPorts } from '@/features/data-model';

let root: string;
const catalog: CatalogSnapshot = {
  database: 'oshal',
  tables: [{ name: 'tickets', kind: 'table', comment: null, rls: false, forced: false, policies: [], columns: [], primaryKey: [], foreignKeys: [], uniques: [], hypertable: null, materialized: false, source: 'catalog' }],
  views: [],
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'data-model-svc-'));
  mkdirSync(join(root, 'scripts', 'migrations'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'migrations', '001.sql'), 'CREATE TABLE tickets (id uuid PRIMARY KEY);');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ports = (extra: Partial<DataModelPorts> = {}): DataModelPorts => ({
  repoRoot: root,
  readPlatformCatalog: vi.fn(async () => catalog),
  listApps: vi.fn(async () => []),
  ...extra,
});

describe('createDataModelService', () => {
  it('builds a snapshot with core ownership from the real source tree', async () => {
    const snap = await createDataModelService(ports()).snapshot();
    expect(snap.database).toBe('oshal');
    expect(snap.tables[0]).toMatchObject({ name: 'tickets', owners: [CORE_OWNER], definers: { [CORE_OWNER]: ['scripts/migrations/001.sql'] } });
    expect(snap.apps.map((a) => a.name)).toEqual([CORE_OWNER]);
  });

  it('serves from cache inside the TTL, rebuilds after it and on refresh', async () => {
    let now = 1_000;
    const p = ports();
    const svc = createDataModelService(p, { ttlMs: 100, now: () => now });
    await svc.snapshot(); await svc.snapshot();
    expect(p.readPlatformCatalog).toHaveBeenCalledTimes(1);
    now += 101; await svc.snapshot();
    expect(p.readPlatformCatalog).toHaveBeenCalledTimes(2);
    await svc.snapshot(true);
    expect(p.readPlatformCatalog).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight build between concurrent callers', async () => {
    const p = ports();
    const svc = createDataModelService(p);
    const [a, b] = await Promise.all([svc.snapshot(), svc.snapshot()]);
    expect(a).toBe(b);
    expect(p.readPlatformCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps the snapshot when the time-series port fails', async () => {
    const snap = await createDataModelService(ports({ readTimeseriesCatalog: async () => { throw new Error('tsdb down'); } })).snapshot();
    expect(snap.tables.map((t) => t.name)).toEqual(['tickets']);
  });

  it('fails the snapshot when the platform catalog cannot be read', async () => {
    await expect(createDataModelService(ports({ readPlatformCatalog: async () => { throw new Error('db down'); } })).snapshot()).rejects.toThrow('db down');
  });

  it('reports each store as not configured, unreachable or ok', async () => {
    const stores = await createDataModelService(ports({
      vectorInventory: async () => { throw new Error('refused'); },
      cacheInventory: async () => ({ store: 'cache', engine: 'Redis', status: 'ok', detail: '3 keys', families: [] }),
    })).stores();
    expect(stores.map((s) => `${s.store}:${s.status}`)).toEqual(['graph:not-configured', 'vector:unreachable', 'cache:ok']);
    expect(stores[1].detail).toContain('refused');
  });
});

describe('Redis key families', () => {
  it('masks segments that could identify a person or a record', () => {
    expect(maskSegment('someone@example.com')).toBe('*');
    expect(maskSegment('3f2a9c1e-77aa-4bbb-9ccc-0123456789ab')).toBe('*');
    expect(maskSegment('user12345')).toBe('*');
    expect(maskSegment('runtime-agent')).toBe('runtime-agent');
  });

  it('groups keys by their first two segments with masking applied', () => {
    expect(keyFamily('oshal:runtime-agent:abc')).toBe('oshal:runtime-agent');
    expect(keyFamily('user:someone@example.com:prefs')).toBe('user:*');
    expect(keyFamily('rl:192.168.50.7')).toBe('rl:*');
    const families = tallyFamilies(['a:b:1', 'a:b:2', 'a:c:1', 'solo'], 1);
    expect(families.map((f) => `${f.prefix}=${f.keys}/${f.sample.length}`)).toEqual(['a:b=2/1', 'a:c=1/1', 'solo=1/1']);
  });
});
