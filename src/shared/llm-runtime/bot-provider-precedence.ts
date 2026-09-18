/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot switch row IS the agent_config record (BACKLOG entry verbatim), so the notes no longer describe a separate "legacy" per-bot store below the registry: with a snapshot installed the caller's switchResolution already reflects agent_config, and the dbProviderId rungs below only answer when no snapshot exists (no Postgres pool). Notes now say what a save writes: the bot's own agent_config record, resolved above the fleet default and the registry literal.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The switch rows outrank the registry (operator, 2026-09-17: "it should literally be a switch in a table"). A per-bot or fleet-default switch row resolved by bot-provider-switch.ts is now the top of the ladder, reported as providerSource 'bot-row' / 'fleet-default' (or 'switch-refused' when the row names an id this build cannot run — fail closed, with the reason as the note). Consequence for the surface: a registry-pinned harness is no longer the ceiling, so providerOverridable is TRUE for every readable-registry bot and the panel's disabled select comes alive. The legacy per-agent record (agents.api_provider_id / agent_config providerId) keeps exactly the rank it had — below a non-cline registry harness — because the box measured on 2026-09-17 holds 11 such rows that differ from the registry (8 on the cancelled claude-code subscription) and honouring them at merge would have moved the fleet.
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The per-bot provider precedence rule, extracted as ONE pure function so the cockpit can show a bot's EFFECTIVE provider and say plainly when the registry outranks the operator's pick. This was previously only knowable by reading three files: provider-runtime.ts:841 (a registry harnessType short-circuits the whole DB/cockpit path), claude-code-provider.ts:246 (inside the cline harness the ORDER is request > agent profile > registry apiType > global config), and bot-node-config-bootstrap.ts:184 (a DB modelId reaches even a registry-pinned harness through CODEX_MODEL/CLAUDE_CODE_MODEL, which is why the model stays overridable when the provider does not). Lives in shared/ because both the agent-profile feature and any surface over it need the same answer; duplicating it in browser JS is how the panel would start lying.
 *
 * @module shared/llm-runtime/bot-provider-precedence
 */

import type { BotProviderSwitchResolution } from './bot-provider-switch';

/** Where a bot's effective provider actually comes from. */
export type BotProviderSource =
  /** The bot's own switch row (the operator's per-bot pick, honoured above the registry). */
  | 'bot-row'
  /** The fleet-default switch row: no per-bot row, and the registry runs this bot on an LLM harness. */
  | 'fleet-default'
  /** A switch row won but names a provider id this build cannot run — refused, with the reason. */
  | 'switch-refused'
  /** The registry pinned a non-cline harnessType; it short-circuits every LEGACY tier below. */
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
  /**
   * The switch-row resolution for this bot from `resolveBotProviderSwitch` (bot-provider-switch.ts).
   * Absent/null, or a resolution whose source is 'registry', means no switch row applies and the
   * legacy ladder below decides exactly as it always has.
   */
  switchResolution?: BotProviderSwitchResolution | null;
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
 *   0. a SWITCH ROW — the bot's own, else the fleet default for a bot the registry runs on an LLM
 *      harness (bot-provider-switch.ts). A row naming an id this build cannot run is refused here
 *      with its reason; it never falls through to the rungs below.
 *   1. a registry `harnessType` other than 'cline' — `resolveHarnessForAgent` returns that harness
 *      before the process provider or the LEGACY DB record is consulted. Since the switch rows
 *      landed this is no longer a ceiling for the operator: writing a per-bot switch row overrides
 *      it, so `providerOverridable` is true here.
 *   2. the per-agent legacy DB provider (agents.api_provider_id / agent_config providerId);
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

  const fromSwitch = resolveFromSwitchRow(inputs.switchResolution, effectiveModel);
  if (fromSwitch) return fromSwitch;

  if (harness && harness !== PASS_THROUGH_HARNESS) {
    return {
      effectiveProvider: apiType ?? harness,
      effectiveModel,
      providerSource: 'registry-harness',
      providerOverridable: true,
      modelOverridable: true,
      precedenceNote: `The bot registry declares harness '${harness}' for this bot and no switch row `
        + "overrides it. Saving a provider here writes the bot's own runtime record (its switch row), "
        + 'which is resolved ABOVE the registry literal; the fleet default (one row) sits between the two.',
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

/**
 * @description The switch-row rung of the ladder: a winning row answers for the bot, a refused row
 * answers with its reason, and no row (or a registry-sourced resolution) defers to the legacy tiers.
 * @param resolution - The switch resolution, if the caller had rows to resolve.
 * @param legacyModel - The legacy per-agent model, reported when the row names none.
 * @returns The effective provider from the switch rung, or null to defer.
 */
function resolveFromSwitchRow(
  resolution: BotProviderSwitchResolution | null | undefined,
  legacyModel: string | null,
): EffectiveBotProvider | null {
  if (!resolution || resolution.source === 'registry') return null;
  if (!resolution.ok) {
    return {
      effectiveProvider: resolution.providerId,
      effectiveModel: meaningful(resolution.row.modelId) ?? legacyModel,
      providerSource: 'switch-refused',
      providerOverridable: true,
      modelOverridable: true,
      precedenceNote: `The ${resolution.source === 'bot-row' ? "bot's own" : 'fleet-default'} switch row names `
        + `'${resolution.providerId}', which this build cannot run — refused, and nothing falls back to the `
        + `registry: ${resolution.reason}`,
    };
  }
  const rung = resolution.source === 'bot-row' ? "This bot's own switch row" : 'The fleet-default switch row';
  return {
    effectiveProvider: resolution.providerId,
    effectiveModel: resolution.modelId ?? legacyModel,
    providerSource: resolution.source,
    providerOverridable: true,
    modelOverridable: true,
    precedenceNote: `${rung} decides: '${resolution.providerId}' runs through harness '${resolution.harnessType}'. `
      + (resolution.source === 'bot-row'
        ? 'It outranks the fleet default and the registry literal; clear the runtime record to fall back to them.'
        : 'No per-bot row exists, so the fleet default outranks the registry literal; save a provider here to give this bot its own row.'),
  };
}
