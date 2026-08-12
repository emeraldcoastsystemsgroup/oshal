/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-127 remote-brain guards for stampRemoteBrain: a CLI-harness node dispatch carries the caller's resolved brain (cli → the ADR-034 providerId/model stamp; hosted → the byoLlmConnection wire trio with resolver metadata stripped), explicit caller choices and identity-less/hosted-harness dispatches pass through with the ladder never consulted, an empty ladder refuses with NO_HOSTED_BRAIN, and a ladder FAILURE dispatches unstamped (fail-open) — the exact behaviours that keep the operator's mounted-CLI turns and guest hosted turns from regressing onto a node's static default.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  NoHostedBrainError,
  stampRemoteBrain,
  type HostedBrainResolutionOverrides,
} from '../../src/app/routes/inline-bot-execution';
import type { AppContext } from '../../src/app/composition/app-context';
import type { BotNodeRequest } from '../../src/features/agent-management';

const POOL = {} as AppContext['pool'];
const CLI_AGENT = 'cb000000-0000-0000-0000-000000000001';

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
  it('stamps a resolved CLI brain as the authoritative dispatch provider (+ model pin)', async () => {
    const req = request();
    await stampRemoteBrain(POOL, CLI_AGENT, req, overrides({ kind: 'cli', providerId: 'claude-code', model: 'claude-sonnet-4-6' }));
    expect(req.providerId).toBe('claude-code');
    expect(req.model).toBe('claude-sonnet-4-6');
    expect(req.byoLlmConnection).toBeUndefined();
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
