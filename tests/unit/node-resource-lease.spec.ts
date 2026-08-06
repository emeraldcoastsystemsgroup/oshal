/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard canonical node keys, bounded inputs, atomic-acquire result mapping, and exact-token renew/release calls; the companion Playwright spec proves the real PostgreSQL/RLS boundary.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Pin the migration's expired-only atomic takeover, FORCE RLS, exact-capability mutation predicates, and all-or-none durable pump binding while live PostgreSQL is an independent environment gate.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireNodeResourceLease,
  releaseNodeResourceLease,
  renewNodeResourceLease,
  vidsNodeResourceKey,
} from '@/app/node-resource-lease';

const now = new Date('2026-08-06T08:00:00.000Z');
const migration = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrations', '120-shared-node-resource-leases.sql'), 'utf8');
const leaseRow = (over: Record<string, unknown> = {}) => ({
  acquired: true,
  resource_key: 'vids-render-node:node-a',
  lease_id: '11111111-2222-4333-8444-555555555555',
  holder: 'daily-recap:2026-08-06:run-a',
  purpose: 'daily-recap-build-publish',
  acquired_at: now,
  heartbeat_at: now,
  expires_at: new Date(now.getTime() + 60_000),
  metadata: { requestedDate: '2026-08-06' },
  ...over,
});

/** @description Build a query-observable pool for branch-contract tests. */
function poolWith(rows: unknown[]): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows }));
  return { pool: { query } as unknown as Pool, query };
}

describe('durable node-resource lease service', () => {
  it('keeps acquisition atomic and every mutation bound to the exact capability', () => {
    expect(migration).toMatch(/ON CONFLICT \(resource_key\) DO UPDATE[\s\S]+WHERE current_lease\.expires_at <= NOW\(\)/);
    expect(migration).toContain('ALTER TABLE oshal_node_resource_leases FORCE ROW LEVEL SECURITY');
    expect(migration).toMatch(/lease\.lease_id = p_lease_id[\s\S]+lease\.holder = p_holder/g);
    expect(migration).toMatch(/node_resource_key IS NULL[\s\S]+node_lease_holder IS NULL[\s\S]+OR[\s\S]+node_lease_id IS NOT NULL/);
  });

  it('derives one shared render-node namespace and rejects empty identities', () => {
    expect(vidsNodeResourceKey(' node-a ')).toBe('vids-render-node:node-a');
    expect(() => vidsNodeResourceKey('')).toThrow(/client id/i);
  });

  it('maps an atomic acquisition and returns the incumbent on contention', async () => {
    const won = poolWith([leaseRow()]);
    const acquired = await acquireNodeResourceLease(won.pool, {
      resourceKey: vidsNodeResourceKey('node-a'),
      holder: 'daily-recap:2026-08-06:run-a',
      purpose: 'daily-recap-build-publish',
      ttlMs: 60_000,
      metadata: { requestedDate: '2026-08-06' },
    });
    expect(acquired).toMatchObject({
      acquired: true,
      lease: { resourceKey: 'vids-render-node:node-a', holder: 'daily-recap:2026-08-06:run-a' },
    });
    expect(String(won.query.mock.calls[0][0])).toContain('oshal_acquire_node_resource_lease');

    const lost = poolWith([leaseRow({ acquired: false, holder: 'joke-pump:show-a' })]);
    await expect(acquireNodeResourceLease(lost.pool, {
      resourceKey: vidsNodeResourceKey('node-a'),
      holder: 'daily-recap:2026-08-06:run-b',
      purpose: 'daily-recap-build-publish',
      ttlMs: 60_000,
    })).resolves.toMatchObject({ acquired: false, lease: { holder: 'joke-pump:show-a' } });
  });

  it('renews and releases only through the exact token-bound database functions', async () => {
    const renewedPool = poolWith([leaseRow({ heartbeat_at: new Date(now.getTime() + 10_000) })]);
    const capability = {
      resourceKey: 'vids-render-node:node-a',
      leaseId: '11111111-2222-4333-8444-555555555555',
      holder: 'daily-recap:2026-08-06:run-a',
    };
    await expect(renewNodeResourceLease(renewedPool.pool, capability, 60_000))
      .resolves.toMatchObject({ leaseId: capability.leaseId });
    expect(renewedPool.query.mock.calls[0][1]).toEqual([
      capability.resourceKey, capability.leaseId, capability.holder, 60,
    ]);

    const releasedPool = poolWith([{ released: true }]);
    await expect(releaseNodeResourceLease(releasedPool.pool, capability)).resolves.toBe(true);
    expect(releasedPool.query.mock.calls[0][1]).toEqual([
      capability.resourceKey, capability.leaseId, capability.holder,
    ]);
  });

  it('rejects unsafe TTLs and labels before touching PostgreSQL', async () => {
    const untouched = poolWith([]);
    await expect(acquireNodeResourceLease(untouched.pool, {
      resourceKey: 'vids-render-node:node-a',
      holder: 'pump',
      purpose: 'render',
      ttlMs: 1,
    })).rejects.toThrow(/between 30 seconds and 12 hours/i);
    await expect(acquireNodeResourceLease(untouched.pool, {
      resourceKey: 'vids-render-node:node-a',
      holder: 'pump\nspoof',
      purpose: 'render',
      ttlMs: 60_000,
    })).rejects.toThrow(/holder is invalid/i);
    expect(untouched.query).not.toHaveBeenCalled();
  });
});
