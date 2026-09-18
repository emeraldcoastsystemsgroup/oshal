/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Named guard bot-node-switch-translation ("A bot's LLM provider is a row in a table", bot-node half): a switch row's id lands on the runtime that executes it — a runtime name/alias natively, a Cline-backed API provider id (from the REAL provider-definitions) on cline-cli fronting that id with CLINE_API_PROVIDER/CLINE_API_MODEL set and the container's own seeds restored on the way back; an id nothing knows resolves to null; and the ADR-034 reconcile + post-execution match accept exactly 'cline-cli fronting gemini' for a carried 'gemini' while still refusing cline-cli fronting anything else. The runtime seam is doubled (the real one is bot-node-runtime.ts, whose setActiveProvider is a thin call into these functions).
 */

import { describe, expect, it } from 'vitest';
import {
  createClineBackingEnv,
  dispatchProviderMatches,
  resolveBotNodeSwitch,
} from '@/app/bot-node-provider-switch';
import {
  dispatchConfigMatchesActive,
  reconcileDispatchProviderConfig,
  type DispatchConfigRuntime,
} from '@/app/bot-node-dispatch-config';
import type { ActiveBotNodeProvider } from '@/app/bot-node-llm-provider-route';
import { PROVIDER_DEFINITIONS } from '@/features/llm-provider/services/provider-definitions';

const CLINE_IDS = PROVIDER_DEFINITIONS.map((p) => p.id);
const ALL_BUILT = { 'openai-codex': {}, 'claude-code': {}, 'cline-cli': {} };
const NO_CLINE = { 'openai-codex': {}, 'claude-code': {}, 'cline-cli': null };
const quiet = { warn: () => undefined, debug: () => undefined };

describe('bot-node-switch-translation', () => {
  it('a runtime name or alias lands natively; a Cline-backed id lands on cline-cli fronting that id', () => {
    expect(resolveBotNodeSwitch('codex-cli', ALL_BUILT, CLINE_IDS)).toEqual({ runtime: 'openai-codex', apiProvider: null });
    expect(resolveBotNodeSwitch('openai-codex', ALL_BUILT, CLINE_IDS)).toEqual({ runtime: 'openai-codex', apiProvider: null });
    expect(resolveBotNodeSwitch('claude-code', ALL_BUILT, CLINE_IDS)).toEqual({ runtime: 'claude-code', apiProvider: null });
    expect(resolveBotNodeSwitch('cline', ALL_BUILT, CLINE_IDS)).toEqual({ runtime: 'cline-cli', apiProvider: null });
    expect(CLINE_IDS).toContain('gemini');
    expect(resolveBotNodeSwitch('gemini', ALL_BUILT, CLINE_IDS)).toEqual({ runtime: 'cline-cli', apiProvider: 'gemini' });
    // Case-insensitive on the way in, the catalog's own spelling on the way out.
    const camel = CLINE_IDS.find((id) => id !== id.toLowerCase());
    if (camel) expect(resolveBotNodeSwitch(camel.toLowerCase(), ALL_BUILT, CLINE_IDS)).toEqual({ runtime: 'cline-cli', apiProvider: camel });
  });

  it('an id nothing knows, or a Cline-backed id when cline did not build, resolves to null (the caller refuses by name)', () => {
    expect(resolveBotNodeSwitch('gemini-3.8-flash', ALL_BUILT, CLINE_IDS)).toBeNull();
    expect(resolveBotNodeSwitch('', ALL_BUILT, CLINE_IDS)).toBeNull();
    expect(resolveBotNodeSwitch('gemini', NO_CLINE, CLINE_IDS)).toBeNull();
    expect(resolveBotNodeSwitch('cline-cli', NO_CLINE, CLINE_IDS)).toBeNull();
    expect(resolveBotNodeSwitch('openai-codex', NO_CLINE, CLINE_IDS)).toEqual({ runtime: 'openai-codex', apiProvider: null });
  });

  it('the Cline backing env is set for a switch and the container seeds are restored on the way back', () => {
    const env: NodeJS.ProcessEnv = { CLINE_API_PROVIDER: 'anthropic', CLINE_API_MODEL: 'claude-sonnet-4-6' };
    const backing = createClineBackingEnv(env);
    expect(backing.apply('gemini', 'gemini-3.8-flash')).toEqual(['CLINE_API_PROVIDER', 'CLINE_API_MODEL']);
    expect(env).toEqual({ CLINE_API_PROVIDER: 'gemini', CLINE_API_MODEL: 'gemini-3.8-flash' });
    expect(backing.apply('openrouter', undefined)).toEqual(['CLINE_API_PROVIDER']);
    expect(env).toEqual({ CLINE_API_PROVIDER: 'openrouter' });
    expect(backing.apply(null, undefined)).toEqual([]);
    expect(env).toEqual({ CLINE_API_PROVIDER: 'anthropic', CLINE_API_MODEL: 'claude-sonnet-4-6' });
    // With no seeds, restoring means removing.
    const bare: NodeJS.ProcessEnv = {};
    const bareBacking = createClineBackingEnv(bare);
    bareBacking.apply('gemini', 'gemini-3.8-flash');
    bareBacking.apply(null, undefined);
    expect(bare).toEqual({});
  });

  it('what ran == what was authorized, across the translation and nowhere else', () => {
    const clineOnGemini: ActiveBotNodeProvider = { provider: 'cline-cli', model: 'gemini-3.8-flash', apiProvider: 'gemini' };
    expect(dispatchProviderMatches('gemini', clineOnGemini)).toBe(true);
    expect(dispatchProviderMatches('Gemini', clineOnGemini)).toBe(true);
    expect(dispatchProviderMatches('cline-cli', clineOnGemini)).toBe(true);
    expect(dispatchProviderMatches('anthropic', clineOnGemini)).toBe(false);
    expect(dispatchProviderMatches('gemini', { provider: 'cline-cli', model: 'x', apiProvider: 'anthropic' })).toBe(false);
    expect(dispatchProviderMatches('gemini', { provider: 'cline-cli', model: 'x' })).toBe(false);
    expect(dispatchProviderMatches('gemini', { provider: 'openai-codex', model: 'gpt-5.5', apiProvider: 'gemini' })).toBe(false);
    expect(dispatchProviderMatches('codex-cli', { provider: 'openai-codex', model: 'gpt-5.5' })).toBe(true);
    // The model still has to match exactly when the record names one.
    expect(dispatchConfigMatchesActive({ providerId: 'gemini', model: 'gemini-3.8-flash' }, clineOnGemini)).toBe(true);
    expect(dispatchConfigMatchesActive({ providerId: 'gemini', model: 'gemini-2.5-flash' }, clineOnGemini)).toBe(false);
  });

  it('the ADR-034 reconcile corrects an idle bot onto the row and the post-check accepts the corrected identity', () => {
    let active: ActiveBotNodeProvider = { provider: 'openai-codex', model: 'gpt-5.5', apiProvider: null };
    const calls: Array<[string, string | undefined]> = [];
    const runtime: DispatchConfigRuntime = {
      getActiveProvider: () => active,
      setActiveProvider: (provider, model) => {
        calls.push([provider, model]);
        const target = resolveBotNodeSwitch(provider, ALL_BUILT, CLINE_IDS);
        if (!target) throw new Error(`unknown ${provider}`);
        active = { provider: target.runtime, model: model ?? 'default', apiProvider: target.apiProvider };
        return active;
      },
    };
    const carried = { providerId: 'gemini', model: 'gemini-3.8-flash', configVersion: 9 };
    const outcome = reconcileDispatchProviderConfig(carried, runtime, { taskId: 't1' }, quiet);
    expect(outcome).toEqual({ action: 'corrected', active: { provider: 'cline-cli', model: 'gemini-3.8-flash', apiProvider: 'gemini' } });
    expect(calls).toEqual([['gemini', 'gemini-3.8-flash']]);
    // The post-execution check: the runtime reports cline-cli; the enforced identity fronts gemini.
    expect(dispatchConfigMatchesActive(carried, { provider: 'cline-cli', model: 'gemini-3.8-flash', apiProvider: outcome.active?.apiProvider })).toBe(true);
    // Already on the row: no switch call.
    expect(reconcileDispatchProviderConfig(carried, runtime, { taskId: 't2' }, quiet)).toMatchObject({ action: 'match' });
    expect(calls).toHaveLength(1);
    // Back to codex is the same one-row path in the other direction.
    expect(reconcileDispatchProviderConfig({ providerId: 'codex-cli', model: 'gpt-5.5' }, runtime, { taskId: 't3' }, quiet))
      .toEqual({ action: 'corrected', active: { provider: 'openai-codex', model: 'gpt-5.5', apiProvider: null } });
    // An id nothing knows is refused, and the active identity is untouched.
    expect(() => reconcileDispatchProviderConfig({ providerId: 'gemini-3.8-flash' }, runtime, { taskId: 't4' }, quiet))
      .toThrow(/Authoritative provider config is unavailable for gemini-3.8-flash/);
    expect(active).toEqual({ provider: 'openai-codex', model: 'gpt-5.5', apiProvider: null });
  });
});
