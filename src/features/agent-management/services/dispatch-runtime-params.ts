/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-034 push-on-dispatch (controller half): RuntimeParamsResolver reads the authoritative agent_config record (providerId/modelId/configVersion — the same keys GET /api/agents/:id/runtime serves) so every BotNodeClient.execute dispatch can carry the expected provider/model; resolveDispatchConfigFields is the fail-open call-site helper — no resolver, no record, or a resolver error all yield {} so the dispatched request stays byte-identical to the legacy shape (the dual dispatch path is load-bearing).
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Extend the spreadable request slice with providerConfigRequired so dispatch chokepoints can distinguish an unavailable authority record from an intentional compatibility-mode request.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Resolve ADR-034 §1a tier 3 (registry apiType) when the per-agent agent_config record carries no providerId. The resolver read ONLY agent_config, but that table is written when something CHANGES a bot's provider — a bot that has always run its registry-declared provider has no row, so the resolver reported "no actionable record" while the registry declared one. Combined with the unconditional providerConfigRequired marker the bot refused before task creation and the ticket escalated: 33 tickets on the operator box carry that message, including a nightly oshal-dev schedule that failed for two weeks, and 13 registry bots with a dedicated bot-node had no row at all. Tier 3 applies ONLY when tier 2 yields nothing, so every bot that resolves today is stamped byte-identically, and an agent neither store declares still resolves to null and keeps the fail-closed refusal.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | The switch rows (migration 147, "a bot's LLM provider is a row in a table") are tier 1 of the carried record: an injected resolver answers the bot's own switch row, else the fleet default for a registry LLM bot; only then do tier 2 (agent_config providerId) and tier 3 (registry apiType) apply, byte-identically. A REFUSED switch (an id this build cannot run) is carried as written and logged at ERROR here, so the bot's own switch seam refuses the dispatch with the id in its reason rather than silently running the registry provider.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Retain completed work from configured failover (BACKLOG #1660): carry fallbackOrder from ProviderSwitchRow in DispatchRuntimeParams and resolveDispatchConfigFields.
 */

/**
 * ADR-034 push-on-dispatch runtime-param resolution (controller half).
 *
 * OSHAL owns the authoritative per-agent runtime record (`agent_config`, keys
 * `providerId` / `modelId` / `configVersion` — exactly what
 * `GET /api/agents/:agentId/runtime` serves and what ConfigSyncService versions).
 * Historically no dispatcher read it, so `BotNodeRequest.providerId/model` were dead
 * fields and a bot whose live provider drifted from the record executed on the wrong
 * config until its next reboot pull. This module gives every dispatch chokepoint ONE
 * shared way to carry the record:
 *
 *  - {@link createAgentConfigRuntimeParamsResolver} — thin AgentConfigService.getConfig
 *    wrapper producing the record (or null when the agent has none).
 *  - {@link resolveDispatchConfigFields} — the call-site helper: resolves and shapes the
 *    record into spreadable BotNodeRequest fields, FAIL-OPEN by contract. No resolver,
 *    no record, record without a providerId, or a thrown resolver error all return `{}`,
 *    so `...(fields)` leaves the request byte-identical to the legacy shape and a config
 *    read can never block or delay-fail a dispatch.
 *
 * The bot half lives in src/app/bot-node-dispatch-config.ts: the bot node compares the
 * carried record against its live active provider and self-corrects via
 * setActiveProvider BEFORE executing.
 *
 * @module dispatch-runtime-params
 */

import { createChildLogger } from '@/shared/logger';
import type { BotProviderSwitchResolution } from '@/shared/llm-runtime';
import type { AgentConfigService } from './agent-config-service';
import type { BotNodeRequest } from './bot-node-client';

const logger = createChildLogger({ module: 'dispatch-runtime-params' });

/**
 * @description The authoritative runtime record a dispatch carries to the bot node
 * (ADR-034 §2 "On dispatch"). `providerId` is mandatory — a record without one is not
 * actionable by the bot and resolves to null instead.
 */
export interface DispatchRuntimeParams {
  providerId: string;
  model?: string;
  configVersion?: number;
  fallbackOrder?: readonly string[] | null;
}

/**
 * @description Resolves an agent's authoritative runtime record for dispatch stamping.
 * Null means "no actionable record" — the dispatch proceeds exactly as legacy.
 */
export type RuntimeParamsResolver = (agentId: string) => Promise<DispatchRuntimeParams | null>;

/** The spreadable BotNodeRequest slice a resolved record populates. */
export type DispatchConfigFields = Partial<Pick<
  BotNodeRequest,
  'providerId' | 'model' | 'configVersion' | 'providerConfigRequired' | 'fallbackOrder'
>>;

/**
 * @description The bot registry's own provider declaration for one agent — ADR-034 §1a
 * tier 3, `apiType`. Injected (rather than imported) because the registry lives in the app
 * layer and this module is a feature-layer service; the composition root supplies it.
 * @param agentId - The agent id to look up.
 * @returns The declared apiType, or null when the agent is absent from the registry or
 *   declares none. A registry that cannot be read must also return null.
 */
export type RegistryProviderDeclarationReader = (agentId: string) => string | null;

/**
 * @description The switch-row resolution for one agent (per-bot row > fleet default > registry),
 * injected by the composition root from the installed snapshot. Null means "no snapshot".
 */
export type ProviderSwitchResolver = (agentId: string) => BotProviderSwitchResolution | null;

/**
 * @description Builds a RuntimeParamsResolver over the authoritative agent_config store —
 * the SAME record ConfigSyncService versions and GET /api/agents/:agentId/runtime serves,
 * so dispatch stamping can never disagree with the push-down/broadcast-up machinery.
 *
 * `agent_config` is the record OSHAL *versions*, but it is only written when something has
 * changed a bot's provider; a bot that has always run its registry-declared provider has no
 * row at all. Push-on-dispatch stamps `providerConfigRequired:true` unconditionally, so a
 * missing row made the bot refuse the dispatch before task creation ("no actionable record
 * was available") — every queued ticket for that bot escalated. ADR-034 §1a already names the
 * remedy: registry `apiType` is the next provider fallback below the per-agent record. That
 * fallback is applied here and ONLY when the per-agent record yields no providerId, so a bot
 * that resolves today is stamped byte-identically and an agent the registry does not declare
 * still resolves to null and keeps the fail-closed refusal.
 *
 * @param agentConfig - The Postgres-backed per-agent config store (only getConfig is used).
 * @param readRegistryProvider - Optional ADR-034 §1a tier-3 reader; omitted → tier 2 only.
 * @returns Resolver yielding the record, or null when the agent has no actionable record
 *   (no row and no registry declaration — model-only records are not carried because the
 *   bot could not compare a model against a possibly-different provider's active model).
 */
export function createAgentConfigRuntimeParamsResolver(
  agentConfig: Pick<AgentConfigService, 'getConfig'>,
  readRegistryProvider?: RegistryProviderDeclarationReader,
  resolveSwitch?: ProviderSwitchResolver,
): RuntimeParamsResolver {
  return async (agentId: string): Promise<DispatchRuntimeParams | null> => {
    const config = await agentConfig.getConfig(agentId);
    const values = config?.values;
    const rawVersion = Number(values?.configVersion);
    const configVersion = Number.isFinite(rawVersion) ? rawVersion : undefined;
    // Tier 1: a switch row. Its provider AND model are the record; the agent_config version still
    // rides along so the bot's drift log names the version it reconciled against.
    const switched = readSwitchRow(resolveSwitch, agentId);
    if (switched) {
      return {
        providerId: switched.providerId,
        ...(switched.model ? { model: switched.model } : {}),
        ...(configVersion !== undefined ? { configVersion } : {}),
        ...(switched.fallbackOrder && switched.fallbackOrder.length > 0 ? { fallbackOrder: switched.fallbackOrder } : {}),
      };
    }
    const recordProviderId = values ? readNonEmptyString(values.providerId) : null;
    // Tier 2 (the per-agent record) wins whenever it is actionable; tier 3 only fills its absence.
    const providerId = recordProviderId ?? readRegistryDeclaredProvider(readRegistryProvider, agentId);
    if (!providerId) return null;
    const model = values ? readNonEmptyString(values.modelId) : null;
    return {
      providerId,
      ...(model ? { model } : {}),
      ...(configVersion !== undefined ? { configVersion } : {}),
    };
  };
}

/**
 * @description Reads the switch rung for one agent. A refused switch is carried AS WRITTEN and
 * logged at ERROR: the bot's switch seam then refuses the dispatch naming that id, which is the
 * fail-closed outcome — never a silent hop onto the registry provider.
 * @param resolver - The injected switch resolver (absent → no switch rung).
 * @param agentId - The agent id to look up.
 * @returns The provider/model the switch names, or null when no switch row applies.
 */
function readSwitchRow(
  resolver: ProviderSwitchResolver | undefined,
  agentId: string,
): { providerId: string; model: string | null; fallbackOrder?: readonly string[] | null } | null {
  if (!resolver) return null;
  const switched = resolver(agentId);
  if (!switched || switched.source === 'registry') return null;
  const fallbackOrder = switched.row?.fallbackOrder;
  if (!switched.ok) {
    logger.error(
      { agentId, source: switched.source, providerId: switched.providerId, reason: switched.reason },
      'Provider switch row names an id this build cannot run — carrying it so the bot refuses the dispatch by name',
    );
    return {
      providerId: switched.providerId,
      model: readNonEmptyString(switched.row.modelId),
      fallbackOrder,
    };
  }
  return {
    providerId: switched.providerId as string,
    model: switched.modelId,
    fallbackOrder,
  };
}

/**
 * @description Reads the registry's declared provider for an agent without letting a registry
 * failure escape into the dispatch path — an unreadable registry is "no declaration", which
 * preserves the fail-closed refusal rather than inventing a provider.
 * @param reader - The injected registry reader (absent → no tier-3 declaration).
 * @param agentId - The agent id to look up.
 * @returns The declared provider, or null.
 */
function readRegistryDeclaredProvider(
  reader: RegistryProviderDeclarationReader | undefined,
  agentId: string,
): string | null {
  if (!reader) return null;
  try {
    const declared = readNonEmptyString(reader(agentId));
    // ADR-034 §1a: `auto` is a no-opinion sentinel, never a provider.
    return declared && declared.toLowerCase() !== 'auto' ? declared : null;
  } catch (err) {
    logger.warn(
      { err, agentId },
      'ADR-034 §1a: bot registry unreadable — no tier-3 provider declaration for this dispatch',
    );
    return null;
  }
}

/**
 * @description Call-site helper for the dispatch chokepoints: resolves the authoritative
 * record and shapes it into spreadable BotNodeRequest fields. FAIL-OPEN by contract —
 * an absent resolver, an absent/non-actionable record, or a resolver error (logged at
 * WARN, never rethrown) all return `{}` so the dispatched request is byte-identical to
 * the legacy shape and a config read can never block a dispatch.
 * @param resolver - The optional injected resolver (absent → legacy dispatch, no lookup).
 * @param agentId - The target worker's agent id.
 * @returns Fields to spread into the BotNodeRequest (possibly empty).
 */
export async function resolveDispatchConfigFields(
  resolver: RuntimeParamsResolver | undefined,
  agentId: string,
): Promise<DispatchConfigFields> {
  if (!resolver) return {};
  try {
    const params = await resolver(agentId);
    if (!params) return {};
    return {
      providerId: params.providerId,
      ...(params.model ? { model: params.model } : {}),
      ...(params.configVersion !== undefined ? { configVersion: params.configVersion } : {}),
      ...(params.fallbackOrder && params.fallbackOrder.length > 0 ? { fallbackOrder: params.fallbackOrder } : {}),
    };
  } catch (err) {
    logger.warn(
      { err, agentId },
      'ADR-034: runtime-param resolution failed — dispatching without a carried config record (fail-open)',
    );
    return {};
  }
}

/** @description Narrows an unknown config value to a trimmed non-empty string, else null. */
function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
