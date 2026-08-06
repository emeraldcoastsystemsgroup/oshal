/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard hashed one-use Apply capability
 *   issuance, exact identity binding, generation replacement, reservation, replay settlement,
 *   callback header parsing, and the FORCE-RLS migration contract.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeApplyCapability,
  issueApplyCapability,
  readApplyCapabilityHeader,
  releaseApplyCapability,
  reserveApplyCapability,
  revokeApplyCapability,
  type ApplyCapabilityBinding,
} from '@/app/apply-task-capability';

const binding: ApplyCapabilityBinding = {
  taskId: 'apply-11111111-2222-4333-8444-555555555555',
  userSub: ' Tenant|Exact Subject ',
  ticketId: 'ticket-1',
  settleTicket: true,
  postingId: 42,
  clientId: 'desktop-1',
  targetHost: 'Jobs.Example.COM',
};

function issuingPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('MAX(generation)')) return { rows: [{ generation: '3' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, release };
}

describe('Apply task capability issuance', () => {
  it('stores only a digest after revoking the previous ticket generation', async () => {
    const { pool, query, release } = issuingPool();
    const issued = await issueApplyCapability(pool, binding);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.generation).toBe(3);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls.indexOf('BEGIN')).toBeLessThan(calls.findIndex((sql) => sql.includes('state=\'revoked\'')));
    expect(calls.findIndex((sql) => sql.includes('state=\'revoked\''))).toBeLessThan(calls.findIndex((sql) => sql.includes('INSERT INTO apply_task_capabilities')));
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO apply_task_capabilities'))!;
    const params = insert[1] as unknown[];
    expect(params).toContain(binding.userSub);
    expect(params).toContain('jobs.example.com');
    expect(params).not.toContain(issued.token);
    expect(params.some((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects malformed bindings before opening a transaction', async () => {
    const { pool } = issuingPool();
    await expect(issueApplyCapability(pool, { ...binding, userSub: '   ' })).rejects.toThrow(/owner/i);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('Apply task capability consumption', () => {
  it('reserves a live exact row and never queries for malformed tokens', async () => {
    const row = {
      task_id: binding.taskId, token_hash: 'a'.repeat(64), owner_sub: binding.userSub,
      ticket_id: binding.ticketId, settle_ticket: true, posting_id: '42', client_id: binding.clientId,
      target_host: 'jobs.example.com', generation: '3', expires_at: new Date('2026-08-05T22:00:00.000Z'),
    };
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const pool = { query } as unknown as Pool;
    expect(await reserveApplyCapability(pool, 'bad token')).toBeNull();
    expect(query).not.toHaveBeenCalled();

    const claim = await reserveApplyCapability(pool, 'A'.repeat(43));
    expect(claim).toMatchObject({ ...binding, targetHost: 'jobs.example.com', generation: 3 });
    expect(String(query.mock.calls[0][0])).toContain("state='active'");
    expect(query.mock.calls[0][1]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it('consumes once, releases retryable work, and revokes failed dispatches by exact task', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const pool = { query } as unknown as Pool;
    const claim = {
      ...binding, targetHost: 'jobs.example.com', tokenHash: 'b'.repeat(64), generation: 4,
      expiresAt: '2026-08-05T22:00:00.000Z',
    };
    expect(await consumeApplyCapability(pool, claim)).toBe(true);
    await releaseApplyCapability(pool, claim);
    await revokeApplyCapability(pool, binding.taskId);
    expect(String(query.mock.calls[0][0])).toContain("state='consumed'");
    expect(String(query.mock.calls[1][0])).toContain("state='active'");
    expect(query.mock.calls[2][1]).toEqual([binding.taskId]);
  });

  it('accepts only the exact raw callback capability header shape', () => {
    const token = 'z'.repeat(43);
    expect(readApplyCapabilityHeader(token)).toBe(token);
    expect(readApplyCapabilityHeader(`Bearer ${token}`)).toBeNull();
    expect(readApplyCapabilityHeader(`${token}=`)).toBeNull();
  });
});

describe('Apply task capability migration', () => {
  const migration = readFileSync(resolve('scripts/migrations/116-apply-task-capabilities.sql'), 'utf8');

  it('binds every security dimension, stores only a hash, and forces owner RLS', () => {
    for (const column of ['task_id', 'token_hash', 'owner_sub', 'ticket_id', 'settle_ticket', 'posting_id', 'client_id', 'target_host', 'generation', 'expires_at']) {
      expect(migration).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(migration).not.toMatch(/\btoken\s+TEXT\b/i);
    expect(migration).toMatch(/UNIQUE INDEX[\s\S]*WHERE state IN \('active', 'processing'\)/i);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/owner_sub = current_setting\('oshal\.current_sub'/i);
  });
});
