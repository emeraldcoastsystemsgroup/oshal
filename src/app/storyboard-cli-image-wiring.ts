/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Boot wiring for the ADR-130 codex-cli storyboard image provider: registers the bot-node render executor into the video-generation feature (registerCliStoryboardImageExecutor, Schwab-resolver pattern) so the controller itself never spawns a CLI. The render runs as one agentic swarm-execute task on a dedicated bot node — SEC-05's demo carve (DEMO_MODE + operator sub) authorizes the spawn there, on the threaded userSub, never here.
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
 * @module app/storyboard-cli-image-wiring
 */

import { BotNodeClient, createRegistryEndpointResolver } from '@/features/agent-management';
import { registerCliStoryboardImageExecutor } from '@/features/video-generation';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'storyboard-cli-image-wiring' });

/** general-bot — the dedicated general/fallback bot node (swarm-bot-registry-local). */
const DEFAULT_RENDER_BOT_ID = 'a0000000-0000-0000-0000-000000000099';

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
