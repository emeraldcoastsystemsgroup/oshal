/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for ADR-034 push-on-dispatch (gap b) substrate: the controller-side resolver (dispatch-runtime-params.ts) and the bot-side reconciler (bot-node-dispatch-config.ts). Proves the load-bearing invariant — ABSENT carried config = byte-identical legacy dispatch (runtime untouched) — plus divergence self-correction, fail-open on an un-switchable provider, fail-open resolver errors, and the "no providerId = not actionable" contract. Both modules are complete + tested here; wiring them into the live dispatch/execution paths is the remaining reviewed step (see burndown ADR-034 gap b).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createAgentConfigRuntimeParamsResolver,
  resolveDispatchConfigFields,
} from '../../src/features/agent-management/services/dispatch-runtime-params';
import {
  parseCarriedDispatchConfig,
  reconcileDispatchProviderConfig,
  type DispatchConfigRuntime,
} from '../../src/app/bot-node-dispatch-config';

const silentLog = { warn: vi.fn(), debug: vi.fn() };

function fakeRuntime(active: { provider: string; model: string | null }): DispatchConfigRuntime & { switches: Array<{ p: string; m?: string }> } {
  const switches: Array<{ p: string; m?: string }> = [];
  let current = { ...active };
  return {
    switches,
    getActiveProvider: () => ({ provider: current.provider, model: current.model }),
    setActiveProvider: (provider: string, model?: string) => {
      switches.push({ p: provider, m: model });
      current = { provider, model: model ?? current.model };
      return { provider: current.provider, model: current.model };
    },
  };
}

describe('dispatch-runtime-params (controller half)', () => {
  it('resolveDispatchConfigFields returns {} with no resolver (legacy dispatch, no lookup)', async () => {
    expect(await resolveDispatchConfigFields(undefined, 'a1')).toEqual({});
  });

  it('shapes a resolved record into spreadable fields', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver({
      getConfig: async () => ({ values: { providerId: 'openai-codex', modelId: 'gpt-5', configVersion: 7 } }) as never,
    });
    expect(await resolveDispatchConfigFields(resolver, 'a1')).toEqual({
      providerId: 'openai-codex', model: 'gpt-5', configVersion: 7,
    });
  });

  it('treats a record without a providerId as not actionable (null → {})', async () => {
    const resolver = createAgentConfigRuntimeParamsResolver({
      getConfig: async () => ({ values: { modelId: 'gpt-5' } }) as never,
    });
    expect(await resolveDispatchConfigFields(resolver, 'a1')).toEqual({});
  });

  it('FAILS OPEN on a resolver error — dispatch stays legacy, never throws', async () => {
    const resolver = () => { throw new Error('config store down'); };
    expect(await resolveDispatchConfigFields(resolver as never, 'a1')).toEqual({});
  });
});

describe('bot-node-dispatch-config (bot half)', () => {
  it('parseCarriedDispatchConfig returns null when providerId is absent/blank (opt-in)', () => {
    expect(parseCarriedDispatchConfig(undefined)).toBeNull();
    expect(parseCarriedDispatchConfig({})).toBeNull();
    expect(parseCarriedDispatchConfig({ providerId: '  ' })).toBeNull();
    expect(parseCarriedDispatchConfig({ model: 'gpt-5', configVersion: 3 })).toBeNull();
  });

  it('parses a well-formed carried record and drops junk fields', () => {
    expect(parseCarriedDispatchConfig({ providerId: 'openai-codex', model: 'gpt-5', configVersion: 4 }))
      .toEqual({ providerId: 'openai-codex', model: 'gpt-5', configVersion: 4 });
    expect(parseCarriedDispatchConfig({ providerId: 'cline-cli', model: '', configVersion: 'x' }))
      .toEqual({ providerId: 'cline-cli' });
  });

  it('ABSENT carried config leaves the runtime untouched (byte-identical legacy dispatch)', () => {
    const rt = fakeRuntime({ provider: 'openai-codex', model: 'gpt-5' });
    const out = reconcileDispatchProviderConfig(null, rt, {}, silentLog);
    expect(out.action).toBe('absent');
    expect(rt.switches).toHaveLength(0);
  });

  it('matching config does not switch', () => {
    const rt = fakeRuntime({ provider: 'openai-codex', model: 'gpt-5' });
    const out = reconcileDispatchProviderConfig({ providerId: 'openai-codex', model: 'gpt-5' }, rt, {}, silentLog);
    expect(out.action).toBe('match');
    expect(rt.switches).toHaveLength(0);
  });

  it('divergent config self-corrects via setActiveProvider before executing', () => {
    const rt = fakeRuntime({ provider: 'cline-cli', model: 'sonnet' });
    const out = reconcileDispatchProviderConfig({ providerId: 'openai-codex', model: 'gpt-5', configVersion: 9 }, rt, { taskId: 't1' }, silentLog);
    expect(out.action).toBe('corrected');
    expect(rt.switches).toEqual([{ p: 'openai-codex', m: 'gpt-5' }]);
    expect(out.active).toEqual({ provider: 'openai-codex', model: 'gpt-5' });
  });

  it('FAILS OPEN when the carried provider cannot be switched to — executes self-resolved', () => {
    const rt = fakeRuntime({ provider: 'cline-cli', model: 'sonnet' });
    rt.setActiveProvider = () => { throw new Error('unknown provider'); };
    const out = reconcileDispatchProviderConfig({ providerId: 'bogus-provider' }, rt, {}, silentLog);
    expect(out.action).toBe('failed-open');
    expect(out.active).toEqual({ provider: 'cline-cli', model: 'sonnet' });
  });
});
