/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added per-agent runtime config routes - oshal-owned provider/model push-down + read (ADR-034)
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Make this the authoritative provider-precedence write surface: reject pinned-provider writes, push before persistence, preserve provider-free model changes, and return explicit applied/pushed/version/effective runtime truth
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Kept signed bot bootstrap reads while restricting credential-bearing runtime mutations to exact operator browser sessions; established human principals remain authoritative when a service-secret header is also present
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: reject every credential field before config lookup/push and remove the raw secret carrier; provider/model mutations remain non-secret.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createChildLogger } from '@/shared/logger';
import { resolveEffectiveBotProvider, type EffectiveBotProvider } from '@/shared/llm-runtime';
import type { ConfigSyncService, RuntimeParams } from '@/features/config-sync';
import type { AgentConfigService } from '@/features/agent-management';
import { getActiveRegistry } from '../swarm-bot-registry';
import { hasAuthenticatedUserIdentity, hasValidServiceSecret, requiresOperator } from '@/shared/middleware/authz';

const logger = createChildLogger({ module: 'config-runtime-routes' });
type ConfigValues = Record<string, unknown>;

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
function resolvePolicy(agentId: string, values: ConfigValues): EffectiveBotProvider {
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
  });
}

function policyPayload(
  policy: EffectiveBotProvider,
): Pick<EffectiveBotProvider, 'effectiveProvider' | 'effectiveModel'> {
  return { effectiveProvider: policy.effectiveProvider, effectiveModel: policy.effectiveModel };
}

async function handleRuntimeRead(
  req: Request,
  res: Response,
  agentConfig: AgentConfigService | undefined,
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
    if (!config) {
      res.status(404).json({ success: false, error: `No config record for agent ${agentId}` });
      return;
    }
    const values = (config.values || {}) as ConfigValues;
    res.json({
      success: true,
      agentId: config.agentId,
      runtime: {
        providerId: values.providerId ?? null,
        modelId: values.modelId ?? null,
        mode: values.mode ?? null,
        requestTimeoutMs: values.requestTimeoutMs ?? null,
      },
      configVersion: Number(values.configVersion ?? 0),
      ...policyPayload(resolvePolicy(agentId, values)),
      updatedAt: config.updatedAt,
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
  const before = await agentConfig.getConfig(agentId);
  const beforeValues = (before?.values || {}) as ConfigValues;
  const beforePolicy = resolvePolicy(agentId, beforeValues);
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
  const afterValues = { ...beforeValues, ...parsed.params, configVersion: result.newVersion };
  const afterPolicy = resolvePolicy(agentId, afterValues);
  res.json({
    success: true, agentId, applied: true, pushed: result.pushed,
    configVersion: result.newVersion ?? Number(beforeValues.configVersion ?? 0),
    ...policyPayload(afterPolicy),
  });
}

async function handleRuntimeWrite(
  req: Request,
  res: Response,
  configSync: ConfigSyncService | undefined,
  agentConfig: AgentConfigService | undefined,
): Promise<void> {
  const agentId = String(req.params.agentId);
  const startedAt = Date.now();
  logger.info({ agentId }, 'Agent runtime config mutation started');
  try {
    await applyRuntimeMutation(req, res, agentId, configSync, agentConfig);
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
 * @returns Router mounted under /api/agents.
 */
export function createConfigRuntimeRoutes(
  configSync: ConfigSyncService | undefined,
  agentConfig: AgentConfigService | undefined,
): Router {
  const router = Router();
  router.get(
    '/:agentId/runtime',
    requiresOperatorOrService,
    (req, res) => void handleRuntimeRead(req, res, agentConfig),
  );
  router.put(
    '/:agentId/runtime',
    requiresOperatorBrowser,
    (req, res) => void handleRuntimeWrite(req, res, configSync, agentConfig),
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
