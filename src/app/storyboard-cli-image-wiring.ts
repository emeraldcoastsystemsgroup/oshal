/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Boot wiring for the ADR-130 codex-cli storyboard image provider: registers the bot-node render executor into the video-generation feature (registerCliStoryboardImageExecutor, Schwab-resolver pattern) so the controller itself never spawns a CLI. The render runs as one agentic swarm-execute task on a dedicated bot node — SEC-05's demo carve (DEMO_MODE + operator sub) authorizes the spawn there, on the threaded userSub, never here.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | The render dispatch names the codex harness (providerId 'openai-codex', the ADR-034 carried record) instead of riding whatever the render bot happens to be running. ADR-130 assumed the bot's boot provider WAS codex; since ADR-162 the fleet default is a switch row, and on the demo box that row is claude-code — so an unstamped render ran on the Claude Code CLI, which has no image generation, and every series storyboard died at frame 1 with NO_IMAGE_CAPABILITY (measured live 2026-09-21 on b1f0f28e: general-bot effectiveProvider claude-code, providerSource fleet-default). With the stamp the bot reconciles its active provider to codex before the spawn (bot-node-dispatch-config), or refuses fail-closed if it cannot. No model is pinned: the render still rides the bot's CODEX_MODEL. Guard: tests/unit/storyboard-cli-image-wiring.spec.ts.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ADR-130 amendment 2026-10-02, the bot-level rule (operator: the bot's own setting wins; "ok lets go with your recommendation"). Entry 2's fixed 'openai-codex' stamp is removed: a render no longer moves the render bot onto an image harness. The rail is chosen from the render bot's own canonical provider record, the record its text turns carry (its own switch row, else the fleet default, else its agent_config record or registry declaration; ctx.swarm.runtimeParamsResolver), and the dispatch is stamped with exactly that record, so the bot's ADR-034 reconcile is a match on its own setting and never a switch. At dispatch the executor re-reads the record and refuses before any network call when no record resolves, when the bot's harness cannot make images ("<bot> runs <harness>, which cannot make images; ..."), or when its rail is not the one the render was prepared for (the bot was switched in between, or STORYBOARD_IMAGE_PROVIDER names the other CLI rail). The stamp carries an EMPTY fallback chain, so a failover rung can never run a rail's prompt on a harness it was not written for. Every render is marked imageTurn (the Antigravity wrapper hands back generate_image's output; other harnesses ignore it). The result carries the provider the bot ran on and its providerConfigAction, so the live case can require 'match'. Boot also registers the render-bot reader the image selection follows. wireCliStoryboardImageExecutor takes the runtime-params resolver as a getter, read per call.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05 carve for image turns (operator decision 2026-10-02 b): the dispatch sends the request's `brief` as the bot's `text` (the untrusted body) and the server-authored `prompt` as `renderInstruction`, the carrier the bot files under TRUSTED CONFIGURATION on an image turn. Nothing else about the dispatch changes: the bot's own record, the empty fallback chain and imageTurn stay.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Throttle image renders (operator decision 2026-10-03): every render dispatch runs through an in-process ImageTurnQueue keyed by the render bot, so the bot runs one image turn at a time and other renders wait their turn in arrival order. The render bot's record is read and the stamp checked inside the turn, at dispatch, as before. A render that names `startBy` and is still waiting then answers success:false with busy:true and nothing dispatched, so its caller's deadline also bounds the wait. Text turns never enter the queue. The dispatch budget is read through cliStoryboardRenderBudgetMs (STORYBOARD_CLI_IMAGE_TIMEOUT_MS, 420 s when unset or not a positive number), the same figure the frame stage and the Test Lab render card hold a whole render to.
 */
/**
 * @description Wires the CLI storyboard image rails (codex-cli, antigravity-cli) to a real bot node at boot.
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
 * Throttle (operator decision 2026-10-03): the render bot runs one image turn at a time; other
 * renders wait their turn (ImageTurnQueue), each no longer than its own `startBy`.
 *
 * Harness (ADR-130 amendment 2026-10-02, the bot-level rule): the render runs on the render bot's
 * OWN effective harness. Its canonical provider record — the one its text turns are stamped with —
 * picks the image rail (antigravity-cli → antigravity-cli, openai-codex/codex-cli → codex-cli) and
 * is the record this dispatch carries, so the bot's ADR-034 reconcile matches its own setting and
 * never switches it. A bot whose harness cannot make images is refused by name. The model is not
 * pinned beyond that record (ADR-130 "Model").
 *
 * @module app/storyboard-cli-image-wiring
 */

import {
  BotNodeClient,
  createRegistryEndpointResolver,
  resolveRequiredDispatchConfigFields,
  type DispatchConfigFields,
  type RuntimeParamsResolver,
} from '@/features/agent-management';
import {
  cliStoryboardRenderBudgetMs,
  imageRailForHarness,
  registerCliStoryboardImageExecutor,
  registerStoryboardRenderBotReader,
  renderBotCannotMakeImages,
  type CliStoryboardRenderRequest,
  type CliStoryboardRenderResult,
  type StoryboardRenderBotReader,
} from '@/features/video-generation';
import { createChildLogger } from '@/shared/logger';
import { getActiveRegistry } from './extensions/swarm/swarm-bot-registry';
import { ImageTurnQueue } from './storyboard-image-turn-queue';

const logger = createChildLogger({ module: 'storyboard-cli-image-wiring' });

/** general-bot — the dedicated general/fallback bot node (swarm-bot-registry-local). */
const DEFAULT_RENDER_BOT_ID = 'a0000000-0000-0000-0000-000000000099';

/** @description Where the wiring reads the swarm's canonical runtime-params resolver, per call. */
export interface CliStoryboardWiringDeps {
  /** The resolver every bot-node dispatch is stamped from (ctx.swarm.runtimeParamsResolver). */
  runtimeParamsResolver: () => RuntimeParamsResolver | undefined;
}

/**
 * @description The render bot as messages name it: its registry name, else its agent id.
 * @param {string} agentId - The render bot's agent id.
 * @returns {string} The name.
 */
export function renderBotName(agentId: string): string {
  try {
    return getActiveRegistry().find((bot) => bot.agentId === agentId)?.name || agentId;
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, agentId }, 'render bot name could not be read from the registry');
    return agentId;
  }
}

/**
 * @description The render bot's canonical provider record: the one its text turns carry.
 * @param {string} agentId - The render bot's agent id.
 * @param {CliStoryboardWiringDeps} deps - The resolver getter.
 * @returns {Promise<DispatchConfigFields | null>} The record, or null when none resolves.
 * @throws When this process has no resolver, or the resolver itself fails (snapshot not loaded).
 */
async function renderBotRecord(agentId: string, deps: CliStoryboardWiringDeps): Promise<DispatchConfigFields | null> {
  const resolver = deps.runtimeParamsResolver();
  if (!resolver) throw new Error('this process has no runtime-params resolver (the swarm extension has no database pool)');
  return resolveRequiredDispatchConfigFields(resolver, agentId);
}

/**
 * @description The reader the image selection follows: the render bot's name and its own
 * effective provider, read fresh on every call.
 * @param {string} agentId - The render bot's agent id.
 * @param {CliStoryboardWiringDeps} deps - The resolver getter.
 * @returns {StoryboardRenderBotReader} The reader.
 */
export function createStoryboardRenderBotReader(agentId: string, deps: CliStoryboardWiringDeps): StoryboardRenderBotReader {
  return async () => ({ name: renderBotName(agentId), harness: (await renderBotRecord(agentId, deps))?.providerId ?? null });
}

/**
 * @description The record a render may be stamped with, or the refusal that stops it before any
 * dispatch: no record, a harness with no image rail, or a rail other than the one requested.
 * @param {string} agentId - The render bot's agent id.
 * @param {CliStoryboardRenderRequest} request - The render request.
 * @param {CliStoryboardWiringDeps} deps - The resolver getter.
 * @returns {Promise<{record: DispatchConfigFields} | {refusal: string}>} The record or the refusal.
 */
async function renderStamp(
  agentId: string, request: CliStoryboardRenderRequest, deps: CliStoryboardWiringDeps,
): Promise<{ record: DispatchConfigFields } | { refusal: string }> {
  const bot = renderBotName(agentId);
  let record: DispatchConfigFields | null;
  try {
    record = await renderBotRecord(agentId, deps);
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack, agentId, taskId: request.taskId }, 'cli storyboard render: the render bot provider record could not be read');
    return { refusal: `the provider of ${bot} could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
  const harness = record?.providerId;
  if (!record || !harness) return { refusal: `${bot} has no provider record (no bot row, fleet default or registry declaration)` };
  const rail = imageRailForHarness(harness);
  if (!rail) return { refusal: renderBotCannotMakeImages(bot, harness) };
  if (rail !== request.rail) {
    return { refusal: `${bot} runs ${harness}, whose image rail is ${rail}, but this render was prepared for ${request.rail}; a render never switches the bot's harness — set STORYBOARD_IMAGE_PROVIDER to ${rail} or unset it, or give ${bot} a harness for ${request.rail}` };
  }
  return { record };
}

/**
 * @description One render on the render bot's own harness: stamp its own record, never another.
 * @param {BotNodeClient} client - The bot-node client.
 * @param {string} agentId - The render bot's agent id.
 * @param {CliStoryboardRenderRequest} request - The render request.
 * @param {CliStoryboardWiringDeps} deps - The resolver getter.
 * @returns {Promise<CliStoryboardRenderResult>} The bot's answer, or the refusal as success:false.
 */
async function renderOnOwnHarness(
  client: BotNodeClient, agentId: string, request: CliStoryboardRenderRequest, deps: CliStoryboardWiringDeps,
): Promise<CliStoryboardRenderResult> {
  const started = Date.now();
  const stamp = await renderStamp(agentId, request, deps);
  if ('refusal' in stamp) {
    logger.error({ agentId, taskId: request.taskId, rail: request.rail, reason: stamp.refusal }, 'cli storyboard render refused before dispatch');
    return { success: false, responseText: '', error: stamp.refusal };
  }
  try {
    const result = await client.execute(agentId, {
      // SEC-05 carve for image turns: the brief is the untrusted body, the server-authored
      // instruction its own carrier, which the bot files under TRUSTED CONFIGURATION.
      text: request.brief,
      renderInstruction: request.prompt,
      taskId: request.taskId,
      workspaceFolderId: request.workspaceFolderId,
      agentId,
      agenticMode: true,
      userSub: request.userSub,
      // ADR-034: the bot's OWN record, so its reconcile matches and never switches it. No failover
      // rung: the rail's prompt is written for this harness only.
      ...stamp.record,
      providerConfigRequired: true,
      fallbackOrder: [],
      // The Antigravity wrapper hands back generate_image's output; other harnesses ignore it.
      imageTurn: true,
    });
    logger.info({ agentId, taskId: request.taskId, rail: request.rail, providerId: stamp.record.providerId, ranOn: result.provider, providerConfigAction: result.providerConfigAction, durationMs: Date.now() - started, model: result.model }, 'cli storyboard render task completed');
    return { success: result.success, responseText: result.response ?? '', model: result.model, provider: result.provider,
      providerConfigAction: result.providerConfigAction, error: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, agentId, taskId: request.taskId, durationMs: Date.now() - started }, 'cli storyboard render task failed');
    return { success: false, responseText: '', error: message };
  }
}

/**
 * @description One render in the render bot's image turn: it waits behind the bot's other image turns
 * (ImageTurnQueue), no longer than its own `startBy`, then is stamped and dispatched on the bot's own
 * harness. A render still waiting at `startBy` is answered busy, with nothing dispatched.
 * @param {BotNodeClient} client - The bot-node client.
 * @param {string} agentId - The render bot's agent id.
 * @param {CliStoryboardRenderRequest} request - The render request.
 * @param {CliStoryboardWiringDeps} deps - The resolver getter.
 * @param {ImageTurnQueue} imageTurns - The process's one-image-turn-per-bot queue.
 * @returns {Promise<CliStoryboardRenderResult>} The bot's answer, a refusal, or busy, as success:false.
 */
async function renderInTurn(
  client: BotNodeClient, agentId: string, request: CliStoryboardRenderRequest, deps: CliStoryboardWiringDeps, imageTurns: ImageTurnQueue,
): Promise<CliStoryboardRenderResult> {
  const turn = await imageTurns.run(agentId, request.startBy, () => renderOnOwnHarness(client, agentId, request, deps));
  if (!turn.started) {
    logger.warn({ agentId, taskId: request.taskId, rail: request.rail, waitedMs: turn.waitedMs }, 'cli storyboard render not started: the render bot was still busy with another image turn when this render had to start');
    return { success: false, busy: true, responseText: '',
      error: `${renderBotName(agentId)} was still rendering another image when this render had to start; nothing was dispatched` };
  }
  if (turn.waitedMs > 0) logger.info({ agentId, taskId: request.taskId, rail: request.rail, waitedMs: turn.waitedMs }, 'cli storyboard render waited its turn on the render bot');
  return turn.value;
}

/**
 * @description Register the bot-node render executor for the CLI image rails (codex-cli and
 * antigravity-cli) and the render-bot reader the image selection follows. Called once from server
 * boot. Fail-soft by design: if this never runs, the CLI rails read unavailable and the resolver
 * fails closed with instructions. Every render the executor takes runs in the render bot's image
 * turn, one at a time (operator decision 2026-10-03, "Throttle image renders").
 * @param {CliStoryboardWiringDeps} deps - Where to read the canonical runtime-params resolver.
 * @returns {void}
 */
export function wireCliStoryboardImageExecutor(deps: CliStoryboardWiringDeps): void {
  const agentId = (process.env.STORYBOARD_CLI_IMAGE_BOT_ID || '').trim() || DEFAULT_RENDER_BOT_ID;
  const timeoutMs = cliStoryboardRenderBudgetMs();
  const client = new BotNodeClient(createRegistryEndpointResolver(), timeoutMs);
  const imageTurns = new ImageTurnQueue();

  registerStoryboardRenderBotReader(createStoryboardRenderBotReader(agentId, deps));
  registerCliStoryboardImageExecutor((request) => renderInTurn(client, agentId, request, deps, imageTurns));
  logger.info({ agentId, timeoutMs }, 'cli storyboard image executor registered');
}
