/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Boot wiring for the ADR-130 codex-cli storyboard image provider: registers the bot-node render executor into the video-generation feature (registerCliStoryboardImageExecutor, Schwab-resolver pattern) so the controller itself never spawns a CLI. The render runs as one agentic swarm-execute task on a dedicated bot node — SEC-05's demo carve (DEMO_MODE + operator sub) authorizes the spawn there, on the threaded userSub, never here.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The render dispatch names the codex harness (providerId 'openai-codex', the ADR-034 carried record) instead of riding whatever the render bot happens to be running. ADR-130 assumed the bot's boot provider WAS codex; since ADR-162 the fleet default is a switch row, and on the demo box that row is claude-code — so an unstamped render ran on the Claude Code CLI, which has no image generation, and every series storyboard died at frame 1 with NO_IMAGE_CAPABILITY (measured live 2026-09-21 on b1f0f28e: general-bot effectiveProvider claude-code, providerSource fleet-default). With the stamp the bot reconciles its active provider to codex before the spawn (bot-node-dispatch-config), or refuses fail-closed if it cannot. No model is pinned: the render still rides the bot's CODEX_MODEL. Guard: tests/unit/storyboard-cli-image-wiring.spec.ts.
 */
/**
 * @description Wires the codex-cli storyboard image provider to a real bot node at boot.
 *
 * Bot selection: `STORYBOARD_CLI_IMAGE_BOT_ID` env, defaulting to general-bot (the dedicated
 * general/fallback node) — same knob pattern as `RCA_SPECIALIST_AGENT_ID`. The render must land
 * on a DEDICATED bot node: inline (controller-container) bots have no endpoint and never spawn
 * CLIs, so pointing this at one makes the provider fail closed at render time.
 *
 * Timeout: `STORYBOARD_CLI_IMAGE_TIMEOUT_MS` (default 7 min) — an image render is one tool call
 * plus reasoning, far below the 65-min dispatch default, and the calling surface holds a request
 * open on this.
 *
 * Harness: the dispatch carries `providerId: 'openai-codex'` as its ADR-034 authoritative record.
 * The image capability this provider is named for exists only in the codex CLI, so the render
 * must not inherit the bot's current provider (a fleet-default or per-bot switch row can name any
 * harness). The bot self-corrects to codex before the spawn, or refuses; the model is deliberately
 * NOT pinned (ADR-130: it rides the render bot's `CODEX_MODEL`).
 *
 * @module app/storyboard-cli-image-wiring
 */

import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { registerCliStoryboardImageExecutor } from '@/features/video-generation';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'storyboard-cli-image-wiring' });

/** general-bot — the dedicated general/fallback bot node (swarm-bot-registry-local). */
const DEFAULT_RENDER_BOT_ID = 'a0000000-0000-0000-0000-000000000099';

/**
 * @description The bot-node provider id of the codex harness — the only harness with native image
 * generation, and therefore the one every codex-cli render is dispatched onto regardless of the
 * render bot's switch row. Exported so the guard pins the literal the bot reconciles against.
 */
export const CODEX_CLI_RENDER_PROVIDER_ID = 'openai-codex';

/**
 * @description Register the bot-node render executor for the codex-cli image provider.
 * Called once from server boot. Fail-soft by design: if this never runs, the provider reads
 * unavailable and the resolver fails closed with instructions.
 * @returns {void}
 */
export function wireCliStoryboardImageExecutor(): void {
  const agentId = (process.env.STORYBOARD_CLI_IMAGE_BOT_ID || '').trim() || DEFAULT_RENDER_BOT_ID;
  const timeoutMs = Number(process.env.STORYBOARD_CLI_IMAGE_TIMEOUT_MS) || 420_000;
  const client = new BotNodeClient(createRegistryEndpointResolver(), timeoutMs);

  registerCliStoryboardImageExecutor(async (request) => {
    const started = Date.now();
    try {
      const result = await client.execute(agentId, {
        text: request.prompt,
        taskId: request.taskId,
        workspaceFolderId: request.workspaceFolderId,
        agentId,
        agenticMode: true,
        userSub: request.userSub,
        // ADR-034 carried record: the bot reconciles onto the codex harness before it spawns.
        providerId: CODEX_CLI_RENDER_PROVIDER_ID,
      });
      logger.info(
        { agentId, taskId: request.taskId, durationMs: Date.now() - started, model: result.model },
        'cli storyboard render task completed',
      );
      return {
        success: result.success,
        responseText: result.response ?? '',
        model: result.model,
        provider: result.provider,
        error: result.error,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, agentId, taskId: request.taskId, durationMs: Date.now() - started },
        'cli storyboard render task failed',
      );
      return { success: false, responseText: '', error: message };
    }
  });
  logger.info({ agentId, timeoutMs }, 'codex-cli storyboard image executor registered');
}
