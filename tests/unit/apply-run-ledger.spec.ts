/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard Apply V2 durable creation, exact metadata, active-run uniqueness, legal compare-and-set edges, verified evidence requirements, and FORCE-RLS migration structure.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard dispatched deadline replacement and manual-mark reconciliation/active-run refusal.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  bindApplyRunDispatch,
  createApplyRun,
  recordManualApplyRun,
  transitionApplyRun,
} from '@/app/apply-run-ledger';

const now = new Date('2026-08-06T08:00:00.000Z');

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: '11111111-2222-4333-8444-555555555555',
    ticket_id: 'ticket-1',
    owner_sub: ' Owner|Exact ',
    posting_id: '42',
    claim_token: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    task_id: null,
    worker_client_id: null,
    state: 'claimed',
    claimed_at: now,
    dispatched_at: null,
    acknowledged_at: null,
    last_progress_at: null,
    timeout_at: new Date('2030-08-06T08:30:00.000Z'),
    finished_at: null,
    result: null,
    failure_code: null,
    failure_detail: null,
    confirmation_path: null,
    confirmation_sha256: null,
    metadata: {
      trigger: 'authenticated-single-job',
      initiatedBySub: ' Owner|Exact ',
      automationSettingsVersion: 'authenticated-single-job-v1',
    },
    ...overrides,
  };
}

describe('Apply V2 durable run ledger', () => {
  it('creates an owner/posting claim before dispatch with mandatory automation metadata', async () => {
    const query = vi.fn(async () => ({ rows: [row()], rowCount: 1 }));
    const pool = { query } as unknown as Pool;
    const created = await createApplyRun(pool, {
      ticketId: 'ticket-1',
      ownerSub: ' Owner|Exact ',
      postingId: 42,
      timeoutAt: new Date('2030-08-06T08:30:00.000Z'),
      metadata: {
        trigger: 'authenticated-single-job',
        initiatedBySub: ' Owner|Exact ',
        automationSettingsVersion: 'authenticated-single-job-v1',
      },
    });

    expect(created).toMatchObject({
      ticketId: 'ticket-1', ownerSub: ' Owner|Exact ', postingId: 42, state: 'claimed',
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO apply_runs');
    expect(params).toContain(' Owner|Exact ');
    expect(params).toContain(42);
    expect(String(params[6])).toContain('automationSettingsVersion');
  });

  it('reports a partial-unique active-run conflict without inventing a second authority', async () => {
    const conflict = Object.assign(new Error('duplicate'), {
      code: '23505', constraint: 'uq_apply_runs_active_owner_posting',
    });
    const pool = { query: vi.fn(async () => { throw conflict; }) } as unknown as Pool;
    await expect(createApplyRun(pool, {
      ticketId: 'ticket-1', ownerSub: ' Owner|Exact ', postingId: 42,
      timeoutAt: new Date('2030-08-06T08:30:00.000Z'),
      metadata: {
        trigger: 'assist-only', initiatedBySub: ' Owner|Exact ',
        automationSettingsVersion: 'assist-only-v1',
      },
    })).resolves.toBeNull();
  });

  it('CAS-binds the accepted task/worker and permits only legal terminal transitions', async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("state='queued_to_worker'")) {
        return { rows: [row({
          state: 'queued_to_worker', task_id: params[1], worker_client_id: params[2],
          dispatched_at: now, last_progress_at: now,
        })], rowCount: 1 };
      }
      return { rows: [row({
        state: params[2], task_id: 'apply-11111111-2222-4333-8444-555555555555',
        worker_client_id: 'desktop-1', dispatched_at: now, finished_at: now,
        confirmation_path: params[7], confirmation_sha256: params[8],
      })], rowCount: 1 };
    });
    const pool = { query } as unknown as Pool;
    await expect(bindApplyRunDispatch(
      pool, '11111111-2222-4333-8444-555555555555',
      'apply-11111111-2222-4333-8444-555555555555', 'desktop-1',
      new Date('2030-08-06T08:30:00.000Z'),
    )).resolves.toMatchObject({ state: 'queued_to_worker', workerClientId: 'desktop-1' });
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1][3])
      .toEqual(new Date('2030-08-06T08:30:00.000Z'));

    await expect(transitionApplyRun(pool, {
      runId: '11111111-2222-4333-8444-555555555555',
      from: ['running'], to: 'submitted_verified',
      confirmationPath: 'applications/confirmation.png', confirmationSha256: 'a'.repeat(64),
    })).resolves.toMatchObject({ state: 'submitted_verified', confirmationSha256: 'a'.repeat(64) });

    await expect(transitionApplyRun(pool, {
      runId: '11111111-2222-4333-8444-555555555555',
      from: ['claimed'], to: 'submitted_verified',
      confirmationPath: 'proof.png', confirmationSha256: 'a'.repeat(64),
    })).rejects.toThrow(/Illegal Apply run transition/);
    await expect(transitionApplyRun(pool, {
      runId: '11111111-2222-4333-8444-555555555555',
      from: ['running'], to: 'submitted_verified',
    })).rejects.toThrow(/confirmation path and SHA-256/);
  });

  it('reconciles unknown outcomes to manual_mark and refuses a still-active automated run', async () => {
    const unknown = row({ state: 'unknown_outcome', task_id: 'apply-task', worker_client_id: 'desktop-1',
      dispatched_at: now, finished_at: now });
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('ORDER BY claimed_at')) return { rows: [unknown], rowCount: 1 };
      return { rows: [row({ ...unknown, state: params[2], result: JSON.parse(String(params[4])) })], rowCount: 1 };
    });
    await expect(recordManualApplyRun({ query } as unknown as Pool, {
      ownerSub: ' Owner|Exact ', postingId: 42, ticketId: 'ticket-1',
      sourceRoute: 'career-board-status',
    })).resolves.toMatchObject({ state: 'manual_mark' });

    query.mockReset();
    query.mockResolvedValue({ rows: [row({ state: 'running' })], rowCount: 1 });
    await expect(recordManualApplyRun({ query } as unknown as Pool, {
      ownerSub: ' Owner|Exact ', postingId: 42, ticketId: 'ticket-1',
      sourceRoute: 'career-board-status',
    })).rejects.toThrow(/still active/);
  });

  it('creates a terminal manual ledger row when no automated run exists', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('ORDER BY claimed_at')
      ? { rows: [], rowCount: 0 }
      : { rows: [row({ state: 'manual_mark', finished_at: now,
        metadata: { trigger: 'manual', initiatedBySub: ' Owner|Exact ', automationSettingsVersion: 'manual-mark-v1' } })], rowCount: 1 });
    await expect(recordManualApplyRun({ query } as unknown as Pool, {
      ownerSub: ' Owner|Exact ', postingId: 42, ticketId: 'ticket-1',
      sourceRoute: 'career-application-applied',
    })).resolves.toMatchObject({ state: 'manual_mark', metadata: { trigger: 'manual' } });
    expect(String((query.mock.calls[1] as unknown as [string])[0])).toContain("'manual_mark'");
  });
});

describe('Apply V2 migration', () => {
  const migration = readFileSync(resolve('scripts/migrations/118-apply-runs-ledger.sql'), 'utf8');

  it('contains the complete ledger, active uniqueness, state constraints, and forced owner RLS', () => {
    for (const column of [
      'run_id', 'ticket_id', 'owner_sub', 'posting_id', 'claim_token', 'task_id',
      'worker_client_id', 'state', 'claimed_at', 'dispatched_at', 'acknowledged_at',
      'last_progress_at', 'timeout_at', 'finished_at', 'result', 'failure_code',
      'failure_detail', 'confirmation_path', 'confirmation_sha256', 'metadata',
    ]) expect(migration).toMatch(new RegExp(`\\b${column}\\b`));
    for (const state of [
      'claimed', 'queued_to_worker', 'acknowledged', 'running', 'submitted_verified',
      'manual_mark', 'failed', 'abandoned', 'unknown_outcome',
    ]) expect(migration).toContain(`'${state}'`);
    expect(migration).toMatch(/UNIQUE INDEX[\s\S]*owner_sub, posting_id[\s\S]*WHERE state IN/i);
    expect(migration).toContain("metadata ? 'automationSettingsVersion'");
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(migration).toMatch(/owner_sub = current_setting\('oshal\.current_sub'/i);
  });
});
