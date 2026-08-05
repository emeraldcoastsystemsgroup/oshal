/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Review-fix coverage for createA2ACostStamper() against a mocked pg pool: the costUnknown honesty marker (zero-cost, requestCount 0, metadata.costUnknown=true), the previously-missing reported-dollar-cost stamp (a remote agent's real totalCostUsd now lands as a dollar-only supplemental row instead of a silent unflagged $0), the genuinely-free case (usage reported, totalCost 0 — nothing to bill, pool never touched), the no-Postgres visible-skip for both branches, and a DB failure being logged non-fatally rather than thrown.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Follow the refactored insertTaskCost SQL bindings: status, processing mode, message/turn counts, and empty metadata are now SQL literals, so total_cost and total_requests bind at $9/$10 rather than the former $13/$14. The production values remain correct; the regression was stale test indexing after the durable cost-settlement refactor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  createA2ACostStamper,
  resetA2ACostStamperPool,
} from '@/app/composition/a2a-cost-stamper';
import type { A2ACostEvent } from '@/features/llm-provider/services/a2a-harness-adapter';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryHandler = (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>;

/** Builds a mock pg pool whose query() dispatches on SQL content, recording every call. */
function mockPool(handler: QueryHandler): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  return { pool: { query } as unknown as Pool, calls };
}

/** Default handler: no existing chat_tasks row, so persistCostEvent always takes the INSERT path. */
function freshTaskPool(): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  return mockPool((sql) => {
    if (sql.includes('SELECT') && sql.includes('FROM chat_tasks')) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
}

function baseEvent(over: Partial<A2ACostEvent> = {}): A2ACostEvent {
  return {
    taskId: 'task-1',
    agentId: 'a2a-sample-agent',
    providerId: 'a2a',
    modelId: 'a2a/remote-agent',
    inputTokens: 0,
    outputTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    currency: 'USD',
    requestCount: 0,
    costUnknown: false,
    remoteEndpointHost: 'remote-agent.example',
    ...over,
  };
}

afterEach(() => {
  resetA2ACostStamperPool(undefined);
});

describe('createA2ACostStamper — no Postgres configured', () => {
  it('costUnknown event: visible warn skip, no throw', async () => {
    resetA2ACostStamperPool(null);
    const stamp = createA2ACostStamper();
    await expect(stamp(baseEvent({ costUnknown: true }))).resolves.toBeUndefined();
  });

  it('reported-cost event: visible warn skip, no throw', async () => {
    resetA2ACostStamperPool(null);
    const stamp = createA2ACostStamper();
    await expect(stamp(baseEvent({ costUnknown: false, totalCost: 0.0123, requestCount: 1 }))).resolves.toBeUndefined();
  });
});

describe('createA2ACostStamper — costUnknown honesty marker', () => {
  it('stamps a zero-cost, zero-request marker row with metadata.costUnknown=true', async () => {
    const { pool, calls } = freshTaskPool();
    resetA2ACostStamperPool(pool);
    const stamp = createA2ACostStamper();
    await stamp(baseEvent({ costUnknown: true, requestCount: 0 }));

    const insert = calls.find((c) => c.sql.includes('INSERT INTO chat_tasks'));
    expect(insert).toBeTruthy();
    // insertTaskCost binds total_cost as $9 and total_requests as $10. Several
    // fixed fields are SQL literals now, so their zero-based parameter indexes
    // are 8 and 9; both must be exactly 0 for the honesty marker.
    expect(insert!.sql).toMatch(/total_cost, total_requests,[\s\S]*\$9, \$10,/);
    expect(insert!.params[8]).toBe(0);
    expect(insert!.params[9]).toBe(0);

    const metadataUpdate = calls.find((c) => c.sql.includes('UPDATE chat_tasks') && c.sql.includes('metadata'));
    expect(metadataUpdate).toBeTruthy();
    const metadata = JSON.parse(metadataUpdate!.params[1] as string);
    expect(metadata).toMatchObject({ costUnknown: true, costSource: 'a2a-remote', remoteEndpointHost: 'remote-agent.example' });
  });
});

describe('createA2ACostStamper — reported dollar cost (review-fix)', () => {
  it('a real remote-reported totalCost is persisted, not silently dropped to $0', async () => {
    const { pool, calls } = freshTaskPool();
    resetA2ACostStamperPool(pool);
    const stamp = createA2ACostStamper();
    await stamp(baseEvent({ costUnknown: false, totalCost: 0.0123, inputTokens: 120, outputTokens: 45, requestCount: 1 }));

    const insert = calls.find((c) => c.sql.includes('INSERT INTO chat_tasks'));
    expect(insert).toBeTruthy();
    // params[8] = total_cost — the real reported dollar figure, no longer $0.
    expect(insert!.sql).toMatch(/total_cost, total_requests,[\s\S]*\$9, \$10,/);
    expect(insert!.params[8]).toBe(0.0123);
    // params[4]/[5] = total_input_tokens/total_output_tokens, params[9] =
    // total_requests — all stay 0 here. The generic token pipeline (not this
    // stamper) owns tokens/requests for this taskId; this is a dollar-only top-up.
    expect(insert!.params[4]).toBe(0);
    expect(insert!.params[5]).toBe(0);
    expect(insert!.params[9]).toBe(0);

    const metadataUpdate = calls.find((c) => c.sql.includes('UPDATE chat_tasks') && c.sql.includes('metadata'));
    const metadata = JSON.parse(metadataUpdate!.params[1] as string);
    expect(metadata).toMatchObject({ costSource: 'a2a-remote-reported', remoteEndpointHost: 'remote-agent.example' });
    expect(metadata.costUnknown).toBeUndefined();
  });

  it('genuinely-free reported usage (totalCost 0, costUnknown false) touches no pool at all', async () => {
    const { pool, calls } = freshTaskPool();
    resetA2ACostStamperPool(pool);
    const stamp = createA2ACostStamper();
    await stamp(baseEvent({ costUnknown: false, totalCost: 0, inputTokens: 50, outputTokens: 10, requestCount: 1 }));
    expect(calls.length).toBe(0);
  });
});

describe('createA2ACostStamper — DB failure is non-blocking', () => {
  it('a query throw is logged, never re-thrown to the caller', async () => {
    const { pool } = mockPool(() => {
      throw new Error('connection reset');
    });
    resetA2ACostStamperPool(pool);
    const stamp = createA2ACostStamper();
    await expect(stamp(baseEvent({ costUnknown: false, totalCost: 5, requestCount: 1 }))).resolves.toBeUndefined();
  });
});
