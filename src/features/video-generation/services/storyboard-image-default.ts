/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Storyboard image selection by the bot-level rule (ADR-130 amendment 2026-10-02; operator: the swarm default is the default and it is antigravity, then "ok lets go with your recommendation": the bot's own setting wins). Image generation is something the RENDER BOT does, so with STORYBOARD_IMAGE_PROVIDER unset and DEMO_MODE on the rail is chosen from that bot's own effective provider, resolved exactly like its text turns (its own switch row, else the fleet default, else its agent_config record or registry declaration): antigravity-cli -> antigravity-cli, openai-codex/codex-cli -> codex-cli. Any other harness, no record at all, or a reader that cannot answer (for example a switch snapshot that has not completed its first read) fails closed naming the bot and its harness ("<bot> runs <harness>, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API"), never a paid fallback. The reader is registered by the app at boot (the feature never imports the app layer) and read on every call, so a switch moves the rail with no restart. imageRailForHarness and renderBotCannotMakeImages are exported so the app's render executor applies the same mapping and the same words at dispatch time. STORYBOARD_IMAGE_PROVIDER always wins; the non-demo default stays codex; with no reader registered (no boot wiring in this process) the demo default stays ADR-130's codex-cli.
 */
/**
 * @description Which storyboard image rail a render uses when the operator has not named one.
 *
 * The answer is one function, `selectStoryboardImageProvider`, shared by the resolver and by the
 * Test Lab readback, so the card can never report a different rail than the one a frame renders on.
 *
 * @module features/video-generation/services/storyboard-image-default
 */

import { createChildLogger } from '@/shared/logger';
import { demoModeEnabled } from '@/shared/deployment-mode';

const logger = createChildLogger({ module: 'storyboard-image-default' });

/** @description The two image rails a bot's own harness can render on. */
export type CliStoryboardImageRail = 'antigravity-cli' | 'codex-cli';

/** @description What the app's reader reports about the render bot at this moment. */
export interface StoryboardRenderBot {
  /** The render bot as messages name it (its registry name, else its agent id). */
  name: string;
  /**
   * The bot's effective provider id, resolved like its text turns (its own switch row, else the
   * fleet default, else its agent_config record or registry declaration); null when none resolves.
   */
  harness: string | null;
}

/** @description The app-boot-registered reader of the render bot's effective provider. */
export type StoryboardRenderBotReader = () => Promise<StoryboardRenderBot>;

/** @description How the image rail was chosen, for the resolver and the Test Lab readback. */
export type StoryboardImageSelection =
  | { ok: true; id: string; source: 'explicit' | 'render-bot' | 'demo-default' | 'platform-default'; renderBot: string | null; harness: string | null }
  | { ok: false; source: 'render-bot'; renderBot: string | null; harness: string | null; reason: string };

/** The image rail each harness can render on. A harness absent here cannot make images. */
const IMAGE_RAIL_BY_HARNESS: Readonly<Record<string, CliStoryboardImageRail>> = Object.freeze({
  'antigravity-cli': 'antigravity-cli',
  'openai-codex': 'codex-cli',
  'codex-cli': 'codex-cli',
});

let renderBotReader: StoryboardRenderBotReader | null = null;

/**
 * @description The image rail a harness renders on, or null when that harness cannot make images.
 * @param {string | null | undefined} harness - A provider id as a switch row or record names it.
 * @returns {CliStoryboardImageRail | null} The rail, or null.
 */
export function imageRailForHarness(harness: string | null | undefined): CliStoryboardImageRail | null {
  const key = String(harness ?? '').trim().toLowerCase();
  return key ? IMAGE_RAIL_BY_HARNESS[key] ?? null : null;
}

/**
 * @description The refusal for a render bot whose own harness cannot make images. One sentence,
 * shared by the selection and the render executor so both say the same thing.
 * @param {string} bot - The render bot's name.
 * @param {string} harness - The harness it runs.
 * @returns {string} The refusal text.
 */
export function renderBotCannotMakeImages(bot: string, harness: string): string {
  return `${bot} runs ${harness}, which cannot make images; give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API`;
}

/**
 * @description Called once at app boot so the feature reads the render bot's provider without
 * importing the app layer (the same seam pattern as the render executor). Null clears it.
 * @param {StoryboardRenderBotReader | null} reader - The render-bot reader, or null to clear.
 * @returns {void}
 */
export function registerStoryboardRenderBotReader(reader: StoryboardRenderBotReader | null): void {
  renderBotReader = reader;
}

/**
 * @description The render bot's selection: its own harness's rail, or a fail-closed refusal.
 * @param {StoryboardRenderBotReader} reader - The registered reader.
 * @returns {Promise<StoryboardImageSelection>} The selection for a demo deployment.
 */
async function renderBotSelection(reader: StoryboardRenderBotReader): Promise<StoryboardImageSelection> {
  let bot: StoryboardRenderBot;
  try {
    bot = await reader();
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack }, 'storyboard render-bot reader failed; no image rail is chosen');
    return { ok: false, source: 'render-bot', renderBot: null, harness: null,
      reason: `the render bot's provider could not be read (${err instanceof Error ? err.message : String(err)}); set STORYBOARD_IMAGE_PROVIDER to an image API` };
  }
  const harness = (bot.harness ?? '').trim();
  if (!harness) {
    return { ok: false, source: 'render-bot', renderBot: bot.name, harness: null,
      reason: `${bot.name} has no provider record (no bot row, fleet default or registry declaration); give that bot an image-capable harness, or set STORYBOARD_IMAGE_PROVIDER to an image API` };
  }
  const rail = imageRailForHarness(harness);
  if (!rail) return { ok: false, source: 'render-bot', renderBot: bot.name, harness, reason: renderBotCannotMakeImages(bot.name, harness) };
  return { ok: true, id: rail, source: 'render-bot', renderBot: bot.name, harness };
}

/**
 * @description Choose the storyboard image rail without building any provider. Order:
 * STORYBOARD_IMAGE_PROVIDER (explicit, always wins) → outside demo mode, codex → in demo mode, the
 * render bot's own harness's rail (no reader registered in this process: codex-cli). Fails closed
 * with a reason instead of a fallback.
 * @returns {Promise<StoryboardImageSelection>} The selected rail id and how it was chosen, or the refusal.
 */
export async function selectStoryboardImageProvider(): Promise<StoryboardImageSelection> {
  const explicit = (process.env.STORYBOARD_IMAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit) return { ok: true, id: explicit, source: 'explicit', renderBot: null, harness: null };
  if (!demoModeEnabled()) return { ok: true, id: 'codex', source: 'platform-default', renderBot: null, harness: null };
  if (!renderBotReader) return { ok: true, id: 'codex-cli', source: 'demo-default', renderBot: null, harness: null };
  return renderBotSelection(renderBotReader);
}
