/**
 * Storyboard sanitizer — never trust raw model output. Parses what the video-director
 * bot returns into a safe, bounded `Storyboard` shaped by the user's `VideoShape`
 * (scene count, per-clip duration, captions/voice toggles). Mirrors `cleanSlides` in
 * bot-presentation-routes.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial storyboard sanitizer for the Video Studio thin slice.
 *
 * @module video-generation/services/storyboard
 */

import type { Scene, Storyboard, VideoShape } from '../types';

/** Bounds that keep a storyboard cheap + renderable regardless of model output. */
const MAX_SCENES = 12;
const MIN_CLIP_SEC = 2;
const MAX_CLIP_SEC = 8;
const MAX_PROMPT_CHARS = 600;
const MAX_NARRATION_CHARS = 300;
const MAX_CAPTION_CHARS = 90;
const MAX_TARGET_SECONDS = 90;

/** Coerce + clamp one scene's duration into Veo's window. */
function cleanDuration(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return MIN_CLIP_SEC;
  return Math.max(MIN_CLIP_SEC, Math.min(MAX_CLIP_SEC, Math.round(n)));
}

/** Sanitize a single raw scene against the shape's caption/voice toggles. */
function cleanScene(raw: unknown, shape: VideoShape): Scene | null {
  const o = (raw || {}) as Record<string, unknown>;
  const prompt = String(o.prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
  if (!prompt) return null;
  return {
    prompt,
    durationSec: cleanDuration(o.durationSec),
    narration: shape.voice === 'none' ? '' : String(o.narration || '').trim().slice(0, MAX_NARRATION_CHARS),
    caption: shape.captions ? String(o.caption || '').trim().slice(0, MAX_CAPTION_CHARS) : '',
  };
}

/**
 * @description Parse + sanitize raw director output into a bounded storyboard. Accepts
 * either an object `{ title, scenes }` or a bare scene array; caps scene count, clamps
 * durations, and strips narration/captions the shape turned off. Throws when no usable
 * scene survives so the route can surface a clean 422.
 * @param raw - parsed JSON from the bot (object or array)
 * @param shape - the user's shape controls (drives toggles)
 * @param fallbackTitle - title to use when the bot omitted one
 * @returns a safe storyboard ready for rendering
 */
export function sanitizeStoryboard(raw: unknown, shape: VideoShape, fallbackTitle: string): Storyboard {
  const obj = (Array.isArray(raw) ? { scenes: raw } : (raw || {})) as Record<string, unknown>;
  const rawScenes = Array.isArray(obj.scenes) ? obj.scenes : [];
  const scenes = rawScenes
    .slice(0, MAX_SCENES)
    .map((s) => cleanScene(s, shape))
    .filter((s): s is Scene => s !== null);
  if (!scenes.length) throw new Error('storyboard had no usable scenes');
  const title = String(obj.title || fallbackTitle || 'Untitled video').trim().slice(0, 120);
  return { title, scenes };
}

/** Total realized seconds across a storyboard's scenes. */
export function storyboardSeconds(storyboard: Storyboard): number {
  return storyboard.scenes.reduce((sum, s) => sum + s.durationSec, 0);
}

/** Clamp a user-requested target length to the studio's allowed range. */
export function clampTargetSeconds(seconds: number): number {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return MIN_CLIP_SEC * 2;
  return Math.max(MIN_CLIP_SEC, Math.min(MAX_TARGET_SECONDS, Math.round(n)));
}
