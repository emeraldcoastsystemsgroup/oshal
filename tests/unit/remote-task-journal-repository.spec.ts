/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add deterministic transaction-contract guards for durable enqueue, client-serialized non-leased claims, first-writer settlement, pending-only outbox delivery, rollback, and retention cleanup.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Guard correlation binding so a claimed task cannot accept a terminal result from another logical request.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Split test groups so every describe callback remains below the repository's 50-physical-line governance limit.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Guard persisted owner binding, shared client-lock serialization, and expectedOwnerSub predicates across enqueue, claim, and owner reassignment.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Prove a transient strict work-item landing failure rolls back outbox delivery and the next journal replay lands the result before marking delivered_at.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PostgresRemoteTaskJournalRepository,
  type RemoteTaskOutboxRecord,
} from '@/features/remote-client';
import { createRemoteTaskOutboxPublisher } from '@/app/routes/remote-client-task-operations';

interface QueryStep {
  match: RegExp;
  rows?: unknown[];
  rowCount?: number;
  inspect?: (params: unknown[] | undefined, sql: string) => void;
}

interface RecordedQuery {
  sql: string;
  params: unknown[] | undefined;
}

class ScriptedPool {
  readonly queries: RecordedQuery[] = [];
  private readonly steps: QueryStep[];
  private readonly client: { query: typeof this.query; release: ReturnType<typeof vi.fn> };
  readonly connect: ReturnType<typeof vi.fn>;
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;

  constructor(steps: QueryStep[]) {
    this.steps = [...steps];
    this.query = async (sql, params) => this.execute(sql, params);
    this.client = { query: this.query, release: vi.fn() };
    this.connect = vi.fn(async () => this.client);
  }

  assertDrained(): void {
    expect(this.steps, 'all expected SQL steps should execute').toHaveLength(0);
  }

  private async execute(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, params });
    const step = this.steps.shift();
    expect(step, `unexpected SQL: ${normalized}`).toBeDefined();
    expect(normalized).toMatch(step!.match);
    step!.inspect?.(params, normalized);
    const rows = step!.rows ?? [];
    return { rows, rowCount: step!.rowCount ?? rows.length };
  }
}

const NOW = '2026-08-05T12:00:00.000Z';

const envelope = {
  taskId: 'task-1',
  correlationId: 'corr-1',
  fromAgentId: 'controller',
  toAgentId: 'agent-a',
  intent: 'status.sync' as const,
  input: {},
  artifacts: [],
  createdAt: NOW,
  status: 'queued' as const,
};

const completedResult = {
  taskId: 'task-1',
  correlationId: 'corr-1',
  clientId: 'client-a',
  status: 'completed' as const,
  output: { ok: true },
  artifacts: [],
  completedAt: '2026-08-05T12:01:00.000Z',
};

function taskRow(status: 'queued' | 'claimed' | 'completed' | 'failed', terminalResult: unknown = null) {
  const claimed = status !== 'queued';
  const terminal = status === 'completed' || status === 'failed';
  return {
    task_id: 'task-1', client_id: 'client-a', owner_sub: 'user-a', correlation_id: 'corr-1',
    envelope, status, claimed_by_client_id: claimed ? 'client-a' : null,
    claimed_at: claimed ? NOW : null, settled_at: terminal ? '2026-08-05T12:01:00.000Z' : null,
    terminal_result: terminalResult,
    tombstone_expires_at: terminal ? '2026-09-04T12:01:00.000Z' : null,
    created_at: NOW, updated_at: NOW,
  };
}

function transactionSteps(...steps: QueryStep[]): QueryStep[] {
  return [{ match: /^BEGIN$/ }, ...steps, { match: /^COMMIT$/ }];
}

function ownerGuardSteps(): QueryStep[] {
  return [
    { match: /^SELECT pg_advisory_xact_lock/ },
    { match: /^SELECT client_id, owner_sub FROM remote_task_journal_client_owners/, rows: [{ client_id: 'client-a', owner_sub: 'user-a' }] },
  ];
}

function repositoryFor(harness: ScriptedPool): PostgresRemoteTaskJournalRepository {
  return new PostgresRemoteTaskJournalRepository(harness as never, async () => undefined);
}

describe('PostgresRemoteTaskJournalRepository enqueue', () => {
  it('atomically inserts a task, queued event, and dispatch outbox row', async () => {
    const harness = new ScriptedPool(transactionSteps(
      ...ownerGuardSteps(),
      { match: /^INSERT INTO remote_task_journal_tasks/, rows: [taskRow('queued')] },
      { match: /^INSERT INTO remote_task_journal_events/, rows: [{ event_id: '11' }] },
      {
        match: /^INSERT INTO remote_task_journal_outbox/,
        inspect: (params) => {
          expect(params?.[5]).toBe('remote-task.dispatch');
          expect(JSON.parse(String(params?.[6]))).toMatchObject({ taskId: 'task-1', clientId: 'client-a' });
        },
      },
    ));
    const outcome = await repositoryFor(harness).enqueue({ clientId: 'client-a', ownerSub: 'user-a', task: envelope });
    expect(outcome.kind).toBe('enqueued');
    expect(outcome.task.status).toBe('queued');
    harness.assertDrained();
  });

  it('treats an exact task-id retry as idempotent without creating another event or outbox row', async () => {
    const harness = new ScriptedPool(transactionSteps(
      ...ownerGuardSteps(),
      { match: /^INSERT INTO remote_task_journal_tasks/, rows: [] },
      { match: /^SELECT .*same_request.*FOR UPDATE$/, rows: [{ ...taskRow('queued'), same_request: true }] },
    ));
    const outcome = await repositoryFor(harness).enqueue({ clientId: 'client-a', ownerSub: 'user-a', task: envelope });
    expect(outcome.kind).toBe('already_exists');
    expect(harness.queries.some((query) => query.sql.includes('remote_task_journal_events'))).toBe(false);
    harness.assertDrained();
  });

  it('rejects task-id reuse when the target, owner, or envelope differs', async () => {
    const harness = new ScriptedPool(transactionSteps(
      ...ownerGuardSteps(),
      { match: /^INSERT INTO remote_task_journal_tasks/, rows: [] },
      { match: /^SELECT .*same_request.*FOR UPDATE$/, rows: [{ ...taskRow('queued'), same_request: false }] },
    ));
    const outcome = await repositoryFor(harness).enqueue({ clientId: 'client-a', ownerSub: 'user-a', task: envelope });
    expect(outcome.kind).toBe('conflict');
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository owner binding', () => {
  it('retains the persisted owner when restart registration omits ownerSub', async () => {
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT pg_advisory_xact_lock/ },
      {
        match: /^SELECT client_id, owner_sub FROM remote_task_journal_client_owners/,
        rows: [{ client_id: 'client-a', owner_sub: 'user-a' }],
      },
    ));
    const outcome = await repositoryFor(harness).bindClientOwner({ clientId: 'client-a' });
    expect(outcome).toEqual({ kind: 'already_bound', ownerSub: 'user-a' });
    harness.assertDrained();
  });

  it('rejects restart registration under a different owner', async () => {
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT pg_advisory_xact_lock/ },
      {
        match: /^SELECT client_id, owner_sub FROM remote_task_journal_client_owners/,
        rows: [{ client_id: 'client-a', owner_sub: 'user-a' }],
      },
    ));
    const outcome = await repositoryFor(harness).bindClientOwner({ clientId: 'client-a', assertedOwnerSub: 'user-b' });
    expect(outcome).toEqual({ kind: 'conflict', ownerSub: 'user-a' });
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository owner transition', () => {
  it('refuses reassignment while queued or claimed work exists under the same client lock', async () => {
    const harness = new ScriptedPool(transactionSteps(
      ...ownerGuardSteps(),
      { match: /status IN \('queued', 'claimed'\).*FOR UPDATE$/, rows: [{ task_id: 'task-1' }] },
    ));
    const outcome = await repositoryFor(harness).transitionClientOwner({
      clientId: 'client-a',
      expectedOwnerSub: 'user-a',
      nextOwnerSub: 'user-b',
    });
    expect(outcome).toEqual({ kind: 'tasks_active', ownerSub: 'user-a' });
    expect(harness.queries.some((query) => query.sql.startsWith('UPDATE remote_task_journal_client_owners'))).toBe(false);
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository claims', () => {
  it('returns the active task after serializing pollers for the client', async () => {
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT pg_advisory_xact_lock/ },
      { match: /status = 'claimed'.*FOR UPDATE$/, rows: [taskRow('claimed')] },
    ));
    const outcome = await repositoryFor(harness).claimNext({ clientId: 'client-a', expectedOwnerSub: 'user-a' });
    expect(outcome).toMatchObject({ kind: 'client_busy', task: { taskId: 'task-1' } });
    expect(harness.queries.some((query) => query.sql.includes('SKIP LOCKED'))).toBe(false);
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository successful claim', () => {
  it('claims the oldest queued task once with no lease or reassignment mutation', async () => {
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT pg_advisory_xact_lock/ },
      {
        match: /owner_sub IS NOT DISTINCT FROM \$2.*status = 'claimed'.*FOR UPDATE$/,
        rows: [],
        inspect: (params) => expect(params).toEqual(['client-a', 'user-a']),
      },
      {
        match: /owner_sub IS NOT DISTINCT FROM \$2.*status = 'queued'.*FOR UPDATE SKIP LOCKED$/,
        rows: [taskRow('queued')],
        inspect: (params) => expect(params).toEqual(['client-a', 'user-a']),
      },
      {
        match: /^UPDATE remote_task_journal_tasks SET status = 'claimed'.*owner_sub IS NOT DISTINCT FROM \$3/,
        rows: [taskRow('claimed')],
        inspect: (params) => expect(params).toEqual(['task-1', 'client-a', 'user-a']),
      },
      { match: /^INSERT INTO remote_task_journal_events/, rows: [{ event_id: 12 }] },
    ));
    const outcome = await repositoryFor(harness).claimNext({ clientId: 'client-a', expectedOwnerSub: 'user-a' });
    expect(outcome).toMatchObject({ kind: 'claimed', task: { claimedByClientId: 'client-a' } });
    const update = harness.queries.find((query) => query.sql.startsWith('UPDATE remote_task_journal_tasks'));
    const mutation = update?.sql.match(/SET (.*?) WHERE/)?.[1] ?? '';
    expect(mutation).not.toMatch(/lease|expires|reassign/i);
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository accepted settlement', () => {
  it('writes the first terminal result, 30-day tombstone, event, and settlement outbox atomically', async () => {
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT .*WHERE task_id = \$1 FOR UPDATE$/, rows: [taskRow('claimed')] },
      {
        match: /^UPDATE remote_task_journal_tasks SET status = \$3/,
        rows: [taskRow('completed', completedResult)],
        inspect: (params, sql) => {
          expect(params?.[4]).toBe(30);
          expect(sql).toContain("INTERVAL '1 day'");
        },
      },
      { match: /^INSERT INTO remote_task_journal_events/, rows: [{ event_id: 13 }] },
      {
        match: /^INSERT INTO remote_task_journal_outbox/,
        inspect: (params) => expect(params?.[5]).toBe('remote-task.settlement'),
      },
    ));
    const outcome = await repositoryFor(harness).settle({ clientId: 'client-a', result: completedResult });
    expect(outcome).toMatchObject({ kind: 'settled', task: { status: 'completed' } });
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository repeated settlement', () => {
  it('rejects a repeated identical settlement without another mutation or side effect', async () => {
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT .*WHERE task_id = \$1 FOR UPDATE$/, rows: [taskRow('completed', completedResult)] },
    ));
    const outcome = await repositoryFor(harness).settle({ clientId: 'client-a', result: completedResult });
    expect(outcome.kind).toBe('already_settled');
    expect(harness.queries.some((query) => query.sql.startsWith('UPDATE'))).toBe(false);
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository conflicting settlement', () => {
  it('rejects a conflicting later settlement and preserves the first terminal result', async () => {
    const conflicting = { ...completedResult, status: 'failed' as const, error: 'late failure' };
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT .*WHERE task_id = \$1 FOR UPDATE$/, rows: [taskRow('completed', completedResult)] },
    ));
    const outcome = await repositoryFor(harness).settle({ clientId: 'client-a', result: conflicting });
    expect(outcome).toMatchObject({ kind: 'conflict', task: { terminalResult: completedResult } });
    expect(harness.queries.some((query) => query.sql.includes('remote_task_journal_outbox'))).toBe(false);
    harness.assertDrained();
  });

  it('rejects a first settlement whose correlation does not match the claimed task', async () => {
    const mismatched = { ...completedResult, correlationId: 'other-correlation' };
    const harness = new ScriptedPool(transactionSteps(
      { match: /^SELECT .*WHERE task_id = \$1 FOR UPDATE$/, rows: [taskRow('claimed')] },
    ));
    const outcome = await repositoryFor(harness).settle({ clientId: 'client-a', result: mismatched });
    expect(outcome).toMatchObject({ kind: 'conflict', task: { status: 'claimed' } });
    expect(harness.queries.some((query) => query.sql.startsWith('UPDATE'))).toBe(false);
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository outbox delivery', () => {
  it('delivers only an undelivered outbox row and marks it after publisher success', async () => {
    const outbox = outboxRow();
    const harness = new ScriptedPool([
      ...transactionSteps(
        { match: /FROM remote_task_journal_outbox WHERE delivered_at IS NULL.*FOR UPDATE SKIP LOCKED$/, rows: [outbox] },
        { match: /^UPDATE remote_task_journal_outbox SET delivered_at = NOW\(\)/, rowCount: 1 },
      ),
      ...transactionSteps(
        { match: /FROM remote_task_journal_outbox WHERE delivered_at IS NULL.*FOR UPDATE SKIP LOCKED$/, rows: [] },
      ),
    ]);
    const published: RemoteTaskOutboxRecord[] = [];
    const repository = repositoryFor(harness);
    expect(await repository.deliverNextOutbox(async (record) => { published.push(record); })).toBe(true);
    expect(await repository.deliverNextOutbox(async (record) => { published.push(record); })).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0].outboxId).toBe('11111111-1111-4111-8111-111111111111');
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository outbox failure and retention', () => {
  it('rolls back and leaves delivered_at null when the publisher fails', async () => {
    const harness = new ScriptedPool([
      { match: /^BEGIN$/ },
      { match: /FROM remote_task_journal_outbox WHERE delivered_at IS NULL.*FOR UPDATE SKIP LOCKED$/, rows: [outboxRow()] },
      { match: /^ROLLBACK$/ },
    ]);
    const repository = repositoryFor(harness);
    await expect(repository.deliverNextOutbox(async () => { throw new Error('publisher offline'); }))
      .rejects.toThrow('publisher offline');
    expect(harness.queries.some((query) => query.sql.startsWith('UPDATE remote_task_journal_outbox'))).toBe(false);
    harness.assertDrained();
  });

  it('purges only expired terminal rows whose outbox has fully drained', async () => {
    const harness = new ScriptedPool([{
      match: /^WITH expired AS/,
      rows: [{ task_id: 'old-a' }, { task_id: 'old-b' }],
      inspect: (params, sql) => {
        expect(params).toEqual([25]);
        expect(sql).toMatch(/NOT EXISTS .*delivered_at IS NULL/);
        expect(sql).toMatch(/status IN \('completed', 'failed'\)/);
      },
    }]);
    const purged = await repositoryFor(harness).purgeExpiredTombstones(25);
    expect(purged).toBe(2);
    harness.assertDrained();
  });
});

describe('PostgresRemoteTaskJournalRepository work-item landing replay', () => {
  it('retries the same pending row after landing fails once', async () => {
    const row = outboxRow({ version: 1, envelope, result: completedResult });
    const harness = new ScriptedPool([
      { match: /^BEGIN$/ },
      { match: /FROM remote_task_journal_outbox WHERE delivered_at IS NULL.*FOR UPDATE SKIP LOCKED$/, rows: [row] },
      { match: /^ROLLBACK$/ },
      ...transactionSteps(
        { match: /FROM remote_task_journal_outbox WHERE delivered_at IS NULL.*FOR UPDATE SKIP LOCKED$/, rows: [row] },
        { match: /^UPDATE remote_task_journal_outbox SET delivered_at = NOW\(\)/, rowCount: 1 },
      ),
    ]);
    const item: { workItemId: string; status: string; executionOutput?: unknown } = {
      workItemId: 'work-1', status: 'executing',
    };
    const setExecutionOutput = vi.fn()
      .mockRejectedValueOnce(new Error('work-item database unavailable'))
      .mockImplementation(async (_id: string, output: unknown) => { item.executionOutput = output; });
    const updateStatus = vi.fn(async (_id: string, status: string) => { item.status = status; });
    const publish = createRemoteTaskOutboxPublisher({
      workItemRepository: {
        findByExternalIdAnyProvider: vi.fn(async () => [item]),
        setExecutionOutput,
        updateStatus,
      } as never,
    });
    const repository = repositoryFor(harness);
    await expect(repository.deliverNextOutbox(publish)).rejects.toThrow('work-item database unavailable');
    expect(harness.queries.some((query) => query.sql.startsWith('UPDATE remote_task_journal_outbox'))).toBe(false);
    await expect(repository.deliverNextOutbox(publish)).resolves.toBe(true);
    expect(item.executionOutput).toMatchObject({ outboxId: row.outbox_id, taskId: 'task-1' });
    expect(item.status).toBe('completed');
    harness.assertDrained();
  });
});

function outboxRow(payload: Record<string, unknown> = { taskId: 'task-1' }) {
  return {
    outbox_id: '11111111-1111-4111-8111-111111111111',
    task_id: 'task-1', client_id: 'client-a', owner_sub: 'user-a', event_id: '13',
    topic: 'remote-task.settlement', payload,
    created_at: NOW, delivered_at: null,
  };
}
