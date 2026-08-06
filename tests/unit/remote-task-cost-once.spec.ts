/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove recordCostOnce commits its outbox receipt, chat-task rollup, and ledger row atomically; duplicate replay is a no-op and partial publication rolls back without in-memory acknowledgement.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Assert task-scoped advisory serialization before rollup mutation so concurrent distinct outbox rows cannot lose cost increments.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CostTrackingService,
  type CostEvent,
} from '@/features/operational-intelligence/services/cost-tracking-service';

interface Step {
  match: RegExp;
  rows?: unknown[];
  error?: Error;
}

class TransactionPool {
  readonly queries: string[] = [];
  readonly release = vi.fn();
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  readonly connect = vi.fn(async () => ({
    query: async (sql: string) => this.execute(sql),
    release: this.release,
  }));

  assertDrained(): void {
    expect(this.steps).toHaveLength(0);
  }

  private async execute(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queries.push(normalized);
    const step = this.steps.shift();
    expect(step, `unexpected SQL: ${normalized}`).toBeDefined();
    expect(normalized).toMatch(step!.match);
    if (step!.error) throw step!.error;
    const rows = step!.rows ?? [];
    return { rows, rowCount: rows.length };
  }
}

const event: CostEvent = {
  taskId: 'ticket-1::agent-a',
  agentId: 'agent-a',
  providerId: 'openai-codex',
  modelId: 'gpt-5',
  inputTokens: 10,
  outputTokens: 4,
  inputCost: 0,
  outputCost: 0,
  totalCost: 0.25,
  currency: 'USD',
  ownerSub: 'owner-a',
  requestCount: 1,
};

const OUTBOX_ID = '11111111-1111-4111-8111-111111111111';

function firstWriteSteps(ledgerError?: Error): Step[] {
  return [
    { match: /^BEGIN$/ },
    { match: /^INSERT INTO remote_task_cost_receipts/, rows: [{ outbox_id: OUTBOX_ID }] },
    { match: /^SELECT pg_advisory_xact_lock/ },
    { match: /^SELECT .* FROM chat_tasks WHERE task_id = \$1 LIMIT 1$/, rows: [] },
    { match: /^INSERT INTO chat_tasks/ },
    { match: /^INSERT INTO oshal_cost_events/, error: ledgerError },
    { match: ledgerError ? /^ROLLBACK$/ : /^COMMIT$/ },
  ];
}

describe('CostTrackingService.recordCostOnce commit', () => {
  it('commits receipt, rollup, and ledger before acknowledging the cost effect', async () => {
    const pool = new TransactionPool(firstWriteSteps());
    const service = new CostTrackingService(pool as never);
    await expect(service.recordCostOnce(OUTBOX_ID, event)).resolves.toBe(true);
    expect(service.getRunningTotal()).toBe(0.25);
    expect(pool.queries.at(-1)).toBe('COMMIT');
    pool.assertDrained();
  });
});

describe('CostTrackingService.recordCostOnce duplicate replay', () => {
  it('commits a no-op when the durable outbox receipt already exists', async () => {
    const pool = new TransactionPool([
      { match: /^BEGIN$/ },
      { match: /^INSERT INTO remote_task_cost_receipts/, rows: [] },
      { match: /^COMMIT$/ },
    ]);
    const service = new CostTrackingService(pool as never);
    await expect(service.recordCostOnce(OUTBOX_ID, event)).resolves.toBe(false);
    expect(service.getRunningTotal()).toBe(0);
    expect(pool.queries.some((sql) => sql.includes('chat_tasks'))).toBe(false);
    pool.assertDrained();
  });
});

describe('CostTrackingService.recordCostOnce partial failure', () => {
  it('rolls back the receipt and cost mutation when the strict ledger append fails', async () => {
    const pool = new TransactionPool(firstWriteSteps(new Error('ledger unavailable')));
    const service = new CostTrackingService(pool as never);
    await expect(service.recordCostOnce(OUTBOX_ID, event)).rejects.toThrow('ledger unavailable');
    expect(service.getRunningTotal()).toBe(0);
    expect(pool.queries.at(-1)).toBe('ROLLBACK');
    pool.assertDrained();
  });
});
