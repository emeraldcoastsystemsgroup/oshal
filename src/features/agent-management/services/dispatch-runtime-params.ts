/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-034 push-on-dispatch (controller half): RuntimeParamsResolver reads the authoritative agent_config record (providerId/modelId/configVersion — the same keys GET /api/agents/:id/runtime serves) so every BotNodeClient.execute dispatch can carry the expected provider/model; resolveDispatchConfigFields is the fail-open call-site helper — no resolver, no record, or a resolver error all yield {} so the dispatched request stays byte-identical to the legacy shape (the dual dispatch path is load-bearing).
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
}

/**
 * @description Resolves an agent's authoritative runtime record for dispatch stamping.
 * Null means "no actionable record" — the dispatch proceeds exactly as legacy.
 */
export type RuntimeParamsResolver = (agentId: string) => Promise<DispatchRuntimeParams | null>;

/** The spreadable BotNodeRequest slice a resolved record populates. */
export type DispatchConfigFields = Partial<Pick<BotNodeRequest, 'providerId' | 'model' | 'configVersion'>>;

/**
 * @description Builds a RuntimeParamsResolver over the authoritative agent_config store —
 * the SAME record ConfigSyncService versions and GET /api/agents/:agentId/runtime serves,
 * so dispatch stamping can never disagree with the push-down/broadcast-up machinery.
 * @param agentConfig - The Postgres-backed per-agent config store (only getConfig is used).
 * @returns Resolver yielding the record, or null when the agent has no actionable record
 *   (no row, or a row without a providerId — model-only records are not carried because the
 *   bot could not compare a model against a possibly-different provider's active model).
 */
export function createAgentConfigRuntimeParamsResolver(
  agentConfig: Pick<AgentConfigService, 'getConfig'>,
): RuntimeParamsResolver {
  return async (agentId: string): Promise<DispatchRuntimeParams | null> => {
    const config = await agentConfig.getConfig(agentId);
    const values = config?.values;
    if (!values) return null;
    const providerId = readNonEmptyString(values.providerId);
    if (!providerId) return null;
    const model = readNonEmptyString(values.modelId);
    const rawVersion = Number(values.configVersion);
    const configVersion = Number.isFinite(rawVersion) ? rawVersion : undefined;
    return {
      providerId,
      ...(model ? { model } : {}),
      ...(configVersion !== undefined ? { configVersion } : {}),
    };
  };
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
