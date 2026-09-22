/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | A bot's LLM provider is a row in a table, not a literal in the registry (operator, 2026-09-17: "it should literally be a switch in a table"). ONE pure rule, most specific first: per-bot switch row -> fleet-default switch row -> the registry literal. Each rung is a real record; no rows anywhere resolves byte-identically to the registry, so the fleet does not move when the rule lands. A provider id the platform cannot run fails CLOSED with a reason — it never falls silently to the registry. Lives in shared/ because the api-side harness resolver, dispatch stamping, the /runtime boot pull and the cockpit all have to answer the same question, and duplicating the rule is how a surface starts lying.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Named the stores behind the rungs so no reader invents a fourth: the per-bot row IS the existing agent_config record (config_values.providerId/modelId — what PUT /api/agents/:id/runtime writes and ADR-034 dispatch stamping carries), the fleet default is the one reserved row of oshal_bot_provider_switch (migration 147). The rule itself is unchanged; ProviderSwitchRow is the common shape both stores project to.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Entry 2 named the wrong store for the per-bot rung. An agent_config record is a machinery-written dispatch artefact (manifest seeding, the bot's own broadcast-up, a config push — the operator box holds 70 and not one was a person's choice), and treating it as the per-bot switch let every one of them outrank a fleet-default write, failing ADR-162 §7 for the whole fleet. Both rungs now live in oshal_bot_provider_switch: a per-bot row (scope = agent id) exists only when an operator wrote one through the api, the fleet default is the reserved row, and agent_config is ADR-034 tier 2 of the carried record BENEATH the fleet row. The rule itself is still unchanged — what changed is that the store no longer hands it agent_config as a botRow.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | requireModelForClineBackedId: a Cline-backed id written without a model is refused with the reason (the Cline wrapper would otherwise pick the container's FORCE_LLM_MODEL seed — gpt-5.5 — through ClineCLIWrapper._resolveBackingProvider's fallback chain, the same 'models/gpt-5.5 is not found' failure by another door). Native harness ids keep their own runtime default; no default model is ever picked for a Cline-backed id.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | The FALLBACK ORDER resolves by the same rule as the provider id: resolveProviderFallbackChain reads the bot row, then the fleet row, then an environment override, then nothing. It names no provider, because the hardcoded chain it replaces (a three-name union and a literal Record in bot-node-runtime.ts) made an exhausted vendor unrecoverable by configuration - the only other name in the literal had been exhausted too, and no setting anywhere could add a third. A row's EMPTY array is a real answer (no failover, fail visibly) and does not inherit; only null/absent does. An id the platform cannot run is dropped and reported, never silently kept, and never allowed to disable failover for the rest of the chain.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | antigravity-cli added to HARNESS_BY_ID. It had been added to the HarnessType union and HARNESS_FACTORIES but not here, so classifyProviderId REFUSED it - it could be neither a fleet default nor a fallback rung - while the ROADMAP row and three comments said it was selectable and usable as a rung. botNodeRuntime is null for the same reason gemini-cli's is: the bot-node builds three runtimes and this is not one of them, so it is selectable on the api side only. The original wording of this entry claimed such an id is "refused with a reason at a node rather than silently dropped" - that was the opposite of the truth. A rung the node cannot resolve is collected into `unavailable` and reported as one logger.warn, which no api read and no cockpit surface shows; correcting the claim rather than the behaviour, because surfacing it is a separate change (F7/F8 in docs/backlog/provider-fallback-review-followups.md).
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | checkModelAgainstCatalog + ProviderSwitchCatalog.modelsByProvider: the provider ID was validated against the runnable catalog and the model id was not validated against anything at all. classifyProviderId refuses an unrunnable provider with the reason and the accepted list; the model beside it was only trimmed (`meaningful(row.modelId)`) and handed to the vendor unexamined, so a configured id absent from provider-definitions produced NO error, NO warning and NO log line — the only visible consequence was usage-cost-resolver finding no pricing and booking a real call at $0. It REPORTS rather than refuses, and the docstring says why: a provider id is a fact about this build (fail closed), a model id is a fact about the vendor's catalog that this file only lags (fail loud). The build-time gate in tests/unit/provider-model-catalog.spec.ts is where an absent id is fatal.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | botNodeCanRunProvider exports the fact SEQ 6 recorded in prose — whether a bot node has a runtime that can execute this provider id — so the api side can stop OFFERING a selection no node can serve. It is derived from HARNESS_BY_ID.botNodeRuntime, never a second list: a hardcoded "gemini-cli is unrunnable" would go stale the day a runtime is added, whereas this answers from the same table the node reconciles against and flips on its own. The settings surface had been offering gemini-cli the moment a login was pushed, and the resolved selection then died at reconcileDispatchProviderConfig with AuthoritativeDispatchConfigError — refused BY NAME, every turn, for a user who had followed the instructions exactly.
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
  /**
   * Ordered provider ids to try when this row's provider fails a failover-eligible way.
   * `null`/absent = inherit the next precedence rung. An EMPTY array = no failover, deliberately.
   */
  fallbackOrder?: readonly string[] | null;
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
  /**
   * The model ids `provider-definitions.ts` records for each provider id, so a configured model
   * can be measured against the catalog instead of travelling to the vendor unexamined. OPTIONAL
   * and deliberately so: a caller that does not supply it gets no model opinion at all, which is
   * honest — an absent map means "this build has no catalog knowledge here", not "the model is
   * fine". A provider whose entry is absent or empty is treated the same way.
   */
  modelsByProvider?: Readonly<Record<string, readonly string[]>>;
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
   * `cline-cli`, `antigravity-cli`), or null when no bot-node runtime exists for it (an api-side-only
   * harness such as `gemini-cli` or `noop`): a dispatch carrying such an id is refused by the bot.
   */
  botNodeRuntime: 'openai-codex' | 'claude-code' | 'cline-cli' | 'antigravity-cli' | null;
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
  'antigravity-cli': { harnessType: 'antigravity-cli', apiType: 'google-gemini', botNodeRuntime: 'antigravity-cli' },
  'google-gemini': { harnessType: 'gemini-cli', apiType: 'google-gemini', botNodeRuntime: null },
  'cline': { harnessType: 'cline', apiType: null, botNodeRuntime: 'cline-cli' },
  'cline-cli': { harnessType: 'cline', apiType: null, botNodeRuntime: 'cline-cli' },
  'noop': { harnessType: 'noop', apiType: 'noop', botNodeRuntime: null },
};

/**
 * @description Whether a BOT NODE holds a runtime that can actually execute this provider id.
 *
 * Distinct from {@link classifyProviderId}, which answers whether the id is a NAME this build
 * understands. An id can be perfectly classifiable, selectable in a switch row and stampable on a
 * dispatch, and still have no runtime behind it — `gemini-cli` is the current example. A dispatch
 * carrying such an id reaches `reconcileDispatchProviderConfig` and
 * is refused by name with `AuthoritativeDispatchConfigError`, so every turn under it fails.
 *
 * Surfaces that OFFER a provider must ask this question, not the classification one, or they offer
 * a choice the node will refuse. It is answered from `HARNESS_BY_ID.botNodeRuntime` rather than a
 * second list on purpose: a separate "these are unrunnable" constant is a fact about today that
 * nothing updates, while this one flips by itself the moment a runtime is wired.
 * @param providerId - A provider id or harness alias as an operator or a preference would write it
 * @returns true when some bot-node runtime serves it; false for an unknown id or a null runtime
 */
export function botNodeCanRunProvider(providerId: string | null | undefined): boolean {
  const key = (providerId ?? '').trim().toLowerCase();
  if (!key) return false;
  return HARNESS_BY_ID[key]?.botNodeRuntime != null;
}

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
 * @description A Cline-backed id must carry its model on the row. The Cline wrapper resolves its
 * model as CLINE_API_MODEL → persisted config → FORCE_LLM_MODEL → LLM_MODEL
 * (ClineCLIWrapper._resolveBackingProvider), so a row naming `gemini` with no model would run on the
 * container's seed model (`gpt-5.5` on the operator box) — the "models/gpt-5.5 is not found" failure
 * through a different door. A native harness id may omit the model (that runtime's own default is
 * its own); a Cline-backed id may not, and no default is picked for it here.
 * @param classified - The accepted classification of the id being written.
 * @param modelId - The model the write names, if any.
 * @returns The refusal for a Cline-backed id with no model; null when the write may proceed.
 */
export function requireModelForClineBackedId(
  classified: ClassifiedProviderId,
  modelId: string | null | undefined,
): RefusedProviderId | null {
  if (!classified.clineApiProvider || meaningful(modelId)) return null;
  return {
    ok: false, providerId: classified.providerId,
    reason: `'${classified.providerId}' is a Cline-backed API provider and needs a modelId on the row: `
      + "without one the Cline runtime falls back to the container's FORCE_LLM_MODEL seed, a model of another provider",
  };
}

/** A configured model id the provider's catalog does not carry, with the details to say so. */
export interface UnknownModelId {
  /** The provider the model was configured for, in the catalog's own spelling. */
  providerId: string;
  /** The model id as configured. */
  modelId: string;
  /** The ids the catalog DOES carry for that provider — what a reader needs to act. */
  available: readonly string[];
  /** One sentence naming the id, the provider and the available ids. */
  message: string;
}

/**
 * @description Measure a configured model id against the provider's catalog in
 * `provider-definitions.ts`. Answers `null` when the id is in the catalog — and also when this
 * build has no catalog for that provider, because absence of knowledge is not evidence of a bad id.
 *
 * WHY THIS REPORTS RATHER THAN REFUSES, unlike {@link classifyProviderId} beside it. That function
 * fails CLOSED because a provider id names something THIS BUILD must be able to run: an id with no
 * harness is a fact about our own code, and running is impossible. A model id is a fact about the
 * VENDOR's catalog, which this file is only ever a lagging copy of — the defect that produced this
 * function was `gemini-3.8-flash`, a real, current, stable Google model absent from our list. Had
 * an unknown id refused, the operator's correct configuration would have been rejected by our own
 * staleness, which is the same failure wearing the other mask. Thirteen providers here carry a
 * single placeholder id (`zai-default`, `hf-default`, …), so refusal on absence would also break
 * every real model id for those. The honest answer is to proceed and SAY SO, loudly, with enough
 * detail to act on: the catalog is what is stale, and the caller should know its cost will not
 * resolve (`usage-cost-resolver.ts` prices from this same catalog and books $0 for an id it cannot
 * find). The build-time gate is where absence is fatal — see tests/unit/provider-model-catalog.spec.ts.
 *
 * Matching is case-insensitive for the same reason {@link classifyProviderId}'s is: a row written
 * `Gemini-2.5-Flash` names the catalog's `gemini-2.5-flash` and must not be reported as unknown.
 *
 * @param providerId - The provider the model is configured for (any spelling the catalog accepts).
 * @param modelId - The configured model id, if any. An absent/blank model is not this check's business.
 * @param catalog - What this build can run, including `modelsByProvider` when the caller supplies it.
 * @returns The unknown-id report, or null when the id is known or unknowable here.
 */
export function checkModelAgainstCatalog(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
  catalog: ProviderSwitchCatalog,
): UnknownModelId | null {
  const model = meaningful(modelId);
  const provider = meaningful(providerId);
  if (!model || !provider || !catalog.modelsByProvider) return null;
  const key = provider.toLowerCase();
  const entry = Object.entries(catalog.modelsByProvider)
    .find(([id]) => id.toLowerCase() === key);
  const available = entry?.[1] ?? [];
  if (available.length === 0) return null;
  if (available.some((id) => id.toLowerCase() === model.toLowerCase())) return null;
  return {
    providerId: entry?.[0] ?? provider,
    modelId: model,
    available,
    message: `model id '${model}' is not in this build's catalog for provider '${entry?.[0] ?? provider}' `
      + `— proceeding, because the catalog lags the vendor and the id may be valid, but its cost will `
      + `not resolve and the catalog needs refreshing. Catalogued ids: ${available.join(', ')}`,
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

/** Where a resolved fallback chain came from, so a surface can say why it is what it is. */
export type FallbackChainSource = 'bot-row' | 'fleet-default' | 'environment' | 'none';

/** An ordered, runnable fallback chain and the rung that supplied it. */
export interface ProviderFallbackChain {
  /** Provider ids to try, in order, after the primary. Never contains the primary. */
  order: readonly string[];
  source: FallbackChainSource;
  /** Ids that were configured but refused, each with the reason, so nothing fails silently. */
  refused: readonly RefusedProviderId[];
}

/**
 * @description Resolve the ordered fallback chain for one bot. ONE rule, most specific first,
 * the same shape {@link resolveBotProviderSwitch} uses for the provider itself: the bot's own
 * switch row, else the fleet-default row, else an environment override, else no failover.
 *
 * No provider is named here, and none may be. The chain is entirely what an administrator wrote,
 * in the order they wrote it, for as many providers as they listed. A hardcoded chain is what this
 * function exists to delete: it made a vendor's exhausted subscription unrecoverable by
 * configuration, because the only other name in the literal had been exhausted too.
 *
 * A configured id the platform cannot run is DROPPED from the order and reported in `refused`,
 * rather than refusing the whole chain — one bad entry must not disable failover for the rest.
 * The primary is filtered out (a provider cannot fail over to itself) and duplicates collapse to
 * their first position.
 *
 * @param input - The bot's row, the fleet row, an environment override, the primary provider id
 *   that is failing over, and the runnable catalog.
 * @returns The ordered chain, its source rung, and any refused entries.
 */
export function resolveProviderFallbackChain(input: {
  botRow?: ProviderSwitchRow | null;
  fleetRow?: ProviderSwitchRow | null;
  /** Operator escape hatch, read only when no row supplies a chain. Comma or space separated. */
  environmentOrder?: string | null;
  primaryProviderId?: string | null;
  catalog: ProviderSwitchCatalog;
}): ProviderFallbackChain {
  const configured = ((): { raw: readonly string[]; source: FallbackChainSource } => {
    // A row's EMPTY array is a real answer — "no failover" — and must not fall through to the
    // next rung. Only null/absent inherits. That distinction is the whole point of the column.
    if (input.botRow && Array.isArray(input.botRow.fallbackOrder)) {
      return { raw: input.botRow.fallbackOrder, source: 'bot-row' };
    }
    if (input.fleetRow && Array.isArray(input.fleetRow.fallbackOrder)) {
      return { raw: input.fleetRow.fallbackOrder, source: 'fleet-default' };
    }
    const env = meaningful(input.environmentOrder);
    if (env) {
      const parsed = env.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
      const off = parsed.length === 1 && ['none', 'off', 'false'].includes(parsed[0].toLowerCase());
      return { raw: off ? [] : parsed, source: 'environment' };
    }
    return { raw: [], source: 'none' };
  })();

  const primary = meaningful(input.primaryProviderId)?.toLowerCase() ?? null;
  const order: string[] = [];
  const refused: RefusedProviderId[] = [];
  const seen = new Set<string>();

  for (const entry of configured.raw) {
    const id = meaningful(entry);
    if (!id) continue;
    const key = id.toLowerCase();
    // A provider cannot fail over to itself, and a repeated id adds no rung.
    if (key === primary || seen.has(key)) continue;
    const classified = classifyProviderId(id, input.catalog);
    if (!classified.ok) { refused.push(classified); continue; }
    seen.add(key);
    order.push(classified.providerId);
  }

  return { order, source: order.length === 0 && configured.source === 'none' ? 'none' : configured.source, refused };
}
