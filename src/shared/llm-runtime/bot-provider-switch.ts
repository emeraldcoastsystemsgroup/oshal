/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A bot's LLM provider is a row in a table, not a literal in the registry (operator, 2026-09-17: "it should literally be a switch in a table"). ONE pure rule, most specific first: per-bot switch row -> fleet-default switch row -> the registry literal. Each rung is a real record; no rows anywhere resolves byte-identically to the registry, so the fleet does not move when the rule lands. A provider id the platform cannot run fails CLOSED with a reason — it never falls silently to the registry. Lives in shared/ because the api-side harness resolver, dispatch stamping, the /runtime boot pull and the cockpit all have to answer the same question, and duplicating the rule is how a surface starts lying.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Named the stores behind the rungs so no reader invents a fourth: the per-bot row IS the existing agent_config record (config_values.providerId/modelId — what PUT /api/agents/:id/runtime writes and ADR-034 dispatch stamping carries), the fleet default is the one reserved row of oshal_bot_provider_switch (migration 146). The rule itself is unchanged; ProviderSwitchRow is the common shape both stores project to.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Entry 2 named the wrong store for the per-bot rung. An agent_config record is a machinery-written dispatch artefact (manifest seeding, the bot's own broadcast-up, a config push — the operator box holds 70 and not one was a person's choice), and treating it as the per-bot switch let every one of them outrank a fleet-default write, failing ADR-162 §7 for the whole fleet. Both rungs now live in oshal_bot_provider_switch: a per-bot row (scope = agent id) exists only when an operator wrote one through the api, the fleet default is the reserved row, and agent_config is ADR-034 tier 2 of the carried record BENEATH the fleet row. The rule itself is still unchanged — what changed is that the store no longer hands it agent_config as a botRow.
 *
 * @module shared/llm-runtime/bot-provider-switch
 */

/** The reserved switch-row id that holds the fleet default: "switch the default" is ONE write. */
export const FLEET_DEFAULT_SWITCH_ID = 'fleet-default';

/** Where a resolved provider came from — the rung of the precedence ladder that answered. */
export type BotProviderSwitchSource = 'bot-row' | 'fleet-default' | 'registry';

/**
 * One switch record: a row of oshal_bot_provider_switch — a bot's own switch (an operator wrote
 * it) or the fleet default. Never an agent_config record: that is the ADR-034 dispatch artefact
 * beneath the fleet row. No secret, ever — keys stay in the env.
 */
export interface ProviderSwitchRow {
  /** An agent id (that bot's operator-written switch), or {@link FLEET_DEFAULT_SWITCH_ID}. */
  scopeId: string;
  providerId: string;
  modelId: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** The registry facts the rule reads for one bot. Structural, so both registries satisfy it. */
export interface SwitchRegistryEntry {
  harnessType?: string | null;
  apiType?: string | null;
}

/** What the platform can run: the harness keys and the Cline-backed API provider ids. */
export interface ProviderSwitchCatalog {
  /** Every `HARNESS_FACTORIES` key — pinned equal to that record by a guard spec. */
  harnessTypes: readonly string[];
  /** Every provider id the generic `cline` harness can be pointed at (provider-definitions). */
  clineApiProviders: readonly string[];
}

/** A provider id the platform knows how to run, translated to the harness that runs it. */
export interface ClassifiedProviderId {
  ok: true;
  /** The id as written on the row (trimmed). */
  providerId: string;
  /** The harness factory that executes it on the api side. */
  harnessType: string;
  /** The api type handed to that harness (the Cline-backed provider id, or the harness's own). */
  apiType: string | null;
  /**
   * The name a dedicated bot-node's runtime speaks for this id (`openai-codex`, `claude-code`,
   * `cline-cli`), or null when no bot-node runtime exists for it (an api-side-only harness such as
   * `gemini-cli` or `noop`): a dispatch carrying such an id is refused by the bot with its reason.
   */
  botNodeRuntime: 'openai-codex' | 'claude-code' | 'cline-cli' | null;
  /** Set when the id is an API provider the generic Cline harness fronts (gemini, anthropic, …). */
  clineApiProvider: string | null;
}

/** A provider id the platform cannot run. Refused with the reason; never silently ignored. */
export interface RefusedProviderId {
  ok: false;
  providerId: string;
  reason: string;
}

export type ProviderIdClassification = ClassifiedProviderId | RefusedProviderId;

/** The resolved answer for one bot. */
export type BotProviderSwitchResolution =
  | {
    ok: true;
    source: BotProviderSwitchSource;
    /** The provider id the winning record names, or the registry apiType/harnessType literal. */
    providerId: string | null;
    harnessType: string | null;
    apiType: string | null;
    modelId: string | null;
    /** The row that won, when a row won. */
    row: ProviderSwitchRow | null;
  }
  | {
    ok: false;
    source: 'bot-row' | 'fleet-default';
    providerId: string;
    reason: string;
    row: ProviderSwitchRow;
  };

/**
 * A harness key's own api type, and the provider-id spellings that mean that harness. The
 * registries write `harnessType: 'codex-cli', apiType: 'openai-codex'`; `agent_config` rows and
 * the bot-node runtime write `openai-codex`; both must land on the same harness.
 */
const HARNESS_BY_ID: Record<string, { harnessType: string; apiType: string | null; botNodeRuntime: ClassifiedProviderId['botNodeRuntime'] }> = {
  'codex-cli': { harnessType: 'codex-cli', apiType: 'openai-codex', botNodeRuntime: 'openai-codex' },
  'openai-codex': { harnessType: 'codex-cli', apiType: 'openai-codex', botNodeRuntime: 'openai-codex' },
  'claude-code': { harnessType: 'claude-code', apiType: 'claude-code', botNodeRuntime: 'claude-code' },
  'gemini-cli': { harnessType: 'gemini-cli', apiType: 'google-gemini', botNodeRuntime: null },
  'google-gemini': { harnessType: 'gemini-cli', apiType: 'google-gemini', botNodeRuntime: null },
  'cline': { harnessType: 'cline', apiType: null, botNodeRuntime: 'cline-cli' },
  'cline-cli': { harnessType: 'cline', apiType: null, botNodeRuntime: 'cline-cli' },
  'noop': { harnessType: 'noop', apiType: 'noop', botNodeRuntime: null },
};

/**
 * Harness keys a switch row may NOT name. `a2a` is an external-agent boundary whose endpoint and
 * credential env are declared per bot in the registry — a row cannot retarget an LLM bot onto it.
 */
const UNSWITCHABLE_HARNESSES = new Set(['a2a']);

/** The registry harness types the fleet default reaches: LLM harnesses, never the a2a boundary. */
function isLlmHarness(harnessType: string | null | undefined): boolean {
  const h = (harnessType ?? '').trim();
  return h.length > 0 && !UNSWITCHABLE_HARNESSES.has(h);
}

/** 'auto' is the record store's documented "no opinion" sentinel — never a provider. */
function meaningful(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v && v.toLowerCase() !== 'auto' ? v : null;
}

/**
 * @description Translate a provider id as an operator would write it into the harness that runs
 * it, or refuse it with a reason. Total over strings: every input gets an answer.
 * @param rawProviderId - The id on the row (a harness key, a harness alias, or a Cline-backed API
 *   provider id from provider-definitions).
 * @param catalog - What this build can run.
 * @returns The translation, or a refusal naming why and what is accepted.
 */
export function classifyProviderId(
  rawProviderId: string | null | undefined,
  catalog: ProviderSwitchCatalog,
): ProviderIdClassification {
  const providerId = meaningful(rawProviderId);
  if (!providerId) {
    return { ok: false, providerId: String(rawProviderId ?? ''), reason: 'providerId must be a non-empty provider id (not the "auto" sentinel)' };
  }
  const key = providerId.toLowerCase();
  if (UNSWITCHABLE_HARNESSES.has(key)) {
    return {
      ok: false, providerId,
      reason: `'${providerId}' is an external-agent boundary declared per bot in the registry (endpoint + credential env), not a switchable LLM provider`,
    };
  }
  const harness = HARNESS_BY_ID[key];
  if (harness && catalog.harnessTypes.includes(harness.harnessType)) {
    return { ok: true, providerId, ...harness, clineApiProvider: null };
  }
  // Match the catalog's own spelling case-insensitively and answer with THAT spelling, so a row
  // written as `NousResearch` still reaches the `nousResearch` definition the Cline config expects.
  const clineProvider = catalog.clineApiProviders.find((id) => id.toLowerCase() === key);
  if (clineProvider && catalog.harnessTypes.includes('cline')) {
    return {
      ok: true, providerId: clineProvider, harnessType: 'cline', apiType: clineProvider,
      botNodeRuntime: 'cline-cli', clineApiProvider: clineProvider,
    };
  }
  const accepted = [
    ...catalog.harnessTypes.filter((h) => !UNSWITCHABLE_HARNESSES.has(h)),
    ...catalog.clineApiProviders,
  ];
  return {
    ok: false, providerId,
    reason: `unknown provider id '${providerId}' — not a harness (${catalog.harnessTypes.filter((h) => !UNSWITCHABLE_HARNESSES.has(h)).join(', ')}) `
      + `and not a Cline-backed API provider; accepted ids: ${Array.from(new Set(accepted)).sort().join(', ')}`,
  };
}

/**
 * @description Resolve which provider serves one bot: its own switch row, else the fleet default
 * (for a bot the registry gives an LLM harness), else the registry literal. A winning row whose
 * id the platform cannot run is a REFUSAL carrying the reason — the caller must not fall through
 * to the registry, because that would make a typo look like "nothing changed".
 * @param input - The bot's own row (if any), the fleet-default row (if any), the registry entry
 *   (if any) and the runnable catalog.
 * @returns The resolution, with the rung that answered.
 */
export function resolveBotProviderSwitch(input: {
  botRow?: ProviderSwitchRow | null;
  fleetRow?: ProviderSwitchRow | null;
  registry?: SwitchRegistryEntry | null;
  catalog: ProviderSwitchCatalog;
}): BotProviderSwitchResolution {
  const registryHarness = meaningful(input.registry?.harnessType);
  const registryApiType = meaningful(input.registry?.apiType);
  const fromRow = (row: ProviderSwitchRow, source: 'bot-row' | 'fleet-default'): BotProviderSwitchResolution => {
    const classified = classifyProviderId(row.providerId, input.catalog);
    if (!classified.ok) {
      return { ok: false, source, providerId: row.providerId, reason: classified.reason, row };
    }
    return {
      ok: true, source, providerId: classified.providerId, harnessType: classified.harnessType,
      apiType: classified.apiType, modelId: meaningful(row.modelId), row,
    };
  };
  if (input.botRow) return fromRow(input.botRow, 'bot-row');
  // The fleet default reaches every bot the registry runs on an LLM harness. A bot the registry
  // does not know keeps the process provider it has today; an a2a boundary is never an LLM.
  if (input.fleetRow && isLlmHarness(registryHarness)) return fromRow(input.fleetRow, 'fleet-default');
  return {
    ok: true, source: 'registry', providerId: registryApiType ?? registryHarness,
    harnessType: registryHarness, apiType: registryApiType, modelId: null, row: null,
  };
}
