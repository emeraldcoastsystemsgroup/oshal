/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the leaf-node cost
 *   capture (ADR-036). Leaf-node LLM tasks (apply / linkedin / any dispatchBrowserTask) ran entirely
 *   off the standard /api/swarm-execute path and billed NOTHING. buildRemoteTaskCostEvent is the hook
 *   that meters them into chat_tasks attributed to the accountable bot. This locks: a codex.exec
 *   result → a CostEvent with the bot's agentId, the ticket as ticketExternalId, forwarded tokens/cost,
 *   per-owner ownerSub, and a COMPOSITE task key (so it never merges into a bot-node row); a non-LLM
 *   task (screen.capture, no usage) → null (bills nothing); an unattributed task → null.
 */

import { describe, expect, it } from 'vitest';
import { buildRemoteTaskCostEvent } from '@/app/routes/remote-client-routes';
import type { A2ATaskEnvelope, A2ATaskResult } from '@/shared/types';

function envelope(over: Partial<A2ATaskEnvelope> = {}): A2ATaskEnvelope {
  return {
    taskId: 'apply-1147705-1',
    correlationId: '1986677e-82de-4239-a8c3-c238e727d5d5', // the apply ticket id
    fromAgentId: 'cb000000-0000-0000-0000-000000000001',   // career-hunter worker (accountable bot)
    toAgentId: 'oshal-chat-node',
    intent: 'mcp.call-tool',
    input: { name: 'codex.exec', arguments: { prompt: 'x', model: 'gpt-5.5-codex' } },
    artifacts: [],
    userSub: 'example-user-sub',
    createdAt: '2026-07-23T18:00:00.000Z',
    status: 'running',
    ...over,
  } as A2ATaskEnvelope;
}

function result(output: unknown, status: 'completed' | 'failed' = 'completed'): A2ATaskResult {
  return {
    taskId: 'apply-1147705-1',
    correlationId: '1986677e-82de-4239-a8c3-c238e727d5d5',
    clientId: 'oshal-chat-node',
    status,
    output,
    completedAt: '2026-07-23T18:05:00.000Z',
  } as A2ATaskResult;
}

describe('buildRemoteTaskCostEvent — meter leaf-node LLM tasks to the accountable bot', () => {
  it('builds a CostEvent from a codex.exec result, attributed to the bot + owner + ticket', () => {
    const e = buildRemoteTaskCostEvent(envelope(), result({
      response: 'applied', provider: 'openai-codex',
      usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 }, cost: 0.021, durationMs: 480000,
    }));
    expect(e).not.toBeNull();
    expect(e!.agentId).toBe('cb000000-0000-0000-0000-000000000001');   // the ACCOUNTABLE bot
    expect(e!.ticketExternalId).toBe('1986677e-82de-4239-a8c3-c238e727d5d5');
    expect(e!.ownerSub).toBe('example-user-sub');                // per-owner budget attribution
    expect(e!.inputTokens).toBe(1200);
    expect(e!.outputTokens).toBe(340);
    expect(e!.totalCost).toBe(0.021);
    expect(e!.providerId).toBe('openai-codex');
    expect(e!.modelId).toBe('gpt-5.5-codex');                          // exact dispatched model
    expect(e!.currency).toBe('USD');
    expect(e!.estimated).toBe(false);
    // COMPOSITE key = ticket::bot — never collides with a bot-node's own chat_tasks row for the ticket.
    expect(e!.taskId).toBe('1986677e-82de-4239-a8c3-c238e727d5d5::cb000000-0000-0000-0000-000000000001');
  });

  it('meters a FAILED run that still burned tokens (leaf POSTs /fail with usage)', () => {
    const e = buildRemoteTaskCostEvent(envelope(), result({
      provider: 'openai-codex', usage: { inputTokens: 800, outputTokens: 50 }, cost: 0.009,
    }, 'failed'));
    expect(e).not.toBeNull();
    expect(e!.totalCost).toBe(0.009);
    expect(e!.inputTokens).toBe(800);
  });

  it('accepts snake_case usage keys (codex JSONL) too', () => {
    const e = buildRemoteTaskCostEvent(envelope(), result({
      provider: 'openai-codex', usage: { input_tokens: 500, output_tokens: 20 }, cost: 0.004,
    }));
    expect(e!.inputTokens).toBe(500);
    expect(e!.outputTokens).toBe(20);
  });

  it('bills NOTHING for a non-LLM leaf task (screen.capture — no usage, no cost)', () => {
    expect(buildRemoteTaskCostEvent(envelope(), result({ screenshotPath: 'C:/x.png' }))).toBeNull();
    expect(buildRemoteTaskCostEvent(envelope(), result({ provider: 'openai-codex', usage: {}, cost: 0 }))).toBeNull();
  });

  it('returns null for an unattributed task (no fromAgentId to bill)', () => {
    expect(buildRemoteTaskCostEvent(null, result({ usage: { inputTokens: 10 }, cost: 0.001 }))).toBeNull();
  });

  it('falls back to the provider name for modelId when no model was dispatched', () => {
    const env = envelope({ input: { name: 'codex.exec', arguments: { prompt: 'x' } } });
    const e = buildRemoteTaskCostEvent(env, result({ provider: 'openai-codex', usage: { inputTokens: 10 }, cost: 0.001 }));
    expect(e!.modelId).toBe('openai-codex');
  });
});
