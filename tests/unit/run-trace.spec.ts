/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for the run-trace read-model against a mocked pg pool: caller-scope vs operator (a non-owner + a null-owner ticket both return the SAME null as a missing one — no existence leak), a malformed ticket id short-circuits before any query, span assembly is ordered by time (phase < bot < llm-call on ties), an empty ticket (phases but no tasks/cost events) returns zero totals without crashing, and totals.costUsd equals the budget ticket-spend query (same ticket_task_links -> oshal_cost_events ledger sum). Mocks pg like tests/unit/cost-governance.spec.ts.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | 090 observability round-trip: a ledger row carrying input_tokens/output_tokens/duration_ms surfaces them on its llm-call span (tokens = split sum, durationMs populated, endedAt stays null); a pre-090 row (columns absent or NULL) keeps the original shape — tokens undefined, durationMs null (backward compat, never a fabricated 0); totals.tokens still sums ONLY bot spans so the mirrored ledger splits are not double-counted.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { TraceService, buildPhaseSpans, computeTotals, renderTraceHtml } from '@/features/run-trace';

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryHandler = (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>;

/** Builds a pool whose query() dispatches on SQL content, recording every call. */
function mockPool(handler: QueryHandler): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return handler(sql, params);
  });
  return { pool: { query } as unknown as Pool, calls };
}

const TID = '11111111-2222-3333-4444-555555555555';

function ticketRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticket_id: TID, ticket_type: 'build', status: 'complete', owner_sub: 'sub-a',
    title: 'Do the thing', created_at: '2026-07-15T10:00:00.000Z', updated_at: '2026-07-15T10:05:00.000Z',
    ...over,
  };
}

/** Dispatches the four getTrace queries by their distinctive SQL fragments. */
function traceHandler(rows: { ticket?: unknown[]; status?: unknown[]; bots?: unknown[]; llm?: unknown[] }): QueryHandler {
  return (sql: string) => {
    if (sql.includes('FROM tickets')) return { rows: rows.ticket ?? [] };
    if (sql.includes('ticket_status_history')) return { rows: rows.status ?? [] };
    if (sql.includes('JOIN chat_tasks ct')) return { rows: rows.bots ?? [] };
    if (sql.includes('JOIN oshal_cost_events e')) return { rows: rows.llm ?? [] };
    return { rows: [] };
  };
}

describe('TraceService.getTrace — caller scope (no existence leak)', () => {
  it('returns null (not the trace) for a non-owner non-operator — same as a missing ticket', async () => {
    const { pool, calls } = mockPool(traceHandler({ ticket: [ticketRow({ owner_sub: 'sub-OWNER' })] }));
    const svc = new TraceService(pool);
    expect(await svc.getTrace(TID, 'sub-INTRUDER', false)).toBeNull();
    // It must NOT read any child rows once ownership fails.
    expect(calls.some((c) => c.sql.includes('ticket_status_history'))).toBe(false);
  });

  it('returns null for a null-owner ticket to a non-operator (fail-closed)', async () => {
    const { pool } = mockPool(traceHandler({ ticket: [ticketRow({ owner_sub: null })] }));
    expect(await new TraceService(pool).getTrace(TID, 'sub-a', false)).toBeNull();
  });

  it('an operator may trace any ticket, including a null-owner one', async () => {
    const { pool } = mockPool(traceHandler({ ticket: [ticketRow({ owner_sub: null })] }));
    const trace = await new TraceService(pool).getTrace(TID, 'op', true);
    expect(trace).not.toBeNull();
    expect(trace!.ticket.id).toBe(TID);
  });

  it('the owner may trace their own ticket', async () => {
    const { pool } = mockPool(traceHandler({ ticket: [ticketRow({ owner_sub: 'sub-a' })] }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    expect(trace!.ticket.owner).toBe('sub-a');
  });

  it('returns null for a missing ticket and never touches child tables', async () => {
    const { pool, calls } = mockPool(traceHandler({ ticket: [] }));
    expect(await new TraceService(pool).getTrace(TID, 'sub-a', false)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('short-circuits a malformed (non-UUID) ticket id with no query at all', async () => {
    const { pool, calls } = mockPool(traceHandler({ ticket: [ticketRow()] }));
    expect(await new TraceService(pool).getTrace('not-a-uuid', 'sub-a', false)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null with no pool (degraded), never throwing', async () => {
    expect(await new TraceService(null).getTrace(TID, 'sub-a', true)).toBeNull();
  });
});

describe('TraceService.getTrace — span assembly + ordering', () => {
  it('merges phase/bot/llm-call spans in time order, ties broken phase < bot < llm-call', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      status: [
        { from_status: null, to_status: 'approved', created_at: '2026-07-15T10:00:00.000Z' },
        { from_status: 'approved', to_status: 'in_process_build', created_at: '2026-07-15T10:01:00.000Z' },
      ],
      bots: [{
        task_id: 'task-1', agent_id: 'agent-uuid', agent_name: 'Builder Bot', provider_id: 'anthropic',
        total_input_tokens: '100', total_output_tokens: '40', total_cost: '0.20',
        usage_by_model: { 'claude-x': {} }, created_at: '2026-07-15T10:01:00.000Z', updated_at: '2026-07-15T10:02:30.000Z',
      }],
      llm: [
        { ts: '2026-07-15T10:01:10.000Z', agent_id: 'agent-uuid', provider_id: 'anthropic', model_id: 'claude-x', cost_usd: '0.12' },
        { ts: '2026-07-15T10:01:50.000Z', agent_id: 'agent-uuid', provider_id: 'anthropic', model_id: 'claude-x', cost_usd: '0.08' },
      ],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    const kinds = trace!.spans.map((s) => s.kind);
    // 10:00 phase, then at 10:01 the phase (tie rank 0) precedes the bot (rank 1), then the two llm calls.
    expect(kinds).toEqual(['phase', 'phase', 'bot', 'llm-call', 'llm-call']);
    const bot = trace!.spans.find((s) => s.kind === 'bot')!;
    expect(bot.label).toBe('Builder Bot');
    expect(bot.tokens).toBe(140);
    expect(bot.durationMs).toBe(90_000);
    expect(bot.model).toBe('claude-x');
    const llm = trace!.spans.find((s) => s.kind === 'llm-call')!;
    expect(llm.endedAt).toBeNull();
    expect(llm.durationMs).toBeNull();
    expect(llm.tokens).toBeUndefined();
  });

  it('surfaces the 090 token split + duration on an llm-call span when the ledger row carries them', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      llm: [{
        ts: '2026-07-19T10:01:10.000Z', agent_id: 'agent-uuid', provider_id: 'anthropic', model_id: 'claude-x',
        cost_usd: '0.12', input_tokens: '900', output_tokens: '100', duration_ms: '4500',
      }],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    const llm = trace!.spans.find((s) => s.kind === 'llm-call')!;
    expect(llm.tokens).toBe(1000);
    expect(llm.durationMs).toBe(4500);
    expect(llm.costUsd).toBe(0.12);
    // The row is still recorded as a point event — duration is metadata, not a bar resize.
    expect(llm.endedAt).toBeNull();
  });

  it('keeps the pre-090 shape for a ledger row with NULL observability columns (backward compat)', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      llm: [{
        ts: '2026-07-19T10:01:10.000Z', agent_id: 'a', provider_id: 'p', model_id: 'm',
        cost_usd: '0.05', input_tokens: null, output_tokens: null, duration_ms: null,
      }],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    const llm = trace!.spans.find((s) => s.kind === 'llm-call')!;
    expect(llm.tokens).toBeUndefined();
    expect(llm.durationMs).toBeNull();
    expect(llm.costUsd).toBe(0.05);
  });

  it('totals.tokens still sums ONLY bot spans — ledger token splits mirror chat_tasks, no double-count', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      bots: [{
        task_id: 't1', agent_id: 'a', agent_name: 'A', provider_id: 'p',
        total_input_tokens: '900', total_output_tokens: '100', total_cost: '0.12', usage_by_model: null,
        created_at: '2026-07-19T10:00:00.000Z', updated_at: '2026-07-19T10:01:00.000Z',
      }],
      llm: [{
        ts: '2026-07-19T10:00:30.000Z', agent_id: 'a', provider_id: 'p', model_id: 'm',
        cost_usd: '0.12', input_tokens: '900', output_tokens: '100', duration_ms: '2000',
      }],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    expect(trace!.totals.tokens).toBe(1000); // not 2000
  });

  it('falls back to agent_id then task_id for a bot label when the agents join misses', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      bots: [{
        task_id: 'task-z', agent_id: 'raw-agent', agent_name: null, provider_id: 'openai',
        total_input_tokens: 0, total_output_tokens: 0, total_cost: 0, usage_by_model: null,
        created_at: '2026-07-15T10:00:00.000Z', updated_at: '2026-07-15T10:00:00.000Z',
      }],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    expect(trace!.spans.find((s) => s.kind === 'bot')!.label).toBe('raw-agent');
  });
});

describe('TraceService.getTrace — empty ticket + totals math', () => {
  it('a ticket with phases but no tasks/cost events returns zero cost/token/call totals, no crash', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      status: [{ from_status: null, to_status: 'approved', created_at: '2026-07-15T10:00:00.000Z' }],
      bots: [], llm: [],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    expect(trace!.spans.map((s) => s.kind)).toEqual(['phase']);
    expect(trace!.totals).toMatchObject({ costUsd: 0, tokens: 0, llmCalls: 0 });
    // wallMs still spans ticket created -> updated (5 min), even with no executions.
    expect(trace!.totals.wallMs).toBe(300_000);
  });

  it('totals.costUsd sums the ledger (llm-call) spans — i.e. the budget ticket-spend query', async () => {
    const { pool } = mockPool(traceHandler({
      ticket: [ticketRow()],
      bots: [{
        task_id: 't1', agent_id: 'a', agent_name: 'A', provider_id: 'p',
        total_input_tokens: 10, total_output_tokens: 5, total_cost: '9.99', usage_by_model: null,
        created_at: '2026-07-15T10:00:00.000Z', updated_at: '2026-07-15T10:01:00.000Z',
      }],
      llm: [
        { ts: '2026-07-15T10:00:10.000Z', agent_id: 'a', provider_id: 'p', model_id: 'm', cost_usd: '0.030000' },
        { ts: '2026-07-15T10:00:20.000Z', agent_id: 'a', provider_id: 'p', model_id: 'm', cost_usd: '0.020000' },
      ],
    }));
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    // Budget sums oshal_cost_events.cost_usd over the ticket's linked tasks => 0.03 + 0.02 = 0.05,
    // NOT the chat_tasks lifetime rollup (9.99). The trace total must match the budget number.
    expect(trace!.totals.costUsd).toBe(0.05);
    expect(trace!.totals.tokens).toBe(15);
    expect(trace!.totals.llmCalls).toBe(2);
  });

  it('degrades gracefully when a child query fails (phases unreadable) without dropping the trace', async () => {
    const { pool } = mockPool((sql) => {
      if (sql.includes('FROM tickets')) return { rows: [ticketRow()] };
      if (sql.includes('ticket_status_history')) throw new Error('relation missing');
      return { rows: [] };
    });
    const trace = await new TraceService(pool).getTrace(TID, 'sub-a', false);
    expect(trace).not.toBeNull();
    expect(trace!.spans).toEqual([]);
  });
});

describe('pure helpers', () => {
  it('buildPhaseSpans closes each span at the next transition, last at the fallback end', () => {
    const spans = buildPhaseSpans(
      [
        { from_status: null, to_status: 'a', created_at: '2026-07-15T10:00:00.000Z' },
        { from_status: 'a', to_status: 'b', created_at: '2026-07-15T10:00:30.000Z' },
      ],
      '2026-07-15T10:01:00.000Z',
    );
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ label: 'a', durationMs: 30_000 });
    expect(spans[1]).toMatchObject({ label: 'b', endedAt: '2026-07-15T10:01:00.000Z', durationMs: 30_000 });
  });

  it('buildPhaseSpans returns nothing for no history (never fabricates a span)', () => {
    expect(buildPhaseSpans([], '2026-07-15T10:00:00.000Z')).toEqual([]);
  });

  it('computeTotals rounds summed micro-costs and floors an inverted wall to 0', () => {
    const ticket = { ticket_id: TID, ticket_type: 'b', status: 's', owner_sub: null, title: '',
      created_at: '2026-07-15T10:05:00.000Z', updated_at: '2026-07-15T10:00:00.000Z' };
    const totals = computeTotals(ticket as never, [], [
      { kind: 'llm-call', label: 'm', startedAt: '2026-07-15T10:00:00.000Z', endedAt: null, durationMs: null, costUsd: 0.1 },
      { kind: 'llm-call', label: 'm', startedAt: '2026-07-15T10:00:01.000Z', endedAt: null, durationMs: null, costUsd: 0.2 },
    ]);
    expect(totals.costUsd).toBe(0.3);
    expect(totals.llmCalls).toBe(2);
    expect(totals.wallMs).toBe(0);
  });
});

describe('renderTraceHtml — self-contained + escaped', () => {
  it('renders totals + rows and HTML-escapes user-influenced ids', () => {
    const html = renderTraceHtml({
      ticket: { id: '<x>"a"', type: 'build', status: 'complete', owner: 'sub-a', created: '2026-07-15T10:00:00.000Z' },
      spans: [{ kind: 'llm-call', label: 'gpt<script>', startedAt: '2026-07-15T10:00:00.000Z', endedAt: null, durationMs: null, costUsd: 0.01, model: 'gpt<script>' }],
      totals: { costUsd: 0.01, tokens: 0, llmCalls: 1, wallMs: 1000 },
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script>gpt');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('$0.010000');
  });
});
