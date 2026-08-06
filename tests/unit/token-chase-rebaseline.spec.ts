/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Behavioral proof for ADR-046 keep-winner re-baselining: a subsequent savings run consumes the active promotion override only for its frame, retains captured response text as the quality reference, and computes cost savings against the promoted provider/model/cost identity.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BotNodeClient } from '../../src/features/agent-management';
import { TokenChaseBudgetGate } from '../../src/features/token-chase/services/token-chase-budget-gate';
import {
  TokenChaseOptimizeService,
  type BaselineOverride,
} from '../../src/features/token-chase/services/token-chase-optimize-service';
import type {
  TokenChaseAccess,
  TokenChaseFrameDetail,
  TokenChaseReadService,
} from '../../src/features/token-chase/services/token-chase-read-service';

const ACCESS: TokenChaseAccess = { callerSub: 'rebaseline-owner', isAdmin: false };

/** A closed, replayable capture whose text remains the quality oracle after cost re-baselining. */
function frame(seq: number): TokenChaseFrameDetail {
  return {
    seq,
    providerRequested: 'harness:claude-code-cli',
    harnessFired: 'claude-code',
    model: 'claude-sonnet-4-6',
    inputMessages: 1,
    tools: [],
    tokensIn: 1_000,
    tokensOut: 200,
    latencyMs: 1_500,
    replayable: true,
    phase: 'closed',
    agentId: 'worker-1',
    source: 'test',
    systemPrompt: 'Answer exactly.',
    responseContent: 'The stable answer.',
    responseBlocks: [],
    history: [{ role: 'user', content: 'What is the stable answer?' }],
  };
}

describe('Token Chase promoted baseline consumption', () => {
  it('uses the winning lane as the next run baseline for that frame only', async () => {
    const getFrames = vi.fn(async () => [frame(1), frame(2)]);
    const getFrame = vi.fn(async (_runId: string, seq: number) => frame(seq));
    const reader = { getFrames, getFrame } as unknown as TokenChaseReadService;
    const replayCall = vi.fn(async () => ({
      success: true,
      content: 'The stable answer.',
      usage: { inputTokens: 900, outputTokens: 180, totalTokens: 1_080 },
      cost: 0.01,
      model: 'candidate-model',
      provider: 'framework:candidate',
      latencyMs: 900,
    }));
    const botClient = {
      hasEndpoint: vi.fn(() => true),
      firstReachableAgentId: vi.fn(() => null),
      replayCall,
    } as unknown as BotNodeClient;
    const service = new TokenChaseOptimizeService(reader, botClient);
    const promoted: BaselineOverride = {
      provider: 'framework:openrouter',
      model: 'llama-3.3-70b:free',
      costUsd: 0.03,
      label: 'winning lane',
    };

    const outcome = await service.runSavings(
      'run-next',
      { label: 'candidate lane' },
      ACCESS,
      undefined,
      new TokenChaseBudgetGate({ capUsd: 1 }),
      new Map([[2, promoted]]),
    );

    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0].baseline?.label).toBe('baseline');
    expect(outcome.results[1].baseline).toMatchObject({
      label: 'baseline (promoted: winning lane)',
      provider: 'framework:openrouter',
      model: 'llama-3.3-70b:free',
      costUsd: 0.03,
      preview: 'The stable answer.',
    });
    expect(outcome.results[1].diff?.costDeltaUsd).toBeCloseTo(-0.02, 10);
    expect(outcome.results[1].diff?.accuracy).toBe(1);
    expect(outcome.results[1].tier).toBe('equivalent-cheaper');
    expect(replayCall).toHaveBeenCalledTimes(2);
  });
});
