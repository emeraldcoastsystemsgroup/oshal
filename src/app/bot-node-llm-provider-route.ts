/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ADR-034 bot-node config surface: PUT /api/llm-provider (the endpoint BotNodeClient.switchProvider has always targeted but which 404'd on every bot-node worker, so ConfigSyncService.pushToBot returned pushed:false for the whole default fleet) + the broadcast-up helper publishing a MeshEnvelope on MESH_CHANNELS.configChange with the X-Config-Source: oshal-push echo-loop guard mirrored from any-bot's routes-llm-settings-stream.js. Applies via the runtime's setActiveProvider seam; unknown provider → 400, no switch, no broadcast.
 */

/**
 * Bot-node LLM-provider config surface (ADR-034 push-down + broadcast-up).
 *
 * The bot-node runtime historically had NO `/api/llm-provider` route: the controller's
 * push-down (`ConfigSyncService.pushToBot` → `BotNodeClient.switchProvider` → PUT
 * `${endpoint}/api/llm-provider`) 404'd on every compose-default worker, and nothing on a
 * bot-node ever published `MESH_CHANNELS.configChange`, so the broadcast-up half of
 * ADR-034 only existed on the any-bot runtime. This module closes both halves:
 *
 *  - `registerBotNodeLlmProviderRoute` mounts PUT `/api/llm-provider` behind the shared
 *    bot-node service-secret gate. Body `{ provider, model? }` applies through the
 *    runtime's `setActiveProvider` seam and answers `{ provider, model, active: true }`
 *    (the exact shape `switchProvider` expects). An unknown/unavailable provider is a
 *    400 with NO switch and NO broadcast.
 *  - `broadcastBotNodeConfigChange` publishes the locally-originated change up to the
 *    controller on `swarm.config-change` — UNLESS the request carried
 *    `X-Config-Source: oshal-push`, the echo-loop guard that stops an OSHAL push-down
 *    from bouncing straight back as a broadcast-up and re-bumping the config version
 *    forever (mirrors any-bot/server/app-modules/routes-llm-settings-stream.js).
 *
 * Credentials are deliberately NOT applied here: bot-node harness auth is the mounted
 * BYOK OAuth login (~/.claude / ~/.codex), never a pushed vendor API key
 * (docs/building-a-bot.md), and secrets must never land in bot-node state or logs.
 *
 * @module bot-node-llm-provider-route
 */

import { randomUUID } from 'crypto';
import type { Express, RequestHandler } from 'express';
import { createChildLogger } from '@/shared/logger';
import { MESH_CHANNELS, type MeshEnvelope } from '@/features/agent-management';

const logger = createChildLogger({ module: 'bot-node-llm-provider-route' });

/** Header + value marking an OSHAL-originated push-down (ADR-034 echo-loop guard). */
export const CONFIG_SOURCE_HEADER = 'X-Config-Source';
/** The push-down marker value BotNodeClient.switchProvider sends. */
export const OSHAL_PUSH_SOURCE = 'oshal-push';

/**
 * @description Thrown by the runtime's `setActiveProvider` when the requested provider is
 * not in the built provider map (unknown name, or a known harness whose provider failed to
 * initialize at boot). Carries a stable `code` so HTTP surfaces can map it to a 400
 * without string-matching messages.
 */
export class UnknownBotNodeProviderError extends Error {
  /** Stable discriminator for HTTP mapping (400, no switch). */
  readonly code = 'UNKNOWN_BOT_NODE_PROVIDER';

  /**
   * @description Builds the error naming the rejected provider and what IS available.
   * @param requested - The provider name the caller asked for.
   * @param available - Provider names actually initialized on this bot-node.
   */
  constructor(requested: string, available: string[]) {
    super(`Unknown or unavailable provider '${requested}'. Available on this bot-node: ${available.join(', ') || 'none'}`);
    this.name = 'UnknownBotNodeProviderError';
  }
}

/** @description The active provider/model pair the runtime reports after a switch. */
export interface ActiveBotNodeProvider {
  provider: string;
  model: string;
}

/** @description Minimal publish surface of the bot-node's connected mesh transport. */
export interface ConfigChangePublisher {
  publish(envelope: MeshEnvelope): Promise<void>;
}

/** @description Construction dependencies for the bot-node LLM-provider route. */
export interface BotNodeLlmProviderRouteDeps {
  /** This bot's runtime agent id (broadcast attribution). */
  agentId: string;
  /** Shared-secret gate (authorizeBotNodeInternalCall on the real server). */
  authorize: RequestHandler;
  /** The runtime's validated switch seam (throws UnknownBotNodeProviderError). */
  setActiveProvider(provider: string, model?: string): ActiveBotNodeProvider;
  /** The already-connected mesh transport used for the broadcast-up. */
  meshTransport: ConfigChangePublisher;
}

/**
 * @description Publishes a bot-node locally-originated config change up to the OSHAL
 * controller on the `swarm.config-change` mesh channel (ADR-034 broadcast-up). The
 * controller's ConfigSyncService subscribes and reconciles `{ agentId, params }` into the
 * authoritative agent_config record. Best-effort and non-fatal: a broadcast failure is
 * logged at ERROR but never fails the config change itself — the bot still works
 * standalone and re-syncs via the boot pull.
 * @param meshTransport - Connected mesh transport (RedisMeshTransport on a real node).
 * @param agentId - This bot's agent id.
 * @param params - The applied runtime params to report.
 * @returns True when the envelope was published, false when publishing failed.
 */
export async function broadcastBotNodeConfigChange(
  meshTransport: ConfigChangePublisher,
  agentId: string,
  params: { providerId: string; modelId?: string },
): Promise<boolean> {
  try {
    await meshTransport.publish({
      correlationId: randomUUID(),
      fromAgentId: agentId,
      toAgentId: '*',
      channel: MESH_CHANNELS.configChange,
      payload: { agentId, params, source: 'bot-local', runtime: 'bot-node' },
      messageType: 'broadcast',
    });
    logger.info(
      { agentId, providerId: params.providerId, modelId: params.modelId ?? null },
      'ADR-034: broadcast config change up to controller (swarm.config-change)',
    );
    return true;
  } catch (err) {
    logger.error(
      { err, agentId, providerId: params.providerId },
      'ADR-034: config-change broadcast-up failed — change applied locally, controller will re-sync on next pull',
    );
    return false;
  }
}

/**
 * @description Mounts PUT `/api/llm-provider` on the bot-node's Express app — the ADR-034
 * push-down target (un-breaking `BotNodeClient.switchProvider`'s 404 on default workers)
 * and the local-change surface whose non-push changes broadcast up. Apply-then-broadcast
 * ordering matches the any-bot runtime; the `X-Config-Source: oshal-push` header
 * suppresses the broadcast (echo-loop guard).
 * @param app - The bot-node Express app.
 * @param deps - Auth gate, agent id, runtime switch seam, and mesh transport.
 * @returns void
 */
export function registerBotNodeLlmProviderRoute(app: Express, deps: BotNodeLlmProviderRouteDeps): void {
  app.put('/api/llm-provider', deps.authorize, async (req, res) => {
    const body = req.body as { provider?: unknown; model?: unknown } | undefined;
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    if (!provider) {
      res.status(400).json({ error: 'Missing provider' });
      return;
    }
    if (body?.model !== undefined && typeof body.model !== 'string') {
      res.status(400).json({ error: 'model must be a string when present' });
      return;
    }
    const model = typeof body?.model === 'string' && body.model.trim().length > 0 ? body.model.trim() : undefined;

    let applied: ActiveBotNodeProvider;
    try {
      applied = deps.setActiveProvider(provider, model);
    } catch (err) {
      if (err instanceof UnknownBotNodeProviderError) {
        // Unknown/unavailable provider: nothing switched, nothing broadcast.
        res.status(400).json({ error: err.message });
        return;
      }
      logger.error({ err, provider, model }, 'PUT /api/llm-provider switch failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Provider switch failed' });
      return;
    }

    // ADR-034 broadcast-up with the echo-loop guard: an OSHAL-originated push-down
    // (X-Config-Source: oshal-push) must NOT bounce back as a bot-local broadcast, or
    // push → broadcast → reconcile → version-bump loops forever. Mirrors the any-bot
    // guard in routes-llm-settings-stream.js.
    if (req.get(CONFIG_SOURCE_HEADER) !== OSHAL_PUSH_SOURCE) {
      await broadcastBotNodeConfigChange(deps.meshTransport, deps.agentId, {
        providerId: applied.provider,
        modelId: applied.model,
      });
    }

    logger.info(
      { provider: applied.provider, model: applied.model, source: req.get(CONFIG_SOURCE_HEADER) ?? 'bot-local' },
      'Bot-node LLM provider switched via PUT /api/llm-provider',
    );
    res.json({ provider: applied.provider, model: applied.model, active: true });
  });
}
