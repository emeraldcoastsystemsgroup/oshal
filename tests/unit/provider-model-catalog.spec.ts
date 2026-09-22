/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the silent model id. The operator configured gemini-3.8-flash — a real, current, stable Google model — and this build's catalog did not carry it, so nothing anywhere said so: the provider id was validated against the runnable catalog and the model against nothing at all. Three gates: checkModelAgainstCatalog reports the operator's exact case with the id, the provider and the available ids (and stays silent when it cannot know); the catalog carries no model the vendor has RETIRED; and every model id configured in this repo resolves in its provider's catalog, with the two known-stale lane defaults named explicitly so a third cannot appear quietly.
 */

import { describe, expect, it } from 'vitest';
import { checkModelAgainstCatalog, type ProviderSwitchCatalog } from '@/shared/llm-runtime';
import { HARNESS_FACTORIES } from '@/app/composition/provider-runtime';
import { buildProviderSwitchCatalog } from '@/app/composition/provider-switch-runtime';
import { PROVIDER_DEFINITIONS } from '@/features/llm-provider/services/provider-definitions';
import { OPENAI_COMPAT_LANES } from '@/app/routes/openai-compat-lanes';

/** The catalog exactly as the running api builds it — real factory keys, real provider records. */
const CATALOG: ProviderSwitchCatalog = buildProviderSwitchCatalog(Object.keys(HARNESS_FACTORIES));

const providerById = new Map(PROVIDER_DEFINITIONS.map((p) => [p.id, p]));

/**
 * Model ids their vendor has RETIRED or SHUT DOWN: naming one is always wrong, whatever our
 * catalog's staleness, because the id cannot answer. Unlike "absent from our list", this is a
 * positive fact we assert, so it is checked as an absolute. Each entry carries its source.
 */
const RETIRED_MODEL_IDS: ReadonlyArray<{ providerId: string; modelId: string; source: string }> = [
  // ai.google.dev/gemini-api/docs/models, read 2026-09-21: the 2.0 line is listed "shut down".
  { providerId: 'gemini', modelId: 'gemini-2.0-flash', source: 'ai.google.dev/gemini-api/docs/models (2026-09-21)' },
  { providerId: 'gemini', modelId: 'gemini-2.0-flash-001', source: 'ai.google.dev/gemini-api/docs/models (2026-09-21)' },
  { providerId: 'gemini', modelId: 'gemini-2.0-flash-lite', source: 'ai.google.dev/gemini-api/docs/models (2026-09-21)' },
];

/**
 * Configured model ids in this repo that their provider's catalog does not carry, TODAY, and that
 * this change does not fix. Both are real current vendor ids whose catalogs here are placeholder
 * or short — the same staleness class the Gemini refresh addresses, in providers this PR does not
 * touch. Listed so the gate below is green and honest rather than quarantined: a THIRD stale
 * default makes it red, and so does fixing one of these without removing it from this list.
 */
const KNOWN_STALE_LANE_DEFAULTS: ReadonlyArray<{ laneId: string; modelId: string; why: string }> = [
  { laneId: 'xai', modelId: 'grok-3-mini', why: "the xai catalog lists grok-4 / grok-3-beta / grok-code-fast-1 and not the -mini tier" },
  { laneId: 'huggingface', modelId: 'openai/gpt-oss-20b:cheapest', why: "the huggingface catalog is the single placeholder id 'hf-default'; the lane default also carries a router policy suffix" },
];

describe('an unknown model id is reported, with the detail needed to act', () => {
  it("reports the operator's exact case: a real model absent from its provider's catalog", () => {
    const unknown = checkModelAgainstCatalog('gemini', 'gemini-9.9-flash-not-a-model', CATALOG);
    expect(unknown).not.toBeNull();
    expect(unknown!.providerId).toBe('gemini');
    expect(unknown!.modelId).toBe('gemini-9.9-flash-not-a-model');
    // The message has to name all three things, or a reader cannot act on the log line.
    expect(unknown!.message).toContain('gemini-9.9-flash-not-a-model');
    expect(unknown!.message).toContain('gemini');
    expect(unknown!.available).toEqual(providerById.get('gemini')!.models.map((m) => m.id));
    for (const id of unknown!.available) expect(unknown!.message).toContain(id);
  });

  it('stays silent for a model the catalog does carry, in any casing', () => {
    expect(checkModelAgainstCatalog('gemini', 'gemini-3.8-flash', CATALOG)).toBeNull();
    expect(checkModelAgainstCatalog('GEMINI', 'Gemini-3.8-Flash', CATALOG)).toBeNull();
  });

  it('stays silent when it cannot know — no model, no catalog, or a placeholder-only provider', () => {
    expect(checkModelAgainstCatalog('gemini', null, CATALOG)).toBeNull();
    expect(checkModelAgainstCatalog('gemini', 'auto', CATALOG)).toBeNull();
    expect(checkModelAgainstCatalog('not-a-provider', 'anything', CATALOG)).toBeNull();
    // Absent map = this build has no catalog knowledge. Silence, not a false accusation.
    expect(checkModelAgainstCatalog('gemini', 'gemini-9.9-flash', {
      harnessTypes: CATALOG.harnessTypes, clineApiProviders: CATALOG.clineApiProviders,
    })).toBeNull();
  });

  it('is fed by the real api catalog, so it cannot drift from what the build ships', () => {
    expect(CATALOG.modelsByProvider).toBeDefined();
    expect(Object.keys(CATALOG.modelsByProvider!).sort()).toEqual(PROVIDER_DEFINITIONS.map((p) => p.id).sort());
  });
});

describe('the catalog offers no model its vendor has retired', () => {
  for (const retired of RETIRED_MODEL_IDS) {
    it(`does not offer ${retired.providerId} / ${retired.modelId} (${retired.source})`, () => {
      const provider = providerById.get(retired.providerId);
      expect(provider, `provider '${retired.providerId}' is missing from PROVIDER_DEFINITIONS`).toBeDefined();
      const ids = provider!.models.map((m) => m.id.toLowerCase());
      expect(
        ids,
        `'${retired.modelId}' is shut down per ${retired.source} — a human can pick it and it cannot answer`,
      ).not.toContain(retired.modelId.toLowerCase());
    });
  }
});

describe("every model id configured in this repo resolves in its provider's catalog", () => {
  it("each provider's own defaultModelId is one of its models", () => {
    const orphans = PROVIDER_DEFINITIONS
      .filter((p) => !p.models.some((m) => m.id === p.defaultModelId))
      .map((p) => `${p.id} -> ${p.defaultModelId}`);
    // ProviderRegistry.getDefaultModel falls silently to models[0] when this drifts, which is a
    // coercion nobody sees: the cockpit preselects a model the operator never chose.
    expect(orphans, 'defaultModelId must name a model the provider actually lists').toEqual([]);
  });

  it('each OpenAI-compatible lane default resolves, apart from the two named stale ones', () => {
    const stale: string[] = [];
    for (const [laneId, lane] of Object.entries(OPENAI_COMPAT_LANES)) {
      if (!lane.defaultModel) continue;
      const unknown = checkModelAgainstCatalog(laneId, lane.defaultModel, CATALOG);
      if (unknown) stale.push(`${laneId} -> ${lane.defaultModel}`);
    }
    expect(
      stale.sort(),
      'a lane default absent from its provider catalog runs unpriced and unrecognised — refresh the '
      + 'catalog, or add it to KNOWN_STALE_LANE_DEFAULTS with the reason',
    ).toEqual(KNOWN_STALE_LANE_DEFAULTS.map((entry) => `${entry.laneId} -> ${entry.modelId}`).sort());
  });

  it('the known-stale list holds no entry that has since been fixed', () => {
    const fixed = KNOWN_STALE_LANE_DEFAULTS
      .filter((entry) => checkModelAgainstCatalog(entry.laneId, entry.modelId, CATALOG) === null)
      .map((entry) => `${entry.laneId} -> ${entry.modelId}`);
    expect(fixed, 'these now resolve — delete them from KNOWN_STALE_LANE_DEFAULTS').toEqual([]);
  });
});
