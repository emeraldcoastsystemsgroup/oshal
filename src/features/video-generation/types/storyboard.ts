/**
 * Storyboard types — the contract between the video-director bot (which drafts a
 * scene-by-scene plan) and the deterministic render service (which turns that plan
 * into a real .mp4 via Veo + ffmpeg). Mirrors how presentation `RenderableSlide`
 * sits between the deck-builder bot and `renderPptx`.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial storyboard/scene/shape contract for the Video Studio (?app=video) thin slice.
 *
 * @module video-generation/types/storyboard
 */

/** Supported short-form aspect ratios. 9:16 is the default for Shorts/Reels/TikTok. */
export type AspectRatio = '9:16' | '1:1' | '16:9';

/**
 * @description One scene in a storyboard. A scene becomes a single Veo clip
 * (≤8s — Veo's per-clip ceiling) plus its own narration line and on-screen caption.
 */
export interface Scene {
  /** The visual prompt sent to Veo for this clip (animated/prompted, no real footage). */
  prompt: string;
  /** Target clip length in seconds. Clamped to Veo's 2–8s window by the render service. */
  durationSec: number;
  /** Voiceover line spoken over this scene (empty string when the shape has voice 'none'). */
  narration: string;
  /** Short on-screen caption burned into this scene (empty string when captions are off). */
  caption: string;
}

/**
 * @description The user's "shape the video" controls from the studio surface — style,
 * tone, framing, target length, and the voice/captions/music toggles. The director
 * reads these to size and style the storyboard; the render service reads them to drive
 * Veo, TTS, captions, and the music bed.
 */
export interface VideoShape {
  /** Visual style, e.g. "futuristic live-action", "interactive stick figures", "clean explainer". */
  style: string;
  /** Tone, e.g. "energetic", "calm tutorial", "playful". */
  tone: string;
  /** Output framing. */
  aspectRatio: AspectRatio;
  /** Desired total length in seconds (the render service splits this across scenes). */
  targetSeconds: number;
  /** Whether to burn in on-screen captions. */
  captions: boolean;
  /** TTS voice id for narration, or 'none' for no voiceover. */
  voice: string | 'none';
  /** Background-music style id, or 'none' for no music bed. */
  music: string | 'none';
}

/**
 * @description A complete plan the director hands to the render service: a title plus
 * the ordered scenes. `targetSeconds` is informational (the sum of scene durations is
 * authoritative).
 */
export interface Storyboard {
  title: string;
  scenes: Scene[];
}

/**
 * @description Result of a render: the .mp4 bytes plus the realized duration and the
 * per-clip generation cost estimate (so the route can persist it + record a cost event).
 */
export interface RenderedVideo {
  mp4: Buffer;
  durationSec: number;
  /** Estimated USD cost of the Veo generation (clip seconds × configured rate). */
  estimatedCostUsd: number;
}
