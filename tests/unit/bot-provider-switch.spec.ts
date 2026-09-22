/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for "a bot's LLM provider is a row in a table, not a literal in the registry": each precedence rung (bot row > fleet default > registry), the byte-identical no-row case, the fail-closed unknown id, the a2a exclusions, and the catalog pinned to the REAL HARNESS_FACTORIES + provider-definitions so the accepted-id set cannot drift from what the build can run. Pure rule, no doubles.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | requireModelForClineBackedId: a Cline-backed id with no model (null, blank, the auto sentinel) is refused with a reason naming the seed fallback; the same id with a model, and a native id without one, pass.
 */

import { describe, expect, it } from 'vitest';
import {
  FLEET_DEFAULT_SWITCH_ID,
  classifyProviderId,
  requireModelForClineBackedId,
  resolveBotProviderSwitch,
  resolveEffectiveBotProvider,
  type ProviderSwitchCatalog,
  type ProviderSwitchRow,
} from '@/shared/llm-runtime';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { PROVIDER_DEFINITIONS } from '@/features/llm-provider/services/provider-definitions';

/** The catalog exactly as the running api builds it: real factory keys, real provider ids. */
const CATALOG: ProviderSwitchCatalog = {
  harnessTypes: Object.keys(HARNESS_FACTORIES),
  clineApiProviders: PROVIDER_DEFINITIONS.map((p) => p.id),
};

const CODEX_REGISTRY = { harnessType: 'codex-cli', apiType: 'openai-codex' };
const A2A_REGISTRY = { harnessType: 'a2a', apiType: 'a2a' };

function row(scopeId: string, providerId: string, modelId: string | null = null): ProviderSwitchRow {
  return { scopeId, providerId, modelId, updatedBy: 'operator', updatedAt: '2026-09-17T00:00:00Z' };
}

describe('bot-provider-switch: the ladder, rung by rung', () => {
  it('no rows anywhere resolves to the registry literal, byte-identically', () => {
    const r = resolveBotProviderSwitch({ registry: CODEX_REGISTRY, catalog: CATALOG });
    expect(r).toEqual({
      ok: true, source: 'registry', providerId: 'openai-codex', harnessType: 'codex-cli',
      apiType: 'openai-codex', modelId: null, row: null,
    });
    // ...and a bot the registry does not know resolves to nothing, exactly as today.
    const unknown = resolveBotProviderSwitch({ registry: null, catalog: CATALOG });
    expect(unknown).toMatchObject({ ok: true, source: 'registry', providerId: null, harnessType: null });
  });

  it('a per-bot row overrides the registry literal', () => {
    const r = resolveBotProviderSwitch({
      botRow: row('a0000000-0000-0000-0000-000000000001', 'claude-code', 'claude-sonnet-4-6'),
      registry: CODEX_REGISTRY, catalog: CATALOG,
    });
    expect(r).toMatchObject({
      ok: true, source: 'bot-row', providerId: 'claude-code', harnessType: 'claude-code',
      apiType: 'claude-code', modelId: 'claude-sonnet-4-6',
    });
  });

  it('a fleet-default row overrides the registry for a bot WITHOUT its own row', () => {
    const r = resolveBotProviderSwitch({
      fleetRow: row(FLEET_DEFAULT_SWITCH_ID, 'gemini', 'gemini-3.8-flash'),
      registry: CODEX_REGISTRY, catalog: CATALOG,
    });
    expect(r).toMatchObject({
      ok: true, source: 'fleet-default', providerId: 'gemini', harnessType: 'cline', apiType: 'gemini',
      modelId: 'gemini-3.8-flash',
    });
  });

  it('a per-bot row beats the fleet default', () => {
    const r = resolveBotProviderSwitch({
      botRow: row('a0000000-0000-0000-0000-000000000001', 'openai-codex', 'gpt-5.5'),
      fleetRow: row(FLEET_DEFAULT_SWITCH_ID, 'gemini', 'gemini-3.8-flash'),
      registry: CODEX_REGISTRY, catalog: CATALOG,
    });
    expect(r).toMatchObject({ ok: true, source: 'bot-row', providerId: 'openai-codex', harnessType: 'codex-cli' });
  });

  it('an unknown provider id on a winning row is REFUSED with a reason — never a silent fall-through', () => {
    const r = resolveBotProviderSwitch({
      botRow: row('a0000000-0000-0000-0000-000000000001', 'gemini-3.8-flash'),
      registry: CODEX_REGISTRY, catalog: CATALOG,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.source).toBe('bot-row');
    expect(r.reason).toMatch(/unknown provider id 'gemini-3.8-flash'/);
    expect(r.reason).toMatch(/accepted ids: .*codex-cli.*gemini/);
    // The refusal must NOT carry the registry's harness — that is what "fall through" would look like.
    expect((r as unknown as { harnessType?: string }).harnessType).toBeUndefined();

    const fleet = resolveBotProviderSwitch({
      fleetRow: row(FLEET_DEFAULT_SWITCH_ID, 'not-a-provider'), registry: CODEX_REGISTRY, catalog: CATALOG,
    });
    expect(fleet).toMatchObject({ ok: false, source: 'fleet-default', providerId: 'not-a-provider' });
  });

  it('the fleet default never reaches an a2a boundary or a bot the registry does not know', () => {
    const fleetRow = row(FLEET_DEFAULT_SWITCH_ID, 'claude-code');
    expect(resolveBotProviderSwitch({ fleetRow, registry: A2A_REGISTRY, catalog: CATALOG }))
      .toMatchObject({ source: 'registry', harnessType: 'a2a' });
    expect(resolveBotProviderSwitch({ fleetRow, registry: null, catalog: CATALOG }))
      .toMatchObject({ source: 'registry', harnessType: null });
    // A per-bot row is explicit and still applies to a bot the registry does not know.
    expect(resolveBotProviderSwitch({ botRow: row('x', 'claude-code'), registry: null, catalog: CATALOG }))
      .toMatchObject({ source: 'bot-row', harnessType: 'claude-code' });
  });
});

describe('bot-provider-switch: what an id means', () => {
  it('harness keys and their provider-id aliases land on the same harness', () => {
    for (const id of ['codex-cli', 'openai-codex', 'OpenAI-Codex']) {
      expect(classifyProviderId(id, CATALOG)).toMatchObject({ ok: true, harnessType: 'codex-cli', apiType: 'openai-codex', botNodeRuntime: 'openai-codex' });
    }
    expect(classifyProviderId('claude-code', CATALOG)).toMatchObject({ ok: true, harnessType: 'claude-code', botNodeRuntime: 'claude-code' });
    expect(classifyProviderId('antigravity-cli', CATALOG)).toMatchObject({
      ok: true, harnessType: 'antigravity-cli', botNodeRuntime: 'antigravity-cli',
    });
    for (const id of ['cline', 'cline-cli']) {
      expect(classifyProviderId(id, CATALOG)).toMatchObject({ ok: true, harnessType: 'cline', apiType: null, botNodeRuntime: 'cline-cli' });
    }
    // Api-side-only harnesses have no bot-node runtime and say so.
    expect(classifyProviderId('gemini-cli', CATALOG)).toMatchObject({ ok: true, harnessType: 'gemini-cli', apiType: 'google-gemini', botNodeRuntime: null });
  });

  it('a Cline-backed API provider id runs through the cline harness with that id as apiType', () => {
    expect(classifyProviderId('gemini', CATALOG)).toEqual({
      ok: true, providerId: 'gemini', harnessType: 'cline', apiType: 'gemini', botNodeRuntime: 'cline-cli', clineApiProvider: 'gemini',
    });
    // The catalog's own spelling is answered, so a differently-cased row still reaches the definition.
    expect(classifyProviderId('nousresearch', CATALOG)).toMatchObject({ ok: true, apiType: 'nousResearch' });
  });

  it('REGRESSION: a Cline-backed id with no model is refused — the Cline runtime would fall back to the container seed model', () => {
    const gemini = classifyProviderId('gemini', CATALOG);
    const codex = classifyProviderId('codex-cli', CATALOG);
    expect(gemini.ok && codex.ok).toBe(true);
    if (!gemini.ok || !codex.ok) return;
    expect(requireModelForClineBackedId(gemini, null)).toMatchObject({
      ok: false, providerId: 'gemini', reason: expect.stringMatching(/needs a modelId.*FORCE_LLM_MODEL/),
    });
    expect(requireModelForClineBackedId(gemini, '   ')).toMatchObject({ ok: false });
    expect(requireModelForClineBackedId(gemini, 'auto')).toMatchObject({ ok: false });
    expect(requireModelForClineBackedId(gemini, 'gemini-3.8-flash')).toBeNull();
    // A native harness id keeps its own runtime default: the seed is that runtime's model.
    expect(requireModelForClineBackedId(codex, null)).toBeNull();
  });

  it('a2a, the auto sentinel and blanks are refused with reasons', () => {
    expect(classifyProviderId('a2a', CATALOG)).toMatchObject({ ok: false, reason: expect.stringMatching(/external-agent boundary/) });
    expect(classifyProviderId('auto', CATALOG)).toMatchObject({ ok: false, reason: expect.stringMatching(/non-empty/) });
    expect(classifyProviderId('   ', CATALOG)).toMatchObject({ ok: false });
    expect(classifyProviderId(null, CATALOG)).toMatchObject({ ok: false });
  });

  it('the accepted-id set is pinned to the REAL build: every HARNESS_FACTORIES key but a2a, every provider definition', () => {
    for (const key of Object.keys(HARNESS_FACTORIES)) {
      const c = classifyProviderId(key, CATALOG);
      if (key === 'a2a') expect(c.ok).toBe(false);
      else expect(c, key).toMatchObject({ ok: true, harnessType: key });
    }
    for (const def of PROVIDER_DEFINITIONS) {
      expect(classifyProviderId(def.id, CATALOG).ok, def.id).toBe(true);
    }
    // A catalog missing the cline harness cannot accept a Cline-backed id — no harness, no route.
    expect(classifyProviderId('gemini', { harnessTypes: ['codex-cli'], clineApiProviders: ['gemini'] }).ok).toBe(false);
  });
});

describe('bot-provider-switch: the surface rule reports the switch rung', () => {
  it('a switch row is reported as the source with the row model, and the registry is no longer a ceiling', () => {
    const resolution = resolveBotProviderSwitch({
      botRow: row('a', 'claude-code', 'claude-sonnet-4-6'), registry: CODEX_REGISTRY, catalog: CATALOG,
    });
    const r = resolveEffectiveBotProvider({ ...CODEX_REGISTRY, dbProviderId: 'anthropic', switchResolution: resolution });
    expect(r.providerSource).toBe('bot-row');
    expect(r.effectiveProvider).toBe('claude-code');
    expect(r.effectiveModel).toBe('claude-sonnet-4-6');
    expect(r.providerOverridable).toBe(true);
    expect(r.precedenceNote).toMatch(/harness 'claude-code'/);

    const fleet = resolveEffectiveBotProvider({
      ...CODEX_REGISTRY,
      switchResolution: resolveBotProviderSwitch({ fleetRow: row(FLEET_DEFAULT_SWITCH_ID, 'gemini'), registry: CODEX_REGISTRY, catalog: CATALOG }),
    });
    expect(fleet.providerSource).toBe('fleet-default');
    expect(fleet.effectiveProvider).toBe('gemini');
  });

  it('a refused row is reported as switch-refused with the reason, never as the registry provider', () => {
    const r = resolveEffectiveBotProvider({
      ...CODEX_REGISTRY,
      switchResolution: resolveBotProviderSwitch({ botRow: row('a', 'nope'), registry: CODEX_REGISTRY, catalog: CATALOG }),
    });
    expect(r.providerSource).toBe('switch-refused');
    expect(r.effectiveProvider).toBe('nope');
    expect(r.precedenceNote).toMatch(/cannot run/);
    expect(r.precedenceNote).toMatch(/unknown provider id 'nope'/);
  });

  it('a registry-sourced resolution defers to the legacy ladder exactly as before', () => {
    const resolution = resolveBotProviderSwitch({ registry: CODEX_REGISTRY, catalog: CATALOG });
    const withSwitch = resolveEffectiveBotProvider({ ...CODEX_REGISTRY, dbProviderId: 'anthropic', switchResolution: resolution });
    const without = resolveEffectiveBotProvider({ ...CODEX_REGISTRY, dbProviderId: 'anthropic' });
    expect(withSwitch).toEqual(without);
    expect(withSwitch.providerSource).toBe('registry-harness');
    // The LEGACY per-bot record still does not outrank a declared harness — the 11 stale rows on
    // the operator box (8 of them claude-code) stay inert when this lands.
    expect(withSwitch.effectiveProvider).toBe('openai-codex');
  });
});
