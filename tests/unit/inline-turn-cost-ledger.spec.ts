/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Branch-logic companion to tests/unit/inline-chat-cost-ledger-postgres.spec.ts (which owns the database boundary). Pins the pure halves: how a finished turn's usage summary becomes ledger events (one row per model bucket, the bare-summary fallback, nothing for a turn that never reached a model, duration only on a single row, a blank agent id stored as null), the ADR-127 cost-unit classification table over the provider ids the ledger actually carries, the by-unit fold, and that the run-trace llm-call span + HTML label the non-billed units.
 */
import { describe, expect, it } from 'vitest';
import { buildInlineTurnCostEvents } from '@/features/chat-orchestration';
import { classifyCostUnit, splitSpendByUnit, COST_UNIT_LABELS } from '@/features/cost-governance';
import { mapLlmSpan, renderTraceHtml } from '@/features/run-trace';

const attribution = { taskId: 'thread-1', agentId: 'bot-a', providerId: 'metered', ownerSub: 'owner-1', durationMs: 1234.6 };

describe('buildInlineTurnCostEvents — a finished turn becomes ledger rows', () => {
  it('emits one row per model bucket carrying that bucket\'s own tokens and cost', () => {
    const events = buildInlineTurnCostEvents({
      inputTokens: 30, outputTokens: 12, totalTokens: 42, inputCost: 0.3, outputCost: 0.12, totalCost: 0.42,
      currency: 'USD', requestCount: 3,
      byModel: {
        'model-a': { inputTokens: 20, outputTokens: 10, totalTokens: 30, inputCost: 0.2, outputCost: 0.1, totalCost: 0.3, requestCount: 2 },
        'model-b': { inputTokens: 10, outputTokens: 2, totalTokens: 12, inputCost: 0.1, outputCost: 0.02, totalCost: 0.12, requestCount: 1 },
      },
    }, attribution);
    expect(events).toEqual([
      { taskId: 'thread-1', agentId: 'bot-a', providerId: 'metered', currency: 'USD', ownerSub: 'owner-1',
        modelId: 'model-a', inputTokens: 20, outputTokens: 10, inputCost: 0.2, outputCost: 0.1, totalCost: 0.3, requestCount: 2 },
      { taskId: 'thread-1', agentId: 'bot-a', providerId: 'metered', currency: 'USD', ownerSub: 'owner-1',
        modelId: 'model-b', inputTokens: 10, outputTokens: 2, inputCost: 0.1, outputCost: 0.02, totalCost: 0.12, requestCount: 1 },
    ]);
    // Two rows: the turn's wall-clock belongs to neither, so it is attached to none.
    expect(events.every((e) => e.durationMs === undefined)).toBe(true);
  });

  it('falls back to one "unknown" row from the totals when the provider reported no model split', () => {
    const events = buildInlineTurnCostEvents({
      inputTokens: 5, outputTokens: 1, totalTokens: 6, inputCost: 0, outputCost: 0, totalCost: 0,
      currency: 'USD', requestCount: 1, byModel: {},
    }, attribution);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ modelId: 'unknown', inputTokens: 5, outputTokens: 1, totalCost: 0, requestCount: 1, durationMs: 1235 });
  });

  it('emits nothing for a turn that never reached a model, and nothing for an absent summary', () => {
    expect(buildInlineTurnCostEvents(undefined, attribution)).toEqual([]);
    expect(buildInlineTurnCostEvents({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0,
      currency: 'USD', requestCount: 0, byModel: { 'idle-model': { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputCost: 0, outputCost: 0, totalCost: 0, requestCount: 0 } },
    }, attribution)).toEqual([]);
  });

  it('stores a blank agent as null and omits the owner when the turn has none', () => {
    const [event] = buildInlineTurnCostEvents({
      inputTokens: 1, outputTokens: 1, totalTokens: 2, inputCost: 0, outputCost: 0, totalCost: 0.01,
      currency: 'USD', requestCount: 1, byModel: {},
    }, { taskId: 't', agentId: '  ', providerId: 'p', durationMs: 0 });
    expect(event.agentId).toBeNull();
    expect('ownerSub' in event).toBe(false);
    expect('durationMs' in event).toBe(false);
  });
});

describe('classifyCostUnit — the ADR-127 unit for the provider ids the ledger carries', () => {
  it.each([
    ['claude-code', 'price-equivalent'],
    ['openai-codex', 'price-equivalent'],
    ['harness:codex-cli', 'price-equivalent'],
    ['codex-cli-harness-adapter', 'price-equivalent'],
    ['failover:claude-code->openai', 'price-equivalent'],
    ['byo-llm', 'byo'],
    ['byo-hosted:user-model', 'byo'],
    ['openai', 'billed'],
    ['image-provider:openrouter', 'billed'],
    ['harness:a2a', 'billed'],
    ['noop', 'billed'],
    ['', 'billed'],
    [null, 'billed'],
    [undefined, 'billed'],
  ])('%s -> %s', (providerId, unit) => {
    expect(classifyCostUnit(providerId as string | null | undefined)).toBe(unit);
  });

  it('folds per-provider spend into the three units plus the plain total', () => {
    expect(splitSpendByUnit([
      { providerId: 'openai', spend: 1.5 },
      { providerId: 'claude-code', spend: 0.25 },
      { providerId: 'byo-llm', spend: 0 },
      { providerId: null, spend: Number.NaN },
    ])).toEqual({ billed: 1.5, priceEquivalent: 0.25, byo: 0, total: 1.75 });
  });
});

describe('run-trace — llm-call spans and rows say which unit a cost is in', () => {
  const row = (provider_id: string, cost_usd: number) => ({
    ts: '2026-09-18T10:00:00.000Z', agent_id: 'bot-a', provider_id, model_id: 'm', cost_usd,
    input_tokens: 10, output_tokens: 5, duration_ms: 40,
  });

  it('mapLlmSpan classifies the row\'s provider', () => {
    expect(mapLlmSpan(row('claude-code', 0.079) as never).costUnit).toBe('price-equivalent');
    expect(mapLlmSpan(row('byo-hosted:x', 0) as never).costUnit).toBe('byo');
    expect(mapLlmSpan(row('openai', 0.2) as never).costUnit).toBe('billed');
  });

  it('the HTML labels a price-equivalent figure, shows a $0 BYO call as BYO, and leaves a bill unlabelled', () => {
    const html = renderTraceHtml({
      ticket: { id: 't', type: 'build', status: 'complete', owner: 'sub-a', created: '2026-09-18T10:00:00.000Z' },
      spans: [
        mapLlmSpan(row('claude-code', 0.079) as never),
        mapLlmSpan(row('byo-hosted:x', 0) as never),
        mapLlmSpan(row('openai', 0.2) as never),
      ],
      totals: { costUsd: 0.279, tokens: 0, llmCalls: 3, wallMs: 1000 },
    });
    expect(html).toContain(`$0.079000 ${COST_UNIT_LABELS['price-equivalent']}`);
    expect(html).toContain(COST_UNIT_LABELS.byo);
    expect(html).toContain('$0.200000');
    expect(html).not.toContain(`$0.200000 ${COST_UNIT_LABELS.billed}`);
  });
});
