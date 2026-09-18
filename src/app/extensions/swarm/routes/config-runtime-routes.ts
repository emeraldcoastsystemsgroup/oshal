/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added per-agent runtime config routes - oshal-owned provider/model push-down + read (ADR-034)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Make this the authoritative provider-precedence write surface: reject pinned-provider writes, push before persistence, preserve provider-free model changes, and return explicit applied/pushed/version/effective runtime truth
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Kept signed bot bootstrap reads while restricting credential-bearing runtime mutations to exact operator browser sessions; established human principals remain authoritative when a service-secret header is also present
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: reject every credential field before config lookup/push and remove the raw secret carrier; provider/model mutations remain non-secret.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | "A bot's LLM provider is a row in a table": the record this route writes IS the per-bot switch row, so (a) the precedence policy is resolved through the injected switch resolver (bot-row > fleet-default > registry) and the provider_pinned 409 for a declared harness is gone with it — providerOverridable is true for every readable-registry bot; (b) a write refuses an id the build cannot run BEFORE the push (400 with the reason and the accepted ids — classifyProviderId, the same rule the resolver refuses on), so a typo never reaches agent_config; (c) a successful write refreshes the installed snapshot through onRuntimeChanged so the next dispatch carries it without waiting for the timer; (d) the read serves the RESOLVED provider/model as runtime.providerId/modelId with providerSource, and answers 200 from the fleet default for a bot with no record, because the bot-node boot pull reads exactly those two fields and a restarted bot must come up on the fleet switch.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Entry 5's "the record IS the per-bot switch row" was the defect: agent_config is also written by manifest seeding, the bot's broadcast-up and config push, so every machinery-written record outranked a fleet-default write (70 of them on the operator box). The per-bot switch is now a row an OPERATOR wrote in oshal_bot_provider_switch, and this route is where that happens: after the ADR-034 push-before-persist succeeds, a mutation naming a providerId writes the bot's own switch row through the injected writeBotSwitch seam under the caller's identity (updated_by = the operator sub; the table's operator-only policy is the enforcement), and a model-only mutation updates that row's model when the bot already has one. The agent_config record is still written exactly as before — it is the dispatch record beneath the fleet row, never a switch.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | refuseUnrunnableSwitch extracted from applyRuntimeMutation (57 -> 49 code lines, the 50-line rule) and grown by one refusal: a Cline-backed providerId with no modelId in the same mutation is 400 model_required before the push and before any row — the Cline runtime would otherwise run on the container's FORCE_LLM_MODEL seed. The cockpit sends the model with a provider pick (the model select re-renders from the provider's definition), so the panel is unchanged.
 * 8 | maintainer@emeraldcoastsystemsgroup.com   | The runtime read serves runtime.fallbackOrder, resolved from the switch rows by the same precedence as the provider. The boot pull is the only carrier from a row to a bot node, so without this the fallback_order column and the cockpit control that writes it reached nothing: an administrator got a success banner, a persisted row and a panel reporting the chain, while every bot resolved an empty one.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import {
  classifyProviderId,
  requireModelForClineBackedId,
  resolveEffectiveBotProvider,
  type BotProviderSwitchResolution,
  type EffectiveBotProvider,
  type ProviderSwitchCatalog,
} from '@/shared/llm-runtime';
import type { ConfigSyncService, RuntimeParams } from '@/features/config-sync';
import type { AgentConfigService } from '@/features/agent-management';
import { getActiveRegistry } from '../swarm-bot-registry';
import { getCaller, hasAuthenticatedUserIdentity, hasValidServiceSecret, requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'config-runtime-routes' });
type ConfigValues = Record<string, unknown>;

/** The switch seams the composition root injects; every member is optional (no Postgres → none). */
export interface RuntimeRouteSwitchDeps {
  /** The switch resolution for one agent from the installed snapshot (bot-row > fleet > registry). */
  resolveSwitch?: (agentId: string) => BotProviderSwitchResolution | null;
  /** The runnable catalog, so a written providerId is refused before it reaches the record. */
  catalog?: () => ProviderSwitchCatalog | null;
  /**
   * The ordered fallback chain for one agent, resolved from the same rows as the provider
   * (bot row > fleet row). Served on the runtime read because the bot-node boot pull is the ONLY
   * carrier from a row to a node — without it the fallback_order column reaches nothing.
   */
  resolveFallbackChain?: (agentId: string, primaryProviderId: string | null) => readonly string[];
  /** Called after a persisted write so the installed snapshot re-reads the rows. */
  onRuntimeChanged?: () => Promise<void>;
  /**
   * Writes the bot's OWN switch row (oshal_bot_provider_switch, scope = the canonical agent id)
   * under the caller's identity. Absent (no Postgres pool) → only the ADR-034 record is written,
   * which a fleet-default row outranks.
   */
  writeBotSwitch?: (agentId: string, providerId: string, modelId: string | null, updatedBy: string) => Promise<void>;
}

interface ParsedMutation {
  params?: RuntimeParams;
  error?: string;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseMutation(input: unknown): ParsedMutation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Request body must be an object' };
  }
  const body = input as Record<string, unknown>;
  if (hasOwn(body, 'credentials')) {
    return { error: 'credential fields are not accepted on runtime configuration mutations' };
  }
  const changesProvider = hasOwn(body, 'providerId');
  const changesModel = hasOwn(body, 'modelId');
  if (!changesProvider && !changesModel) {
    return { error: 'At least one of providerId or modelId is required' };
  }
  const providerId = optionalString(body.providerId);
  const modelId = optionalString(body.modelId);
  if (changesProvider && !providerId) return { error: 'providerId must be a non-empty string' };
  if (changesModel && !modelId) return { error: 'modelId must be a non-empty string' };
  const mode = optionalString(body.mode);
  const params: RuntimeParams = {
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof body.requestTimeoutMs === 'number' && Number.isFinite(body.requestTimeoutMs)
      ? { requestTimeoutMs: body.requestTimeoutMs } : {}),
  };
  return { params };
}

/**
 * Resolve provider precedence from the same live registry that composes the bot. Registry read
 * failure is deliberately fail-closed: the highest-precedence tier cannot be assumed absent.
 */
function resolvePolicy(agentId: string, values: ConfigValues, switches: RuntimeRouteSwitchDeps): EffectiveBotProvider {
  let registryReadable = false;
  let entry: { harnessType?: string; apiType?: string } | undefined;
  try {
    entry = getActiveRegistry().find((bot) => bot.agentId === agentId || bot.name === agentId);
    registryReadable = true;
  } catch (err) {
    logger.error({ err, agentId }, 'Provider precedence registry read failed closed');
  }
  return resolveEffectiveBotProvider({
    harnessType: entry?.harnessType ?? null,
    apiType: entry?.apiType ?? null,
    dbProviderId: optionalString(values.providerId) ?? null,
    dbModelId: optionalString(values.modelId) ?? null,
    registryReadable,
    switchResolution: switches.resolveSwitch?.(agentId) ?? null,
  });
}

/**
 * The provider/model the bot-node boot pull applies: the switch rung when a row won (bot-row or
 * fleet-default, or a refused row carried by name so the bot refuses it rather than booting
 * something else), else the record's own values exactly as before.
 */
function resolvedRuntimeFields(
  agentId: string, values: ConfigValues, switches: RuntimeRouteSwitchDeps,
): { providerId: unknown; modelId: unknown; providerSource: string } {
  const switched = switches.resolveSwitch?.(agentId) ?? null;
  if (switched && switched.source !== 'registry') {
    const modelId = switched.ok ? switched.modelId : optionalString(switched.row.modelId) ?? null;
    return { providerId: switched.providerId, modelId: modelId ?? values.modelId ?? null, providerSource: switched.source };
  }
  return { providerId: values.providerId ?? null, modelId: values.modelId ?? null, providerSource: 'registry' };
}

function policyPayload(
  policy: EffectiveBotProvider,
): Pick<EffectiveBotProvider, 'effectiveProvider' | 'effectiveModel' | 'providerSource'> {
  return { effectiveProvider: policy.effectiveProvider, effectiveModel: policy.effectiveModel, providerSource: policy.providerSource };
}

async function handleRuntimeRead(
  req: Request,
  res: Response,
  agentConfig: AgentConfigService | undefined,
  switches: RuntimeRouteSwitchDeps,
): Promise<void> {
  const agentId = String(req.params.agentId);
  const startedAt = Date.now();
  logger.info({ agentId }, 'Agent runtime config read started');
  try {
    if (!agentConfig) {
      res.status(503).json({ success: false, error: 'Agent config store unavailable (no Postgres pool)' });
      return;
    }
    const config = await agentConfig.getConfig(agentId);
    const fleetApplies = (switches.resolveSwitch?.(agentId)?.source ?? 'registry') === 'fleet-default';
    if (!config && !fleetApplies) {
      res.status(404).json({ success: false, error: `No config record for agent ${agentId}` });
      return;
    }
    const values = (config?.values || {}) as ConfigValues;
    const resolved = resolvedRuntimeFields(agentId, values, switches);
    res.json({
      success: true,
      agentId: config?.agentId ?? agentId,
      runtime: {
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        // The administrator's ordered chain, carried to the node on the same pull that carries the
        // provider. A bot that restarts must come up on the CURRENT chain, not the one baked into
        // whatever env its container was created with.
        fallbackOrder: switches.resolveFallbackChain?.(
          agentId, typeof resolved.providerId === 'string' ? resolved.providerId : null,
        ) ?? [],
        mode: values.mode ?? null,
        requestTimeoutMs: values.requestTimeoutMs ?? null,
      },
      record: { providerId: values.providerId ?? null, modelId: values.modelId ?? null },
      configVersion: Number(values.configVersion ?? 0),
      ...policyPayload(resolvePolicy(agentId, values, switches)),
      updatedAt: config?.updatedAt ?? null,
    });
  } catch (err) {
    logger.error({ err, agentId }, 'Failed to read agent runtime config');
    res.status(500).json({ success: false, error: (err as Error).message });
  } finally {
    logger.info(
      { agentId, statusCode: res.statusCode, durationMs: Date.now() - startedAt },
      'Agent runtime config read completed',
    );
  }
}

function precedenceConflict(
  body: Record<string, unknown>,
  policy: EffectiveBotProvider,
): { code: string; error: string } | null {
  if (hasOwn(body, 'providerId') && !policy.providerOverridable) {
    return { code: 'provider_pinned', error: policy.precedenceNote };
  }
  if (hasOwn(body, 'modelId') && !policy.modelOverridable) {
    return { code: 'model_pinned', error: policy.precedenceNote };
  }
  return null;
}

/**
 * The record is the switch row: an id the build cannot run, or a Cline-backed id written without a
 * model (the Cline runtime would fall back to the container's FORCE_LLM_MODEL seed), is refused
 * here by name before anything is pushed or persisted — the same rule the resolver would refuse it
 * with later. An accepted id is canonicalized in place (a row written `nousresearch` reaches the
 * `nousResearch` definition).
 * @returns True when a 400 was written and the mutation must stop.
 */
function refuseUnrunnableSwitch(res: Response, params: RuntimeParams, switches: RuntimeRouteSwitchDeps): boolean {
  const catalog = switches.catalog?.() ?? null;
  if (!params.providerId || !catalog) return false;
  const classified = classifyProviderId(params.providerId, catalog);
  if (!classified.ok) {
    res.status(400).json({ success: false, applied: false, pushed: false, code: 'provider_unknown', error: classified.reason });
    return true;
  }
  const modelLess = requireModelForClineBackedId(classified, params.modelId ?? null);
  if (modelLess) {
    res.status(400).json({ success: false, applied: false, pushed: false, code: 'model_required', error: modelLess.reason });
    return true;
  }
  params.providerId = classified.providerId;
  return false;
}

/**
 * Validate one mutation against current precedence, then delegate the push-before-persist
 * transaction to ConfigSyncService. Every early response means the authoritative record stayed
 * unchanged.
 */
async function applyRuntimeMutation(
  req: Request,
  res: Response,
  agentId: string,
  configSync: ConfigSyncService | undefined,
  agentConfig: AgentConfigService | undefined,
  switches: RuntimeRouteSwitchDeps,
): Promise<void> {
  const parsed = parseMutation(req.body);
  if (!parsed.params) {
    res.status(400).json({ success: false, applied: false, error: parsed.error });
    return;
  }
  if (!configSync || !agentConfig) {
    res.status(503).json({ success: false, applied: false, error: 'Config services unavailable (no Postgres pool)' });
    return;
  }
  if (refuseUnrunnableSwitch(res, parsed.params, switches)) return;
  const before = await agentConfig.getConfig(agentId);
  const beforeValues = (before?.values || {}) as ConfigValues;
  const beforePolicy = resolvePolicy(agentId, beforeValues, switches);
  const conflict = precedenceConflict(req.body as Record<string, unknown>, beforePolicy);
  if (conflict) {
    res.status(409).json({
      success: false, applied: false, pushed: false,
      ...conflict, ...policyPayload(beforePolicy),
    });
    return;
  }
  const result = await configSync.pushToBot(agentId, parsed.params);
  if (result.reason) {
    res.status(502).json({
      success: false, applied: false, error: result.reason,
      ...result, ...policyPayload(beforePolicy),
    });
    return;
  }
  await writeOwnSwitchRow(req, before?.agentId ?? agentId, parsed.params, switches);
  if (switches.onRuntimeChanged) {
    await switches.onRuntimeChanged();
  }
  const afterValues = { ...beforeValues, ...parsed.params, configVersion: result.newVersion };
  const afterPolicy = resolvePolicy(agentId, afterValues, switches);
  res.json({
    success: true, agentId, applied: true, pushed: result.pushed,
    configVersion: result.newVersion ?? Number(beforeValues.configVersion ?? 0),
    ...policyPayload(afterPolicy),
  });
}

/**
 * The operator's provider pick is the bot's own switch row — the only per-bot record that beats
 * the fleet default. A provider mutation writes the row with the model it names (or none: the
 * harness default, never a model left over from another provider); a model-only mutation updates
 * the row's model when the bot already has one, and otherwise writes nothing here, because a
 * record with no switch row is governed by the fleet default.
 */
async function writeOwnSwitchRow(
  req: Request,
  agentId: string,
  params: RuntimeParams,
  switches: RuntimeRouteSwitchDeps,
): Promise<void> {
  if (!switches.writeBotSwitch) return;
  const updatedBy = getCaller(req).sub ?? 'operator';
  if (params.providerId) {
    await switches.writeBotSwitch(agentId, params.providerId, params.modelId ?? null, updatedBy);
    return;
  }
  const own = switches.resolveSwitch?.(agentId) ?? null;
  if (params.modelId && own && own.source === 'bot-row' && own.row) {
    await switches.writeBotSwitch(agentId, own.row.providerId, params.modelId, updatedBy);
  }
}

async function handleRuntimeWrite(
  req: Request,
  res: Response,
  configSync: ConfigSyncService | undefined,
  agentConfig: AgentConfigService | undefined,
  switches: RuntimeRouteSwitchDeps,
): Promise<void> {
  const agentId = String(req.params.agentId);
  const startedAt = Date.now();
  logger.info({ agentId }, 'Agent runtime config mutation started');
  try {
    await applyRuntimeMutation(req, res, agentId, configSync, agentConfig, switches);
  } catch (err) {
    logger.error({ err, agentId }, 'Failed to push agent runtime config');
    res.status(500).json({ success: false, applied: false, error: (err as Error).message });
  } finally {
    logger.info(
      { agentId, statusCode: res.statusCode, durationMs: Date.now() - startedAt },
      'Agent runtime config mutation completed',
    );
  }
}

/**
 * @description Per-agent runtime configuration routes (ADR-034). Reads report the authoritative
 * record. Writes validate registry precedence, push to the live runtime first, and persist only
 * after acceptance through ConfigSyncService.
 * @param configSync - Bidirectional runtime synchronization service.
 * @param agentConfig - Authoritative per-agent config store.
 * @param switches - The switch resolver, catalog and post-write refresh (all optional).
 * @returns Router mounted under /api/agents.
 */
export function createConfigRuntimeRoutes(
  configSync: ConfigSyncService | undefined,
  agentConfig: AgentConfigService | undefined,
  switches: RuntimeRouteSwitchDeps = {},
): Router {
  const router = Router();
  router.get(
    '/:agentId/runtime',
    requiresOperatorOrService,
    (req, res) => void handleRuntimeRead(req, res, agentConfig, switches),
  );
  router.put(
    '/:agentId/runtime',
    requiresOperatorBrowser,
    (req, res) => void handleRuntimeWrite(req, res, configSync, agentConfig, switches),
  );
  return router;
}

/**
 * @description Allows bot bootstrap reads with the exact machine secret, otherwise requires an
 * operator identity established by the outer session-auth mount.
 */
function requiresOperatorOrService(req: Request, res: Response, next: NextFunction): void {
  if (hasAuthenticatedUserIdentity(req)) {
    requiresOperator(req, res, next);
    return;
  }
  if (hasValidServiceSecret(req)) {
    next();
    return;
  }
  requiresOperator(req, res, next);
}

/**
 * @description Runtime mutations change global non-secret provider/model state and therefore require
 * an operator browser identity. Credential fields are rejected before any config lookup or push.
 */
function requiresOperatorBrowser(req: Request, res: Response, next: NextFunction): void {
  if (hasAuthenticatedUserIdentity(req)) {
    requiresOperator(req, res, next);
    return;
  }
  if (hasValidServiceSecret(req)) {
    res.status(403).json({ success: false, applied: false, error: 'Operator privilege required' });
    return;
  }
  requiresOperator(req, res, next);
}
