/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 2 (slice 1) tests: determinism verdict + replay pre-condition gating (no stack, no LLM cost)
 */

import { test, expect } from '@playwright/test';
import { assessDeterminism, EQUIVALENT_SIMILARITY_THRESHOLD } from '@/features/token-chase';
import { TokenChaseOptimizeService, TokenChaseReplayService, buildTokenChaseDemoComparison } from '@/features/token-chase';
import type { TokenChaseReadService, TokenChaseFrameDetail, TokenChaseAccess } from '@/features/token-chase';
import type { BotNodeClient, ReplayCallResponse } from '@/features/agent-management';

const ACCESS: TokenChaseAccess = { callerSub: 'user-1', isAdmin: false };

/** Builds a frame detail with sensible replayable defaults, overridable per test. */
function frame(overrides: Partial<TokenChaseFrameDetail> = {}): TokenChaseFrameDetail {
  return {
    seq: 1, providerRequested: 'claude-code', harnessFired: 'claude-code', model: 'claude-sonnet-4-6',
    inputMessages: 2, tools: [], tokensIn: 100, tokensOut: 50, latencyMs: 1200, replayable: true, phase: 'closed',
    agentId: 'agent-x', source: 'incident', systemPrompt: 'You are a bot.',
    responseContent: 'The root cause is a failed disk.', responseBlocks: [], history: [{ role: 'user', content: 'why?' }],
    ...overrides,
  };
}

/** A reader that always returns the given frame (or null). */
function fakeReader(detail: TokenChaseFrameDetail | null): TokenChaseReadService {
  return { getFrame: async () => detail } as unknown as TokenChaseReadService;
}

/** A bot client whose endpoint presence and replay response are scripted. */
function fakeBot(hasEndpoint: boolean, replay?: Partial<ReplayCallResponse> & { throws?: boolean }): BotNodeClient {
  return {
    hasEndpoint: () => hasEndpoint,
    replayCall: async (): Promise<ReplayCallResponse> => {
      if (replay?.throws) throw new Error('bot unreachable');
      return {
        success: replay?.success ?? true,
        content: replay?.content ?? '',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        cost: replay?.cost ?? 0.0021, model: replay?.model ?? 'claude-sonnet-4-6',
        provider: replay?.provider ?? 'claude-code', latencyMs: replay?.latencyMs ?? 980, error: replay?.error,
      };
    },
  } as unknown as BotNodeClient;
}

test.describe('assessDeterminism — the gate verdict', () => {
  test('byte-identical output grades deterministic with similarity 1', () => {
    const v = assessDeterminism('hello world', 'hello world');
    expect(v.status).toBe('deterministic');
    expect(v.byteExact).toBe(true);
    expect(v.similarity).toBe(1);
    expect(v.tokenDeltaPct).toBe(0);
  });

  test('two empty responses are deterministic (empty reproduced as empty)', () => {
    expect(assessDeterminism('', '').status).toBe('deterministic');
  });

  test('minor wording drift within tolerance grades equivalent', () => {
    const base = 'the root cause is a failed disk on node three of the cluster today';
    const replay = 'the root cause is a failed disk on node three of the cluster';
    const v = assessDeterminism(base, replay);
    expect(v.byteExact).toBe(false);
    expect(v.similarity).toBeGreaterThanOrEqual(EQUIVALENT_SIMILARITY_THRESHOLD);
    expect(v.status).toBe('equivalent');
  });

  test('a wholly different response grades divergent', () => {
    const v = assessDeterminism('the disk failed', 'the network partition caused a quorum loss elsewhere');
    expect(v.status).toBe('divergent');
    expect(v.similarity).toBeLessThan(EQUIVALENT_SIMILARITY_THRESHOLD);
  });

  test('baseline non-empty but replay empty is divergent, not a crash', () => {
    const v = assessDeterminism('something', '');
    expect(v.status).toBe('divergent');
    expect(v.replayTokens).toBe(0);
  });
});

test.describe('TokenChaseOptimizeService - estimated vs actual cost demo', () => {
  test('builds a no-token demo comparison with estimated baseline and actual variant cost', () => {
    const result = buildTokenChaseDemoComparison();
    expect(result.baseline?.costEstimated).toBe(true);
    expect(result.variant?.costEstimated).toBe(false);
    expect(result.variant?.costUsd).toBeGreaterThan(0);
    expect(result.diff?.costDeltaUsd).toBeLessThan(0);
    expect(result.diff?.accuracy).toBe(1);
    expect(result.tier).toBe('equivalent-cheaper');
  });

  test('compares an estimated baseline cost to an actual cheaper equivalent variant', async () => {
    const f = frame({
      providerRequested: 'harness:claude-code-cli',
      model: 'claude-sonnet-4-6',
      tokensIn: 1000,
      tokensOut: 200,
      latencyMs: 1500,
      responseContent: 'The root cause is a failed disk.',
    });
    const svc = new TokenChaseOptimizeService(
      fakeReader(f),
      fakeBot(true, {
        content: f.responseContent!,
        cost: 0.0001,
        model: 'gpt-5',
        provider: 'openai-codex',
        latencyMs: 900,
      }),
    );

    const result = await svc.replayVariant('run-1', 1, { label: 'gpt-5 cheaper lane' }, ACCESS);

    expect(result?.status).toBe('deterministic');
    expect(result?.baseline?.costEstimated).toBe(true);
    expect(result?.baseline?.costUsd).toBeGreaterThan(0);
    expect(result?.variant?.costEstimated).toBe(false);
    expect(result?.variant?.costUsd).toBe(0.0001);
    expect(result?.diff?.equivalent).toBe(true);
    expect(result?.diff?.costDeltaUsd).toBeLessThan(0);
    expect(result?.diff?.latencyDeltaMs).toBeLessThan(0);
    expect(result?.tier).toBe('equivalent-cheaper');
  });
});

test.describe('TokenChaseReplayService — pre-condition gating before spending tokens', () => {
  test('absent/invisible frame returns null (route → 404)', async () => {
    const svc = new TokenChaseReplayService(fakeReader(null), fakeBot(true));
    expect(await svc.replayFrame('run-1', 9, ACCESS)).toBeNull();
  });

  test('in-flight frame is excluded as open-frame (no baseline yet)', async () => {
    const svc = new TokenChaseReplayService(fakeReader(frame({ phase: 'open', responseContent: null })), fakeBot(true));
    const r = await svc.replayFrame('run-1', 1, ACCESS);
    expect(r?.status).toBe('open-frame');
    expect(r?.verdict).toBeNull();
  });

  test('non-replayable frame is excluded without re-firing', async () => {
    const svc = new TokenChaseReplayService(fakeReader(frame({ replayable: false })), fakeBot(true));
    const r = await svc.replayFrame('run-1', 1, ACCESS);
    expect(r?.status).toBe('non-replayable');
    expect(r?.verdict).toBeNull();
  });

  test('no reachable bot node → no-endpoint (replay must not run on the controller)', async () => {
    const svc = new TokenChaseReplayService(fakeReader(frame()), fakeBot(false));
    const r = await svc.replayFrame('run-1', 1, ACCESS);
    expect(r?.status).toBe('no-endpoint');
    expect(r?.verdict).toBeNull();
  });

  test('bot error surfaces as replay-error with the reason', async () => {
    const svc = new TokenChaseReplayService(fakeReader(frame()), fakeBot(true, { throws: true }));
    const r = await svc.replayFrame('run-1', 1, ACCESS);
    expect(r?.status).toBe('replay-error');
    expect(r?.reason).toContain('unreachable');
  });

  test('reproduced baseline grades deterministic end-to-end', async () => {
    const f = frame();
    const svc = new TokenChaseReplayService(fakeReader(f), fakeBot(true, { content: f.responseContent! }));
    const r = await svc.replayFrame('run-1', 1, ACCESS);
    expect(r?.status).toBe('deterministic');
    expect(r?.verdict?.byteExact).toBe(true);
    expect(r?.replay?.costUsd).toBeGreaterThan(0);
  });
});
