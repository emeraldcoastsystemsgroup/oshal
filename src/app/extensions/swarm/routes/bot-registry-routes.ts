/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — bot registry and proxy-health for multi-bot cockpit
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added rca-specialist (3014) and presentation-bot (3015) to swarm registry
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added runtime-registry overlay so cockpit bot registry reflects live agent heartbeats and canonical IDs
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres agent status overlay so disabled bots reflect their DB status in registry responses
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | /registry online now uses resolveDisplayOnline(heartbeat, container) for static-registry bots: inline/api-hosted bots (container oshal-api) never heartbeat, so they showed offline in swarm-control + the Ops fleet even while working. staticDefinitions is SwarmBotRegistry.listDefinitions() = getActiveRegistry() (dynamic-inclusive), so app bots + container are present. Dynamic heartbeat-only bots (unregistered runtime rows) keep the heartbeat check.
 */

import { Router, type Request, type Response } from 'express';
import http from 'http';
import { Pool } from 'pg';
import { AgentRuntimeRegistryService, resolveDisplayOnline } from '@/features/agent-management';
import { createChildLogger } from '@/shared/logger';
import type { ModelUsageStats } from '@/shared/types';
import { SwarmBotRegistry, getActiveRegistry } from '../swarm-bot-registry';

const logger = createChildLogger({ module: 'bot-registry-routes' });
const SWARM_BOT_REGISTRY = getActiveRegistry();
export { SWARM_BOT_REGISTRY };

/**
 * @description Creates bot registry and proxy-health routes for multi-bot cockpit.
 * @param runtimeRegistryService - Optional Redis-backed runtime registry for live bot heartbeat overlays.
 * @returns Express Router with /registry and /proxy-health endpoints
 */
export function createBotRegistryRoutes(runtimeRegistryService?: AgentRuntimeRegistryService, pool?: Pool): Router {
  const router = Router();

  /**
   * @description Returns the list of known bots in the swarm with their ports and capabilities.
   * GET /api/swarm/bots/registry
   */
  router.get('/registry', async (_req: Request, res: Response) => {
    const selfIdentity = SwarmBotRegistry.resolveRuntimeIdentity(process.env);

    try {
      const runtimeRegistrations = runtimeRegistryService
        ? await runtimeRegistryService.listAgentRegistrations()
        : [];
      const runtimeByAgentId = new Map(runtimeRegistrations.map((registration) => [registration.agentId, registration]));
      const runtimeByName = new Map(runtimeRegistrations.map((registration) => [registration.agentName, registration]));
      const telemetryByAgent = await loadBotTelemetry(pool);
      // Overlay Postgres agent status (active/inactive) onto registry entries
      const agentStatusMap = new Map<string, string>();
      if (pool) {
        try {
          const statusResult = await pool.query('SELECT agent_id, name, status FROM agents');
          for (const row of statusResult.rows) {
            if (row.agent_id) agentStatusMap.set(row.agent_id, row.status);
            if (row.name) agentStatusMap.set(row.name, row.status);
          }
        } catch (statusErr) {
          logger.warn({ err: statusErr }, 'Failed to load agent status from Postgres — all bots treated as active');
        }
      }

      const staticDefinitions = SwarmBotRegistry.listDefinitions();
      const staticAgentIds = new Set(
        staticDefinitions
          .map((bot) => bot.agentId)
          .filter((agentId): agentId is string => typeof agentId === 'string' && agentId.trim().length > 0),
      );
      const staticBotNames = new Set(staticDefinitions.map((bot) => bot.name));

      const bots = staticDefinitions.map((bot) => {
        const runtimeRegistration = (bot.agentId ? runtimeByAgentId.get(bot.agentId) : undefined)
          ?? runtimeByName.get(bot.name);
        const agentId = bot.agentId ?? runtimeRegistration?.agentId ?? bot.name;
        const endpointUrl = runtimeRegistration?.endpointUrl?.trim() || `http://localhost:${bot.port}`;
        const internalEndpointUrl = runtimeRegistration?.internalEndpointUrl?.trim() || `http://${bot.container}:5000`;
        const dbStatus = agentStatusMap.get(agentId) || agentStatusMap.get(bot.name) || 'active';
        const telemetry = telemetryByAgent.get(agentId) || telemetryByAgent.get(bot.name) || createEmptyBotTelemetry();
        return {
          ...bot,
          agentId,
          dbStatus,
          telemetry,
          isSelf: agentId === selfIdentity.agentId || bot.name === selfIdentity.agentName,
          // Inline/api-hosted bots (container oshal-api) never heartbeat — they run in this api, so
        // they are online whenever it is (unless the operator disabled them). resolveDisplayOnline
        // reads the LIVE registry container, so the promoted trading-analyst NODE stays heartbeat-gated.
        online: resolveDisplayOnline(runtimeRegistration?.status === 'online', bot.container) && dbStatus !== 'inactive',
          aliases: runtimeRegistration?.aliases ?? [],
          lastHeartbeatAt: runtimeRegistration?.heartbeatAt ?? null,
          chatUrl: `${endpointUrl}/chat`,
          healthUrl: `${endpointUrl}/health`,
          configUrl: `${endpointUrl}/config`,
          endpointUrl,
          internalHealthUrl: `${internalEndpointUrl}/health`,
          internalEndpointUrl,
        };
      });

      const dynamicRuntimeBots = runtimeRegistrations
        .filter((registration) => !staticAgentIds.has(registration.agentId) && !staticBotNames.has(registration.agentName))
        .map((registration) => {
          const endpointUrl = registration.endpointUrl?.trim() || '';
          const internalEndpointUrl = registration.internalEndpointUrl?.trim() || '';
          const dbStatus = agentStatusMap.get(registration.agentId) || agentStatusMap.get(registration.agentName) || 'active';
          const telemetry = telemetryByAgent.get(registration.agentId)
            || telemetryByAgent.get(registration.agentName)
            || createEmptyBotTelemetry();
          return {
            agentId: registration.agentId,
            name: registration.agentName,
            port: registration.externalPort ?? 0,
            container: registration.agentName,
            role: registration.role,
            capabilities: registration.capabilities,
            dbStatus,
            telemetry,
            isSelf: registration.agentId === selfIdentity.agentId || registration.agentName === selfIdentity.agentName,
            online: registration.status === 'online' && dbStatus !== 'inactive',
            aliases: registration.aliases ?? [],
            lastHeartbeatAt: registration.heartbeatAt ?? null,
            chatUrl: endpointUrl ? `${endpointUrl}/chat` : '',
            healthUrl: endpointUrl ? `${endpointUrl}/health` : '',
            configUrl: endpointUrl ? `${endpointUrl}/config` : '',
            endpointUrl,
            internalHealthUrl: internalEndpointUrl ? `${internalEndpointUrl}/health` : '',
            internalEndpointUrl,
            isDynamic: true,
          };
        });
      const allBots = [...bots, ...dynamicRuntimeBots];

      logger.info(
        {
          selfAgentId: selfIdentity.agentId,
          selfAgentName: selfIdentity.agentName,
          selfPort: selfIdentity.externalPort,
          botCount: allBots.length,
          onlineBotCount: allBots.filter((bot) => bot.online).length,
        },
        'Bot registry requested',
      );

      res.json({
        self: selfIdentity.agentId,
        selfName: selfIdentity.agentName,
        selfPort: selfIdentity.externalPort ?? 0,
        bots: allBots,
        totalBots: allBots.length,
        liveBots: allBots.filter((bot) => bot.online).length,
      });
    } catch (error) {
      logger.error({ err: error }, 'Failed to build bot registry response');
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to build bot registry response.',
      });
    }
  });

  /**
   * @description Proxies a health check to another bot's port.
   * Allows the cockpit on one bot to check other bots' health without CORS issues.
   * GET /api/swarm/bots/proxy-health?url=http://localhost:3010/health
   */
  router.get('/proxy-health', (req: Request, res: Response) => {
    const targetUrl = req.query.url as string;

    if (!targetUrl) {
      res.status(400).json({ success: false, error: 'Missing ?url= parameter' });
      return;
    }

    // Security: only allow localhost and Docker internal health checks
    if (!targetUrl.startsWith('http://localhost:') && !targetUrl.startsWith('http://swarm-') && !targetUrl.startsWith('http://oshal-')) {
      res.status(403).json({ success: false, error: 'Only localhost/swarm health checks allowed' });
      return;
    }

    const startTime = Date.now();

    const httpReq = http.get(targetUrl, { timeout: 5000 }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      proxyRes.on('end', () => {
        const latencyMs = Date.now() - startTime;
        try {
          const data = JSON.parse(body);
          res.json({ success: true, status: proxyRes.statusCode, data, latencyMs });
        } catch {
          res.json({ success: true, status: proxyRes.statusCode, data: { raw: body }, latencyMs });
        }
      });
    });

    httpReq.on('error', (error) => {
      const latencyMs = Date.now() - startTime;
      logger.warn({ err: error, targetUrl, latencyMs }, 'Proxy health check failed');
      res.json({ success: false, error: error.message, latencyMs });
    });

    httpReq.on('timeout', () => {
      httpReq.destroy();
      const latencyMs = Date.now() - startTime;
      res.json({ success: false, error: 'Timeout', latencyMs });
    });
  });

  return router;
}

interface BotTelemetrySummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  totalRequests: number;
  latestModel: string | null;
  usageByModel: Record<string, ModelUsageStats>;
  updatedAt: string | null;
}

interface BotTelemetryRow {
  agent_id: string | null;
  total_input_tokens: number | string | null;
  total_output_tokens: number | string | null;
  total_cost: number | string | null;
  total_requests: number | string | null;
  usage_by_model: Record<string, ModelUsageStats> | string | null;
  updated_at: string | null;
}

async function loadBotTelemetry(pool?: Pool): Promise<Map<string, BotTelemetrySummary>> {
  const summaries = new Map<string, BotTelemetrySummary>();
  if (!pool) {
    return summaries;
  }

  try {
    const result = await pool.query<BotTelemetryRow>(
      `SELECT
        agent_id,
        total_input_tokens,
        total_output_tokens,
        total_cost,
        total_requests,
        usage_by_model,
        updated_at
      FROM chat_tasks
      WHERE agent_id IS NOT NULL`,
    );

    result.rows.forEach((row) => {
      const agentId = normalizeOptionalString(row.agent_id);
      if (!agentId) {
        return;
      }
      const existing = summaries.get(agentId) || createEmptyBotTelemetry();
      const usageByModel = mergeUsageByModel(existing.usageByModel, parseUsageByModel(row.usage_by_model));
      const latestModel = pickTopModel(usageByModel) || existing.latestModel;
      summaries.set(agentId, {
        totalInputTokens: existing.totalInputTokens + normalizeInt(row.total_input_tokens),
        totalOutputTokens: existing.totalOutputTokens + normalizeInt(row.total_output_tokens),
        totalTokens: existing.totalTokens + normalizeInt(row.total_input_tokens) + normalizeInt(row.total_output_tokens),
        totalCost: existing.totalCost + normalizeFloat(row.total_cost),
        totalRequests: existing.totalRequests + normalizeInt(row.total_requests),
        latestModel,
        usageByModel,
        updatedAt: pickLatestTimestamp(existing.updatedAt, normalizeOptionalString(row.updated_at)),
      });
    });
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load bot telemetry from chat_tasks');
  }

  return summaries;
}

function createEmptyBotTelemetry(): BotTelemetrySummary {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalRequests: 0,
    latestModel: null,
    usageByModel: {},
    updatedAt: null,
  };
}

function mergeUsageByModel(
  base: Record<string, ModelUsageStats>,
  incoming: Record<string, ModelUsageStats>,
): Record<string, ModelUsageStats> {
  const merged: Record<string, ModelUsageStats> = { ...base };
  Object.entries(incoming).forEach(([modelId, stats]) => {
    const current = merged[modelId] || createEmptyModelUsage();
    merged[modelId] = {
      inputTokens: normalizeInt(current.inputTokens) + normalizeInt(stats.inputTokens),
      outputTokens: normalizeInt(current.outputTokens) + normalizeInt(stats.outputTokens),
      totalTokens: normalizeInt(current.totalTokens) + normalizeInt(stats.totalTokens),
      inputCost: normalizeFloat(current.inputCost) + normalizeFloat(stats.inputCost),
      outputCost: normalizeFloat(current.outputCost) + normalizeFloat(stats.outputCost),
      totalCost: normalizeFloat(current.totalCost) + normalizeFloat(stats.totalCost),
      requestCount: normalizeInt(current.requestCount) + normalizeInt(stats.requestCount),
    };
  });
  return merged;
}

function parseUsageByModel(rawValue: unknown): Record<string, ModelUsageStats> {
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue as Record<string, ModelUsageStats>;
  }
  if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, ModelUsageStats>;
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to parse bot usage_by_model');
    }
  }
  return {};
}

function createEmptyModelUsage(): ModelUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    requestCount: 0,
  };
}

function pickTopModel(usageByModel: Record<string, ModelUsageStats>): string | null {
  const ranked = Object.entries(usageByModel).sort((left, right) =>
    normalizeInt(right[1].totalTokens) - normalizeInt(left[1].totalTokens),
  );
  return ranked[0]?.[0] || null;
}

function pickLatestTimestamp(current: string | null, candidate: string | null): string | null {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  return new Date(candidate).getTime() >= new Date(current).getTime() ? candidate : current;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeFloat(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
