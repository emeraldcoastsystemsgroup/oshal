/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-111 Phase 1 review-fix guards — the SpatialMappingService lifecycle + quota: a non-terminal scan orphaned by a restart self-heals to 'failed' on read (never stuck forever), a fresh in-flight scan is left alone, and the per-user scan cap gates uploads. Runs in validate-only schema-bootstrap mode so the store validates (no connect()) against the fake pool.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { SpatialMappingService } from '@/features/spatial-mapping';

const HOURS_3 = 3 * 60 * 60 * 1000;

function row(status: string, stale: boolean): Record<string, unknown> {
  const updated = stale ? new Date(Date.now() - HOURS_3) : new Date();
  return {
    id: 's1', user_sub: 'user-a', title: 'Room', status, source_kind: 'video',
    source_name: 'r.mp4', source_ref: '/x/r.mp4', source_bytes: 10, provider: null,
    artifact_ref: null, gaussian_count: null, error: null,
    created_at: new Date('2026-07-19T00:00:00Z'), updated_at: updated,
  };
}

/** A fake pool routed by SQL; validate-only means the store never calls connect(). */
function servicePool(opts: { status: string; stale: boolean; count?: number }): Pool {
  let status = opts.status;
  return {
    query: async (sql: string) => {
      if (/to_regclass/i.test(sql)) return { rows: [{ exists: true }] };
      if (/information_schema\.columns/i.test(sql)) return { rows: [{ column_name: 'x' }] };
      if (/UPDATE spatial_scans SET status='failed'/i.test(sql)) { status = 'failed'; return { rows: [], rowCount: 1 }; }
      if (/DELETE FROM spatial_scans/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/SELECT count\(\*\)/i.test(sql)) return { rows: [{ n: String(opts.count ?? 0) }] };
      if (/SELECT .*FROM spatial_scans WHERE user_sub=\$1 AND id=\$2/is.test(sql)) return { rows: [row(status, opts.stale)] };
      return { rows: [] };
    },
  } as unknown as Pool;
}

describe('SpatialMappingService lifecycle + quota', () => {
  const prev = process.env.OSHAL_SCHEMA_BOOTSTRAP;
  beforeEach(() => { process.env.OSHAL_SCHEMA_BOOTSTRAP = 'validate-only'; });
  afterEach(() => {
    if (prev === undefined) delete process.env.OSHAL_SCHEMA_BOOTSTRAP;
    else process.env.OSHAL_SCHEMA_BOOTSTRAP = prev;
  });

  it('self-heals an orphaned non-terminal scan to failed on read', async () => {
    const svc = new SpatialMappingService(servicePool({ status: 'reconstructing', stale: true }));
    const scan = await svc.getScan('user-a', 's1');
    expect(scan?.status).toBe('failed');
  });

  it('leaves a fresh in-flight scan untouched', async () => {
    const svc = new SpatialMappingService(servicePool({ status: 'reconstructing', stale: false }));
    const scan = await svc.getScan('user-a', 's1');
    expect(scan?.status).toBe('reconstructing');
  });

  it('enforces the per-user scan quota', async () => {
    const atCap = new SpatialMappingService(servicePool({ status: 'ready', stale: false, count: 100 }));
    const under = new SpatialMappingService(servicePool({ status: 'ready', stale: false, count: 5 }));
    expect(await atCap.canAcceptScan('user-a')).toBe(false);
    expect(await under.canAcceptScan('user-a')).toBe(true);
  });

  it('deletes an owned scan (row + dir)', async () => {
    const svc = new SpatialMappingService(servicePool({ status: 'ready', stale: false }));
    expect(await svc.deleteScan('user-a', 's1')).toBe(true);
  });
});
