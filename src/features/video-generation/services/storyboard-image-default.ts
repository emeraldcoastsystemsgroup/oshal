/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | The storyboard image default follows the swarm default (ADR-130 amendment 2026-10-02; operator: "our settings should have swarm default as the default. that is antigravity"). With STORYBOARD_IMAGE_PROVIDER unset and DEMO_MODE on, the fleet-default harness picks the image rail: antigravity-cli -> antigravity-cli, openai-codex/codex-cli -> codex-cli; any other harness fails closed with "the swarm default <harness> cannot make images; set STORYBOARD_IMAGE_PROVIDER" and never falls back to a paid rail. No fleet-default row (or no switch store in this process) keeps ADR-130's codex-cli; a switch store that has not completed its first read fails closed. The explicit env always wins and the non-demo default stays codex. The fleet harness is read per call through an app-boot-registered reader (the feature never imports the app layer), so a fleet switch moves the image rail without a restart, as fast as the switch snapshot refreshes.
 */
/**
 * @description Which storyboard image rail a deployment uses when the operator has not named one.
 *
 * The answer is one function, `selectStoryboardImageProvider`, shared by the resolver and by the
 * Test Lab readback, so the card can never report a different rail than the one a frame renders on.
 *
 * @module features/video-generation/services/storyboard-image-default
 */

import { createChildLogger } from '@/shared/logger';
import { demoModeEnabled } from '@/shared/deployment-mode';

const logger = createChildLogger({ module: 'storyboard-image-default' });

/** @description What the app's reader reports about the swarm default at this moment. */
export interface StoryboardSwarmDefault {
  /** False while the provider switch has not completed its first read: the default is unknown. */
  loaded: boolean;
  /** The fleet-default row's provider id, or null when no fleet-default row exists. */
  harness: string | null;
}

/** @description The app-boot-registered reader of the swarm default (the installed switch snapshot). */
export type StoryboardSwarmDefaultReader = () => StoryboardSwarmDefault;

/** @description How the image rail was chosen, for the resolver and the Test Lab readback. */
export type StoryboardImageSelection =
  | { ok: true; id: string; source: 'explicit' | 'swarm-default' | 'demo-default' | 'platform-default'; swarmDefault: string | null }
  | { ok: false; source: 'swarm-default'; swarmDefault: string | null; reason: string };

/** The image rail each swarm-default harness can render on. A harness absent here cannot make images. */
const IMAGE_PROVIDER_BY_HARNESS: Readonly<Record<string, 'antigravity-cli' | 'codex-cli'>> = Object.freeze({
  'antigravity-cli': 'antigravity-cli',
  'openai-codex': 'codex-cli',
  'codex-cli': 'codex-cli',
});

let swarmDefaultReader: StoryboardSwarmDefaultReader | null = null;

/**
 * @description Called once at app boot so the feature reads the fleet default without importing the
 * app layer (the same seam pattern as the render executor). Passing null clears it (test isolation).
 * @param {StoryboardSwarmDefaultReader | null} reader - The fleet-default reader, or null to clear.
 * @returns {void}
 */
export function registerStoryboardSwarmDefaultReader(reader: StoryboardSwarmDefaultReader | null): void {
  swarmDefaultReader = reader;
}

/**
 * @description The swarm default as the registered reader reports it now, or null when no reader is
 * registered. A reader that throws reads as "not loaded", which fails closed rather than guessing.
 * @returns {StoryboardSwarmDefault | null} The swarm default, or null with no reader.
 */
function readSwarmDefault(): StoryboardSwarmDefault | null {
  if (!swarmDefaultReader) return null;
  try {
    return swarmDefaultReader();
  } catch (err) {
    logger.error({ err, stack: (err as Error).stack }, 'storyboard swarm-default reader failed; the image default reads as unknown');
    return { loaded: false, harness: null };
  }
}

/**
 * @description The demo-mode default: the swarm default's image rail, or a fail-closed refusal.
 * @returns {StoryboardImageSelection} The selection for a demo deployment with no explicit provider.
 */
function demoSelection(): StoryboardImageSelection {
  const current = readSwarmDefault();
  if (current && !current.loaded) {
    return { ok: false, source: 'swarm-default', swarmDefault: null,
      reason: 'the swarm default is not known yet (the provider switch has not completed its first read); set STORYBOARD_IMAGE_PROVIDER' };
  }
  const harness = (current?.harness ?? '').trim();
  if (!harness) return { ok: true, id: 'codex-cli', source: 'demo-default', swarmDefault: null };
  const mapped = IMAGE_PROVIDER_BY_HARNESS[harness.toLowerCase()];
  if (!mapped) {
    return { ok: false, source: 'swarm-default', swarmDefault: harness,
      reason: `the swarm default ${harness} cannot make images; set STORYBOARD_IMAGE_PROVIDER` };
  }
  return { ok: true, id: mapped, source: 'swarm-default', swarmDefault: harness };
}

/**
 * @description Choose the storyboard image rail without building any provider. Order:
 * STORYBOARD_IMAGE_PROVIDER (explicit, always wins) → in demo mode, the swarm default's image rail
 * (no fleet row: codex-cli) → otherwise codex. Fails closed with a reason instead of a fallback.
 * @returns {StoryboardImageSelection} The selected rail id and how it was chosen, or the refusal.
 */
export function selectStoryboardImageProvider(): StoryboardImageSelection {
  const explicit = (process.env.STORYBOARD_IMAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit) return { ok: true, id: explicit, source: 'explicit', swarmDefault: null };
  if (!demoModeEnabled()) return { ok: true, id: 'codex', source: 'platform-default', swarmDefault: null };
  return demoSelection();
}
