/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot provider precedence rule, extracted as ONE pure function so the cockpit can show a bot's EFFECTIVE provider and say plainly when the registry outranks the operator's pick. This was previously only knowable by reading three files: provider-runtime.ts:841 (a registry harnessType short-circuits the whole DB/cockpit path), claude-code-provider.ts:246 (inside the cline harness the ORDER is request > agent profile > registry apiType > global config), and bot-node-config-bootstrap.ts:184 (a DB modelId reaches even a registry-pinned harness through CODEX_MODEL/CLAUDE_CODE_MODEL, which is why the model stays overridable when the provider does not). Lives in shared/ because both the agent-profile feature and any surface over it need the same answer; duplicating it in browser JS is how the panel would start lying.
 *
 * @module shared/llm-runtime/bot-provider-precedence
 */

/** Where a bot's effective provider actually comes from. */
export type BotProviderSource =
  /** The registry pinned a non-cline harnessType; it short-circuits everything below. */
  | 'registry-harness'
  /** The per-agent DB record (agents.api_provider_id / agent_config providerId). */
  | 'agent-profile'
  /** The registry's apiType, consulted inside the cline harness below the DB record. */
  | 'registry-api-type'
  /** Nothing bot-specific is set: the deployment default decides (FORCE_LLM_PROVIDER / global-config). */
  | 'deployment-default'
  /**
   * The registry could not be consulted, so whether a harness outranks the per-bot record is
   * UNKNOWN. Fail-closed: treated as not overridable, because offering a control we cannot prove
   * is live is worse than declining to offer it.
   */
  | 'registry-unreadable';

/** The inputs the rule needs. Every one of them is data a caller already has. */
export interface BotProviderInputs {
  /** Registry `harnessType` for this agentId, or null when the registry pins none. */
  harnessType?: string | null;
  /** Registry `apiType` for this agentId, or null. */
  apiType?: string | null;
  /** The per-agent DB provider (`agents.api_provider_id`). 'auto' means "no opinion". */
  dbProviderId?: string | null;
  /** The per-agent DB model (`agents.model_id`). */
  dbModelId?: string | null;
  /**
   * Whether the caller could actually READ the bot registry. Pass `false` when the lookup failed:
   * the registry is the highest tier, so a failed read means the answer is unknown rather than
   * "nothing is pinned". Defaults to true (a caller that always has the registry need not pass it).
   */
  registryReadable?: boolean;
}

/** The resolved answer, shaped for direct rendering. */
export interface EffectiveBotProvider {
  /** The provider that will actually serve this bot, or null when the deployment default decides. */
  effectiveProvider: string | null;
  /** The model that will be used, when a bot-specific one is set. */
  effectiveModel: string | null;
  /** Which tier won. */
  providerSource: BotProviderSource;
  /** Whether writing a per-bot provider would change anything for this bot. */
  providerOverridable: boolean;
  /**
   * Whether writing a per-bot MODEL would change anything. True even for a registry-pinned bot:
   * the bot-node config bootstrap maps a pulled modelId onto the harness's own model env var
   * (CODEX_MODEL / CLAUDE_CODE_MODEL), so the model is reachable when the provider is not.
   */
  modelOverridable: boolean;
  /** One sentence a surface can render verbatim explaining WHY this tier won. */
  precedenceNote: string;
}

/**
 * `cline` is the only harnessType that does NOT short-circuit: it is the generic wrapper, and the
 * per-agent DB provider is consulted inside it. Every other declared harness is a distinct CLI or
 * transport chosen at composition time, which no DB row can retarget.
 */
const PASS_THROUGH_HARNESS = 'cline';

/** 'auto' is the DB's documented "no opinion" sentinel — treat it as unset, not as a provider. */
function meaningful(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v && v.toLowerCase() !== 'auto' ? v : null;
}

/**
 * @description Resolve which provider will actually serve a bot, and whether an operator's per-bot
 * pick can change it. Pure and total — every input combination returns a source and a note, so a
 * surface never has to invent an explanation for a case it did not expect.
 *
 * Precedence, highest first:
 *   1. a registry `harnessType` other than 'cline' — `resolveHarnessForAgent` returns that harness
 *      before the process provider or any DB record is consulted, so the cockpit pick is inert;
 *   2. the per-agent DB provider;
 *   3. the registry `apiType` (the cline harness's `configuredProvider`);
 *   4. the deployment default (`FORCE_LLM_PROVIDER`, then global-config.json).
 *
 * @param inputs - Registry + DB facts for one bot.
 * @returns The effective provider/model, which tier won, what is overridable, and why.
 */
export function resolveEffectiveBotProvider(inputs: BotProviderInputs): EffectiveBotProvider {
  if (inputs.registryReadable === false) {
    // FAIL CLOSED. The registry outranks everything below it, so a failed read cannot be treated
    // as "no harness declared" — that would silently promote the per-bot record and make a surface
    // offer a provider control that may be inert. Report unknown and offer nothing.
    return {
      effectiveProvider: meaningful(inputs.dbProviderId),
      effectiveModel: meaningful(inputs.dbModelId),
      providerSource: 'registry-unreadable',
      providerOverridable: false,
      modelOverridable: true,
      precedenceNote: 'The bot registry could not be read, so whether a pinned harness outranks a '
        + 'per-bot provider is unknown for this bot. The provider is left read-only rather than '
        + 'offering a control that might have no effect; the model is still safe to set.',
    };
  }

  const harness = meaningful(inputs.harnessType);
  const apiType = meaningful(inputs.apiType);
  const dbProvider = meaningful(inputs.dbProviderId);
  const effectiveModel = meaningful(inputs.dbModelId);

  if (harness && harness !== PASS_THROUGH_HARNESS) {
    return {
      effectiveProvider: apiType ?? harness,
      effectiveModel,
      providerSource: 'registry-harness',
      providerOverridable: false,
      modelOverridable: true,
      precedenceNote: `The bot registry pins harness '${harness}' for this bot, and a declared harness `
        + 'is resolved before the deployment provider or any per-bot record — so a provider pick here '
        + 'would have no effect. Changing it means changing the registry entry. The MODEL is still '
        + "yours to set: it reaches the harness through the bot-node config bootstrap's model env var.",
    };
  }

  if (dbProvider) {
    return {
      effectiveProvider: dbProvider,
      effectiveModel,
      providerSource: 'agent-profile',
      providerOverridable: true,
      modelOverridable: true,
      precedenceNote: 'This bot runs on its own saved provider. The registry pins no harness for it, '
        + 'so the per-bot record is the highest tier that applies.',
    };
  }

  if (apiType) {
    return {
      effectiveProvider: apiType,
      effectiveModel,
      providerSource: 'registry-api-type',
      providerOverridable: true,
      modelOverridable: true,
      precedenceNote: "The registry declares this bot's apiType but pins no harness, so the value is "
        + 'consulted inside the generic cline wrapper — below a per-bot record. Saving a provider here '
        + 'will take precedence over it.',
    };
  }

  return {
    effectiveProvider: null,
    effectiveModel,
    providerSource: 'deployment-default',
    providerOverridable: true,
    modelOverridable: true,
    precedenceNote: 'Nothing bot-specific is set, so this bot follows the deployment default '
      + '(FORCE_LLM_PROVIDER, then the active provider in global-config.json). Saving a provider here '
      + 'gives it one of its own.',
  };
}
