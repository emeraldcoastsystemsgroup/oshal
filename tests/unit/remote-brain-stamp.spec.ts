/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 remote-brain guards for stampRemoteBrain: a CLI-harness node dispatch carries the caller's resolved brain (cli → the ADR-034 providerId/model stamp; hosted → the byoLlmConnection wire trio with resolver metadata stripped), explicit caller choices and identity-less/hosted-harness dispatches pass through with the ladder never consulted, an empty ladder refuses with NO_HOSTED_BRAIN, and a ladder FAILURE dispatches unstamped (fail-open) — the exact behaviours that keep the operator's mounted-CLI turns and guest hosted turns from regressing onto a node's static default.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Require the resolved CLI provider stamp at the protected remote reasoning boundary.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Regression for the live Intelligent Sales reversion: `bot-default` stamps the canonical Sales Gemini record (including required authority) while the existing explicit OpenAI Codex user choice still wins and never consults that resolver.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A sparse canonical bot record replaces the whole authoritative slice, clearing stale model/version/fallback fields from a partially stamped incoming request.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Cover strict bot-default resolution and SEC-05 degradation: dedicated bot defaults require the exact demo/operator carve before canonical resolution, guests fall through to hosted/no-brain, null falls through for the operator, and resolver outages propagate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NoHostedBrainError,
  stampRemoteBrain,
  type HostedBrainResolutionOverrides,
} from '../../src/app/routes/inline-bot-execution';
import type { AppContext } from '../../src/app/composition/app-context';
import type { BotNodeRequest } from '../../src/features/agent-management';

const POOL = {} as AppContext['pool'];
const CLI_AGENT = '15000000-0000-0000-0000-000000000001';

/** Registry seam: one CLI-harness node (the stamp condition) + one non-CLI node (the pass-through). */
const REGISTRY = [
  { agentId: CLI_AGENT, harnessType: 'claude-code' },
  { agentId: 'aa000000-0000-0000-0000-000000000002', harnessType: 'noop' },
];

function request(partial: Partial<BotNodeRequest> = {}): BotNodeRequest {
  return {
    text: 'tighten my resume summary',
    taskId: 't-1',
    workspaceFolderId: 'w-1',
    agentId: CLI_AGENT,
    userSub: 'operator-sub',
    ...partial,
  };
}

function overrides(
  brain: unknown,
  opts: { reject?: boolean } = {},
): HostedBrainResolutionOverrides & { resolveBrain: ReturnType<typeof vi.fn> } {
  const resolveBrain = opts.reject
    ? vi.fn().mockRejectedValue(new Error('ladder infrastructure failure'))
    : vi.fn().mockResolvedValue(brain);
  return { loadRegistry: () => REGISTRY, resolveBrain };
}

describe('stampRemoteBrain (ADR-127 remote branch)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('stamps a resolved CLI brain as the authoritative dispatch provider (+ model pin)', async () => {
    const req = request();
    await stampRemoteBrain(POOL, CLI_AGENT, req, overrides({ kind: 'cli', providerId: 'claude-code', model: 'claude-sonnet-4-6' }));
    expect(req.providerId).toBe('claude-code');
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.providerConfigRequired).toBe(true);
    expect(req.byoLlmConnection).toBeUndefined();
  });

  it('stamps the canonical Sales Gemini record only when bot-default is selected', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-sub');
    const req = request();
    const resolveConnection = vi.fn();
    const runtimeParamsResolver = vi.fn().mockResolvedValue({
      providerId: 'gemini',
      model: 'gemini-3.8-flash',
      configVersion: 2,
      fallbackOrder: ['openai-codex'],
    });
    await stampRemoteBrain(POOL, CLI_AGENT, req, {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver,
      resolveConnection,
    });
    expect(runtimeParamsResolver).toHaveBeenCalledWith(CLI_AGENT);
    expect(req).toMatchObject({
      providerId: 'gemini',
      model: 'gemini-3.8-flash',
      configVersion: 2,
      fallbackOrder: ['openai-codex'],
      providerConfigRequired: true,
    });
    expect(req.byoLlmConnection).toBeUndefined();
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('degrades a guest bot-default CLI record to the hosted ladder and clears stale authority', async () => {
    const req = request({
      userSub: 'guest-visitor',
      model: 'stale-model',
      configVersion: 41,
      fallbackOrder: ['stale-fallback'],
      providerConfigRequired: true,
    });
    const resolveConnection = vi.fn().mockResolvedValue({
      baseUrl: 'https://guest-lane.example/v1', apiKey: 'guest-key', model: 'hosted-model',
    });

    const runtimeParamsResolver = vi.fn().mockResolvedValue({ providerId: 'gemini', model: 'gemini-3.8-flash' });
    await stampRemoteBrain(POOL, CLI_AGENT, req, {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver,
      resolveConnection,
    });

    expect(resolveConnection).toHaveBeenCalledWith(POOL, 'guest-visitor');
    expect(runtimeParamsResolver).not.toHaveBeenCalled();
    expect(req.byoLlmConnection).toEqual({
      baseUrl: 'https://guest-lane.example/v1', apiKey: 'guest-key', model: 'hosted-model',
    });
    expect(req.providerId).toBeUndefined();
    expect(req.model).toBeUndefined();
    expect(req.configVersion).toBeUndefined();
    expect(req.fallbackOrder).toBeUndefined();
    expect(req.providerConfigRequired).toBeUndefined();
  });

  it('refuses honestly when a guest bot-default CLI record has no hosted fallback', async () => {
    const runtimeParamsResolver = vi.fn().mockResolvedValue({ providerId: 'gemini', model: 'gemini-3.8-flash' });
    await expect(stampRemoteBrain(POOL, CLI_AGENT, request({ userSub: 'guest-visitor' }), {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver,
      resolveConnection: vi.fn().mockResolvedValue(undefined),
    })).rejects.toBeInstanceOf(NoHostedBrainError);
    expect(runtimeParamsResolver).not.toHaveBeenCalled();
  });

  it('keeps a bot-default CLI record for the exact demo deployment operator', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-sub');
    const req = request();
    const resolveConnection = vi.fn();
    await stampRemoteBrain(POOL, CLI_AGENT, req, {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver: vi.fn().mockResolvedValue({ providerId: 'openai-codex', model: 'gpt-5.5' }),
      resolveConnection,
    });
    expect(req).toMatchObject({
      providerId: 'openai-codex', model: 'gpt-5.5', providerConfigRequired: true,
    });
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('falls through on an honestly absent bot-default record but propagates resolver outages', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-sub');
    const absent = request();
    await stampRemoteBrain(POOL, CLI_AGENT, absent, {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver: vi.fn().mockResolvedValue(null),
      resolveConnection: vi.fn().mockResolvedValue({ baseUrl: 'https://lane/v1', apiKey: 'k', model: 'm' }),
    });
    expect(absent.byoLlmConnection).toEqual({ baseUrl: 'https://lane/v1', apiKey: 'k', model: 'm' });

    const outage = new Error('provider switch snapshot unavailable');
    const resolveConnection = vi.fn();
    await expect(stampRemoteBrain(POOL, CLI_AGENT, request(), {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver: vi.fn().mockRejectedValue(outage),
      resolveConnection,
    })).rejects.toBe(outage);
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  it('clears stale optional authority fields omitted by the canonical bot record', async () => {
    vi.stubEnv('DEMO_MODE', 'true');
    vi.stubEnv('OSHAL_OPERATOR_SUBS', 'operator-sub');
    const req = request({
      model: 'stale-user-model',
      configVersion: 999,
      fallbackOrder: ['openai-codex'],
      providerConfigRequired: false,
    });
    const runtimeParamsResolver = vi.fn().mockResolvedValue({ providerId: 'gemini' });

    await stampRemoteBrain(POOL, CLI_AGENT, req, {
      ...overrides({ kind: 'bot-default' }),
      runtimeParamsResolver,
    });

    expect(req.providerId).toBe('gemini');
    expect(req.providerConfigRequired).toBe(true);
    expect(req.model).toBeUndefined();
    expect(req.configVersion).toBeUndefined();
    expect(req.fallbackOrder).toBeUndefined();
  });

  it('preserves an explicit OpenAI Codex user preference above the Sales bot default', async () => {
    const req = request();
    const runtimeParamsResolver = vi.fn().mockResolvedValue({
      providerId: 'gemini', model: 'gemini-3.8-flash', configVersion: 2,
    });
    await stampRemoteBrain(POOL, CLI_AGENT, req, {
      ...overrides({ kind: 'cli', providerId: 'openai-codex', model: 'gpt-5.5' }),
      runtimeParamsResolver,
    });
    expect(req).toMatchObject({
      providerId: 'openai-codex', model: 'gpt-5.5', providerConfigRequired: true,
    });
    expect(runtimeParamsResolver).not.toHaveBeenCalled();
  });

  it('threads a resolved hosted brain as the byoLlmConnection wire trio, metadata stripped', async () => {
    const req = request({ userSub: 'guest-visitor' });
    await stampRemoteBrain(POOL, CLI_AGENT, req, overrides({
      kind: 'hosted',
      connection: {
        baseUrl: 'https://lane.example/v1', apiKey: 'k', model: 'm-1',
        resolutionSource: 'free-tier', connectionId: 42,
      },
    }));
    expect(req.byoLlmConnection).toEqual({ baseUrl: 'https://lane.example/v1', apiKey: 'k', model: 'm-1' });
    expect(req.providerConfigRequired).toBeUndefined();
    expect(req.providerId).toBeUndefined();
  });

  it('never consults the ladder when the caller already threaded a connection or provider', async () => {
    const threaded = { baseUrl: 'https://mine.example/v1', apiKey: 'mine', model: 'mine-1' };
    const byoSeams = overrides({ kind: 'cli', providerId: 'claude-code' });
    const byoReq = request({ byoLlmConnection: { ...threaded } });
    await stampRemoteBrain(POOL, CLI_AGENT, byoReq, byoSeams);
    expect(byoReq.byoLlmConnection).toEqual(threaded);
    expect(byoSeams.resolveBrain).not.toHaveBeenCalled();

    const stampSeams = overrides({ kind: 'hosted', connection: { baseUrl: 'x', apiKey: 'y', model: 'z' } });
    const stampedReq = request({ providerId: 'openai-codex' });
    await stampRemoteBrain(POOL, CLI_AGENT, stampedReq, stampSeams);
    expect(stampedReq.providerId).toBe('openai-codex');
    expect(stampedReq.byoLlmConnection).toBeUndefined();
    expect(stampSeams.resolveBrain).not.toHaveBeenCalled();
  });

  it('leaves identity-less dispatches and non-CLI-harness nodes untouched', async () => {
    const anonSeams = overrides({ kind: 'cli', providerId: 'claude-code' });
    const anonReq = request({ userSub: undefined });
    await stampRemoteBrain(POOL, CLI_AGENT, anonReq, anonSeams);
    expect(anonReq.providerId).toBeUndefined();
    expect(anonSeams.resolveBrain).not.toHaveBeenCalled();

    const hostedSeams = overrides({ kind: 'cli', providerId: 'claude-code' });
    const hostedReq = request({ agentId: 'aa000000-0000-0000-0000-000000000002' });
    await stampRemoteBrain(POOL, 'aa000000-0000-0000-0000-000000000002', hostedReq, hostedSeams);
    expect(hostedReq.providerId).toBeUndefined();
    expect(hostedSeams.resolveBrain).not.toHaveBeenCalled();
  });

  it('refuses with NO_HOSTED_BRAIN when a CLI-harness node caller has nothing on the ladder', async () => {
    await expect(stampRemoteBrain(POOL, CLI_AGENT, request({ userSub: 'guest-visitor' }), overrides({ kind: 'none' })))
      .rejects.toBeInstanceOf(NoHostedBrainError);
  });

  it('dispatches unstamped when the ladder itself fails (infra error is not "no brain")', async () => {
    const req = request();
    await stampRemoteBrain(POOL, CLI_AGENT, req, overrides(undefined, { reject: true }));
    expect(req.providerId).toBeUndefined();
    expect(req.byoLlmConnection).toBeUndefined();
  });
});
