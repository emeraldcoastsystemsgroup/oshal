/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Adversarial coverage for Token Chase `free:auto`: offer only eligible aggregate rotation, resolve probed-live owner/platform lanes, retain exact provider/model evidence, rotate a provider wall, carry the winner across a savings run, and fail closed without an implicit paid/default replay.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotNodeClient } from '../../src/features/agent-management';
import { TokenChaseBudgetGate } from '../../src/features/token-chase/services/token-chase-budget-gate';
import {
  TokenChaseOptimizeService,
} from '../../src/features/token-chase/services/token-chase-optimize-service';
import type {
  TokenChaseAccess,
  TokenChaseFrameDetail,
  TokenChaseReadService,
} from '../../src/features/token-chase/services/token-chase-read-service';

vi.mock('../../src/app/routes/provider-routes', () => ({
  listConfiguredProviders: vi.fn(() => ({
    activeProvider: 'claude-code',
    providers: [
      { id: 'claude-code', label: 'Claude Code', selectedModel: '', defaultModelId: 'claude-haiku-4-5' },
    ],
  })),
}));

vi.mock('../../src/app/routes/byo-llm-routes', () => ({
  ANY_LLM_PROVIDER: 'any-llm',
  getUserLlmConnection: vi.fn(async () => null),
  buildAnyLlmListEntry: vi.fn(() => ({ connections: [] })),
}));

vi.mock('../../src/app/routes/connector-tenancy', () => ({
  accessibleConnections: vi.fn(async () => []),
}));

vi.mock('../../src/app/routes/free-tier-rotation', () => ({
  freeTierRuntimeSnapshot: vi.fn(),
  listFreeTierConnections: vi.fn(),
  platformFreeConnection: vi.fn(),
  reportResolvedLlmFailure: vi.fn(),
  reportSuccess: vi.fn(),
  resolveLiveFreeTierConnection: vi.fn(),
}));

import {
  createOptimizerLaneRotation,
  listOptimizerLogins,
  optimizerReplayLane,
  resolveOptimizerLane,
  TOKEN_CHASE_FREE_ROTATION_ID,
} from '../../src/app/routes/optimizer-providers';
import {
  freeTierRuntimeSnapshot,
  listFreeTierConnections,
  platformFreeConnection,
  reportResolvedLlmFailure,
  reportSuccess,
  resolveLiveFreeTierConnection,
} from '../../src/app/routes/free-tier-rotation';

const ACCESS: TokenChaseAccess = { callerSub: 'free-owner', isAdmin: false };
const POOL = { query: vi.fn() };
const mockedSnapshot = vi.mocked(freeTierRuntimeSnapshot);
const mockedStatuses = vi.mocked(listFreeTierConnections);
const mockedPlatform = vi.mocked(platformFreeConnection);
const mockedFailure = vi.mocked(reportResolvedLlmFailure);
const mockedSuccess = vi.mocked(reportSuccess);
const mockedResolve = vi.mocked(resolveLiveFreeTierConnection);

/** A captured call whose response is stable enough to grade rotated variants. */
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

/** Builds an optimizer with local fake frames and an inspectable bot replay boundary. */
function optimizer(
  replayCall: ReturnType<typeof vi.fn>,
  sequences: number[] = [1],
): TokenChaseOptimizeService {
  const reader = {
    getFrames: vi.fn(async () => sequences.map(frame)),
    getFrame: vi.fn(async (_runId: string, seq: number) => frame(seq)),
  } as unknown as TokenChaseReadService;
  const botClient = {
    hasEndpoint: vi.fn(() => true),
    firstReachableAgentId: vi.fn(() => null),
    replayCall,
  } as unknown as BotNodeClient;
  return new TokenChaseOptimizeService(reader, botClient);
}

/** One decrypted owner lane returned only by the mocked health-qualified resolver. */
function freeLane(connectionId: string, providerId: string, model: string, apiKey: string) {
  return {
    connectionId,
    providerId,
    clineProvider: 'openai',
    model,
    baseUrl: `https://${providerId}.example/v1`,
    apiKey,
    label: `${providerId} free`,
  };
}

/** A successful replay response with a generic bot provider label. */
function success(model: string) {
  return {
    success: true,
    content: 'The stable answer.',
    usage: { inputTokens: 900, outputTokens: 180, totalTokens: 1_080 },
    cost: 0.01,
    model,
    provider: 'byo',
    latencyMs: 900,
  };
}

describe('Token Chase health-qualified free-provider lanes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatuses.mockResolvedValue([]);
    mockedSnapshot.mockReturnValue({
      configured: false,
      verdict: 'unknown',
      verdictExpiresAt: null,
      model: null,
      lastLiveModel: null,
      catalogSize: null,
      catalogExpiresAt: null,
      maxProbesPerResolution: 6,
      verdictScope: 'this-api-process',
    });
    mockedPlatform.mockResolvedValue(null);
    mockedResolve.mockResolvedValue(null);
    mockedFailure.mockResolvedValue(false);
    mockedSuccess.mockResolvedValue(undefined);
  });

  it('offers the aggregate selector only while an owner-visible or cached platform free lane is eligible', async () => {
    mockedStatuses.mockResolvedValueOnce([{
      connectionId: 'cooled', providerId: 'groq', providerLabel: 'Groq', model: 'groq-free',
      host: 'groq.example', isDefault: true, tenantId: null, cooldownUntil: Date.now() + 60_000,
      cooledDown: true, lastStatus: 'rate_limited', lastUsedAt: Date.now(),
    }]);
    expect(await listOptimizerLogins(POOL, ACCESS.callerSub!)).not.toContainEqual(
      expect.objectContaining({ connectionId: TOKEN_CHASE_FREE_ROTATION_ID }),
    );

    mockedStatuses.mockResolvedValueOnce([{
      connectionId: 'ready', providerId: 'groq', providerLabel: 'Groq', model: 'groq-free',
      host: 'groq.example', isDefault: true, tenantId: null, cooldownUntil: 0,
      cooledDown: false, lastStatus: 'ok', lastUsedAt: Date.now(),
    }]);
    expect(await listOptimizerLogins(POOL, ACCESS.callerSub!)).toContainEqual(expect.objectContaining({
      connectionId: TOKEN_CHASE_FREE_ROTATION_ID,
      kind: 'free-rotation',
      model: 'health-qualified at replay time',
    }));

    mockedStatuses.mockResolvedValueOnce([]);
    mockedSnapshot.mockReturnValueOnce({
      configured: true,
      verdict: 'live',
      verdictExpiresAt: Date.now() + 60_000,
      model: 'openai/gpt-oss-20b:free',
      lastLiveModel: 'openai/gpt-oss-20b:free',
      catalogSize: 3,
      catalogExpiresAt: Date.now() + 60_000,
      maxProbesPerResolution: 6,
      verdictScope: 'this-api-process',
    });
    expect(await listOptimizerLogins(POOL, ACCESS.callerSub!)).toContainEqual(expect.objectContaining({
      connectionId: TOKEN_CHASE_FREE_ROTATION_ID,
      label: 'Free-provider rotation (1 eligible lane)',
    }));
  });

  it('resolves an owner free lane first and rejects a platform fallback whose model is not free', async () => {
    mockedResolve.mockResolvedValueOnce(freeLane('owner-groq', 'groq', 'groq-free', 'owner-key'));
    const owner = await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID);
    expect(owner).toMatchObject({
      kind: 'byo', providerId: 'groq', model: 'groq-free',
      freeSelection: { source: 'user-free-tier', connectionId: 'owner-groq', providerId: 'groq', model: 'groq-free' },
    });
    expect(mockedPlatform).not.toHaveBeenCalled();

    mockedResolve.mockResolvedValueOnce(null);
    mockedPlatform.mockResolvedValueOnce({
      baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'platform-key', model: 'paid/model',
    });
    expect(await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID)).toBeNull();
  });

  it('accepts only a strict :free platform fallback and retains its server-derived identity', async () => {
    mockedResolve.mockResolvedValueOnce(null);
    mockedPlatform.mockResolvedValueOnce({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'platform-key',
      model: 'openai/gpt-oss-20b:free',
    });

    const lane = await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID);

    expect(lane).toMatchObject({
      kind: 'byo', providerId: 'openrouter', model: 'openai/gpt-oss-20b:free',
      freeSelection: {
        source: 'platform-free', connectionId: null,
        providerId: 'openrouter', model: 'openai/gpt-oss-20b:free',
      },
    });
  });

  it('rotates a classified provider wall on the same frame and records the exact successful lane', async () => {
    mockedResolve
      .mockResolvedValueOnce(freeLane('first', 'cerebras', 'cerebras-free', 'key-1'))
      .mockResolvedValueOnce(freeLane('second', 'groq', 'groq-free', 'key-2'));
    mockedFailure.mockResolvedValue(true);
    const initial = await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID);
    expect(initial).not.toBeNull();
    const replayCall = vi.fn()
      .mockResolvedValueOnce({ success: false, error: '429 quota exceeded' })
      .mockResolvedValueOnce(success('groq-free'));
    const service = optimizer(replayCall);

    const replay = await service.replayVariantRotating(
      'run-rotate', 1, optimizerReplayLane(initial!), ACCESS, undefined,
      createOptimizerLaneRotation(POOL, ACCESS.callerSub!, initial!),
    );

    expect(replay.selection).toEqual({
      attempts: 2, rotations: 1, failedClosed: false,
      selectedProvider: 'groq', selectedModel: 'groq-free',
    });
    expect(replay.result?.variant).toMatchObject({ provider: 'groq', model: 'groq-free' });
    expect(replayCall.mock.calls.map((call) => call[1].byoLlmConnection.apiKey)).toEqual(['key-1', 'key-2']);
    expect(replayCall.mock.calls.every((call) => call[1].byoLlmConnection !== undefined)).toBe(true);
    expect(mockedFailure).toHaveBeenCalledWith(
      POOL,
      expect.objectContaining({ resolutionSource: 'free-tier', connectionId: 'first', apiKey: 'key-1' }),
      '429 quota exceeded',
    );
    expect(mockedSuccess).toHaveBeenCalledWith(POOL, 'second');
  });

  it('fails closed after the last free lane walls without issuing a default-provider replay', async () => {
    mockedResolve
      .mockResolvedValueOnce(freeLane('last', 'cerebras', 'cerebras-free', 'last-key'))
      .mockResolvedValueOnce(null);
    mockedFailure.mockResolvedValue(true);
    const initial = await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID);
    const replayCall = vi.fn().mockResolvedValue({ success: false, error: '403 quota exhausted' });
    const service = optimizer(replayCall);

    const replay = await service.replayVariantRotating(
      'run-closed', 1, optimizerReplayLane(initial!), ACCESS, undefined,
      createOptimizerLaneRotation(POOL, ACCESS.callerSub!, initial!),
    );

    expect(replay.selection).toEqual({
      attempts: 1, rotations: 0, failedClosed: true,
      selectedProvider: 'cerebras', selectedModel: 'cerebras-free',
    });
    expect(replay.result?.status).toBe('replay-error');
    expect(replay.result?.reason).toContain('No eligible free-provider lane remains');
    expect(replayCall).toHaveBeenCalledTimes(1);
    expect(replayCall.mock.calls[0][1].byoLlmConnection).toMatchObject({
      apiKey: 'last-key', model: 'cerebras-free',
    });
  });

  it('fails a non-provider error closed without rotating or probing a replacement lane', async () => {
    mockedResolve.mockResolvedValueOnce(freeLane('only', 'groq', 'groq-free', 'only-key'));
    mockedFailure.mockResolvedValue(false);
    const initial = await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID);
    const replayCall = vi.fn().mockResolvedValue({ success: false, error: 'malformed response payload' });
    const service = optimizer(replayCall);

    const replay = await service.replayVariantRotating(
      'run-non-provider', 1, optimizerReplayLane(initial!), ACCESS, undefined,
      createOptimizerLaneRotation(POOL, ACCESS.callerSub!, initial!),
    );

    expect(replay.selection).toEqual({
      attempts: 1, rotations: 0, failedClosed: true,
      selectedProvider: 'groq', selectedModel: 'groq-free',
    });
    expect(replayCall).toHaveBeenCalledTimes(1);
    expect(mockedResolve).toHaveBeenCalledTimes(1);
    expect(mockedPlatform).not.toHaveBeenCalled();
  });

  it('carries the rotated winner across later savings frames and returns aggregate provider/model evidence', async () => {
    mockedResolve
      .mockResolvedValueOnce(freeLane('first', 'cerebras', 'cerebras-free', 'key-1'))
      .mockResolvedValueOnce(freeLane('winner', 'groq', 'groq-free', 'key-2'));
    mockedFailure.mockResolvedValue(true);
    const initial = await resolveOptimizerLane(POOL, ACCESS.callerSub!, TOKEN_CHASE_FREE_ROTATION_ID);
    const replayCall = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'rate limit reached' })
      .mockResolvedValueOnce(success('groq-free'))
      .mockResolvedValueOnce(success('groq-free'));
    const service = optimizer(replayCall, [1, 2]);

    const outcome = await service.runSavings(
      'run-savings',
      optimizerReplayLane(initial!),
      ACCESS,
      undefined,
      new TokenChaseBudgetGate({ capUsd: 1 }),
      undefined,
      createOptimizerLaneRotation(POOL, ACCESS.callerSub!, initial!),
    );

    expect(outcome.results).toHaveLength(2);
    expect(outcome.rotation).toEqual({
      attempts: 3,
      rotations: 1,
      failedClosed: false,
      selectedLanes: [{ provider: 'groq', model: 'groq-free' }],
    });
    expect(replayCall.mock.calls.map((call) => call[1].byoLlmConnection.apiKey)).toEqual([
      'key-1', 'key-2', 'key-2',
    ]);
    expect(mockedResolve).toHaveBeenCalledTimes(2);
    expect(mockedSuccess).toHaveBeenCalledTimes(2);
  });
});
