/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Write-side guard for the run-trace per-LLM-call observability columns (migration 090). run-trace.spec.ts already proves the READ path surfaces a ledger row's token split + duration; this proves the WRITE path — CostTrackingService.recordCost -> appendCostLedgerRow — actually PERSISTS input_tokens/output_tokens/duration_ms into the oshal_cost_events INSERT (not just the chat_tasks rollup). Covers: (1) a fully-measured event lands all three column values in the ledger insert; (2) an event whose producer did not time the call writes duration_ms=NULL (never a fabricated 0) while still persisting the token split; (3) a DB predating the 090 columns (42703 undefined_column) falls back to the legacy 6-column insert so the cost row is never lost. Guard-per-fix: these would go red if a refactor dropped the token/duration columns from the ledger write or removed the backward-compatible fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { CostTrackingService, type CostEvent } from '../../src/features/operational-intelligence/services/cost-tracking-service';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryHandler = (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>;

/** Builds a pool whose query() dispatches on SQL content, recording every call for assertions. */
function mockPool(handler: QueryHandler): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  return { pool: { query } as unknown as Pool, calls };
}

/**
 * A handler for the persistCostEvent flow: the initial chat_tasks SELECT returns no row
 * (so the INSERT-new branch runs), the chat_tasks INSERT succeeds, and the ledger insert
 * is delegated to `onLedger` so a test can succeed or simulate a pre-090 undefined_column.
 */
function persistHandler(onLedger: (sql: string) => QueryResult): QueryHandler {
  return (sql: string) => {
    if (sql.includes('FROM chat_tasks') && sql.includes('WHERE task_id')) return { rows: [] };
    if (sql.includes('INSERT INTO chat_tasks')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO oshal_cost_events')) return onLedger(sql);
    return { rows: [], rowCount: 1 };
  };
}

/** The full 090 ledger insert (the primary write path) names the observability columns. */
const isFullLedgerInsert = (sql: string): boolean =>
  sql.includes('INSERT INTO oshal_cost_events') &&
  sql.includes('input_tokens') &&
  sql.includes('output_tokens') &&
  sql.includes('duration_ms');

/** The legacy fallback insert is the 6-column shape with NONE of the 090 columns. */
const isLegacyLedgerInsert = (sql: string): boolean =>
  sql.includes('INSERT INTO oshal_cost_events') &&
  !sql.includes('input_tokens') &&
  !sql.includes('output_tokens') &&
  !sql.includes('duration_ms');

function baseEvent(over: Partial<CostEvent> = {}): CostEvent {
  return {
    taskId: 'task-obs-1',
    agentId: 'code-developer',
    providerId: 'anthropic',
    modelId: 'claude-x',
    inputTokens: 1200,
    outputTokens: 340,
    inputCost: 0.0024,
    outputCost: 0.0016,
    totalCost: 0.004,
    currency: 'USD',
    durationMs: 4500,
    ...over,
  };
}

describe('CostTrackingService.recordCost — ledger observability columns (migration 090 write path)', () => {
  it('persists the token split + measured duration into the oshal_cost_events insert', async () => {
    const { pool, calls } = mockPool(persistHandler(() => ({ rows: [], rowCount: 1 })));
    await new CostTrackingService(pool).recordCost(baseEvent({ ownerSub: 'owner-a' }));

    const ledger = calls.find((c) => isFullLedgerInsert(c.sql));
    expect(ledger).toBeTruthy();
    // Column order: task_id, owner_sub, agent_id, provider_id, model_id, cost_usd,
    //               input_tokens, output_tokens, duration_ms  -> params $1..$9.
    expect(ledger!.params[0]).toBe('task-obs-1');
    expect(ledger!.params[1]).toBe('owner-a');
    expect(ledger!.params[6]).toBe(1200); // input_tokens
    expect(ledger!.params[7]).toBe(340); // output_tokens
    expect(ledger!.params[8]).toBe(4500); // duration_ms
  });

  it('writes duration_ms = NULL when the producer did not time the call, still persisting tokens', async () => {
    const { pool, calls } = mockPool(persistHandler(() => ({ rows: [], rowCount: 1 })));
    // durationMs omitted -> an unmeasured call. Tokens are still known.
    await new CostTrackingService(pool).recordCost(baseEvent({ durationMs: undefined }));

    const ledger = calls.find((c) => isFullLedgerInsert(c.sql));
    expect(ledger).toBeTruthy();
    expect(ledger!.params[6]).toBe(1200); // input_tokens still persisted
    expect(ledger!.params[7]).toBe(340); // output_tokens still persisted
    expect(ledger!.params[8]).toBeNull(); // NULL, never a fabricated 0
  });

  it('falls back to the legacy 6-column insert on a pre-090 DB (42703) so the cost row is never lost', async () => {
    const { pool, calls } = mockPool(
      persistHandler((sql) => {
        if (isFullLedgerInsert(sql)) {
          const err = Object.assign(new Error('column "input_tokens" does not exist'), { code: '42703' });
          throw err;
        }
        return { rows: [], rowCount: 1 };
      }),
    );
    await new CostTrackingService(pool).recordCost(baseEvent());

    // The primary insert was attempted and rejected, then the legacy insert carried the cost row.
    expect(calls.some((c) => isFullLedgerInsert(c.sql))).toBe(true);
    const legacy = calls.find((c) => isLegacyLedgerInsert(c.sql));
    expect(legacy).toBeTruthy();
    // Legacy shape carries only the six pre-090 values — cost survives, no token/duration columns.
    expect(legacy!.params).toHaveLength(6);
    expect(legacy!.params[0]).toBe('task-obs-1');
    expect(legacy!.params[5]).toBe(0.004); // cost_usd
  });
});
